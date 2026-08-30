const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { withFixture } = require("./support/fixture");

const view = path.join(__dirname, "..", "service", "battery-view.sh");

const NOW = 20000000;

function writeBattery(root, name, values) {
  const directory = path.join(root, name);
  fs.mkdirSync(directory, { recursive: true });
  for (const [field, value] of Object.entries(values)) {
    fs.writeFileSync(path.join(directory, field), `${value}\n`);
  }
}

function writeMains(root, online) {
  writeBattery(root, "AC", { type: "Mains", online });
}

function writeState(stateDir, fields = {}) {
  const values = {
    state_schema_version: 2,
    previous_state: "on-battery",
    state_since: 19999000,
    state_since_at_least: 0,
    last_observed: 19999990,
    discharge_session_id: 19999000,
    window_start_epoch: 19999550,
    window_reset_reason: "''",
    battery_fingerprint: "BAT0:energy:50000000",
    ...fields,
  };
  fs.writeFileSync(
    path.join(stateDir, "state"),
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n") + "\n",
  );
}

function writeHistory(stateDir, rows) {
  fs.writeFileSync(
    path.join(stateDir, "discharge-history.tsv"),
    ["# battery-discharge-history\tv1", ...rows].join("\n") + "\n",
  );
}

// 12 windows across 3 sessions, all at the same draw: a model that is ready
// and whose median is unambiguous.
function readyHistory(draw = 10000) {
  return Array.from(
    { length: 12 },
    (_, index) => `${19990000 + index}\tsession-${index % 3}\t${draw}\t50000000`,
  );
}

function withViewFixture(callback) {
  return withFixture({ root: "view-power", state: "view-state" }, (f) => {
    fs.mkdirSync(f.root, { recursive: true });
    return callback(f);
  });
}

function runView(fixture, extraEnv = {}) {
  const raw = execFileSync(view, {
    env: {
      ...process.env,
      POWER_SUPPLY_ROOT: fixture.root,
      BATTERY_SESSION_STATE_DIR: fixture.state,
      BATTERY_VIEW_NOW: String(NOW),
      BATTERY_VIEW_PROFILES_COMMAND: "/nonexistent/powerprofiles",
      ...extraEnv,
    },
    encoding: "utf8",
  });
  return JSON.parse(raw);
}

