const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { withFixture: withDir } = require("./support/fixture");

const statusScript = path.join(
  __dirname,
  "..",
  "scripts",
  "battery-intelligence-status.sh",
);
const repository = path.join(__dirname, "..");
const ansi = String.fromCharCode(27);

const NOW = 20000000;

// The tracker state file after the v2 schema change: session and sampling
// facts only. Energy and every runtime estimate are derived by the view from
// live sysfs and the discharge history, so they are no longer stored here.
function writeState(stateDir, fields = {}) {
  const defaults = {
    state_schema_version: 2,
    previous_state: "on-battery",
    state_since: 19999000,
    state_since_at_least: 0,
    last_observed: 19999990,
    discharge_session_id: 19999000,
    window_start_epoch: 19999550,
    window_start_energy_uwh: 40000000,
    last_sample_energy_uwh: 39900000,
    window_reset_reason: "''",
    battery_fingerprint: "BAT0:energy:50000000",
  };
  const values = { ...defaults, ...fields };
  fs.writeFileSync(
    path.join(stateDir, "state"),
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n") + "\n",
  );
}

function writeHistory(
  stateDir,
  {
    count = 12,
    sessions = 3,
    draw = 10000,
    capacity = 50000000,
    old = 0,
    future = 0,
  } = {},
) {
  const rows = ["# battery-discharge-history\tv1"];
  for (let index = 0; index < old; index += 1) {
    rows.push(`${1000 + index}\told-${index}\t${draw}\t${capacity}`);
  }
  for (let index = 0; index < count; index += 1) {
    rows.push(
      `${19999000 + index}\tsession-${index % sessions}\t${
        draw + index * 100
      }\t${capacity}`,
    );
  }
  for (let index = 0; index < future; index += 1) {
    rows.push(`${20000100 + index}\tfuture-${index}\t${draw}\t${capacity}`);
  }
  fs.writeFileSync(
    path.join(stateDir, "discharge-history.tsv"),
    rows.join("\n") + "\n",
  );
}

// Each entry is a status string, or an object that also sets the battery name
// and the sysfs files the view reads. `acOnline` adds a Mains supply, which is
// how the view decides the machine is plugged in.
function writeBatteries(stateDir, batteries, { acOnline = false } = {}) {
  const powerRoot = path.join(stateDir, "power-supply");
  fs.mkdirSync(powerRoot, { recursive: true });
  batteries.forEach((entry, index) => {
    const spec = typeof entry === "string" ? { status: entry } : entry;
    const battery = path.join(powerRoot, spec.name || `BAT${index}`);
    fs.mkdirSync(battery, { recursive: true });
    fs.writeFileSync(path.join(battery, "present"), "1\n");
    fs.writeFileSync(path.join(battery, "status"), `${spec.status}\n`);
    const optional = {
      energy_now: spec.energyNow,
      energy_full: spec.energyFull,
      energy_full_design: spec.energyFullDesign,
      power_now: spec.powerNow,
      capacity: spec.percent,
      manufacturer: spec.manufacturer,
      model_name: spec.modelName,
      serial_number: spec.serial,
      charge_control_end_threshold: spec.endThreshold,
    };
    Object.entries(optional).forEach(([file, value]) => {
      if (value !== undefined) {
        fs.writeFileSync(path.join(battery, file), `${value}\n`);
      }
    });
  });
  if (acOnline) {
    const mains = path.join(powerRoot, "AC");
    fs.mkdirSync(mains, { recursive: true });
    fs.writeFileSync(path.join(mains, "type"), "Mains\n");
    fs.writeFileSync(path.join(mains, "online"), "1\n");
  }
  return powerRoot;
}

// The default machine: one 50 Wh battery holding 40 Wh, on battery.
function writeDefaultBattery(stateDir, overrides = {}, options = {}) {
  return writeBatteries(
    stateDir,
    [
      {
        status: "Discharging",
        energyNow: 40000000,
        energyFull: 50000000,
        ...overrides,
      },
    ],
    options,
  );
}

function runStatus(stateDir, extraEnv = {}) {
  return spawnSync(statusScript, [], {
    env: {
      ...process.env,
      BATTERY_SESSION_STATE_DIR: stateDir,
      BATTERY_INTELLIGENCE_NOW: String(NOW),
      BATTERY_INTELLIGENCE_SYSTEMCTL_COMMAND: "/bin/true",
      BATTERY_STATUS_POWER_SUPPLY_ROOT: path.join(stateDir, "power-supply"),
      BATTERY_VIEW_PROFILES_COMMAND: "/nonexistent/powerprofiles",
      ...extraEnv,
    },
    encoding: "utf8",
  });
}

