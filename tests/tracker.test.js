const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const tracker = path.join(
  __dirname,
  "..",
  "service",
  "battery-session-tracker.sh",
);
const testRoot = path.join(
  os.homedir(),
  ".cache",
  "omarchy-battery-monitor-plugin-tests",
);
fs.mkdirSync(testRoot, { recursive: true });

function fixture() {
  const root = fs.mkdtempSync(path.join(testRoot, "battery-power-"));
  const state = fs.mkdtempSync(path.join(testRoot, "battery-state-"));
  fs.mkdirSync(path.join(root, "BAT0"));
  fs.writeFileSync(path.join(root, "BAT0", "present"), "1\n");
  return { root, state };
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

test("computes usual full runtime from seeded discharge history", () => {
  const f = fixture();
  try {
    writeBattery(f.root, "BAT0", {
      present: 1,
      status: "Discharging",
      energy_now: 40000000,
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
      "1110\tsession-c\t9000\t50000000",
    ]);

    const state = runTracker(f, { BATTERY_SESSION_NOW: "2000" });
    assert.match(state, /^battery_energy_now_uwh=40000000$/m);
    assert.match(state, /^battery_usable_capacity_uwh=50000000$/m);
    assert.match(state, /^usual_remaining_runtime_seconds=14400$/m);
    assert.match(state, /^usual_full_runtime_seconds=18000$/m);
    assert.match(state, /^usual_sample_count=12$/m);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
    fs.rmSync(f.state, { recursive: true, force: true });
  }
});

test("records a 15-minute discharge window and updates usual runtime", () => {
  const f = fixture();
  try {
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
    const state = runTracker(f, { BATTERY_SESSION_NOW: "1900" });
    assert.match(state, /^usual_full_runtime_seconds=18000$/m);
    assert.match(state, /^usual_sample_count=12$/m);
    assert.match(
      fs.readFileSync(path.join(f.state, "discharge-history.tsv"), "utf8"),
      /1900\t[0-9]+\t10000\t50000000/,
    );
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
    fs.rmSync(f.state, { recursive: true, force: true });
  }
});

test("retains only recent valid history rows and adjusts for current capacity", () => {
  const f = fixture();
  try {
    writeBattery(f.root, "BAT0", {
      present: 1,
      status: "Discharging",
      energy_full: 40000000,
    });
    const rows = [
      "4000000\told-session\t10000\t50000000",
      ...Array.from({ length: 100 }, (_, index) => {
        const session =
          index % 3 === 0
            ? "session-a"
            : index % 3 === 1
              ? "session-b"
              : "session-c";
        const draw = index === 99 ? 100000 : 10000;
        return `${19990000 + index}\t${session}\t${draw}\t50000000`;
      }),
    ];
    writeHistory(f.state, rows);

    const state = runTracker(f, { BATTERY_SESSION_NOW: "20000000" });
    const history = fs
      .readFileSync(path.join(f.state, "discharge-history.tsv"), "utf8")
      .trim()
      .split("\n");
    assert.equal(history.length, 97);
    assert.equal(history[0], "# battery-discharge-history\tv1");
    assert.match(history[1], /^19990004\t/);
    assert.doesNotMatch(history.join("\n"), /old-session/);
    assert.match(state, /^usual_full_runtime_seconds=14400$/m);
    assert.match(state, /^usual_sample_count=96$/m);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
    fs.rmSync(f.state, { recursive: true, force: true });
  }
});

test("uses recent observations while retaining older back-reference data", () => {
  const f = fixture();
  try {
    writeBattery(f.root, "BAT0", { present: 1, energy_full: 50000000 });
    const older = Array.from(
      { length: 12 },
      (_, index) => `${17000000 + index}\told-${index % 3}\t20000\t50000000`,
    );
    const recent = Array.from(
      { length: 12 },
      (_, index) => `${19990000 + index}\tnew-${index % 3}\t10000\t50000000`,
    );
    writeHistory(f.state, [...older, ...recent]);

    const state = runTracker(f, { BATTERY_SESSION_NOW: "20000000" });
    const history = fs.readFileSync(
      path.join(f.state, "discharge-history.tsv"),
      "utf8",
    );
    assert.match(state, /^usual_full_runtime_seconds=18000$/m);
    assert.match(state, /^usual_sample_count=12$/m);
    assert.match(history, /17000000\told-0\t20000/);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
    fs.rmSync(f.state, { recursive: true, force: true });
  }
});

test("ignores future-dated observations in the model", () => {
  const f = fixture();
  try {
    writeBattery(f.root, "BAT0", { present: 1, energy_full: 50000000 });
    const recent = Array.from(
      { length: 11 },
      (_, index) => `${19990000 + index}\trecent-${index % 3}\t10000\t50000000`,
    );
    writeHistory(f.state, [
      ...recent,
      "20000100\tfuture-session\t10000\t50000000",
    ]);

    const state = runTracker(f, { BATTERY_SESSION_NOW: "20000000" });
    assert.match(state, /^usual_full_runtime_seconds=0$/m);
    assert.match(state, /^usual_sample_count=0$/m);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
    fs.rmSync(f.state, { recursive: true, force: true });
  }
});

test("uses the median instead of an outlier for an odd sample set", () => {
  const f = fixture();
  try {
    writeBattery(f.root, "BAT0", { present: 1, energy_full: 50000000 });
    writeHistory(f.state, [
      "100\ta\t8000\t50000000",
      "200\ta\t9000\t50000000",
      "300\tb\t10000\t50000000",
      "400\tb\t11000\t50000000",
      "500\tc\t12000\t50000000",
      "600\tc\t100000\t50000000",
      "700\ta\t10000\t50000000",
      "800\tb\t10000\t50000000",
      "900\tc\t10000\t50000000",
      "1000\ta\t10000\t50000000",
      "1100\tb\t10000\t50000000",
      "1200\tc\t10000\t50000000",
      "1300\ta\t10000\t50000000",
    ]);
    const state = runTracker(f, { BATTERY_SESSION_NOW: "2000" });
    assert.match(state, /^usual_full_runtime_seconds=18000$/m);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
    fs.rmSync(f.state, { recursive: true, force: true });
  }
});

test("resets a discharge window when energy increases", () => {
  const f = fixture();
  try {
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
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
    fs.rmSync(f.state, { recursive: true, force: true });
  }
});

test("does not bridge a long polling gap into a discharge window", () => {
  const f = fixture();
  try {
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
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
    fs.rmSync(f.state, { recursive: true, force: true });
  }
});

test("rejects an implausibly high discharge draw", () => {
  const f = fixture();
  try {
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
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
    fs.rmSync(f.state, { recursive: true, force: true });
  }
});

test("resets sampling when energy data is missing or zero", () => {
  const f = fixture();
  try {
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
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
    fs.rmSync(f.state, { recursive: true, force: true });
  }
});

test("resets sampling when the clock moves backwards", () => {
  const f = fixture();
  try {
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
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
    fs.rmSync(f.state, { recursive: true, force: true });
  }
});

test("aggregates compatible batteries into one discharge window", () => {
  const f = fixture();
  try {
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
      /1900\t[0-9]+\t10000\t100000000/,
    );
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
    fs.rmSync(f.state, { recursive: true, force: true });
  }
});

