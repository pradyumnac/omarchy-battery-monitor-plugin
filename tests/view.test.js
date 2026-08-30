// The aggregated view: the single document every consumer reads.
//
// These are integration tests. They run the real producer against a temporary
// sysfs tree and state directory, because the view's job is precisely to turn
// those two into one document, and a mocked producer would prove nothing.

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { withFixture } = require("./support/fixture");
const {
  BAT0,
  BAT1,
  KEY_BAT0,
  KEY_BAT1,
  KEY_RETIRED,
  HISTORY_HEADER_V2,
  installBattery,
  writeBattery,
  writeMains,
  writeHistory,
  writeEstimators,
  windowsFor,
  historyRow,
  runView,
} = require("./support/battery");

const NOW = 20000000;

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

function withView(callback) {
  return withFixture({ root: "view-power", state: "view-state" }, (f) => {
    fs.mkdirSync(f.root, { recursive: true });
    return callback(f);
  });
}

function view(fixture, extraEnv = {}) {
  return runView(fixture, { BATTERY_VIEW_NOW: String(NOW), ...extraEnv });
}

describe("the view document", () => {
  test("names its own schema and version", () => {
    withView((f) => {
      installBattery(f.root, BAT1, { status: "Discharging" });
      const document = view(f);
      assert.equal(document.schema, "battery-view");
      assert.equal(document.version, 1);
      assert.equal(document.generated_epoch, NOW);
    });
  });

  test("escapes strings that would otherwise break the document", () => {
    // Given a vendor string containing quotes and a backslash
    // When the document is produced
    // Then it is still parseable and the value survives intact
    withView((f) => {
      installBattery(f.root, BAT1, {
        status: "Discharging",
        model_name: 'Think "Pad" \\ X1',
      });
      assert.equal(view(f).batteries[0].model, 'Think "Pad" \\ X1');
    });
  });

  test("reports every present battery and the pack totals", () => {
    withView((f) => {
      installBattery(f.root, BAT0, {
        status: "Discharging",
        capacity: 70,
        energy_now: 8000000,
        power_now: 0,
        cycle_count: 113,
        charge_control_end_threshold: 90,
      });
      installBattery(f.root, BAT1, {
        status: "Discharging",
        energy_now: 12000000,
        power_now: 9500000,
      });

      const document = view(f);
      assert.equal(document.batteries.length, 2);
      assert.equal(document.energy.now_uwh, 20000000);
      assert.equal(document.energy.capacity_uwh, 38090000);
      // sysfs reports microwatts; the document reports milliwatts.
      assert.equal(document.energy.draw_mw, 9500);
      assert.equal(document.energy.charge_limit_percent, 90);
      assert.equal(document.batteries[0].cycle_count, "113");
    });
  });

  test("skips batteries the kernel reports as not present", () => {
    withView((f) => {
      writeBattery(f.root, "BAT0", { present: 0, status: "Unknown" });
      installBattery(f.root, BAT1, { status: "Discharging" });
      const document = view(f);
      assert.equal(document.batteries.length, 1);
      assert.equal(document.batteries[0].name, "BAT1");
    });
  });

  test("separates an unreadable sysfs tree from a machine with no battery", () => {
    // Given a power-supply tree that cannot be read at all
    // When the document is produced
    // Then that is reported distinctly from a tree holding no battery, because
    // only the second means "this machine has no battery"
    withView((f) => {
      assert.equal(view(f).power.sysfs_available, true);
      const missing = view(f, {
        POWER_SUPPLY_ROOT: path.join(f.root, "nothing-here"),
        BATTERY_STATUS_POWER_SUPPLY_ROOT: path.join(f.root, "nothing-here"),
      });
      assert.equal(missing.power.sysfs_available, false);
    });
  });

  test("identifies the installed set, and says when identity is weak", () => {
    withView((f) => {
      installBattery(f.root, BAT1, { status: "Discharging" });
      const document = view(f);
      assert.equal(document.sampling.pack_key, KEY_BAT1);
      assert.equal(document.sampling.pack_key_weak, false);
    });
    withView((f) => {
      installBattery(f.root, BAT1, {
        status: "Discharging",
        serial_number: undefined,
      });
      assert.equal(view(f).sampling.pack_key_weak, true);
    });
  });
});