describe("the aggregated view document", () => {
  test("is one versioned JSON document naming its own schema", () => {
    withViewFixture((f) => {
      writeBattery(f.root, "BAT0", { present: 1, status: "Discharging" });
      const document = runView(f);
      assert.equal(document.schema, "battery-view");
      assert.equal(document.version, 1);
      assert.equal(document.generated_epoch, NOW);
    });
  });

  test("escapes strings that would otherwise break the document", () => {
    withViewFixture((f) => {
      writeBattery(f.root, "BAT0", {
        present: 1,
        status: "Discharging",
        model_name: 'Think "Pad" \\ X1',
        manufacturer: "LGC",
      });
      const document = runView(f);
      assert.equal(document.batteries[0].model, 'Think "Pad" \\ X1');
      assert.equal(document.batteries[0].vendor, "LGC");
    });
  });

  test("reports every present battery and the pack totals", () => {
    withViewFixture((f) => {
      writeBattery(f.root, "BAT0", {
        present: 1,
        status: "Discharging",
        capacity: 80,
        energy_now: 40000000,
        energy_full: 50000000,
        energy_full_design: 60000000,
        power_now: 9500000,
        cycle_count: 112,
        charge_control_end_threshold: 80,
      });
      writeBattery(f.root, "BAT1", {
        present: 1,
        status: "Discharging",
        energy_now: 10000000,
        energy_full: 20000000,
      });

      const document = runView(f);
      assert.equal(document.batteries.length, 2);
      assert.equal(document.energy.now_uwh, 50000000);
      assert.equal(document.energy.capacity_uwh, 70000000);
      assert.equal(document.energy.percent, 71);
      // sysfs reports µW; the document reports mW.
      assert.equal(document.energy.draw_mw, 9500);
      assert.equal(document.energy.charge_limit_percent, 80);
      assert.equal(document.batteries[0].cycle_count, "112");
    });
  });

  test("claims a threshold hold only when a battery reached its own cap", () => {
    withViewFixture((f) => {
      // Sequential dual-battery charging: the idle one reports the same bare
      // "Not charging" string a genuinely capped battery would, far below its
      // configured cap. It must not be reported as held, and it must not drag
      // the whole pack's phase to "held" either.
      writeBattery(f.root, "BAT0", {
        present: 1,
        status: "Not charging",
        capacity: 70,
        charge_control_end_threshold: 90,
      });
      writeBattery(f.root, "BAT1", {
        present: 1,
        status: "Not charging",
        capacity: 60,
        charge_control_end_threshold: 90,
      });
      writeMains(f.root, 1);

      let document = runView(f);
      assert.equal(document.batteries[0].held, false);
      assert.equal(document.batteries[1].held, false);
      assert.equal(document.power.phase, "plugged");

      // Once BAT0 actually reaches its cap, both the battery and the pack say so.
      writeBattery(f.root, "BAT0", { capacity: 95 });
      document = runView(f);
      assert.equal(document.batteries[0].held, true);
      assert.equal(document.batteries[1].held, false);
      assert.equal(document.power.phase, "held");
    });
  });

  test("a battery with no configured cap is never held", () => {
    withViewFixture((f) => {
      writeBattery(f.root, "BAT0", {
        present: 1,
        status: "Not charging",
        capacity: 100,
      });
      writeMains(f.root, 1);
      const document = runView(f);
      assert.equal(document.batteries[0].held, false);
      assert.equal(document.power.phase, "plugged");
    });
  });

  test("skips batteries the kernel reports as not present", () => {
    withViewFixture((f) => {
      writeBattery(f.root, "BAT0", { present: 0, status: "Unknown" });
      writeBattery(f.root, "BAT1", { present: 1, status: "Discharging" });
      const document = runView(f);
      assert.equal(document.batteries.length, 1);
      assert.equal(document.batteries[0].name, "BAT1");
    });
  });

  test("separates an unreadable sysfs tree from a machine with no battery", () => {
    withViewFixture((f) => {
      const absent = runView(f);
      assert.equal(absent.power.sysfs_available, true);
      assert.equal(absent.batteries.length, 0);

      const missing = runView(f, {
        POWER_SUPPLY_ROOT: path.join(f.root, "nothing-here"),
      });
      assert.equal(missing.power.sysfs_available, false);
    });
  });
});

