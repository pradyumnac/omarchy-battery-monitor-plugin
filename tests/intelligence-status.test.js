// `make status`: the sole operational report.
//
// It computes nothing — it renders the aggregated view and adds systemd
// service health. These tests assert what an operator actually reads, because
// that text is the contract; the numbers behind it are covered in view and
// model-lib tests.

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { withFixture } = require("./support/fixture");
const {
  repository,
  BAT0,
  BAT1,
  KEY_BAT0,
  KEY_BAT1,
  KEY_RETIRED,
  installBattery,
  writeMains,
  writeHistory,
  writeEstimators,
  windowsFor,
  runStatus,
} = require("./support/battery");

const NOW = 20000000;
const ansi = String.fromCharCode(27);

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
    battery_fingerprint: "BAT0:energy:12090000",
    ...fields,
  };
  fs.writeFileSync(
    path.join(stateDir, "state"),
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n") + "\n",
  );
}

function withStatus(callback) {
  return withFixture({ root: "status-power", state: "status-state" }, (f) => {
    fs.mkdirSync(f.root, { recursive: true });
    return callback(f);
  });
}

function status(fixture, extraEnv = {}) {
  return runStatus(fixture, {
    BATTERY_INTELLIGENCE_NOW: String(NOW),
    ...extraEnv,
  });
}

// One discharging battery holding 13 Wh of its 26 Wh.
function singleBattery(f, overrides = {}) {
  return installBattery(f.root, BAT1, {
    status: "Discharging",
    energy_now: 13000000,
    power_now: 9941000,
    capacity: 50,
    ...overrides,
  });
}

describe("service health", () => {
  test("reports healthy services, and names the failing one otherwise", () => {
    withStatus((f) => {
      singleBattery(f);
      writeState(f.state);
      assert.match(status(f).stdout, /Services: healthy/);
      const down = status(f, {
        BATTERY_INTELLIGENCE_SYSTEMCTL_COMMAND: "/bin/false",
      });
      assert.match(down.stdout, /Services: tracker inactive · monitor inactive/);
      assert.match(down.stdout, /Action: run make install/);
    });
  });
});

describe("per-battery reporting", () => {
  test("names each battery before any of its metrics", () => {
    // Given two installed batteries
    // When the report is rendered
    // Then each block opens with who the cell is, because a metric means
    // little until you know which cell produced it
    withStatus((f) => {
      installBattery(f.root, BAT0, {
        status: "Not charging",
        energy_now: 8000000,
        capacity: 66,
      });
      singleBattery(f);
      writeState(f.state);

      const result = status(f);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /BAT0: LGC 01AV420 · SN 1020/);
      assert.match(result.stdout, /BAT1: SMP 01AV425 · SN 783/);
      // Health and energy follow the identity, not precede it.
      const bat0Line = result.stdout.indexOf("BAT0: LGC");
      // Health is wear against design capacity, not the charge level.
      const bat0Health = result.stdout.indexOf("health 50%");
      assert.ok(bat0Line >= 0 && bat0Health > bat0Line);
    });
  });

  test("reports a model per battery, from that battery's own evidence", () => {
    withStatus((f) => {
      installBattery(f.root, BAT0, {
        status: "Not charging",
        energy_now: 8000000,
      });
      singleBattery(f);
      writeState(f.state);
      writeHistory(f.state, windowsFor(KEY_BAT1, { count: 12, drawMw: 10000 }));

      const result = status(f);
      // BAT1 has evidence; BAT0 has none of its own and must say so.
      assert.match(result.stdout, /Model\s+ready · 12 windows \/ 3 sessions/);
      assert.match(result.stdout, /Model\s+learning · 0\/12 windows · 0\/3 sessions/);
      assert.match(result.stdout, /From this level\s+3h 4?\d?m|From this level\s+\dh/);
    });
  });

  test("shows the estimator a battery projects with and its held-out cost", () => {
    withStatus((f) => {
      singleBattery(f);
      writeState(f.state);
      writeHistory(f.state, windowsFor(KEY_BAT1, { count: 12, drawMw: 10000 }));
      writeEstimators(f.state, [
        { key: KEY_BAT1, estimator: "recent", meanError: 400 },
      ]);
      assert.match(status(f).stdout, /Typical draw\s+10\.0 W · recent \(±0\.4 W held-out\)/);
    });
  });

  test("attributes the open sampling window to the discharging battery", () => {
    // Given one battery discharging and another idle
    // When a sampling window is open
    // Then its progress is reported under the battery being measured
    withStatus((f) => {
      installBattery(f.root, BAT0, {
        status: "Not charging",
        energy_now: 8000000,
      });
      singleBattery(f);
      writeState(f.state, { window_start_epoch: 19999550 });

      const lines = status(f).stdout.split("\n");
      const bat1Index = lines.findIndex((line) => line.includes("BAT1:"));
      const sampleIndex = lines.findIndex((line) => line.includes("Current sample"));
      assert.ok(sampleIndex > bat1Index, "sample must sit under BAT1");
      const bat0Index = lines.findIndex((line) => line.includes("BAT0:"));
      assert.ok(bat0Index < bat1Index, "BAT0 block comes first and has no sample");
      assert.equal(
        lines.filter((line) => line.includes("Current sample")).length,
        1,
      );
    });
  });

  test("marks a battery held only when it reached its own cap", () => {
    withStatus((f) => {
      singleBattery(f, {
        status: "Not charging",
        capacity: 95,
        charge_control_end_threshold: 90,
      });
      writeMains(f.root, 1);
      writeState(f.state, { previous_state: "on-charge" });
      assert.match(status(f).stdout, /held at 90%/);
      assert.match(status(f).stdout, /Power: plugged in · charge held/);
    });
  });

  test("does not call an idle battery held when it is below its cap", () => {
    withStatus((f) => {
      singleBattery(f, {
        status: "Not charging",
        capacity: 70,
        charge_control_end_threshold: 90,
      });
      writeMains(f.root, 1);
      writeState(f.state, { previous_state: "on-charge" });
      const result = status(f);
      assert.doesNotMatch(result.stdout, /charge held/);
      assert.doesNotMatch(result.stdout, /held at/);
    });
  });
});