test("invalidates only the active window when a battery is added", () => {
  const f = fixture();
  try {
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
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
    fs.rmSync(f.state, { recursive: true, force: true });
  }
});

test("invalidates only the active window when a battery is removed", () => {
  const f = fixture();
  try {
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
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
    fs.rmSync(f.state, { recursive: true, force: true });
  }
});

test("rejects mixed battery energy measurement modes", () => {
  const f = fixture();
  try {
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
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
    fs.rmSync(f.state, { recursive: true, force: true });
  }
});

test("ignores unknown history schemas safely", () => {
  const f = fixture();
  try {
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
    assert.match(state, /^usual_full_runtime_seconds=0$/m);
    assert.match(state, /^window_reset_reason=energy-unavailable$/m);
    assert.equal(
      fs
        .readFileSync(path.join(f.state, "discharge-history.tsv"), "utf8")
        .split("\n")[0],
      "# battery-discharge-history\tv99",
    );
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
    fs.rmSync(f.state, { recursive: true, force: true });
  }
});

test("writes runtime state and history as user-only files", () => {
  const f = fixture();
  try {
    writeBattery(f.root, "BAT0", {
      present: 1,
      status: "Discharging",
      energy_full: 50000000,
    });
    writeHistory(f.state, [
      ...Array.from(
        { length: 12 },
        (_, index) =>
          `${1000 + index}\\tsession-${index % 3}\\t10000\\t50000000`,
      ),
    ]);
    runTracker(f, { BATTERY_SESSION_NOW: "2000" });
    assert.equal(fs.statSync(path.join(f.state, "state")).mode & 0o777, 0o600);
    assert.equal(
      fs.statSync(path.join(f.state, "discharge-history.tsv")).mode & 0o777,
      0o600,
    );
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
    fs.rmSync(f.state, { recursive: true, force: true });
  }
});

test("detects a non-AC-named mains supply", () => {
  const f = fixture();
  try {
    fs.mkdirSync(path.join(f.root, "ADP1"));
    fs.writeFileSync(path.join(f.root, "ADP1", "type"), "Mains\n");
    fs.writeFileSync(path.join(f.root, "ADP1", "online"), "1\n");
    assert.match(runTracker(f), /^previous_state=on-charge$/m);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
    fs.rmSync(f.state, { recursive: true, force: true });
  }
});

test("starts an observed session when the initial state is already on battery", () => {
  const f = fixture();
  try {
    writeBattery(f.root, "BAT0", { present: 1, status: "Discharging" });
    const state = runTracker(f, { BATTERY_SESSION_NOW: "1234" });
    assert.match(state, /^previous_state=on-battery$/m);
    assert.match(state, /^state_since=1234$/m);
    assert.match(state, /^state_since_at_least=1$/m);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
    fs.rmSync(f.state, { recursive: true, force: true });
  }
});

test("recovers a missing timestamp in an existing battery session", () => {
  const f = fixture();
  try {
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
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
    fs.rmSync(f.state, { recursive: true, force: true });
  }
});

