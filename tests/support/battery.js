// Shared fixture builders for battery tests.
//
// Every suite here drives real scripts against a temporary sysfs tree and a
// temporary state directory. Building those by hand in each test produced
// subtly different fixtures that drifted apart, so the builders live here.

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const repository = path.join(__dirname, "..", "..");
const tracker = path.join(repository, "service", "battery-session-tracker.sh");
const view = path.join(repository, "service", "battery-view.sh");
const modelLibrary = path.join(repository, "service", "battery-model.sh");
const statusScript = path.join(
  repository,
  "scripts",
  "battery-intelligence-status.sh",
);
const backtestScript = path.join(repository, "scripts", "battery-backtest.sh");
const exportScript = path.join(repository, "scripts", "battery-export.sh");

const HISTORY_HEADER_V3 = "# battery-discharge-history\tv3";
const HISTORY_HEADER_V2 = "# battery-discharge-history\tv2";
const HISTORY_HEADER_V1 = "# battery-discharge-history\tv1";
const ESTIMATOR_HEADER = "# battery-estimators\tv1";

// Two real cells from a ThinkPad, so identities in tests look like the ones
// the code meets in the field.
const BAT0 = {
  name: "BAT0",
  manufacturer: "LGC",
  model_name: "01AV420",
  serial_number: " 1020",
  energy_full: 12090000,
  energy_full_design: 23940000,
};
const BAT1 = {
  name: "BAT1",
  manufacturer: "SMP",
  model_name: "01AV425",
  serial_number: "  783",
  energy_full: 26000000,
  energy_full_design: 49500000,
};
const KEY_BAT0 = "BAT0:LGC:01AV420:1020";
const KEY_BAT1 = "BAT1:SMP:01AV425:783";
// A cell that has since been replaced; used wherever a swapped battery matters.
const KEY_RETIRED = "BAT1:SMP:DEADCELL:999";

function writeBattery(root, name, fields) {
  const directory = path.join(root, name);
  fs.mkdirSync(directory, { recursive: true });
  for (const [field, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    fs.writeFileSync(path.join(directory, field), `${value}\n`);
  }
  return directory;
}

// Install one of the reference cells, with per-test overrides.
function installBattery(root, spec, overrides = {}) {
  const { name, ...fields } = { ...spec, ...overrides };
  return writeBattery(root, name, { present: 1, ...fields });
}

function writeMains(root, online = 1) {
  return writeBattery(root, "AC", { type: "Mains", online });
}

// One schema-v3 record. Defaults describe a healthy cell mid-discharge, so a
// test only states the field it is actually about.
function historyRow({
  epoch,
  session = "s0",
  key = KEY_BAT1,
  drawMw = 10000,
  energyNow = 13000000,
  energyFull = 26000000,
  energyFullDesign = 49500000,
  voltageNow = 11297000,
  powerNow = 9941000,
  capacity = 50,
  cycleCount = 109,
  status = "Discharging",
} = {}) {
  return [
    epoch,
    session,
    key,
    drawMw,
    energyNow,
    energyFull,
    energyFullDesign,
    voltageNow,
    powerNow,
    capacity,
    cycleCount,
    status,
  ].join("\t");
}

function writeHistory(stateDir, rows, header = HISTORY_HEADER_V3) {
  const file = path.join(stateDir, "discharge-history.tsv");
  fs.writeFileSync(file, [header, ...rows].join("\n") + "\n");
  return file;
}

// `count` windows for one battery, spread across `sessions` discharge sessions.
function windowsFor(key, { count = 12, sessions = 3, drawMw = 10000, start = 19990000, ...rest } = {}) {
  return Array.from({ length: count }, (_, index) =>
    historyRow({
      epoch: start + index,
      session: `${key}-s${index % sessions}`,
      key,
      drawMw: typeof drawMw === "function" ? drawMw(index) : drawMw,
      ...rest,
    }),
  );
}

function writeEstimators(stateDir, entries, header = ESTIMATOR_HEADER) {
  const rows = entries.map(
    ({ key, estimator, scored = 20, meanError = 100, epoch = 19999999 }) =>
      [key, estimator, scored, meanError, epoch].join("\t"),
  );
  fs.writeFileSync(
    path.join(stateDir, "estimators.tsv"),
    [header, ...rows].join("\n") + "\n",
  );
}

function baseEnv(fixture, extra = {}) {
  return {
    ...process.env,
    POWER_SUPPLY_ROOT: fixture.root,
    BATTERY_STATUS_POWER_SUPPLY_ROOT: fixture.root,
    BATTERY_SESSION_STATE_DIR: fixture.state,
    BATTERY_SESSION_NOTIFY_COMMAND: "/nonexistent/battery-notifier",
    BATTERY_VIEW_PROFILES_COMMAND: "/nonexistent/powerprofiles",
    ...extra,
  };
}

function runTracker(fixture, extraEnv = {}, args = []) {
  execFileSync(tracker, args, { env: baseEnv(fixture, extraEnv) });
  return fs.readFileSync(path.join(fixture.state, "state"), "utf8");
}

function runView(fixture, extraEnv = {}) {
  return JSON.parse(
    execFileSync(view, {
      env: baseEnv(fixture, extraEnv),
      encoding: "utf8",
    }),
  );
}

function runStatus(fixture, extraEnv = {}) {
  return spawnSync(statusScript, [], {
    env: baseEnv(fixture, {
      BATTERY_INTELLIGENCE_SYSTEMCTL_COMMAND: "/bin/true",
      NO_COLOR: "1",
      ...extraEnv,
    }),
    encoding: "utf8",
  });
}

// Evaluate a snippet against the model library and return its stdout. This is
// what lets the seam be unit tested directly rather than only through the
// scripts that happen to call it.
function modelEval(snippet, extraEnv = {}) {
  const result = spawnSync(
    "bash",
    ["-c", `source ${JSON.stringify(modelLibrary)}\n${snippet}`],
    { env: { ...process.env, ...extraEnv }, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`model snippet failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

// Drive a complete discharge window through the tracker.
//
// The tracker only accepts a window built from polls closer together than its
// gap tolerance, so a test that jumps straight to the end silently gets a
// restarted window instead of a recorded one. Stepping here keeps that detail
// in one place.
function dischargeWindow(fixture, { start, batteries, steps = 5, interval = 180 }) {
  const levels = { ...batteries };
  let now = start;
  for (let step = 0; step <= steps; step += 1) {
    for (const [name, spec] of Object.entries(levels)) {
      if (spec.energyNow === undefined) continue;
      const value = spec.energyNow - spec.perStep * step;
      fs.writeFileSync(
        path.join(fixture.root, name, "energy_now"),
        `${value}\n`,
      );
    }
    runTracker(fixture, { BATTERY_SESSION_NOW: String(now) });
    now += interval;
  }
  return now - interval;
}

module.exports = {
  repository,
  tracker,
  view,
  statusScript,
  backtestScript,
  exportScript,
  modelLibrary,
  HISTORY_HEADER_V1,
  HISTORY_HEADER_V2,
  HISTORY_HEADER_V3,
  ESTIMATOR_HEADER,
  BAT0,
  BAT1,
  KEY_BAT0,
  KEY_BAT1,
  KEY_RETIRED,
  writeBattery,
  installBattery,
  writeMains,
  historyRow,
  writeHistory,
  windowsFor,
  writeEstimators,
  runTracker,
  runView,
  runStatus,
  modelEval,
  dischargeWindow,
};