describe("batteries that are not installed", () => {
  test("names a swapped-out battery, and models only the installed one", () => {
    withStatus((f) => {
      singleBattery(f);
      writeState(f.state);
      writeHistory(f.state, [
        ...windowsFor(KEY_RETIRED, { count: 9, drawMw: 3000, start: 19990000 }),
        ...windowsFor(KEY_BAT1, { count: 12, drawMw: 10000, start: 19991000 }),
      ]);

      const result = status(f);
      assert.match(result.stdout, /Not installed: BAT1 SMP DEADCELL 999 · 9 window\(s\)/);
      // The retired cell's windows never reach the installed battery's model.
      assert.match(result.stdout, /Model\s+ready · 12 windows/);
      assert.match(result.stdout, /Typical draw\s+10\.0 W/);
    });
  });

  test("says nothing about absent batteries when there are none", () => {
    withStatus((f) => {
      singleBattery(f);
      writeState(f.state);
      writeHistory(f.state, windowsFor(KEY_BAT1, { count: 6 }));
      assert.doesNotMatch(status(f).stdout, /Not installed/);
    });
  });
});

describe("pack summary and lifecycle", () => {
  test("summarises the pack once every battery is ready", () => {
    withStatus((f) => {
      singleBattery(f);
      writeState(f.state);
      writeHistory(f.state, windowsFor(KEY_BAT1, { count: 12, drawMw: 10000 }));
      const result = status(f);
      assert.match(result.stdout, /Pack model: ready/);
      assert.match(result.stdout, /Pack remaining: 1h 18m/);
      assert.match(result.stdout, /At full: 2h 36m/);
    });
  });

  test("uses charging-specific labels when plugged in", () => {
    withStatus((f) => {
      singleBattery(f, { status: "Charging" });
      writeMains(f.root, 1);
      writeState(f.state, { previous_state: "on-charge", window_start_epoch: 0 });
      writeHistory(f.state, windowsFor(KEY_BAT1, { count: 12, drawMw: 10000 }));
      const result = status(f);
      assert.match(result.stdout, /Power: charging/);
      assert.match(result.stdout, /If unplugged now: 1h 18m/);
      assert.doesNotMatch(result.stdout, /Pack remaining:/);
    });
  });

  test("reports learning while no battery has its own evidence", () => {
    withStatus((f) => {
      singleBattery(f);
      writeState(f.state);
      assert.match(
        status(f).stdout,
        /Pack model: learning · no battery has enough of its own evidence yet/,
      );
    });
  });

  test("waits rather than guessing before the tracker has ever run", () => {
    withStatus((f) => {
      singleBattery(f);
      const result = status(f);
      assert.equal(result.status, 0);
      assert.match(result.stdout, /Model: waiting for first tracker poll/);
      assert.doesNotMatch(result.stdout, /Energy:/);
    });
  });

  test("suppresses runtime when no battery is present at all", () => {
    withStatus((f) => {
      writeState(f.state);
      const result = status(f);
      assert.match(result.stdout, /Battery: not detected/);
      assert.match(result.stdout, /Model: unavailable · no present battery/);
      assert.doesNotMatch(result.stdout, /Pack remaining/);
    });
  });

  test("rejects an unsupported history schema visibly", () => {
    withStatus((f) => {
      singleBattery(f);
      writeState(f.state);
      writeHistory(f.state, [], "# battery-discharge-history\tv99");
      assert.match(
        status(f).stdout,
        /Pack model: unavailable · unsupported history format/,
      );
    });
  });

  test("names pack-level rows from an older schema as unusable", () => {
    withStatus((f) => {
      singleBattery(f);
      writeState(f.state);
      writeHistory(
        f.state,
        ["19990000\ts0\t9000\t26000000"],
        "# battery-discharge-history\tv2",
      );
      assert.match(status(f).stdout, /Legacy rows: 1 pack-level row\(s\)/);
    });
  });
});

