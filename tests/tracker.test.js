const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const tracker = path.join(
  __dirname,
  "..",
  "tracker",
  "battery-session-tracker",
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
    assert.equal(args[9], "BAT0 · 20%");
    assert.equal(args.length, 10);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
    fs.rmSync(f.state, { recursive: true, force: true });
  }
});

test("uses Plugged without listing held batteries as charging", () => {
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
      capacity: 80,
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
    assert.equal(args[9], "No battery is charging");
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

test("does not continue a session after a long observation gap", () => {
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
    const state = runTracker(f);
    assert.match(state, /^previous_state=on-battery$/m);
    assert.match(state, /^state_since=0$/m);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
    fs.rmSync(f.state, { recursive: true, force: true });
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