function withFixture(name, callback) {
  return withDir({ stateDir: name }, (f) => callback(f.stateDir));
}

test("reports a ready discharging model", () => {
  withFixture("status-ready", (stateDir) => {
    writeState(stateDir);
    writeHistory(stateDir);
    writeDefaultBattery(stateDir);

    const result = runStatus(stateDir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Services: healthy/);
    assert.match(result.stdout, /Power: on battery · 17m/);
    assert.match(result.stdout, /Energy: 40\.0 Wh \/ 50\.0 Wh · 80%/);
    assert.match(
      result.stdout,
      /Model: ready · 12 windows \/ 3 sessions · learned 17m ago/,
    );
    // 40 Wh at the 10.55 W median.
    assert.match(result.stdout, /Usual remaining: 3h 48m/);
    assert.match(result.stdout, /At full: 4h 45m/);
    assert.match(result.stdout, /Typical draw: 10\.6 W/);
    assert.doesNotMatch(result.stdout, /Current sample/);
    assert.match(result.stdout, /Updated: 10s ago/);
  });
});

test("estimates come from live sysfs, not a stored copy", () => {
  withFixture("status-live-energy", (stateDir) => {
    writeState(stateDir);
    writeHistory(stateDir);
    // Half the stored energy of the default fixture: the reported runtime has
    // to halve with it, which it cannot do if anything is reading a cached
    // estimate off the state file.
    writeDefaultBattery(stateDir, { energyNow: 20000000 });

    const result = runStatus(stateDir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Energy: 20\.0 Wh \/ 50\.0 Wh · 40%/);
    assert.match(result.stdout, /Usual remaining: 1h 54m/);
    assert.match(result.stdout, /At full: 4h 45m/);
  });
});

test("reports a p25-p75 range and a right-now estimate", () => {
  withFixture("status-range", (stateDir) => {
    writeState(stateDir);
    writeHistory(stateDir);
    writeDefaultBattery(stateDir);

    const result = runStatus(stateDir);
    assert.match(result.stdout, /Range: 3h \d+m – 3h \d+m · p25–p75/);
    assert.match(result.stdout, /Right now: .* over the last 4 windows/);
  });
});

test("reports learning progress and active sampling on battery", () => {
  withFixture("status-learning-battery", (stateDir) => {
    writeState(stateDir);
    writeHistory(stateDir, { count: 3, sessions: 1 });
    writeDefaultBattery(stateDir);

    const result = runStatus(stateDir);
    assert.match(
      result.stdout,
      /Model: learning · 3\/12 windows · 1\/3 sessions/,
    );
    assert.match(result.stdout, /Current sample: 50% · 8m of 15m/);
  });
});

test("offers a provisional estimate before the full gate is met", () => {
  withFixture("status-provisional", (stateDir) => {
    writeState(stateDir);
    writeHistory(stateDir, { count: 5, sessions: 1 });
    writeDefaultBattery(stateDir);

    const result = runStatus(stateDir);
    assert.match(result.stdout, /Model: provisional · 5 windows \/ 1 sessions/);
    assert.match(result.stdout, /Confidence: low · needs 5\/12 windows/);
    assert.match(result.stdout, /Usual remaining: /);
    assert.doesNotMatch(result.stdout, /Model: learning/);
  });
});

test("reports learning while charging without a discharge sample", () => {
  withFixture("status-learning-charge", (stateDir) => {
    writeState(stateDir, {
      previous_state: "on-charge",
      window_start_epoch: 0,
    });
    writeDefaultBattery(stateDir, { status: "Charging" }, { acOnline: true });

    const result = runStatus(stateDir);
    assert.match(result.stdout, /Power: charging/);
    assert.match(
      result.stdout,
      /Model: learning · 0\/12 windows · 0\/3 sessions/,
    );
    assert.doesNotMatch(result.stdout, /Current sample/);
  });
});

test("uses charging-specific runtime labels", () => {
  withFixture("status-ready-charge", (stateDir) => {
    writeState(stateDir, {
      previous_state: "on-charge",
      window_start_epoch: 0,
    });
    writeHistory(stateDir);
    writeDefaultBattery(stateDir, { status: "Charging" }, { acOnline: true });

    const result = runStatus(stateDir);
    assert.match(result.stdout, /Power: charging/);
    assert.match(result.stdout, /If unplugged now: 3h 48m/);
    assert.match(result.stdout, /At full: 4h 45m/);
    assert.doesNotMatch(result.stdout, /Usual remaining:/);
  });
});