describe("the runtime model in the view", () => {
  test("projects usual runtime from the median of the discharge history", () => {
    withViewFixture((f) => {
      writeBattery(f.root, "BAT0", {
        present: 1,
        status: "Discharging",
        energy_now: 40000000,
        energy_full: 50000000,
      });
      writeState(f.state);
      writeHistory(f.state, readyHistory(10000));

      const document = runView(f);
      assert.equal(document.model.state, "ready");
      assert.equal(document.model.windows, 12);
      assert.equal(document.model.sessions, 3);
      assert.equal(document.model.typical_draw_mw, 10000);
      // 40 Wh at 10 W is 4 hours; 50 Wh is 5.
      assert.equal(document.model.remaining_seconds, 14400);
      assert.equal(document.model.full_seconds, 18000);
    });
  });

  test("takes the median, not an outlier", () => {
    withViewFixture((f) => {
      writeBattery(f.root, "BAT0", {
        present: 1,
        energy_now: 50000000,
        energy_full: 50000000,
      });
      writeState(f.state);
      writeHistory(f.state, [
        ...readyHistory(10000),
        `19990500\tsession-0\t100000\t50000000`,
      ]);

      const document = runView(f);
      assert.equal(document.model.typical_draw_mw, 10000);
      assert.equal(document.model.full_seconds, 18000);
    });
  });

  test("holds the full gate at 12 windows across 3 sessions", () => {
    withViewFixture((f) => {
      writeBattery(f.root, "BAT0", {
        present: 1,
        energy_now: 40000000,
        energy_full: 50000000,
      });
      writeState(f.state);
      // Twelve windows, but all from one session.
      writeHistory(
        f.state,
        Array.from(
          { length: 12 },
          (_, index) => `${19990000 + index}\tonly-one\t10000\t50000000`,
        ),
      );

      const document = runView(f);
      assert.equal(document.model.state, "provisional");
      assert.equal(document.model.required_windows, 12);
      assert.equal(document.model.required_sessions, 3);
    });
  });

  test("says nothing at all below the provisional gate", () => {
    withViewFixture((f) => {
      writeBattery(f.root, "BAT0", {
        present: 1,
        energy_now: 40000000,
        energy_full: 50000000,
      });
      writeState(f.state);
      writeHistory(f.state, readyHistory(10000).slice(0, 3));

      const document = runView(f);
      assert.equal(document.model.state, "learning");
      assert.equal(document.model.remaining_seconds, 0);
      assert.equal(document.model.typical_draw_mw, 0);
    });
  });

  test("ignores rows outside the 30-day lookback and rows from the future", () => {
    withViewFixture((f) => {
      writeBattery(f.root, "BAT0", {
        present: 1,
        energy_now: 40000000,
        energy_full: 50000000,
      });
      writeState(f.state);
      writeHistory(f.state, [
        "1000\tancient\t20000\t50000000",
        ...readyHistory(10000),
        `${NOW + 100}\tfuture\t20000\t50000000`,
      ]);

      const document = runView(f);
      assert.equal(document.model.windows, 12);
      assert.equal(document.model.typical_draw_mw, 10000);
      assert.equal(document.history.total, 14);
      assert.equal(document.history.archived, 1);
      assert.equal(document.history.future, 1);
    });
  });

  test("reports a p25-p75 band, widest draw giving the shortest time", () => {
    withViewFixture((f) => {
      writeBattery(f.root, "BAT0", {
        present: 1,
        energy_now: 40000000,
        energy_full: 50000000,
      });
      writeState(f.state);
      writeHistory(
        f.state,
        Array.from(
          { length: 12 },
          (_, index) =>
            `${19990000 + index}\tsession-${index % 3}\t${
              8000 + index * 500
            }\t50000000`,
        ),
      );

      const document = runView(f);
      assert.ok(document.model.remaining_low_seconds > 0);
      assert.ok(
        document.model.remaining_low_seconds <
          document.model.remaining_seconds,
        "the p75 draw must buy less time than the median",
      );
      assert.ok(
        document.model.remaining_high_seconds >
          document.model.remaining_seconds,
        "the p25 draw must buy more time than the median",
      );
    });
  });

  test("tracks a workload shift with a right-now estimate", () => {
    withViewFixture((f) => {
      writeBattery(f.root, "BAT0", {
        present: 1,
        energy_now: 40000000,
        energy_full: 50000000,
      });
      writeState(f.state);
      // Eight quiet windows, then four heavy ones.
      writeHistory(f.state, [
        ...Array.from(
          { length: 8 },
          (_, index) => `${19990000 + index}\tsession-${index % 3}\t5000\t50000000`,
        ),
        ...Array.from(
          { length: 4 },
          (_, index) => `${19990100 + index}\tsession-${index % 3}\t20000\t50000000`,
        ),
      ]);

      const document = runView(f);
      assert.equal(document.model.recent_windows, 4);
      assert.equal(document.model.recent_draw_mw, 20000);
      assert.ok(
        document.model.recent_remaining_seconds <
          document.model.remaining_seconds,
        "the recent heavy draw must shorten the right-now estimate",
      );
    });
  });

  test("blocks the model when the battery reports no energy", () => {
    withViewFixture((f) => {
      writeBattery(f.root, "BAT0", { present: 1, status: "Discharging" });
      writeState(f.state);
      writeHistory(f.state, readyHistory(10000));

      const document = runView(f);
      assert.equal(document.model.state, "blocked-energy");
      assert.equal(document.model.remaining_seconds, 0);
    });
  });

  test("refuses a history file whose schema it does not know", () => {
    withViewFixture((f) => {
      writeBattery(f.root, "BAT0", { present: 1, energy_full: 50000000 });
      writeState(f.state);
      fs.writeFileSync(
        path.join(f.state, "discharge-history.tsv"),
        "# battery-discharge-history\tv99\n1000\ta\t10000\t50000000\n",
      );

      const document = runView(f);
      assert.equal(document.history.state, "unsupported");
      assert.equal(document.model.state, "unavailable");
    });
  });
});