test("records an observed battery-to-charge transition", () => {
  const f = fixture();
  try {
    assert.match(runTracker(f), /^previous_state=on-battery$/m);
    fs.mkdirSync(path.join(f.root, "USB"));
    fs.writeFileSync(path.join(f.root, "USB", "type"), "Mains\n");
    fs.writeFileSync(path.join(f.root, "USB", "online"), "1\n");
    const state = runTracker(f);
    assert.match(state, /^previous_state=on-charge$/m);
    assert.match(state, /^state_since=[1-9][0-9]*$/m);
    assert.match(state, /^state_since_at_least=0$/m);
    assert.match(state, /^last_charge_start=[1-9][0-9]*$/m);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
    fs.rmSync(f.state, { recursive: true, force: true });
  }
});

test("notifies once with dual-battery charging details", () => {
  const f = fixture();
  const notifier = path.join(f.state, "notifier");
  const notificationLog = path.join(f.state, "notifications");
  try {
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
    assert.equal(args[9], "BAT0 · 20%\n⚠ Charge threshold:\nBAT1 · 80%");
    assert.equal(args.length, 10);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
    fs.rmSync(f.state, { recursive: true, force: true });
  }
});

test("uses Plugged with a charge-threshold block when a battery is held", () => {
  const f = fixture();
  const notifier = path.join(f.state, "notifier");
  const notificationLog = path.join(f.state, "notifications");
  try {
    fs.writeFileSync(
      notifier,
      '#!/usr/bin/env bash\nprintf \'%s\\0\' "$@" >> "$BATTERY_NOTIFICATION_LOG"\n',
      { mode: 0o700 },
    );
    writeBattery(f.root, "BAT0", {
      present: 1,
      capacity: 95,
      status: "Not charging",
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
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
    fs.rmSync(f.state, { recursive: true, force: true });
  }
});

test("omits unavailable charging statistics for one battery", () => {
  const f = fixture();
  const notifier = path.join(f.state, "notifier");
  const notificationLog = path.join(f.state, "notifications");
  try {
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
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
    fs.rmSync(f.state, { recursive: true, force: true });
  }
});

test("persists a transition when notification delivery fails", () => {
  const f = fixture();
  const notifier = path.join(f.state, "failing-notifier");
  try {
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
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
    fs.rmSync(f.state, { recursive: true, force: true });
  }
});

test("summarizes a dual-battery charging session on unplug", () => {
  const f = fixture();
  const notifier = path.join(f.state, "notifier");
  const notificationLog = path.join(f.state, "notifications");
  try {
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
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
    fs.rmSync(f.state, { recursive: true, force: true });
  }
});

test("unplug omits duration and deltas when the charge start is unknown", () => {
  const f = fixture();
  const notifier = path.join(f.state, "notifier");
  const notificationLog = path.join(f.state, "notifications");
  try {
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
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
    fs.rmSync(f.state, { recursive: true, force: true });
  }
});

test("reports a battery removed mid-session as removed", () => {
  const f = fixture();
  const notifier = path.join(f.state, "notifier");
  const notificationLog = path.join(f.state, "notifications");
  try {
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
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
    fs.rmSync(f.state, { recursive: true, force: true });
  }
});

test("reports a battery added mid-session as added", () => {
  const f = fixture();
  const notifier = path.join(f.state, "notifier");
  const notificationLog = path.join(f.state, "notifications");
  try {
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
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
    fs.rmSync(f.state, { recursive: true, force: true });
  }
});

test("records charger removal as the end of charging", () => {
  const f = fixture();
  try {
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
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
    fs.rmSync(f.state, { recursive: true, force: true });
  }
});

test("starts a new observed session after a long observation gap", () => {
  const f = fixture();
  try {
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
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
    fs.rmSync(f.state, { recursive: true, force: true });
  }
});

test("tracks a battery that has no present file", () => {
  const root = fs.mkdtempSync(path.join(testRoot, "battery-power-"));
  const state = fs.mkdtempSync(path.join(testRoot, "battery-state-"));
  try {
    fs.mkdirSync(path.join(root, "BAT0"));
    fs.writeFileSync(path.join(root, "BAT0", "status"), "Discharging\n");
    fs.writeFileSync(path.join(root, "BAT0", "capacity"), "57\n");
    execFileSync(tracker, [], {
      env: {
        ...process.env,
        POWER_SUPPLY_ROOT: root,
        BATTERY_SESSION_STATE_DIR: state,
      },
    });
    assert.equal(fs.existsSync(path.join(state, "state")), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test("does not create state on a desktop without a battery", () => {
  const root = fs.mkdtempSync(path.join(testRoot, "battery-power-"));
  const state = fs.mkdtempSync(path.join(testRoot, "battery-state-"));
  try {
    execFileSync(tracker, [], {
      env: {
        ...process.env,
        POWER_SUPPLY_ROOT: root,
        BATTERY_SESSION_STATE_DIR: state,
      },
    });
    assert.equal(fs.existsSync(path.join(state, "state")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(state, { recursive: true, force: true });
  }
});