test("collapses duplicate runtime at full charge", () => {
  withFixture("status-full", (stateDir) => {
    writeState(stateDir, {
      previous_state: "on-charge",
      window_start_epoch: 0,
    });
    writeHistory(stateDir);
    writeDefaultBattery(
      stateDir,
      { status: "Full", energyNow: 50000000 },
      { acOnline: true },
    );

    const result = runStatus(stateDir);
    assert.match(result.stdout, /Power: full/);
    assert.match(result.stdout, /Usual runtime: 4h 45m · battery full/);
    assert.doesNotMatch(result.stdout, /At full:/);
    assert.doesNotMatch(result.stdout, /If unplugged now:/);
  });
});

test("reports a charge-threshold hold", () => {
  withFixture("status-held", (stateDir) => {
    writeState(stateDir, {
      previous_state: "on-charge",
      window_start_epoch: 0,
    });
    writeHistory(stateDir);
    writeDefaultBattery(
      stateDir,
      { status: "Not charging", percent: 90, endThreshold: 90 },
      { acOnline: true },
    );

    const result = runStatus(stateDir);
    assert.match(result.stdout, /Power: plugged in · charge held/);
    assert.match(result.stdout, /If unplugged now: 3h 48m/);
  });
});

test("does not call an idle battery held when it is below its own cap", () => {
  withFixture("status-not-held", (stateDir) => {
    writeState(stateDir, {
      previous_state: "on-charge",
      window_start_epoch: 0,
    });
    writeHistory(stateDir);
    // Sequential dual-battery charging: "Not charging" at 70% against a 90%
    // cap is waiting its turn, not a threshold hold.
    writeDefaultBattery(
      stateDir,
      { status: "Not charging", percent: 70, endThreshold: 90 },
      { acOnline: true },
    );

    const result = runStatus(stateDir);
    assert.match(result.stdout, /Power: plugged in/);
    assert.doesNotMatch(result.stdout, /charge held/);
  });
});

test("distinguishes blocked evidence from learning", () => {
  withFixture("status-blocked", (stateDir) => {
    writeState(stateDir);
    writeHistory(stateDir);
    // A battery that reports a status but no energy at all.
    writeBatteries(stateDir, [{ status: "Discharging" }]);

    const result = runStatus(stateDir);
    assert.match(result.stdout, /Energy: not available/);
    assert.match(
      result.stdout,
      /Model: blocked · current battery energy unavailable/,
    );
    assert.match(result.stdout, /Evidence: 12 windows \/ 3 sessions/);
    assert.doesNotMatch(result.stdout, /Model: learning/);
  });
});

test("marks stale runtime estimates as cached", () => {
  withFixture("status-stale", (stateDir) => {
    writeState(stateDir, { last_observed: 19999000 });
    writeHistory(stateDir);
    writeDefaultBattery(stateDir);

    const result = runStatus(stateDir);
    assert.match(result.stdout, /Usual remaining \(cached\): 3h 48m/);
    assert.match(
      result.stdout,
      /Data: stale · tracker updated 17m ago; estimates are cached/,
    );
  });
});

test("marks estimates cached when a service is inactive", () => {
  withFixture("status-service-down", (stateDir) => {
    writeState(stateDir);
    writeHistory(stateDir);
    writeDefaultBattery(stateDir);

    const result = runStatus(stateDir, {
      BATTERY_INTELLIGENCE_SYSTEMCTL_COMMAND: "/bin/false",
    });
    assert.match(
      result.stdout,
      /Services: tracker inactive · monitor inactive/,
    );
    assert.match(result.stdout, /Usual remaining \(cached\): 3h 48m/);
    assert.match(result.stdout, /Action: run make install/);
  });
});

test("reports a clock mismatch without presenting live estimates", () => {
  withFixture("status-clock", (stateDir) => {
    writeState(stateDir, { last_observed: 20000100 });
    writeHistory(stateDir);
    writeDefaultBattery(stateDir);

    const result = runStatus(stateDir);
    assert.match(result.stdout, /Usual remaining \(cached\): 3h 48m/);
    assert.match(result.stdout, /Data: clock mismatch · estimates are cached/);
  });
});

