const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { withFixture } = require("./support/fixture");
const { reextractScript } = require("./support/battery");

const tracker = path.join(
  __dirname,
  "..",
  "service",
  "battery-session-tracker.sh",
);

function withBatteryFixture(callback) {
  return withFixture({ root: "battery-power", state: "battery-state" }, (f) => {
    fs.mkdirSync(path.join(f.root, "BAT0"));
    fs.writeFileSync(path.join(f.root, "BAT0", "present"), "1\n");
    return callback(f);
  });
}

function runTracker(fixture, extraEnv = {}, args = []) {
  execFileSync(tracker, args, {
    env: {
      ...process.env,
      POWER_SUPPLY_ROOT: fixture.root,
      BATTERY_SESSION_STATE_DIR: fixture.state,
      BATTERY_SESSION_NOTIFY_COMMAND: "/nonexistent/battery-notifier",
      ...extraEnv,
    },
  });
  return fs.readFileSync(path.join(fixture.state, "state"), "utf8");
}

function writeBattery(root, name, values) {
  const directory = path.join(root, name);
  fs.mkdirSync(directory, { recursive: true });
  for (const [field, value] of Object.entries(values)) {
    fs.writeFileSync(path.join(directory, field), `${value}\n`);
  }
}

// --- ADR-0001 helpers -------------------------------------------------
//
// The tracker no longer computes windows in-flight into a single history
// file; it appends a raw observation per battery, per poll, and calls the
// shared extractor on a bounded tail. Extraction itself (gap classification,
// session grouping, the eligible flag) is unit tested directly in
// extract.test.js against battery_extract_windows(); what belongs here is
// the integration surface - does the real tracker binary call it correctly,
// detect triggers correctly, and keep batteries isolated by directory.

