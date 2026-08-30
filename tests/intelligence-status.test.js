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

function writeState(stateDir, fields = {}) {
  const defaults = {
    previous_state: "on-battery",
    state_since: 19999000,
    last_observed: 19999990,
    battery_energy_now_uwh: 40000000,
    battery_usable_capacity_uwh: 50000000,
    usual_remaining_runtime_seconds: 14400,
    usual_full_runtime_seconds: 18000,
    usual_sample_count: 12,
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
// and the sysfs energy/power files the per-battery summary reads.
function writeBatteries(stateDir, batteries) {
  const powerRoot = path.join(stateDir, "power-supply");
  fs.mkdirSync(powerRoot, { recursive: true });
  batteries.forEach((entry, index) => {
    const spec = typeof entry === "string" ? { status: entry } : entry;
    const battery = path.join(powerRoot, spec.name || `BAT${index}`);
    fs.mkdirSync(battery);
    fs.writeFileSync(path.join(battery, "present"), "1\n");
    fs.writeFileSync(path.join(battery, "status"), `${spec.status}\n`);
    const optional = {
      energy_full: spec.energyFull,
      energy_full_design: spec.energyFullDesign,
      power_now: spec.powerNow,
    };
    Object.entries(optional).forEach(([file, value]) => {
      if (value !== undefined) {
        fs.writeFileSync(path.join(battery, file), `${value}\n`);
      }
    });
  });
  return powerRoot;
}

function runStatus(stateDir, extraEnv = {}) {
  return spawnSync(statusScript, [], {
    env: {
      ...process.env,
      BATTERY_SESSION_STATE_DIR: stateDir,
      BATTERY_INTELLIGENCE_NOW: "20000000",
      BATTERY_INTELLIGENCE_SYSTEMCTL_COMMAND: "/bin/true",
      BATTERY_STATUS_POWER_SUPPLY_ROOT: path.join(stateDir, "not-inspected"),
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

    const result = runStatus(stateDir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Services: healthy/);
    assert.match(result.stdout, /Power: on battery · 17m/);
    assert.match(result.stdout, /Energy: 40\.0 Wh \/ 50\.0 Wh · 80%/);
    assert.match(
      result.stdout,
      /Model: ready · 12 windows \/ 3 sessions · learned 17m ago/,
    );
    assert.match(result.stdout, /Usual remaining: 4h/);
    assert.match(result.stdout, /At full: 5h/);
    assert.match(result.stdout, /Typical draw: 10\.6 W/);
    assert.doesNotMatch(result.stdout, /Current sample/);
    assert.match(result.stdout, /Updated: 10s ago/);
  });
});

test("derives remaining runtime from legacy tracker state", () => {
  withFixture("status-legacy", (stateDir) => {
    writeState(stateDir, {
      battery_energy_now_uwh: "",
      battery_usable_capacity_uwh: "",
      usual_remaining_runtime_seconds: "",
      last_sample_energy_uwh: 40000000,
    });
    writeHistory(stateDir, { draw: 10000 });

    const result = runStatus(stateDir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Model: ready/);
    assert.match(result.stdout, /Usual remaining: 4h/);
    assert.doesNotMatch(result.stdout, /learning/);
  });
});

test("reports learning progress and active sampling on battery", () => {
  withFixture("status-learning-battery", (stateDir) => {
    writeState(stateDir, {
      usual_remaining_runtime_seconds: 0,
      usual_full_runtime_seconds: 0,
    });
    writeHistory(stateDir, { count: 4, sessions: 1 });

    const result = runStatus(stateDir);
    assert.match(
      result.stdout,
      /Model: learning · 4\/12 windows · 1\/3 sessions/,
    );
    assert.match(result.stdout, /Current sample: 50% · 8m of 15m/);
  });
});

test("reports learning while charging without a discharge sample", () => {
  withFixture("status-learning-charge", (stateDir) => {
    writeState(stateDir, {
      previous_state: "on-charge",
      usual_remaining_runtime_seconds: 0,
      usual_full_runtime_seconds: 0,
      window_start_epoch: 0,
    });
    const powerRoot = writeBatteries(stateDir, ["Charging"]);

    const result = runStatus(stateDir, {
      BATTERY_STATUS_POWER_SUPPLY_ROOT: powerRoot,
    });
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
    const powerRoot = writeBatteries(stateDir, ["Charging"]);

    const result = runStatus(stateDir, {
      BATTERY_STATUS_POWER_SUPPLY_ROOT: powerRoot,
    });
    assert.match(result.stdout, /Power: charging/);
    assert.match(result.stdout, /If unplugged now: 4h/);
    assert.match(result.stdout, /At full: 5h/);
    assert.doesNotMatch(result.stdout, /Usual remaining:/);
  });
});

test("collapses duplicate runtime at full charge", () => {
  withFixture("status-full", (stateDir) => {
    writeState(stateDir, {
      previous_state: "on-charge",
      battery_energy_now_uwh: 50000000,
      usual_remaining_runtime_seconds: 18000,
      window_start_epoch: 0,
    });
    writeHistory(stateDir);
    const powerRoot = writeBatteries(stateDir, ["Full"]);

    const result = runStatus(stateDir, {
      BATTERY_STATUS_POWER_SUPPLY_ROOT: powerRoot,
    });
    assert.match(result.stdout, /Power: full/);
    assert.match(result.stdout, /Usual runtime: 5h · battery full/);
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
    const powerRoot = writeBatteries(stateDir, ["Not charging"]);

    const result = runStatus(stateDir, {
      BATTERY_STATUS_POWER_SUPPLY_ROOT: powerRoot,
    });
    assert.match(result.stdout, /Power: plugged in · charge held/);
    assert.match(result.stdout, /If unplugged now: 4h/);
  });
});

test("distinguishes blocked evidence from learning", () => {
  withFixture("status-blocked", (stateDir) => {
    writeState(stateDir, {
      battery_energy_now_uwh: 0,
      last_sample_energy_uwh: 0,
      usual_remaining_runtime_seconds: 0,
    });
    writeHistory(stateDir);

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

    const result = runStatus(stateDir);
    assert.match(result.stdout, /Usual remaining \(cached\): 4h/);
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

    const result = runStatus(stateDir, {
      BATTERY_INTELLIGENCE_SYSTEMCTL_COMMAND: "/bin/false",
    });
    assert.match(
      result.stdout,
      /Services: tracker inactive · monitor inactive/,
    );
    assert.match(result.stdout, /Usual remaining \(cached\): 4h/);
    assert.match(result.stdout, /Action: run make install/);
  });
});

test("reports a clock mismatch without presenting live estimates", () => {
  withFixture("status-clock", (stateDir) => {
    writeState(stateDir, { last_observed: 20000100 });
    writeHistory(stateDir);

    const result = runStatus(stateDir);
    assert.match(result.stdout, /Usual remaining \(cached\): 4h/);
    assert.match(result.stdout, /Data: clock mismatch · estimates are cached/);
  });
});

test("rejects an unsupported history schema visibly", () => {
  withFixture("status-schema", (stateDir) => {
    writeState(stateDir);
    fs.writeFileSync(
      path.join(stateDir, "discharge-history.tsv"),
      "# battery-discharge-history\tv2\n",
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
    const powerRoot = path.join(stateDir, "power-supply");
    fs.mkdirSync(powerRoot);

    const result = runStatus(stateDir, {
      BATTERY_STATUS_POWER_SUPPLY_ROOT: powerRoot,
    });
    assert.match(result.stdout, /Battery: not detected/);
    assert.match(result.stdout, /Model: unavailable · no present battery/);
    assert.doesNotMatch(result.stdout, /Usual remaining/);
  });
});

test("ignores and reports future-dated history", () => {
  withFixture("status-future-history", (stateDir) => {
    writeState(stateDir, {
      usual_remaining_runtime_seconds: 0,
      usual_full_runtime_seconds: 0,
    });
    writeHistory(stateDir, { count: 11, sessions: 3, future: 1 });

    const result = runStatus(stateDir);
    assert.match(
      result.stdout,
      /Model: learning · 11\/12 windows · 3\/3 sessions/,
    );
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

    const result = runStatus(stateDir);
    assert.match(result.stdout, /History: 12 recent · 2 archived/);
    assert.match(result.stdout, /Sampling: restarted · battery set changed/);
  });
});

test("verbose mode exposes collection diagnostics only on request", () => {
  withFixture("status-verbose", (stateDir) => {
    writeState(stateDir);
    writeHistory(stateDir);

    const concise = runStatus(stateDir);
    const verbose = runStatus(stateDir, { BATTERY_STATUS_VERBOSE: "1" });
    assert.doesNotMatch(concise.stdout, /State file:/);
    assert.doesNotMatch(concise.stdout, /Battery set:/);
    assert.match(verbose.stdout, /State file:/);
    assert.match(verbose.stdout, /History detail: 12 retained/);
    assert.match(verbose.stdout, /Last learned:/);
    assert.match(verbose.stdout, /Battery set: BAT0:energy:50000000/);
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
    writeState(stateDir, {
      battery_energy_now_uwh: 0,
      battery_usable_capacity_uwh: 0,
      usual_remaining_runtime_seconds: 0,
      usual_full_runtime_seconds: 0,
    });
    fs.writeFileSync(path.join(bin, "systemctl"), "#!/bin/sh\nexit 0\n", {
      mode: 0o700,
    });
    const statusEnv = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      XDG_STATE_HOME: root,
      BATTERY_INTELLIGENCE_NOW: "20000000",
      BATTERY_INTELLIGENCE_SYSTEMCTL_COMMAND: path.join(bin, "systemctl"),
      BATTERY_STATUS_POWER_SUPPLY_ROOT: path.join(root, "not-inspected"),
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
    const powerRoot = writeBatteries(stateDir, [
      {
        name: "BAT1",
        status: "Discharging",
        energyFull: 45000000,
        energyFullDesign: 50000000,
        powerNow: 10000000,
      },
      {
        name: "BAT2",
        status: "Charging",
        energyFull: 20000000,
        energyFullDesign: 25000000,
        powerNow: 5000000,
      },
    ]);

    const result = runStatus(stateDir, {
      BATTERY_STATUS_POWER_SUPPLY_ROOT: powerRoot,
    });
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
    const powerRoot = writeBatteries(stateDir, [
      { status: "Discharging", energyFull: 45000000, powerNow: 10000000 },
    ]);

    const result = runStatus(stateDir, {
      BATTERY_STATUS_POWER_SUPPLY_ROOT: powerRoot,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /BAT0: health N\/A · 45\.0 Wh/);
    assert.doesNotMatch(result.stdout, /BAT1:/);
  });
});