describe("charge-threshold holds in the view", () => {
  test("claims a hold only when a battery reached its own cap", () => {
    // Given sequential charging, where the idle cell reports the same
    // "Not charging" string a genuinely capped one would
    // When the document is produced
    // Then neither the battery nor the pack is called held
    withView((f) => {
      installBattery(f.root, BAT0, {
        status: "Not charging",
        capacity: 70,
        charge_control_end_threshold: 90,
      });
      installBattery(f.root, BAT1, {
        status: "Not charging",
        capacity: 60,
        charge_control_end_threshold: 90,
      });
      writeMains(f.root, 1);

      let document = view(f);
      assert.equal(document.batteries[0].held, false);
      assert.equal(document.batteries[1].held, false);
      assert.equal(document.power.phase, "plugged");

      // And once one really reaches its cap, both it and the pack say so.
      fs.writeFileSync(path.join(f.root, "BAT0", "capacity"), "95\n");
      document = view(f);
      assert.equal(document.batteries[0].held, true);
      assert.equal(document.batteries[1].held, false);
      assert.equal(document.power.phase, "held");
    });
  });

  test("never holds a battery with no configured cap", () => {
    withView((f) => {
      installBattery(f.root, BAT1, { status: "Not charging", capacity: 100 });
      writeMains(f.root, 1);
      const document = view(f);
      assert.equal(document.batteries[0].held, false);
      assert.equal(document.power.phase, "plugged");
    });
  });
});

describe("per-battery models", () => {
  function machine(f, overrides = {}) {
    installBattery(f.root, BAT0, {
      status: "Not charging",
      energy_now: 8000000,
      ...overrides.bat0,
    });
    installBattery(f.root, BAT1, {
      status: "Discharging",
      energy_now: 13000000,
      ...overrides.bat1,
    });
    writeState(f.state);
  }

  function byName(document, name) {
    return document.batteries.find((battery) => battery.name === name);
  }

  test("projects each battery from its own evidence alone", () => {
    // Given two batteries with very different recorded draws
    // When the document is produced
    // Then each is projected from its own windows, never from the other's
    withView((f) => {
      machine(f);
      writeHistory(f.state, [
        ...windowsFor(KEY_BAT1, { count: 12, drawMw: 10000, start: 19990000 }),
        ...windowsFor(KEY_BAT0, { count: 12, drawMw: 4000, start: 19991000 }),
      ]);

      const document = view(f);
      const bat1 = byName(document, "BAT1");
      const bat0 = byName(document, "BAT0");
      assert.equal(bat1.projection.typical_draw_mw, 10000);
      assert.equal(bat0.projection.typical_draw_mw, 4000);
      // 13 Wh at 10 W, and 8 Wh at 4 W.
      assert.equal(bat1.projection.remaining_seconds, 4680);
      assert.equal(bat0.projection.remaining_seconds, 7200);
    });
  });

  test("sums the per-battery projections into the pack figure", () => {
    // These cells discharge one after another, so the pack lasts as long as
    // its parts added together.
    withView((f) => {
      machine(f);
      writeHistory(f.state, [
        ...windowsFor(KEY_BAT1, { count: 12, drawMw: 10000, start: 19990000 }),
        ...windowsFor(KEY_BAT0, { count: 12, drawMw: 4000, start: 19991000 }),
      ]);
      const document = view(f);
      assert.equal(document.model.remaining_seconds, 4680 + 7200);
      assert.equal(document.model.state, "ready");
    });
  });

  test("leaves a battery with no evidence of its own unmodelled", () => {
    // Given evidence for only one of two installed batteries
    // When the document is produced
    // Then the other is still learning and contributes nothing to the pack
    withView((f) => {
      machine(f);
      writeHistory(f.state, windowsFor(KEY_BAT1, { count: 12, drawMw: 10000 }));
      const document = view(f);
      assert.equal(byName(document, "BAT0").projection.state, "learning");
      assert.equal(byName(document, "BAT0").projection.remaining_seconds, 0);
      assert.equal(byName(document, "BAT1").projection.state, "ready");
      // The pack is only as certain as its least certain battery.
      assert.equal(document.model.state, "provisional");
    });
  });

  test("offers a provisional estimate before the full gate", () => {
    withView((f) => {
      machine(f);
      writeHistory(f.state, windowsFor(KEY_BAT1, { count: 5, sessions: 1 }));
      assert.equal(byName(view(f), "BAT1").projection.state, "provisional");
    });
  });

  test("says nothing at all below the provisional gate", () => {
    withView((f) => {
      machine(f);
      writeHistory(f.state, windowsFor(KEY_BAT1, { count: 3, sessions: 1 }));
      const bat1 = byName(view(f), "BAT1");
      assert.equal(bat1.projection.state, "learning");
      assert.equal(bat1.projection.typical_draw_mw, 0);
      assert.equal(bat1.projection.remaining_seconds, 0);
    });
  });

  test("reports a band whose low edge comes from the heavier draw", () => {
    withView((f) => {
      machine(f);
      writeHistory(
        f.state,
        windowsFor(KEY_BAT1, {
          count: 12,
          drawMw: (index) => 8000 + index * 500,
        }),
      );
      const model = byName(view(f), "BAT1").projection;
      assert.ok(model.remaining_low_seconds < model.remaining_seconds);
      assert.ok(model.remaining_high_seconds > model.remaining_seconds);
    });
  });

  test("blocks a battery that reports no capacity", () => {
    withView((f) => {
      installBattery(f.root, BAT1, {
        status: "Discharging",
        energy_full: 0,
        energy_now: 0,
      });
      writeState(f.state);
      writeHistory(f.state, windowsFor(KEY_BAT1, { count: 12 }));
      assert.equal(view(f).batteries[0].projection.state, "blocked-energy");
    });
  });

  test("refuses a history schema it does not know", () => {
    withView((f) => {
      machine(f);
      writeHistory(f.state, [], "# battery-discharge-history\tv99");
      const document = view(f);
      assert.equal(document.history.state, "unsupported");
      assert.equal(document.model.state, "unavailable");
    });
  });

  test("counts pack-level rows from an older schema as unusable", () => {
    withView((f) => {
      machine(f);
      writeHistory(
        f.state,
        ["19990000\ts0\t9000\t26000000", "19990001\ts0\t9100\t26000000"],
        HISTORY_HEADER_V2,
      );
      const document = view(f);
      assert.equal(document.history.legacy, 2);
      assert.equal(document.batteries[0].projection.windows, 0);
    });
  });
});

