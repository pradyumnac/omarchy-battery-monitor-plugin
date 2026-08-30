const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { withFixture } = require("./support/fixture");

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

function writeHistory(state, rows) {
  fs.writeFileSync(
    path.join(state, "discharge-history.tsv"),
    ["# battery-discharge-history\tv1", ...rows].join("\n") + "\n",
  );
}

describe("discharge history recording", () => {
  test("records a 15-minute discharge window", () => {
    withBatteryFixture((f) => {
      writeBattery(f.root, "BAT0", {
        present: 1,
        status: "Discharging",
        energy_now: 50000000,
        energy_full: 50000000,
      });
      writeHistory(f.state, [
        "1000\tsession-a\t10000\t50000000",
        "1010\tsession-a\t9000\t50000000",
        "1020\tsession-a\t11000\t50000000",
        "1030\tsession-a\t10000\t50000000",
        "1040\tsession-a\t12000\t50000000",
        "1050\tsession-b\t10000\t50000000",
        "1060\tsession-b\t9000\t50000000",
        "1070\tsession-b\t11000\t50000000",
        "1080\tsession-b\t10000\t50000000",
        "1090\tsession-c\t12000\t50000000",
        "1100\tsession-c\t10000\t50000000",
      ]);

      runTracker(f, { BATTERY_SESSION_NOW: "1000" });
      for (let timestamp = 1030; timestamp < 1900; timestamp += 30) {
        runTracker(f, { BATTERY_SESSION_NOW: String(timestamp) });
      }
      writeBattery(f.root, "BAT0", { energy_now: 47500000 });
      runTracker(f, { BATTERY_SESSION_NOW: "1900" });
      assert.match(
        fs.readFileSync(path.join(f.state, "discharge-history.tsv"), "utf8"),
        /^1900\t[0-9]+\tBAT0:[^\t]*\t10000\t/m,
      );
    });
  });

  test("keeps per-battery retention when a new window is recorded", () => {
    // Given more recorded windows than the per-battery cap, plus one expired
    // When a new window is recorded
    // Then each battery keeps its own newest windows, so a cell that is
    // swapped in only occasionally is not evicted by a heavily used one
    withBatteryFixture((f) => {
      writeBattery(f.root, "BAT0", {
        present: 1,
        status: "Discharging",
        energy_now: 50000000,
        energy_full: 40000000,
        manufacturer: "LGC",
        model_name: "01AV420",
        serial_number: "1020",
      });
      const other = "BAT9:ACME:SPARE:1";
      const rows = ["# battery-discharge-history\tv3"];
      rows.push(
        `4000000\told\tBAT0:LGC:01AV420:1020\t10000\t1\t1\t1\t1\t1\t1\t1\tDischarging`,
      );
      for (let index = 0; index < 100; index += 1) {
        rows.push(
          `${19990000 + index}\ts${index % 3}\tBAT0:LGC:01AV420:1020\t10000\t1\t1\t1\t1\t1\t1\t1\tDischarging`,
        );
      }
      // A second battery with few windows must survive the prune intact.
      for (let index = 0; index < 3; index += 1) {
        rows.push(
          `${19995000 + index}\tz${index}\t${other}\t4000\t1\t1\t1\t1\t1\t1\t1\tDischarging`,
        );
      }
      fs.writeFileSync(
        path.join(f.state, "discharge-history.tsv"),
        rows.join("\n") + "\n",
      );

      for (const timestamp of [
        19999100, 19999280, 19999460, 19999640, 19999820,
      ]) {
        runTracker(f, { BATTERY_SESSION_NOW: String(timestamp) });
      }
      writeBattery(f.root, "BAT0", { energy_now: 47500000 });
      runTracker(f, { BATTERY_SESSION_NOW: "20000000" });

      const history = fs
        .readFileSync(path.join(f.state, "discharge-history.tsv"), "utf8")
        .trim()
        .split("\n");
      const forBat0 = history.filter((line) => line.includes("BAT0:LGC"));
      const forOther = history.filter((line) => line.includes(other));
      assert.equal(forBat0.length, 96, "BAT0 keeps its own cap, not the file's");
      assert.equal(forOther.length, 3, "the rarely used battery is not evicted");
      assert.doesNotMatch(history.join("\n"), /\told\t/);
    });
  });

  test("drops pack-level rows when migrating an older history", () => {
    // Given a history recorded before evidence was per battery
    // When a window is recorded
    // Then those rows go, rather than lingering as rows no model can attribute
    withBatteryFixture((f) => {
      writeBattery(f.root, "BAT0", {
        present: 1,
        status: "Discharging",
        energy_now: 50000000,
        energy_full: 50000000,
      });
      writeHistory(f.state, ["19990000\ts0\t9000\t50000000"]);

      for (const timestamp of [1000, 1180, 1360, 1540, 1720]) {
        runTracker(f, { BATTERY_SESSION_NOW: String(timestamp) });
      }
      writeBattery(f.root, "BAT0", { energy_now: 47500000 });
      runTracker(f, { BATTERY_SESSION_NOW: "1900" });

      const history = fs.readFileSync(
        path.join(f.state, "discharge-history.tsv"),
        "utf8",
      );
      assert.match(history, /^# battery-discharge-history\tv3$/m);
      assert.doesNotMatch(history, /19990000/);
    });
  });

  test("keeps sampling when a battery recalibrates its reported capacity", () => {
    // Given a cell that adjusts energy_full mid-session, which is ordinary
    // behaviour as it deep-discharges
    // When the next poll arrives
    // Then the open window survives, because capacity drift is not a swap and
    // discarding the window on every adjustment records no evidence at all
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
      const state = runTracker(f, { BATTERY_SESSION_NOW: "1180" });
      assert.match(state, /^window_start_epoch=1000$/m);
      assert.doesNotMatch(state, /battery-set-changed/);
    });
  });

  test("restarts sampling when the battery set really changes", () => {
    // Given a different physical cell in the same slot
    // When the next poll arrives
    // Then the open window is discarded, because its energy accounting spans
    // two different batteries
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

      writeBattery(f.root, "BAT0", { energy_now: 49000000, serial_number: "9999" });
      const state = runTracker(f, { BATTERY_SESSION_NOW: "1180" });
      assert.match(state, /^window_reset_reason=battery-set-changed$/m);
      assert.match(state, /^window_start_epoch=1180$/m);
    });
  });

  test("records only the battery that actually discharged", () => {
    // Given two batteries where only one supplies the system, which is how
    // these packs behave
    // When a window completes
    // Then the idle cell contributes no row, because a row of zeros would bury
    // its real draw
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
        fs.writeFileSync(
          path.join(f.root, "BAT1", "energy_now"),
          `${energy}\n`,
        );
        runTracker(f, { BATTERY_SESSION_NOW: String(timestamp) });
        energy -= 500000;
      }

      const history = fs.readFileSync(
        path.join(f.state, "discharge-history.tsv"),
        "utf8",
      );
      assert.match(history, /BAT1:SMP:01AV425:783/);
      assert.doesNotMatch(history, /BAT0:LGC/);
    });
  });

  test("restarts a window whose per-battery baseline is missing", () => {
    // Given a session opened by a build that stored only the pack total, which
    // is the state an upgrade lands in
    // When the window would otherwise complete
    // Then it restarts and names the reason, instead of silently recording
    // nothing while reporting success
    withBatteryFixture((f) => {
      writeBattery(f.root, "BAT0", {
        present: 1,
        status: "Discharging",
        energy_now: 50000000,
        energy_full: 50000000,
      });
      runTracker(f, { BATTERY_SESSION_NOW: "1000" });
      const statePath = path.join(f.state, "state");
      fs.writeFileSync(
        statePath,
        fs
          .readFileSync(statePath, "utf8")
          .replace(/^window_start_energies=.*$/m, "window_start_energies=''"),
      );

      writeBattery(f.root, "BAT0", { energy_now: 47500000 });
      const state = runTracker(f, { BATTERY_SESSION_NOW: "1180" });
      assert.match(state, /^window_reset_reason=battery-baseline-missing$/m);
      assert.equal(
        fs.existsSync(path.join(f.state, "discharge-history.tsv")),
        false,
      );
    });
  });

  test("does not claim a sample when no battery measurably discharged", () => {
    // Given a window that elapses with the pack draining but no single battery
    // showing a drop of its own
    // When the window completes
    // Then no history is written and the reason says so
    withBatteryFixture((f) => {
      writeBattery(f.root, "BAT0", {
        present: 1,
        status: "Discharging",
        energy_now: 50000000,
        energy_full: 50000000,
      });
      runTracker(f, { BATTERY_SESSION_NOW: "1000" });
      // Rewrite the baseline so the per-battery start is below the current
      // reading while the pack total still shows a drop.
      const statePath = path.join(f.state, "state");
      fs.writeFileSync(
        statePath,
        fs
          .readFileSync(statePath, "utf8")
          .replace(
            /^window_start_energies=.*$/m,
            "window_start_energies=BAT0=40000000",
          )
          .replace(/^window_start_energy_uwh=.*$/m, "window_start_energy_uwh=50000000"),
      );
      writeBattery(f.root, "BAT0", { energy_now: 47500000 });
      // Poll within the gap tolerance so the window survives to complete.
      for (const timestamp of [1180, 1360, 1540, 1720]) {
        runTracker(f, { BATTERY_SESSION_NOW: String(timestamp) });
      }
      const state = runTracker(f, { BATTERY_SESSION_NOW: "1900" });
      assert.match(state, /^window_reset_reason=no-battery-evidence$/m);
      assert.equal(
        fs.existsSync(path.join(f.state, "discharge-history.tsv")),
        false,
      );
    });
  });

  test("records which estimator each battery should project with", () => {
    // Given a completed window
    // When the tracker records it
    // Then it also rescores that battery, so the choice is kept off the
    // panel-refresh path
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
      for (const timestamp of [1000, 1180, 1360, 1540, 1720]) {
        runTracker(f, { BATTERY_SESSION_NOW: String(timestamp) });
      }
      writeBattery(f.root, "BAT0", { energy_now: 47500000 });
      runTracker(f, { BATTERY_SESSION_NOW: "1900" });

      const store = fs.readFileSync(
        path.join(f.state, "estimators.tsv"),
        "utf8",
      );
      assert.match(store, /^# battery-estimators\tv1$/m);
      assert.match(store, /^BAT0:LGC:01AV420:1020\t\w+\t/m);
    });
  });

  test("leaves the history untouched when no window completed", () => {
    withBatteryFixture((f) => {
      writeBattery(f.root, "BAT0", {
        present: 1,
        status: "Discharging",
        energy_now: 50000000,
        energy_full: 50000000,
      });
      // An expired row a prune would remove, if a prune were due.
      writeHistory(f.state, ["4000000\told-session\t10000\t50000000"]);
      const before = fs.readFileSync(
        path.join(f.state, "discharge-history.tsv"),
        "utf8",
      );

      runTracker(f, { BATTERY_SESSION_NOW: "20000000" });
      assert.equal(
        fs.readFileSync(path.join(f.state, "discharge-history.tsv"), "utf8"),
        before,
      );
    });
  });

  test("resets a discharge window when energy increases", () => {
    withBatteryFixture((f) => {
      writeBattery(f.root, "BAT0", {
        present: 1,
        status: "Discharging",
        energy_now: 50000000,
        energy_full: 50000000,
      });
      runTracker(f, { BATTERY_SESSION_NOW: "1000" });
      writeBattery(f.root, "BAT0", { energy_now: 49000000 });
      runTracker(f, { BATTERY_SESSION_NOW: "1030" });
      writeBattery(f.root, "BAT0", { energy_now: 50000000 });
      runTracker(f, { BATTERY_SESSION_NOW: "1060" });
      writeBattery(f.root, "BAT0", { energy_now: 49000000 });
      const state = runTracker(f, { BATTERY_SESSION_NOW: "1090" });
      assert.equal(
        fs.existsSync(path.join(f.state, "discharge-history.tsv")),
        false,
      );
      assert.match(state, /^window_start_epoch=1060$/m);
      assert.match(state, /^window_reset_reason=energy-increased$/m);
    });
  });

  test("does not bridge a long polling gap into a discharge window", () => {
    withBatteryFixture((f) => {
      writeBattery(f.root, "BAT0", {
        present: 1,
        status: "Discharging",
        energy_now: 50000000,
        energy_full: 50000000,
      });
      runTracker(f, { BATTERY_SESSION_NOW: "1000" });
      writeBattery(f.root, "BAT0", { energy_now: 45000000 });
      const state = runTracker(f, { BATTERY_SESSION_NOW: "2000" });
      assert.equal(
        fs.existsSync(path.join(f.state, "discharge-history.tsv")),
        false,
      );
      assert.match(state, /^window_start_epoch=2000$/m);
      assert.match(state, /^window_reset_reason=polling-gap$/m);
    });
  });

  test("rejects an implausibly high discharge draw", () => {
    withBatteryFixture((f) => {
      writeBattery(f.root, "BAT0", {
        present: 1,
        status: "Discharging",
        energy_now: 50000000,
        energy_full: 50000000,
      });
      runTracker(f, { BATTERY_SESSION_NOW: "1000" });
      for (let timestamp = 1030; timestamp < 1900; timestamp += 30) {
        runTracker(f, { BATTERY_SESSION_NOW: String(timestamp) });
      }
      writeBattery(f.root, "BAT0", { energy_now: 10000000 });
      const state = runTracker(f, { BATTERY_SESSION_NOW: "1900" });
      assert.equal(
        fs.existsSync(path.join(f.state, "discharge-history.tsv")),
        false,
      );
      assert.match(state, /^window_start_epoch=1900$/m);
      assert.match(state, /^window_reset_reason=implausible-draw$/m);
    });
  });

  test("resets sampling when energy data is missing or zero", () => {
    withBatteryFixture((f) => {
      writeBattery(f.root, "BAT0", {
        present: 1,
        status: "Discharging",
        energy_full: 50000000,
      });
      runTracker(f, { BATTERY_SESSION_NOW: "1000" });
      writeBattery(f.root, "BAT0", { energy_now: 0 });
      const state = runTracker(f, { BATTERY_SESSION_NOW: "1030" });
      assert.equal(
        fs.existsSync(path.join(f.state, "discharge-history.tsv")),
        false,
      );
      assert.match(state, /^window_start_epoch=0$/m);
      assert.match(state, /^last_sample_energy_uwh=0$/m);
      assert.match(state, /^window_reset_reason=energy-unavailable$/m);
    });
  });

  test("resets sampling when the clock moves backwards", () => {
    withBatteryFixture((f) => {
      writeBattery(f.root, "BAT0", {
        present: 1,
        status: "Discharging",
        energy_now: 50000000,
        energy_full: 50000000,
      });
      runTracker(f, { BATTERY_SESSION_NOW: "1000" });
      writeBattery(f.root, "BAT0", { energy_now: 49000000 });
      const state = runTracker(f, { BATTERY_SESSION_NOW: "900" });
      assert.equal(
        fs.existsSync(path.join(f.state, "discharge-history.tsv")),
        false,
      );
      assert.match(state, /^window_start_epoch=900$/m);
      assert.match(state, /^window_reset_reason=polling-gap$/m);
    });
  });
});