describe("freshness and diagnostics", () => {
  test("marks estimates cached when the tracker has gone quiet", () => {
    withStatus((f) => {
      singleBattery(f);
      writeState(f.state, { last_observed: 19990000 });
      writeHistory(f.state, windowsFor(KEY_BAT1, { count: 12, drawMw: 10000 }));
      const result = status(f);
      assert.match(result.stdout, /Pack remaining \(cached\)/);
      assert.match(result.stdout, /Data: stale · tracker updated/);
    });
  });

  test("reports a clock that has moved backwards", () => {
    withStatus((f) => {
      singleBattery(f);
      writeState(f.state, { last_observed: NOW + 500 });
      writeHistory(f.state, windowsFor(KEY_BAT1, { count: 12, drawMw: 10000 }));
      assert.match(status(f).stdout, /Data: clock mismatch/);
    });
  });

  test("explains a sampling restart in words, not a reason code", () => {
    withStatus((f) => {
      singleBattery(f);
      writeState(f.state, { window_reset_reason: "battery-baseline-missing" });
      assert.match(
        status(f).stdout,
        /Sampling: restarted · per-battery baseline missing after upgrade/,
      );
    });
  });

  test("keeps collection diagnostics behind the verbose flag", () => {
    withStatus((f) => {
      singleBattery(f);
      writeState(f.state);
      writeHistory(f.state, windowsFor(KEY_BAT1, { count: 12 }));
      const concise = status(f);
      const verbose = status(f, { BATTERY_STATUS_VERBOSE: "1" });
      assert.doesNotMatch(concise.stdout, /State file:/);
      assert.match(verbose.stdout, /State file:/);
      assert.match(verbose.stdout, /Battery set key: BAT1:SMP:01AV425:783/);
    });
  });

  test("uses ANSI colour only when asked", () => {
    withStatus((f) => {
      singleBattery(f);
      writeState(f.state);
      const colored = status(f, { BATTERY_STATUS_COLOR: "always", NO_COLOR: "" });
      const plain = status(f, { BATTERY_STATUS_COLOR: "never" });
      assert.ok(colored.stdout.includes(`${ansi}[36m`));
      assert.equal(plain.stdout.includes(ansi), false);
    });
  });

  test("rejects an invalid verbosity rather than guessing", () => {
    withStatus((f) => {
      singleBattery(f);
      const result = status(f, { BATTERY_STATUS_VERBOSE: "yes" });
      assert.equal(result.status, 2);
      assert.match(result.stderr, /Invalid BATTERY_STATUS_VERBOSE/);
    });
  });
});

describe("make status", () => {
  test("renders the concise report and never the raw state", () => {
    withFixture({ root: "combined-status" }, (f) => {
      const stateDir = path.join(f.root, "battery-session");
      const bin = path.join(f.root, "bin");
      fs.mkdirSync(stateDir);
      fs.mkdirSync(bin);
      writeState(stateDir);
      fs.writeFileSync(path.join(bin, "systemctl"), "#!/bin/sh\nexit 0\n", {
        mode: 0o700,
      });
      const env = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        XDG_STATE_HOME: f.root,
        BATTERY_INTELLIGENCE_NOW: String(NOW),
        BATTERY_INTELLIGENCE_SYSTEMCTL_COMMAND: path.join(bin, "systemctl"),
        BATTERY_STATUS_POWER_SUPPLY_ROOT: path.join(f.root, "not-inspected"),
        BATTERY_VIEW_PROFILES_COMMAND: "/nonexistent/powerprofiles",
      };
      const result = spawnSync("make", ["--no-print-directory", "status"], {
        cwd: repository,
        env: { ...env, NO_COLOR: "1" },
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /^BATTERY STATUS/m);
      assert.equal(result.stdout.includes("previous_state"), false);
      assert.equal(result.stdout.includes("State file:"), false);
    });
  });
});