describe("batteries that are no longer installed", () => {
  test("lists a swapped-out battery without ever modelling it", () => {
    // Given evidence recorded on a cell that has since been replaced
    // When the document is produced
    // Then it is named as absent, and none of its windows reach the installed
    // battery's projection
    withView((f) => {
      installBattery(f.root, BAT1, {
        status: "Discharging",
        energy_now: 13000000,
      });
      writeState(f.state);
      writeHistory(f.state, [
        ...windowsFor(KEY_RETIRED, { count: 10, drawMw: 3000, start: 19990000 }),
        ...windowsFor(KEY_BAT1, { count: 12, drawMw: 10000, start: 19991000 }),
      ]);

      const document = view(f);
      assert.equal(document.absent_batteries.length, 1);
      assert.equal(document.absent_batteries[0].key, KEY_RETIRED);
      assert.equal(document.absent_batteries[0].windows, 10);
      // The installed battery's draw is its own, untouched by the retired one.
      assert.equal(document.batteries[0].projection.typical_draw_mw, 10000);
      assert.equal(document.batteries[0].projection.windows, 12);
    });
  });

  test("lists nothing when every recorded battery is installed", () => {
    withView((f) => {
      installBattery(f.root, BAT1, { status: "Discharging" });
      writeState(f.state);
      writeHistory(f.state, windowsFor(KEY_BAT1, { count: 6 }));
      assert.deepEqual(view(f).absent_batteries, []);
    });
  });
});

