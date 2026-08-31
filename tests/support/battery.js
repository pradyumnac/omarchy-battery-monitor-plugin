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
const reextractScript = path.join(repository, "scripts", "battery-reextract.sh");

// ADR-0001 generation: the files the tracker actually writes today.
const RAW_HEADER = "# battery-raw-observations\tv0.1.0";
const WINDOWS_HEADER = "# battery-windows\tv0.1.0";
const GAPS_HEADER = "# battery-gaps\tv0.1.0";
const BATTERY_STATE_HEADER = "# battery-state\tv0.1.0";

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

// --- ADR-0001 builders -------------------------------------------------

function rawDirName(key) {
  return key.replace(/\//g, "-");
}

// One raw observation row, matching battery_raw_row()'s column order:
// epoch, trigger, rules, status, energy_now, energy_full, energy_full_design,
// voltage_now, power_now, capacity, cycle_count, end_threshold, ac_online,
// boot_id, suspend_count, uptime_s.
function rawRow({
  epoch,
  trigger = "poll",
  rules = "v0.1.0",
  status = "Discharging",
  energyNow = 13000000,
  energyFull = 26000000,
  energyFullDesign = 49500000,
  voltageNow = 11297000,
  powerNow = 9941000,
  capacity = 50,
  cycleCount = 109,
  endThreshold = 90,
  acOnline = 0,
  bootId = "boot-a",
  suspendCount = 0,
  uptimeSeconds = 1000,
} = {}) {
  return [
    epoch,
    trigger,
    rules,
    status,
    energyNow,
    energyFull,
    energyFullDesign,
    voltageNow,
    powerNow,
    capacity,
    cycleCount,
    endThreshold,
    acOnline,
    bootId,
    suspendCount,
    uptimeSeconds,
  ].join("\t");
}

// Write one battery's raw file for one local date. `date` defaults to a
// fixed value so tests are not sensitive to when they happen to run;
// pass the real current date only when a test cares about file naming.
function writeRawDay(stateDir, key, rows, { date = "2026-01-01", header = RAW_HEADER } = {}) {
  const dir = path.join(stateDir, "raw", rawDirName(key));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${date}.tsv`);
  fs.writeFileSync(file, [header, ...rows].join("\n") + "\n");
  return file;
}

// A run of `count` polls, 180s apart, over a discharging battery, so the
// extractor sees exactly the shape a live tracker would produce: enough
// polls to complete `count * 180 / 900` windows.
function rawPollRun(key, { count = 30, start = 1900000000, energyStart = 26000000, drawUwhPerPoll = 500000, ...rest } = {}) {
  let energy = energyStart;
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    rows.push(
      rawRow({
        epoch: start + index * 180,
        trigger: index === 0 ? "start" : "poll",
        energyNow: energy,
        ...rest,
      }),
    );
    energy -= drawUwhPerPoll;
  }
  return rows;
}

// One windows.tsv row, matching battery_extract_windows()'s output order:
// epoch, session_epoch, key, draw_mw, energy_now, energy_full,
// energy_full_design, voltage_now, power_now, capacity, cycle_count, eligible.
function windowRow({
  epoch,
  sessionEpoch,
  key = KEY_BAT1,
  drawMw = 10000,
  energyNow = 13000000,
  energyFull = 26000000,
  energyFullDesign = 49500000,
  voltageNow = 11297000,
  powerNow = 9941000,
  capacity = 50,
  cycleCount = 109,
  eligible = 1,
} = {}) {
  return [
    epoch,
    sessionEpoch ?? epoch,
    key,
    drawMw,
    energyNow,
    energyFull,
    energyFullDesign,
    voltageNow,
    powerNow,
    capacity,
    cycleCount,
    eligible,
  ].join("\t");
}

// `count` windows for one battery, one continuous session unless `sessions`
// says otherwise. Mirrors what battery_extract_windows() actually produces:
// a continuous discharge run is one session however many windows it spans.
// Defaults to the small-epoch convention view.test.js and
// intelligence-status.test.js use (NOW around 20000000, so windows just
// before it are not future-dated). Pass a large `start` explicitly when a
// test wants realistic wall-clock-scale epochs instead.
function windowsForBattery(key, { count = 12, sessions = 3, drawMw = 10000, start = 19990000, eligible = 1, ...rest } = {}) {
  const perSession = Math.max(1, Math.ceil(count / sessions));
  return Array.from({ length: count }, (_, index) => {
    const sessionIndex = Math.floor(index / perSession);
    return windowRow({
      epoch: start + index * 900,
      sessionEpoch: start + sessionIndex * perSession * 900,
      key,
      drawMw: typeof drawMw === "function" ? drawMw(index) : drawMw,
      eligible,
      ...rest,
    });
  });
}

function writeWindows(stateDir, rows, header = WINDOWS_HEADER) {
  const file = path.join(stateDir, "windows.tsv");
  fs.writeFileSync(file, [header, ...rows].join("\n") + "\n");
  return file;
}

// One gaps.tsv row: key, start_epoch, end_epoch, cause, ac_start, ac_end,
// energy_before_uwh, energy_after_uwh, energy_delta_uwh.
function gapRow({
  key = KEY_BAT1,
  startEpoch,
  endEpoch,
  cause = "asleep",
  acStart = 0,
  acEnd = 0,
  energyBefore = 13000000,
  energyAfter = 12950000,
} = {}) {
  const delta = Math.abs(energyBefore - energyAfter);
  return [key, startEpoch, endEpoch, cause, acStart, acEnd, energyBefore, energyAfter, delta].join("\t");
}

function writeGaps(stateDir, rows, header = GAPS_HEADER) {
  const file = path.join(stateDir, "gaps.tsv");
  fs.writeFileSync(file, [header, ...rows].join("\n") + "\n");
  return file;
}

// One battery-state.tsv row: key, open_epoch, open_energy, estimator,
// scored, error, updated_epoch.
function batteryStateRow({
  key = KEY_BAT1,
  openEpoch = 0,
  openEnergy = 0,
  estimator = "median",
  scored = 0,
  error = 0,
  updatedEpoch = 1900000000,
} = {}) {
  return [key, openEpoch, openEnergy, estimator, scored, error, updatedEpoch].join("\t");
}

function writeBatteryState(stateDir, rows, header = BATTERY_STATE_HEADER) {
  const file = path.join(stateDir, "battery-state.tsv");
  fs.writeFileSync(file, [header, ...rows].join("\n") + "\n");
  return file;
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
  reextractScript,
  modelLibrary,
  // The files the tracker actually writes today (ADR-0001).
  RAW_HEADER,
  WINDOWS_HEADER,
  GAPS_HEADER,
  BATTERY_STATE_HEADER,
  rawDirName,
  rawRow,
  writeRawDay,
  rawPollRun,
  windowRow,
  windowsForBattery,
  writeWindows,
  gapRow,
  writeGaps,
  batteryStateRow,
  writeBatteryState,
  BAT0,
  BAT1,
  KEY_BAT0,
  KEY_BAT1,
  KEY_RETIRED,
  writeBattery,
  installBattery,
  writeMains,
  runTracker,
  runView,
  runStatus,
  modelEval,
  dischargeWindow,
};