test("rejects an unsupported history schema visibly", () => {
  withFixture("status-schema", (stateDir) => {
    writeState(stateDir);
    writeDefaultBattery(stateDir);
    fs.writeFileSync(
      path.join(stateDir, "discharge-history.tsv"),
      "# battery-discharge-history\tv99\n",
    );

    const result = runStatus(stateDir);
    assert.match(
      result.stdout,
      /Model: unavailable · unsupported history format/,
    );
    assert.doesNotMatch(result.stdout, /Model: learning/);
  });
});

test("does not present stale state after the last battery is removed", () => {
  withFixture("status-no-battery", (stateDir) => {
    writeState(stateDir);
    writeHistory(stateDir);
    fs.mkdirSync(path.join(stateDir, "power-supply"));

    const result = runStatus(stateDir);
    assert.match(result.stdout, /Battery: not detected/);
    assert.match(result.stdout, /Model: unavailable · no present battery/);
    assert.doesNotMatch(result.stdout, /Usual remaining/);
  });
});

test("ignores and reports future-dated history", () => {
  withFixture("status-future-history", (stateDir) => {
    writeState(stateDir);
    writeHistory(stateDir, { count: 11, sessions: 3, future: 1 });
    writeDefaultBattery(stateDir);

    const result = runStatus(stateDir);
    assert.match(result.stdout, /Model: provisional · 11 windows/);
    assert.match(
      result.stdout,
      /History warning: 1 future-dated row\(s\) ignored/,
    );
  });
});

test("reports archived history and sampling reset reasons", () => {
  withFixture("status-history", (stateDir) => {
    writeState(stateDir, { window_reset_reason: "battery-set-changed" });
    writeHistory(stateDir, { old: 2 });
    writeDefaultBattery(stateDir);

    const result = runStatus(stateDir);
    assert.match(result.stdout, /History: 12 recent · 2 archived/);
    assert.match(result.stdout, /Sampling: restarted · battery set changed/);
  });
});

test("announces a battery-set change instead of letting it pass unremarked", () => {
  withFixture("status-pack-changed", (stateDir) => {
    writeState(stateDir);
    // Nine windows on a set holding a since-replaced cell, then three on the
    // set installed now. Draw is a machine property, so all twelve still count
    // toward the model - but the swap has to be visible.
    const rows = ["# battery-discharge-history\tv2"];
    const oldPack = "BAT0:LGC:01AV420:1020,BAT1:SMP:DEADCELL:999";
    const newPack = "BAT0:LGC:01AV420:1020";
    for (let index = 0; index < 9; index += 1) {
      rows.push(
        `${19999000 + index}\told-${index % 3}\t10000\t15000000\t${oldPack}`,
      );
    }
    for (let index = 0; index < 3; index += 1) {
      rows.push(
        `${19999100 + index}\tnew-${index}\t10000\t50000000\t${newPack}`,
      );
    }
    fs.writeFileSync(
      path.join(stateDir, "discharge-history.tsv"),
      rows.join("\n") + "\n",
    );
    writeBatteries(stateDir, [
      {
        status: "Discharging",
        energyNow: 40000000,
        energyFull: 50000000,
        manufacturer: "LGC",
        modelName: "01AV420",
        serial: " 1020",
      },
    ]);

    const result = runStatus(stateDir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /Battery set: changed · 9 of 12 windows were measured on a previous set/,
    );
    // The swap must not quietly reset learning: draw evidence is machine-wide.
    assert.match(result.stdout, /Model: ready · 12 windows/);
  });
});

test("flags version-1 rows as unattributed rather than assigning them a set", () => {
  withFixture("status-unattributed", (stateDir) => {
    writeState(stateDir);
    writeHistory(stateDir);
    writeDefaultBattery(stateDir);

    const result = runStatus(stateDir);
    assert.match(
      result.stdout,
      /Unattributed: 12 window\(s\) recorded before battery identity was tracked/,
    );
    assert.doesNotMatch(result.stdout, /Battery set: changed/);
  });
});

test("verbose mode exposes collection diagnostics only on request", () => {
  withFixture("status-verbose", (stateDir) => {
    writeState(stateDir);
    writeHistory(stateDir);
    writeDefaultBattery(stateDir);

    const concise = runStatus(stateDir);
    const verbose = runStatus(stateDir, { BATTERY_STATUS_VERBOSE: "1" });
    assert.doesNotMatch(concise.stdout, /State file:/);
    assert.doesNotMatch(concise.stdout, /Battery set:/);
    assert.match(verbose.stdout, /State file:/);
    assert.match(verbose.stdout, /View schema: battery-view v1 · state v2/);
    assert.match(verbose.stdout, /History detail: 12 retained/);
    assert.match(verbose.stdout, /Last learned:/);
    assert.match(verbose.stdout, /Battery fingerprint: BAT0:energy:50000000/);
  });
});