describe("estimator selection in the view", () => {
  test("projects with the estimator recorded for that battery", () => {
    // Given a stored selection of "last" for this battery
    // When the document is produced
    // Then the projection uses the newest window, not the median
    withView((f) => {
      installBattery(f.root, BAT1, {
        status: "Discharging",
        energy_now: 13000000,
      });
      writeState(f.state);
      writeHistory(f.state, [
        ...windowsFor(KEY_BAT1, { count: 11, drawMw: 5000, start: 19990000 }),
        historyRow({ epoch: 19990500, key: KEY_BAT1, session: "late", drawMw: 20000 }),
      ]);
      writeEstimators(f.state, [
        { key: KEY_BAT1, estimator: "last", meanError: 250 },
      ]);

      const model = view(f).batteries[0].projection;
      assert.equal(model.estimator, "last");
      assert.equal(model.estimator_error_mw, 250);
      assert.equal(model.typical_draw_mw, 20000);
    });
  });

  test("falls back to the median when nothing was selected", () => {
    withView((f) => {
      installBattery(f.root, BAT1, {
        status: "Discharging",
        energy_now: 13000000,
      });
      writeState(f.state);
      writeHistory(f.state, windowsFor(KEY_BAT1, { count: 12, drawMw: 5000 }));
      const model = view(f).batteries[0].projection;
      assert.equal(model.estimator, "median");
      assert.equal(model.typical_draw_mw, 5000);
    });
  });
});

describe("session and freshness", () => {
  test("carries the tracker's session facts through unchanged", () => {
    withView((f) => {
      installBattery(f.root, BAT1, { status: "Discharging" });
      writeState(f.state, {
        previous_state: "on-charge",
        state_since_at_least: 1,
        last_charge_start: 19998000,
        last_charge_end: 19999000,
      });
      const document = view(f);
      assert.equal(document.power.state, "on-charge");
      assert.equal(document.power.state_since_at_least, true);
      assert.equal(document.power.charge_start_epoch, 19998000);
      assert.equal(document.sampling.session_id, "19999000");
    });
  });

  test("distinguishes live, cached and impossible tracker timestamps", () => {
    withView((f) => {
      installBattery(f.root, BAT1, { status: "Discharging" });
      writeState(f.state);
      assert.equal(view(f).tracker.freshness, "live");
      writeState(f.state, { last_observed: 19990000 });
      assert.equal(view(f).tracker.freshness, "cached");
      writeState(f.state, { last_observed: NOW + 500 });
      assert.equal(view(f).tracker.freshness, "clock-mismatch");
    });
  });

  test("reads a state file written before the schema was versioned", () => {
    // Given a v1 state file, which carries no version key and holds derived
    // fields the view no longer reads
    // When the document is produced
    // Then the stale copies are ignored in favour of live sysfs
    withView((f) => {
      installBattery(f.root, BAT1, {
        status: "Discharging",
        energy_now: 13000000,
      });
      fs.writeFileSync(
        path.join(f.state, "state"),
        [
          "previous_state=on-battery",
          "state_since=19999000",
          "last_observed=19999990",
          "battery_energy_now_uwh=99000000",
          "usual_remaining_runtime_seconds=99999",
        ].join("\n") + "\n",
      );
      writeHistory(f.state, windowsFor(KEY_BAT1, { count: 12, drawMw: 10000 }));
      const document = view(f);
      assert.equal(document.energy.now_uwh, 13000000);
      assert.equal(document.batteries[0].projection.remaining_seconds, 4680);
    });
  });

  test("describes the power phase from sysfs, not the state file", () => {
    withView((f) => {
      installBattery(f.root, BAT1, { status: "Charging" });
      writeMains(f.root, 1);
      writeState(f.state, { previous_state: "on-charge" });
      assert.equal(view(f).power.phase, "charging");
      assert.equal(view(f).power.ac_online, true);
    });
  });

  test("offers the power profiles the panel draws its picker from", () => {
    withView((f) => {
      installBattery(f.root, BAT1, { status: "Discharging" });
      const fake = path.join(f.state, "powerprofiles");
      fs.writeFileSync(
        fake,
        "#!/bin/sh\nprintf 'power-saver\\t0\\nbalanced\\t1\\nperformance\\t0\\n'\n",
        { mode: 0o700 },
      );
      const document = view(f, { BATTERY_VIEW_PROFILES_COMMAND: fake });
      assert.deepEqual(document.profiles.available, [
        "power-saver",
        "balanced",
        "performance",
      ]);
      assert.equal(document.profiles.active, "balanced");
    });
  });
});