function rawFileFor(state, key) {
  const dir = path.join(state, "raw", key.replace(/\//g, "-"));
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((name) => name.endsWith(".tsv"));
  if (files.length === 0) return null;
  return path.join(dir, files.sort().at(-1));
}

function rawRows(state, key) {
  const file = rawFileFor(state, key);
  if (!file) return [];
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter((line) => !line.startsWith("#"));
}

function windowsFile(state) {
  const file = path.join(state, "windows.tsv");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter((line) => !line.startsWith("#"));
}

function batteryStateRows(state) {
  const file = path.join(state, "battery-state.tsv");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .map((line) => {
      const [key, openEpoch, openEnergy, estimator, scored, error, updated] =
        line.split("\t");
      return { key, openEpoch: Number(openEpoch), openEnergy: Number(openEnergy), estimator, scored: Number(scored), error: Number(error), updated: Number(updated) };
    });
}

const KEY_BAT0 = "BAT0:LGC:01AV420:1020";
const KEY_BAT1 = "BAT1:SMP:01AV425:783";

describe("raw observation capture", () => {
  test("appends a poll row every run, unconditionally", () => {
    // Given a battery on AC, where the tracker's old window logic never ran
    // at all
    // When the tracker polls
    // Then a raw row is still written - the poll row is the liveness proof,
    // independent of whether a window can be built from it
    withBatteryFixture((f) => {
      fs.mkdirSync(path.join(f.root, "AC"));
      fs.writeFileSync(path.join(f.root, "AC", "type"), "Mains\n");
      fs.writeFileSync(path.join(f.root, "AC", "online"), "1\n");
      writeBattery(f.root, "BAT0", {
        present: 1,
        status: "Charging",
        energy_now: 50000000,
        energy_full: 50000000,
        manufacturer: "LGC",
        model_name: "01AV420",
        serial_number: "1020",
      });
      runTracker(f, { BATTERY_SESSION_NOW: "1000" });
      const rows = rawRows(f.state, KEY_BAT0);
      assert.equal(rows.length, 1);
      assert.match(rows[0], /^1000\tstart\t/);
    });
  });

  test("labels the first ever row for a battery as start", () => {
    withBatteryFixture((f) => {
      writeBattery(f.root, "BAT0", {
        present: 1,
        status: "Discharging",
        energy_now: 50000000,
        energy_full: 50000000,
        manufacturer: "LGC",
        model_name: "01AV420",
        serial_number: "1020",
      });
      runTracker(f, { BATTERY_SESSION_NOW: "1000" });
      assert.match(rawRows(f.state, KEY_BAT0)[0], /^1000\tstart\t/);
    });
  });

  test("labels an ordinary follow-up poll as poll", () => {
    withBatteryFixture((f) => {
      writeBattery(f.root, "BAT0", {
        present: 1,
        status: "Discharging",
        energy_now: 50000000,
        energy_full: 50000000,
        manufacturer: "LGC",
        model_name: "01AV420",
        serial_number: "1020",
      });
      runTracker(f, { BATTERY_SESSION_NOW: "1000" });
      writeBattery(f.root, "BAT0", { energy_now: 49500000 });
      runTracker(f, { BATTERY_SESSION_NOW: "1180" });
      assert.match(rawRows(f.state, KEY_BAT0)[1], /^1180\tpoll\t/);
    });
  });

  test("labels a status change, so a threshold hold or handover is visible later", () => {
    withBatteryFixture((f) => {
      writeBattery(f.root, "BAT0", {
        present: 1,
        status: "Discharging",
        energy_now: 50000000,
        energy_full: 50000000,
        manufacturer: "LGC",
        model_name: "01AV420",
        serial_number: "1020",
      });
      runTracker(f, { BATTERY_SESSION_NOW: "1000" });
      writeBattery(f.root, "BAT0", { status: "Not charging" });
      runTracker(f, { BATTERY_SESSION_NOW: "1180" });
      assert.match(rawRows(f.state, KEY_BAT0)[1], /^1180\tstatus\t/);
    });
  });

  test("labels the first poll after a gap as resume", () => {
    withBatteryFixture((f) => {
      writeBattery(f.root, "BAT0", {
        present: 1,
        status: "Discharging",
        energy_now: 50000000,
        energy_full: 50000000,
        manufacturer: "LGC",
        model_name: "01AV420",
        serial_number: "1020",
      });
      runTracker(f, { BATTERY_SESSION_NOW: "1000" });
      // Well beyond the poll-gap tolerance.
      runTracker(f, { BATTERY_SESSION_NOW: "50000" });
      assert.match(rawRows(f.state, KEY_BAT0)[1], /^50000\tresume\t/);
    });
  });

  test("keeps two batteries in separate directories, never mixing their rows", () => {
    withBatteryFixture((f) => {
      writeBattery(f.root, "BAT0", {
        present: 1,
        status: "Not charging",
        energy_now: 8000000,
        energy_full: 12090000,
        manufacturer: "LGC",
        model_name: "01AV420",
        serial_number: "1020",
      });
      writeBattery(f.root, "BAT1", {
        present: 1,
        status: "Discharging",
        energy_now: 20000000,
        energy_full: 26000000,
        manufacturer: "SMP",
        model_name: "01AV425",
        serial_number: "783",
      });
      runTracker(f, { BATTERY_SESSION_NOW: "1000" });
      assert.equal(rawRows(f.state, KEY_BAT0).length, 1);
      assert.equal(rawRows(f.state, KEY_BAT1).length, 1);
      assert.ok(rawFileFor(f.state, KEY_BAT0) !== rawFileFor(f.state, KEY_BAT1));
    });
  });
});

describe("incremental extraction after a poll", () => {
  test("derives a window in windows.tsv once enough polls complete one", () => {
    withBatteryFixture((f) => {
      writeBattery(f.root, "BAT0", {
        present: 1,
        status: "Discharging",
        energy_now: 50000000,
        energy_full: 50000000,
        manufacturer: "LGC",
        model_name: "01AV420",
        serial_number: "1020",
      });
      let energy = 50000000;
      for (const timestamp of [1000, 1180, 1360, 1540, 1720, 1900]) {
        writeBattery(f.root, "BAT0", { energy_now: energy });
        runTracker(f, { BATTERY_SESSION_NOW: String(timestamp) });
        energy -= 500000;
      }
      const windows = windowsFile(f.state);
      assert.equal(windows.length, 1);
      assert.match(windows[0], new RegExp(`\\t${KEY_BAT0.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\t`));
    });
  });

  test("never appends the same window twice on repeated polls", () => {
    withBatteryFixture((f) => {
      writeBattery(f.root, "BAT0", {
        present: 1,
        status: "Discharging",
        energy_now: 50000000,
        energy_full: 50000000,
        manufacturer: "LGC",
        model_name: "01AV420",
        serial_number: "1020",
      });
      let energy = 50000000;
      for (const timestamp of [1000, 1180, 1360, 1540, 1720, 1900]) {
        writeBattery(f.root, "BAT0", { energy_now: energy });
        runTracker(f, { BATTERY_SESSION_NOW: String(timestamp) });
        energy -= 500000;
      }
      const afterFirstWindow = windowsFile(f.state).length;
      writeBattery(f.root, "BAT0", { energy_now: energy });
      runTracker(f, { BATTERY_SESSION_NOW: "2080" });
      assert.equal(windowsFile(f.state).length, afterFirstWindow);
    });
  });

  test("records only the battery that actually discharged", () => {
    // These batteries discharge in sequence, not together: while one
    // supplies the system the other sits idle. A row of zeros for the idle
    // one would bury its real draw, so it contributes no window at all.
    withBatteryFixture((f) => {
      writeBattery(f.root, "BAT0", {
        present: 1,
        status: "Not charging",
        energy_now: 8000000,
        energy_full: 12090000,
        manufacturer: "LGC",
        model_name: "01AV420",
        serial_number: "1020",
      });
      writeBattery(f.root, "BAT1", {
        present: 1,
        status: "Discharging",
        energy_now: 20000000,
        energy_full: 26000000,
        manufacturer: "SMP",
        model_name: "01AV425",
        serial_number: "783",
      });
      let energy = 20000000;
      for (const timestamp of [1000, 1180, 1360, 1540, 1720, 1900]) {
        writeBattery(f.root, "BAT1", { energy_now: energy });
        runTracker(f, { BATTERY_SESSION_NOW: String(timestamp) });
        energy -= 500000;
      }
      const windows = windowsFile(f.state);
      assert.ok(windows.length >= 1);
      for (const window of windows) {
        assert.match(window, /BAT1:SMP:01AV425:783/);
        assert.doesNotMatch(window, /BAT0:LGC/);
      }
    });
  });

  test("rescores and records the selected estimator in battery-state.tsv", () => {
    withBatteryFixture((f) => {
      writeBattery(f.root, "BAT0", {
        present: 1,
        status: "Discharging",
        energy_now: 50000000,
        energy_full: 50000000,
        manufacturer: "LGC",
        model_name: "01AV420",
        serial_number: "1020",
      });
      let energy = 50000000;
      for (const timestamp of [1000, 1180, 1360, 1540, 1720, 1900]) {
        writeBattery(f.root, "BAT0", { energy_now: energy });
        runTracker(f, { BATTERY_SESSION_NOW: String(timestamp) });
        energy -= 500000;
      }
      const rows = batteryStateRows(f.state);
      const bat0 = rows.find((row) => row.key === KEY_BAT0);
      assert.ok(bat0, "expected a battery-state row for BAT0");
      assert.equal(bat0.estimator, "median");
    });
  });

  test("reports the still-open window's progress in battery-state.tsv", () => {
    withBatteryFixture((f) => {
      writeBattery(f.root, "BAT0", {
        present: 1,
        status: "Discharging",
        energy_now: 50000000,
        energy_full: 50000000,
        manufacturer: "LGC",
        model_name: "01AV420",
        serial_number: "1020",
      });
      runTracker(f, { BATTERY_SESSION_NOW: "1000" });
      const rows = batteryStateRows(f.state);
      const bat0 = rows.find((row) => row.key === KEY_BAT0);
      assert.equal(bat0.openEpoch, 1000);
      assert.equal(bat0.openEnergy, 50000000);
    });
  });

  test("agrees with a full re-extraction across one long discharge session", () => {
    // extract_battery() feeds the extractor a bounded tail. The extractor
    // is stateless: its first row seeds both the session id and the window
    // anchor. Once a discharge run outgrows the tail, that anchor slides
    // forward every poll instead of staying fixed at the run's real start -
    // one false window and one false session per poll. Six polls (the other
    // tests in this file) never reach that tail bound; this run needs to.
    withBatteryFixture((f) => {
      writeBattery(f.root, "BAT0", {
        present: 1,
        status: "Discharging",
        energy_now: 50000000,
        energy_full: 50000000,
        manufacturer: "LGC",
        model_name: "01AV420",
        serial_number: "1020",
      });
      let energy = 50000000;
      let timestamp = 1000;
      for (let poll = 0; poll < 30; poll += 1) {
        writeBattery(f.root, "BAT0", { energy_now: energy });
        runTracker(f, { BATTERY_SESSION_NOW: String(timestamp) });
        energy -= 30000;
        timestamp += 180;
      }

      const windows = windowsFile(f.state);
      const sessionEpochs = new Set(windows.map((row) => row.split("\t")[1]));
      assert.equal(
        sessionEpochs.size,
        1,
        "one continuous discharge run must produce one session id",
      );
      // 30 polls * 180s = 5220s of run time; a window closes every 900s,
      // so a correctly anchored extractor closes floor(5220/900) = 5 of
      // them, not one per poll.
      assert.equal(windows.length, 5);

      const result = spawnSync(reextractScript, [], {
        env: {
          ...process.env,
          BATTERY_SESSION_STATE_DIR: f.state,
          // battery-state.tsv's last column is a wall-clock "last rescored
          // at" stamp, not derived from raw - it legitimately differs
          // between the incremental run above and this batch run unless
          // both are pinned to the same value.
          BATTERY_REEXTRACT_NOW: String(timestamp - 180),
        },
        encoding: "utf8",
      });
      assert.equal(
        result.status,
        0,
        `incremental and batch extraction disagree:\n${result.stdout}`,
      );
      assert.match(result.stdout, /No difference/);
    });
  });
});

describe("battery identity: recalibration versus a real swap", () => {
  test("a capacity recalibration does not start a new identity", () => {
    // A cell adjusting its reported energy_full while deep-discharging is
    // ordinary behaviour, not a swap: capacity is not part of the identity
    // key, so raw rows keep landing in the same directory.
    withBatteryFixture((f) => {
      writeBattery(f.root, "BAT0", {
        present: 1,
        status: "Discharging",
        energy_now: 50000000,
        energy_full: 26000000,
        manufacturer: "LGC",
        model_name: "01AV420",
        serial_number: "1020",
      });
      runTracker(f, { BATTERY_SESSION_NOW: "1000" });
      writeBattery(f.root, "BAT0", {
        energy_now: 49000000,
        energy_full: 26390000,
      });
      runTracker(f, { BATTERY_SESSION_NOW: "1180" });
      assert.equal(rawRows(f.state, KEY_BAT0).length, 2);
    });
  });

  test("a different serial starts a fresh raw file under a new identity", () => {
    withBatteryFixture((f) => {
      writeBattery(f.root, "BAT0", {
        present: 1,
        status: "Discharging",
        energy_now: 50000000,
        energy_full: 26000000,
        manufacturer: "LGC",
        model_name: "01AV420",
        serial_number: "1020",
      });
      runTracker(f, { BATTERY_SESSION_NOW: "1000" });
      const oldKey = KEY_BAT0;
      writeBattery(f.root, "BAT0", { energy_now: 49000000, serial_number: "9999" });
      runTracker(f, { BATTERY_SESSION_NOW: "1180" });
      const newKey = "BAT0:LGC:01AV420:9999";

      assert.equal(rawRows(f.state, oldKey).length, 1, "the old identity's file stops growing");
      assert.equal(rawRows(f.state, newKey).length, 1, "the new identity starts its own file");
    });
  });
});

describe("power session and discharge window edge cases", () => {
  test("resets the window rather than completing it when energy rises", () => {
    withBatteryFixture((f) => {
      writeBattery(f.root, "BAT0", {
        present: 1,
        status: "Discharging",
        energy_now: 50000000,
        energy_full: 50000000,
        manufacturer: "LGC",
        model_name: "01AV420",
        serial_number: "1020",
      });
      runTracker(f, { BATTERY_SESSION_NOW: "1000" });
      writeBattery(f.root, "BAT0", { energy_now: 49000000 });
      runTracker(f, { BATTERY_SESSION_NOW: "1180" });
      writeBattery(f.root, "BAT0", { energy_now: 50000000 });
      runTracker(f, { BATTERY_SESSION_NOW: "1360" });
      // No window can have completed: only 360s have elapsed, and energy
      // rose partway through.
      assert.equal(windowsFile(f.state).length, 0);
    });
  });

  test("rejects an implausibly high discharge draw", () => {
    withBatteryFixture((f) => {
      writeBattery(f.root, "BAT0", {
        present: 1,
        status: "Discharging",
        energy_now: 50000000,
        energy_full: 50000000,
        manufacturer: "LGC",
        model_name: "01AV420",
        serial_number: "1020",
      });
      let energy = 50000000;
      for (const timestamp of [1000, 1180, 1360, 1540, 1720]) {
        writeBattery(f.root, "BAT0", { energy_now: energy });
        runTracker(f, { BATTERY_SESSION_NOW: String(timestamp) });
        energy -= 100000;
      }
      writeBattery(f.root, "BAT0", { energy_now: 10000000 }); // implausible drop
      runTracker(f, { BATTERY_SESSION_NOW: "1900" });
      assert.equal(windowsFile(f.state).length, 0);
    });
  });

  test("does not bridge a long polling gap into one discharge window", () => {
    withBatteryFixture((f) => {
      writeBattery(f.root, "BAT0", {
        present: 1,
        status: "Discharging",
        energy_now: 50000000,
        energy_full: 50000000,
        manufacturer: "LGC",
        model_name: "01AV420",
        serial_number: "1020",
      });
      runTracker(f, { BATTERY_SESSION_NOW: "1000" });
      writeBattery(f.root, "BAT0", { energy_now: 45000000 });
      runTracker(f, { BATTERY_SESSION_NOW: "50000" }); // far past the poll tolerance
      assert.equal(windowsFile(f.state).length, 0);
    });
  });

  test("resets sampling when energy data is missing or zero", () => {
    withBatteryFixture((f) => {
      writeBattery(f.root, "BAT0", {
        present: 1,
        status: "Discharging",
        energy_full: 50000000,
      });
      const state = runTracker(f, { BATTERY_SESSION_NOW: "1000" });
      assert.match(state, /^previous_state=on-battery$/m);
      assert.equal(windowsFile(f.state).length, 0);
    });
  });
});

describe("state file and windows.tsv permissions", () => {
  test("writes runtime state and windows as user-only files", () => {
    withBatteryFixture((f) => {
      writeBattery(f.root, "BAT0", {
        present: 1,
        status: "Discharging",
        energy_now: 50000000,
        energy_full: 50000000,
        manufacturer: "LGC",
        model_name: "01AV420",
        serial_number: "1020",
      });
      let energy = 50000000;
      for (const timestamp of [1000, 1180, 1360, 1540, 1720, 1900]) {
        writeBattery(f.root, "BAT0", { energy_now: energy });
        runTracker(f, { BATTERY_SESSION_NOW: String(timestamp) });
        energy -= 500000;
      }
      assert.equal(fs.statSync(path.join(f.state, "state")).mode & 0o777, 0o600);
      assert.equal(
        fs.statSync(path.join(f.state, "windows.tsv")).mode & 0o777,
        0o600,
      );
      const rawFile = rawFileFor(f.state, KEY_BAT0);
      assert.ok(rawFile);
      assert.equal(fs.statSync(rawFile).mode & 0o777, 0o600);
    });
  });
});

describe("power session and notification transitions", () => {
  test("detects a non-AC-named mains supply", () => {
    withBatteryFixture((f) => {
      fs.mkdirSync(path.join(f.root, "ADP1"));
      fs.writeFileSync(path.join(f.root, "ADP1", "type"), "Mains\n");
      fs.writeFileSync(path.join(f.root, "ADP1", "online"), "1\n");
      assert.match(runTracker(f), /^previous_state=on-charge$/m);
    });
  });

  test("starts an observed session when the initial state is already on battery", () => {
    withBatteryFixture((f) => {
      writeBattery(f.root, "BAT0", { present: 1, status: "Discharging" });
      const state = runTracker(f, { BATTERY_SESSION_NOW: "1234" });
      assert.match(state, /^previous_state=on-battery$/m);
      assert.match(state, /^state_since=1234$/m);
      assert.match(state, /^state_since_at_least=1$/m);
    });
  });

  test("recovers a missing timestamp in an existing battery session", () => {
    withBatteryFixture((f) => {
      fs.writeFileSync(
        path.join(f.state, "state"),
        [
          "previous_state=on-battery",
          "state_since=0",
          "last_observed=1200",
          "",
        ].join("\n"),
      );
      const state = runTracker(f, { BATTERY_SESSION_NOW: "1230" });
      assert.match(state, /^previous_state=on-battery$/m);
      assert.match(state, /^state_since=1230$/m);
      assert.match(state, /^state_since_at_least=1$/m);
    });
  });

  test("records an observed battery-to-charge transition", () => {
    withBatteryFixture((f) => {
      assert.match(runTracker(f), /^previous_state=on-battery$/m);
      fs.mkdirSync(path.join(f.root, "USB"));
      fs.writeFileSync(path.join(f.root, "USB", "type"), "Mains\n");
      fs.writeFileSync(path.join(f.root, "USB", "online"), "1\n");
      const state = runTracker(f);
      assert.match(state, /^previous_state=on-charge$/m);
      assert.match(state, /^state_since=[1-9][0-9]*$/m);
      assert.match(state, /^state_since_at_least=0$/m);
      assert.match(state, /^last_charge_start=[1-9][0-9]*$/m);
    });
  });

  test("notifies once with dual-battery charging details", () => {
    withBatteryFixture((f) => {
    const notifier = path.join(f.state, "notifier");
    const notificationLog = path.join(f.state, "notifications");
      fs.writeFileSync(
        notifier,
        '#!/usr/bin/env bash\nprintf \'%s\\0\' "$@" >> "$BATTERY_NOTIFICATION_LOG"\n',
        { mode: 0o700 },
      );
      writeBattery(f.root, "BAT0", {
        present: 1,
        capacity: 20,
        status: "Discharging",
        energy_now: 20000000,
        energy_full: 50000000,
        power_now: 10000000,
      });
      writeBattery(f.root, "BAT1", {
        present: 1,
        capacity: 80,
        status: "Not charging",
        energy_now: 40000000,
        energy_full: 50000000,
        power_now: 0,
      });
      runTracker(f);

      fs.mkdirSync(path.join(f.root, "AC"));
      fs.writeFileSync(path.join(f.root, "AC", "type"), "Mains\n");
      fs.writeFileSync(path.join(f.root, "AC", "online"), "1\n");
      fs.writeFileSync(path.join(f.root, "BAT0", "status"), "Charging\n");
      const notifyEnv = {
        BATTERY_SESSION_NOTIFY_COMMAND: notifier,
        BATTERY_NOTIFICATION_LOG: notificationLog,
      };
      runTracker(f, notifyEnv);
      assert.equal(fs.existsSync(notificationLog), false);
      runTracker(f, notifyEnv, ["--power-event"]);
      runTracker(f, notifyEnv);

      const args = fs
        .readFileSync(notificationLog, "utf8")
        .split("\0")
        .filter(Boolean);
      assert.deepEqual(args.slice(0, 9), [
        "--app-name",
        "doe.power",
        "-u",
        "low",
        "-g",
        "󰂆",
        "-t",
        "6000",
        "Plugged",
      ]);
      assert.equal(args[9], "BAT0 · 20%\nNot charging:\nBAT1 · 80%");
      assert.equal(args.length, 10);
    });
  });

  test("uses Plugged with a charge-threshold block only once the cap is actually reached", () => {
    withBatteryFixture((f) => {
    const notifier = path.join(f.state, "notifier");
    const notificationLog = path.join(f.state, "notifications");
      fs.writeFileSync(
        notifier,
        '#!/usr/bin/env bash\nprintf \'%s\\0\' "$@" >> "$BATTERY_NOTIFICATION_LOG"\n',
        { mode: 0o700 },
      );
      writeBattery(f.root, "BAT0", {
        present: 1,
        capacity: 95,
        status: "Not charging",
        charge_control_end_threshold: 90,
      });
      runTracker(f);
      writeBattery(f.root, "AC", { type: "Mains", online: 1 });
      runTracker(
        f,
        {
          BATTERY_SESSION_NOTIFY_COMMAND: notifier,
          BATTERY_NOTIFICATION_LOG: notificationLog,
        },
        ["--power-event"],
      );

      const args = fs.readFileSync(notificationLog, "utf8").split("\0");
      assert.equal(args[8], "Plugged");
      assert.equal(args[9], "⚠ Charge threshold:\nBAT0 · 95%");
    });
  });

  test("reports a battery that is merely not charging without a false threshold claim", () => {
    withBatteryFixture((f) => {
      const notifier = path.join(f.state, "notifier");
      const notificationLog = path.join(f.state, "notifications");
      fs.writeFileSync(
        notifier,
        '#!/usr/bin/env bash\nprintf \'%s\\0\' "$@" >> "$BATTERY_NOTIFICATION_LOG"\n',
        { mode: 0o700 },
      );
      // A dual-battery reserve pack: idle at 70%, far below its own 90% cap.
      // sysfs reports the same "Not charging" string it would for a battery
      // that is genuinely capped, so this must not be reported as one.
      writeBattery(f.root, "BAT0", {
        present: 1,
        capacity: 70,
        status: "Not charging",
        charge_control_end_threshold: 90,
      });
      runTracker(f);
      writeBattery(f.root, "AC", { type: "Mains", online: 1 });
      runTracker(
        f,
        {
          BATTERY_SESSION_NOTIFY_COMMAND: notifier,
          BATTERY_NOTIFICATION_LOG: notificationLog,
        },
        ["--power-event"],
      );

      const args = fs.readFileSync(notificationLog, "utf8").split("\0");
      assert.equal(args[8], "Plugged");
      assert.equal(args[9], "Not charging:\nBAT0 · 70%");
      assert.doesNotMatch(args[9], /Charge threshold/);
    });
  });

  test("omits unavailable charging statistics for one battery", () => {
    withBatteryFixture((f) => {
    const notifier = path.join(f.state, "notifier");
    const notificationLog = path.join(f.state, "notifications");
      fs.writeFileSync(
        notifier,
        '#!/usr/bin/env bash\nprintf \'%s\\0\' "$@" >> "$BATTERY_NOTIFICATION_LOG"\n',
        { mode: 0o700 },
      );
      writeBattery(f.root, "BAT0", {
        present: 1,
        capacity: 35,
        status: "Discharging",
      });
      runTracker(f);
      writeBattery(f.root, "AC", { type: "Mains", online: 1 });
      fs.writeFileSync(path.join(f.root, "BAT0", "status"), "Charging\n");
      runTracker(
        f,
        {
          BATTERY_SESSION_NOTIFY_COMMAND: notifier,
          BATTERY_NOTIFICATION_LOG: notificationLog,
        },
        ["--power-event"],
      );

      const args = fs.readFileSync(notificationLog, "utf8").split("\0");
      assert.equal(args[8], "Plugged");
      assert.equal(args[9], "BAT0 · 35%");
    });
  });

  test("persists a transition when notification delivery fails", () => {
    withBatteryFixture((f) => {
    const notifier = path.join(f.state, "failing-notifier");
      fs.writeFileSync(notifier, "#!/usr/bin/env bash\nexit 1\n", {
        mode: 0o700,
      });
      runTracker(f);
      writeBattery(f.root, "AC", { type: "Mains", online: 1 });
      const state = runTracker(f, { BATTERY_SESSION_NOTIFY_COMMAND: notifier }, [
        "--power-event",
      ]);
      assert.match(state, /^previous_state=on-charge$/m);
      assert.match(state, /^state_since=[1-9][0-9]*$/m);
    });
  });

  test("summarizes a dual-battery charging session on unplug", () => {
    withBatteryFixture((f) => {
    const notifier = path.join(f.state, "notifier");
    const notificationLog = path.join(f.state, "notifications");
      fs.writeFileSync(
        notifier,
        '#!/usr/bin/env bash\nprintf \'%s\\0\' "$@" >> "$BATTERY_NOTIFICATION_LOG"\n',
        { mode: 0o700 },
      );
      writeBattery(f.root, "BAT0", {
        present: 1,
        capacity: 12,
        status: "Discharging",
      });
      writeBattery(f.root, "BAT1", {
        present: 1,
        capacity: 80,
        status: "Not charging",
      });
      runTracker(f, { BATTERY_SESSION_NOW: "950" });

      writeBattery(f.root, "AC", { type: "Mains", online: 1 });
      fs.writeFileSync(path.join(f.root, "BAT0", "status"), "Charging\n");
      const notifyEnv = {
        BATTERY_SESSION_NOTIFY_COMMAND: notifier,
        BATTERY_NOTIFICATION_LOG: notificationLog,
      };
      const chargingState = runTracker(
        f,
        { ...notifyEnv, BATTERY_SESSION_NOW: "1000" },
        ["--power-event"],
      );
      assert.match(chargingState, /^charge_session_valid=1$/m);
      for (let now = 1060; now <= 2020; now += 60) {
        runTracker(f, { ...notifyEnv, BATTERY_SESSION_NOW: String(now) });
      }

      fs.writeFileSync(path.join(f.root, "AC", "online"), "0\n");
      fs.writeFileSync(path.join(f.root, "BAT0", "capacity"), "22\n");
      fs.writeFileSync(path.join(f.root, "BAT0", "status"), "Discharging\n");
      runTracker(f, { ...notifyEnv, BATTERY_SESSION_NOW: "2080" }, [
        "--power-event",
      ]);

      const args = fs
        .readFileSync(notificationLog, "utf8")
        .split("\0")
        .filter(Boolean);
      assert.equal(args[18], "Unplugged");
      assert.equal(
        args[19],
        "Charged for ~18m\nBAT0: 12% → 22%\nBAT1: 80% → 80%",
      );
      assert.equal(args.length, 20);
    });
  });

  test("unplug omits duration and deltas when the charge start is unknown", () => {
    withBatteryFixture((f) => {
    const notifier = path.join(f.state, "notifier");
    const notificationLog = path.join(f.state, "notifications");
      fs.writeFileSync(
        notifier,
        '#!/usr/bin/env bash\nprintf \'%s\\0\' "$@" >> "$BATTERY_NOTIFICATION_LOG"\n',
        { mode: 0o700 },
      );
      writeBattery(f.root, "BAT0", {
        present: 1,
        capacity: 35,
        status: "Charging",
      });
      writeBattery(f.root, "AC", { type: "Mains", online: 1 });
      runTracker(f, { BATTERY_SESSION_NOW: "1000" });
      fs.writeFileSync(path.join(f.root, "AC", "online"), "0\n");
      fs.writeFileSync(path.join(f.root, "BAT0", "status"), "Discharging\n");
      runTracker(
        f,
        {
          BATTERY_SESSION_NOTIFY_COMMAND: notifier,
          BATTERY_NOTIFICATION_LOG: notificationLog,
          BATTERY_SESSION_NOW: "1100",
        },
        ["--power-event"],
      );

      const args = fs
        .readFileSync(notificationLog, "utf8")
        .split("\0")
        .filter(Boolean);
      assert.equal(args[8], "Unplugged");
      assert.equal(args[9], "BAT0: 35%");
    });
  });

  test("reports a battery removed mid-session as removed", () => {
    withBatteryFixture((f) => {
    const notifier = path.join(f.state, "notifier");
    const notificationLog = path.join(f.state, "notifications");
      fs.writeFileSync(
        notifier,
        '#!/usr/bin/env bash\nprintf \'%s\\0\' "$@" >> "$BATTERY_NOTIFICATION_LOG"\n',
        { mode: 0o700 },
      );
      writeBattery(f.root, "BAT0", {
        present: 1,
        capacity: 30,
        status: "Discharging",
      });
      writeBattery(f.root, "BAT1", {
        present: 1,
        capacity: 80,
        status: "Discharging",
      });
      writeBattery(f.root, "AC", { type: "Mains", online: 1 });
      fs.writeFileSync(path.join(f.root, "BAT0", "status"), "Charging\n");
      runTracker(f, {}, ["--power-event"]);

      fs.rmSync(path.join(f.root, "BAT1"), { recursive: true, force: true });
      fs.writeFileSync(path.join(f.root, "AC", "online"), "0\n");
      fs.writeFileSync(path.join(f.root, "BAT0", "status"), "Discharging\n");
      const notifyEnv = {
        BATTERY_SESSION_NOTIFY_COMMAND: notifier,
        BATTERY_NOTIFICATION_LOG: notificationLog,
      };
      runTracker(f, notifyEnv, ["--power-event"]);

      const args = fs
        .readFileSync(notificationLog, "utf8")
        .split("\0")
        .filter(Boolean);
      const description = args[args.length - 1];
      assert.match(description, /BAT1: 80% → removed/);
    });
  });

  test("reports a battery added mid-session as added", () => {
    withBatteryFixture((f) => {
    const notifier = path.join(f.state, "notifier");
    const notificationLog = path.join(f.state, "notifications");
      fs.writeFileSync(
        notifier,
        '#!/usr/bin/env bash\nprintf \'%s\\0\' "$@" >> "$BATTERY_NOTIFICATION_LOG"\n',
        { mode: 0o700 },
      );
      writeBattery(f.root, "BAT0", {
        present: 1,
        capacity: 30,
        status: "Discharging",
      });
      writeBattery(f.root, "AC", { type: "Mains", online: 1 });
      fs.writeFileSync(path.join(f.root, "BAT0", "status"), "Charging\n");
      runTracker(f, {}, ["--power-event"]);

      writeBattery(f.root, "BAT1", {
        present: 1,
        capacity: 80,
        status: "Discharging",
      });
      fs.writeFileSync(path.join(f.root, "AC", "online"), "0\n");
      fs.writeFileSync(path.join(f.root, "BAT0", "status"), "Discharging\n");
      const notifyEnv = {
        BATTERY_SESSION_NOTIFY_COMMAND: notifier,
        BATTERY_NOTIFICATION_LOG: notificationLog,
      };
      runTracker(f, notifyEnv, ["--power-event"]);

      const args = fs
        .readFileSync(notificationLog, "utf8")
        .split("\0")
        .filter(Boolean);
      const description = args[args.length - 1];
      assert.match(description, /BAT1: added at 80%/);
    });
  });

  test("records charger removal as the end of charging", () => {
    withBatteryFixture((f) => {
      fs.mkdirSync(path.join(f.root, "AC"));
      fs.writeFileSync(path.join(f.root, "AC", "type"), "Mains\n");
      fs.writeFileSync(path.join(f.root, "AC", "online"), "1\n");
      runTracker(f);
      fs.writeFileSync(path.join(f.root, "AC", "online"), "0\n");
      const state = runTracker(f);
      assert.match(state, /^previous_state=on-battery$/m);
      assert.match(state, /^state_since=[1-9][0-9]*$/m);
      assert.match(state, /^last_charge_end=[1-9][0-9]*$/m);
      fs.writeFileSync(path.join(f.root, "AC", "online"), "1\n");
      const reconnectedState = runTracker(f);
      assert.match(reconnectedState, /^previous_state=on-charge$/m);
      assert.match(reconnectedState, /^last_charge_end=0$/m);
    });
  });

  test("starts a new observed session after a long observation gap", () => {
    withBatteryFixture((f) => {
      fs.writeFileSync(
        path.join(f.state, "state"),
        [
          "previous_state=on-battery",
          "state_since=100",
          "last_charge_end=0",
          "last_charge_start=0",
          "last_observed=100",
          "",
        ].join("\n"),
      );
      const state = runTracker(f, { BATTERY_SESSION_NOW: "1000" });
      assert.match(state, /^previous_state=on-battery$/m);
      assert.match(state, /^state_since=1000$/m);
      assert.match(state, /^state_since_at_least=1$/m);
    });
  });

  test("tracks a battery that has no present file", () => {
    withFixture({ root: "battery-power", state: "battery-state" }, (f) => {
      fs.mkdirSync(path.join(f.root, "BAT0"));
      fs.writeFileSync(path.join(f.root, "BAT0", "status"), "Discharging\n");
      fs.writeFileSync(path.join(f.root, "BAT0", "capacity"), "57\n");
      execFileSync(tracker, [], {
        env: {
          ...process.env,
          POWER_SUPPLY_ROOT: f.root,
          BATTERY_SESSION_STATE_DIR: f.state,
        },
      });
      assert.equal(fs.existsSync(path.join(f.state, "state")), true);
    });
  });

  test("does not create state on a desktop without a battery", () => {
    withFixture({ root: "battery-power", state: "battery-state" }, (f) => {
      execFileSync(tracker, [], {
        env: {
          ...process.env,
          POWER_SUPPLY_ROOT: f.root,
          BATTERY_SESSION_STATE_DIR: f.state,
        },
      });
      assert.equal(fs.existsSync(path.join(f.state, "state")), false);
    });
  });

});