describe("battery topology and aggregation", () => {
  test("aggregates compatible batteries into one discharge window", () => {
    withBatteryFixture((f) => {
      writeBattery(f.root, "BAT0", {
        present: 1,
        status: "Discharging",
        energy_now: 50000000,
        energy_full: 60000000,
      });
      writeBattery(f.root, "BAT1", {
        present: 1,
        status: "Discharging",
        energy_now: 40000000,
        energy_full: 40000000,
      });
      runTracker(f, { BATTERY_SESSION_NOW: "1000" });
      for (let timestamp = 1030; timestamp < 1900; timestamp += 30) {
        runTracker(f, { BATTERY_SESSION_NOW: String(timestamp) });
      }
      writeBattery(f.root, "BAT0", { energy_now: 47500000 });
      const state = runTracker(f, { BATTERY_SESSION_NOW: "1900" });
      assert.match(state, /^window_start_energy_uwh=87500000$/m);
      assert.match(
        fs.readFileSync(path.join(f.state, "discharge-history.tsv"), "utf8"),
        /^1900\t[0-9]+\tBAT0:[^\t]*\t10000\t/m,
      );
    });
  });

  test("invalidates only the active window when a battery is added", () => {
    withBatteryFixture((f) => {
      writeBattery(f.root, "BAT0", {
        present: 1,
        status: "Discharging",
        energy_now: 50000000,
        energy_full: 60000000,
      });
      runTracker(f, { BATTERY_SESSION_NOW: "1000" });
      writeBattery(f.root, "BAT1", {
        present: 1,
        status: "Discharging",
        energy_now: 40000000,
        energy_full: 40000000,
      });
      const state = runTracker(f, { BATTERY_SESSION_NOW: "1030" });
      assert.equal(
        fs.existsSync(path.join(f.state, "discharge-history.tsv")),
        false,
      );
      assert.match(state, /^window_start_epoch=1030$/m);
      assert.match(state, /^window_start_energy_uwh=90000000$/m);
      assert.match(state, /^window_reset_reason=battery-set-changed$/m);
    });
  });

  test("invalidates only the active window when a battery is removed", () => {
    withBatteryFixture((f) => {
      writeBattery(f.root, "BAT0", {
        present: 1,
        status: "Discharging",
        energy_now: 50000000,
        energy_full: 60000000,
      });
      writeBattery(f.root, "BAT1", {
        present: 1,
        status: "Discharging",
        energy_now: 40000000,
        energy_full: 40000000,
      });
      runTracker(f, { BATTERY_SESSION_NOW: "1000" });
      fs.rmSync(path.join(f.root, "BAT1"), { recursive: true });
      const state = runTracker(f, { BATTERY_SESSION_NOW: "1030" });
      assert.equal(
        fs.existsSync(path.join(f.state, "discharge-history.tsv")),
        false,
      );
      assert.match(state, /^window_start_epoch=1030$/m);
      assert.match(state, /^window_start_energy_uwh=50000000$/m);
      assert.match(state, /^window_reset_reason=battery-set-changed$/m);
    });
  });

  test("rejects mixed battery energy measurement modes", () => {
    withBatteryFixture((f) => {
      writeBattery(f.root, "BAT0", {
        present: 1,
        status: "Discharging",
        energy_now: 50000000,
        energy_full: 60000000,
      });
      runTracker(f, { BATTERY_SESSION_NOW: "1000" });
      writeBattery(f.root, "BAT1", {
        present: 1,
        status: "Discharging",
        charge_now: 4000000,
        charge_full: 4000000,
      });
      const state = runTracker(f, { BATTERY_SESSION_NOW: "1030" });
      assert.match(state, /^window_start_epoch=0$/m);
      assert.match(state, /^last_sample_energy_uwh=0$/m);
      assert.match(state, /^window_reset_reason=energy-unavailable$/m);
    });
  });

  test("ignores unknown history schemas safely", () => {
    withBatteryFixture((f) => {
      writeBattery(f.root, "BAT0", {
        present: 1,
        status: "Discharging",
        energy_full: 50000000,
      });
      fs.writeFileSync(
        path.join(f.state, "discharge-history.tsv"),
        [
          "# battery-discharge-history\tv99",
          "1000\ta\t10000\t50000000",
          "1010\tb\t10000\t50000000",
        ].join("\n") + "\n",
      );
      const state = runTracker(f, { BATTERY_SESSION_NOW: "2000" });
      assert.match(state, /^window_reset_reason=energy-unavailable$/m);
      assert.equal(
        fs
          .readFileSync(path.join(f.state, "discharge-history.tsv"), "utf8")
          .split("\n")[0],
        "# battery-discharge-history\tv99",
      );
    });
  });
});

describe("state file permissions", () => {
  test("writes runtime state and history as user-only files", () => {
    withBatteryFixture((f) => {
      writeBattery(f.root, "BAT0", {
        present: 1,
        status: "Discharging",
        energy_now: 50000000,
        energy_full: 50000000,
      });
      for (const timestamp of [1000, 1180, 1360, 1540, 1720]) {
        runTracker(f, { BATTERY_SESSION_NOW: String(timestamp) });
      }
      writeBattery(f.root, "BAT0", { energy_now: 47500000 });
      runTracker(f, { BATTERY_SESSION_NOW: "1900" });

      assert.equal(fs.statSync(path.join(f.state, "state")).mode & 0o777, 0o600);
      assert.equal(
        fs.statSync(path.join(f.state, "discharge-history.tsv")).mode & 0o777,
        0o600,
      );
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