test("uses ANSI colors only when requested", () => {
  withFixture("status-color", (stateDir) => {
    const colored = runStatus(stateDir, { BATTERY_STATUS_COLOR: "always" });
    const plain = runStatus(stateDir, { BATTERY_STATUS_COLOR: "never" });
    assert.equal(colored.status, 0, colored.stderr);
    assert.equal(colored.stdout.includes(`${ansi}[36m`), true);
    assert.equal(colored.stdout.includes(`${ansi}[33m`), true);
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(plain.stdout.includes(ansi), false);
  });
});

test("make status renders only the concise human-facing report", () => {
  withDir({ root: "combined-status" }, (f) => {
    const root = f.root;
    const stateDir = path.join(root, "battery-session");
    const bin = path.join(root, "bin");
    fs.mkdirSync(stateDir);
    fs.mkdirSync(bin);
    writeState(stateDir);
    fs.writeFileSync(path.join(bin, "systemctl"), "#!/bin/sh\nexit 0\n", {
      mode: 0o700,
    });
    const statusEnv = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      XDG_STATE_HOME: root,
      BATTERY_INTELLIGENCE_NOW: String(NOW),
      BATTERY_INTELLIGENCE_SYSTEMCTL_COMMAND: path.join(bin, "systemctl"),
      BATTERY_STATUS_POWER_SUPPLY_ROOT: path.join(root, "not-inspected"),
      BATTERY_VIEW_PROFILES_COMMAND: "/nonexistent/powerprofiles",
    };
    const result = spawnSync("make", ["--no-print-directory", "status"], {
      cwd: repository,
      env: { ...statusEnv, NO_COLOR: "1" },
      encoding: "utf8",
    });
    const verbose = spawnSync(
      "make",
      ["--no-print-directory", "status", "VERBOSE=1"],
      { cwd: repository, env: statusEnv, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^BATTERY STATUS/m);
    assert.match(result.stdout, /Services: healthy/);
    assert.equal(result.stdout.includes("previous_state"), false);
    assert.equal(result.stdout.includes("State file:"), false);
    assert.match(verbose.stdout, /State file:/);
  });
});

test("reports waiting state before any observations", () => {
  withFixture("status-empty", (stateDir) => {
    writeDefaultBattery(stateDir);
    const result = runStatus(stateDir);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Model: waiting for first tracker poll/);
    assert.match(result.stdout, /Learning: 0\/12 windows · 0\/3 sessions/);
    assert.equal(result.stdout.includes("Energy:"), false);
  });
});

test("reports one summary line per present battery, whatever it is named", () => {
  withFixture("status-per-battery", (stateDir) => {
    writeState(stateDir);
    writeHistory(stateDir);
    writeBatteries(stateDir, [
      {
        name: "BAT1",
        status: "Discharging",
        energyNow: 40000000,
        energyFull: 45000000,
        energyFullDesign: 50000000,
        powerNow: 10000000,
      },
      {
        name: "BAT2",
        status: "Charging",
        energyNow: 15000000,
        energyFull: 20000000,
        energyFullDesign: 25000000,
        powerNow: 5000000,
      },
    ]);

    const result = runStatus(stateDir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /BAT1: health 90% · 45\.0 Wh · Discharging · draw 10\.0 W/,
    );
    assert.match(
      result.stdout,
      /BAT2: health 80% · 20\.0 Wh · Charging · charging power 5\.0 W/,
    );
    assert.doesNotMatch(result.stdout, /BAT0:/);
  });
});

test("a single battery produces no phantom second summary line", () => {
  withFixture("status-one-battery", (stateDir) => {
    writeState(stateDir);
    writeHistory(stateDir);
    writeBatteries(stateDir, [
      {
        status: "Discharging",
        energyNow: 40000000,
        energyFull: 45000000,
        powerNow: 10000000,
      },
    ]);

    const result = runStatus(stateDir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /BAT0: health N\/A · 45\.0 Wh/);
    assert.doesNotMatch(result.stdout, /BAT1:/);
  });
});