describe("session and freshness in the view", () => {
  test("carries the tracker's session facts through unchanged", () => {
    withViewFixture((f) => {
      writeBattery(f.root, "BAT0", { present: 1, status: "Discharging" });
      writeState(f.state, {
        previous_state: "on-charge",
        state_since: 19999000,
        state_since_at_least: 1,
        last_charge_start: 19998000,
        last_charge_end: 19999000,
      });

      const document = runView(f);
      assert.equal(document.power.state, "on-charge");
      assert.equal(document.power.state_since_epoch, 19999000);
      assert.equal(document.power.state_since_at_least, true);
      assert.equal(document.power.charge_start_epoch, 19998000);
      assert.equal(document.sampling.session_id, "19999000");
    });
  });

  test("calls a recently written state file live and an old one cached", () => {
    withViewFixture((f) => {
      writeBattery(f.root, "BAT0", { present: 1, status: "Discharging" });
      writeState(f.state);
      assert.equal(runView(f).tracker.freshness, "live");

      writeState(f.state, { last_observed: 19990000 });
      assert.equal(runView(f).tracker.freshness, "cached");

      writeState(f.state, { last_observed: NOW + 500 });
      assert.equal(runView(f).tracker.freshness, "clock-mismatch");
    });
  });

  test("reads a v1 state file, which carries no version key", () => {
    withViewFixture((f) => {
      writeBattery(f.root, "BAT0", {
        present: 1,
        status: "Discharging",
        energy_now: 40000000,
        energy_full: 50000000,
      });
      // A pre-upgrade state file: no schema version, and the derived model
      // fields v2 dropped. The view must ignore the stale copies and project
      // from live sysfs and the history instead.
      fs.writeFileSync(
        path.join(f.state, "state"),
        [
          "previous_state=on-battery",
          "state_since=19999000",
          "last_observed=19999990",
          "battery_energy_now_uwh=99000000",
          "usual_remaining_runtime_seconds=99999",
          "usual_full_runtime_seconds=99999",
        ].join("\n") + "\n",
      );
      writeHistory(f.state, readyHistory(10000));

      const document = runView(f);
      assert.equal(document.power.state, "on-battery");
      assert.equal(document.energy.now_uwh, 40000000);
      assert.equal(document.model.remaining_seconds, 14400);
    });
  });

  test("describes the machine's power phase from sysfs, not the state file", () => {
    withViewFixture((f) => {
      writeBattery(f.root, "BAT0", { present: 1, status: "Charging" });
      writeMains(f.root, 1);
      writeState(f.state, { previous_state: "on-charge" });
      assert.equal(runView(f).power.phase, "charging");
      assert.equal(runView(f).power.ac_online, true);

      writeBattery(f.root, "BAT0", {
        status: "Not charging",
        capacity: 90,
        charge_control_end_threshold: 90,
      });
      assert.equal(runView(f).power.phase, "held");
    });
  });

  test("offers the power profiles the panel needs to draw its picker", () => {
    withViewFixture((f) => {
      writeBattery(f.root, "BAT0", { present: 1, status: "Discharging" });
      const fake = path.join(f.state, "powerprofiles");
      fs.writeFileSync(
        fake,
        "#!/bin/sh\nprintf 'power-saver\\t0\\nbalanced\\t1\\nperformance\\t0\\n'\n",
        { mode: 0o700 },
      );

      const document = runView(f, { BATTERY_VIEW_PROFILES_COMMAND: fake });
      assert.deepEqual(document.profiles.available, [
        "power-saver",
        "balanced",
        "performance",
      ]);
      assert.equal(document.profiles.active, "balanced");
    });
  });
});
