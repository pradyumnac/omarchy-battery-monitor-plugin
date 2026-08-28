const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const monitor = path.join(
  __dirname,
  "..",
  "service",
  "battery-session-monitor.sh",
);
const testRoot = path.join(
  os.homedir(),
  ".cache",
  "omarchy-battery-monitor-plugin-tests",
);
fs.mkdirSync(testRoot, { recursive: true });

function executable(file, content) {
  fs.writeFileSync(file, content, { mode: 0o700 });
}

test("waits for a battery charging event before notifying", () => {
  const root = fs.mkdtempSync(path.join(testRoot, "monitor-power-"));
  const work = fs.mkdtempSync(path.join(testRoot, "monitor-state-"));
  const monitorStub = path.join(work, "upower-monitor");
  const trackerStub = path.join(work, "tracker");
  const trackerLog = path.join(work, "tracker-log");
  try {
    const ac = path.join(root, "AC");
    fs.mkdirSync(ac);
    fs.writeFileSync(path.join(ac, "type"), "Mains\n");
    fs.writeFileSync(path.join(ac, "online"), "0\n");
    const battery = path.join(root, "BAT0");
    fs.mkdirSync(battery);
    fs.writeFileSync(path.join(battery, "present"), "1\n");
    fs.writeFileSync(path.join(battery, "status"), "Discharging\n");
    executable(
      monitorStub,
      "#!/usr/bin/env bash\nprintf '1\\n' > \"$POWER_SUPPLY_ROOT/AC/online\"\nprintf 'device changed: /org/freedesktop/UPower/devices/line_power_AC\\n'\nsleep 0.1\nprintf 'Charging\\n' > \"$POWER_SUPPLY_ROOT/BAT0/status\"\nprintf 'device changed: /org/freedesktop/UPower/devices/battery_BAT0\\n'\n",
    );
    executable(
      trackerStub,
      '#!/usr/bin/env bash\nprintf \'%s\\n\' "$*" >> "$BATTERY_TRACKER_LOG"\n',
    );

    execFileSync(monitor, [], {
      env: {
        ...process.env,
        POWER_SUPPLY_ROOT: root,
        BATTERY_SESSION_MONITOR_COMMAND: monitorStub,
        BATTERY_SESSION_TRACKER_COMMAND: trackerStub,
        BATTERY_TRACKER_LOG: trackerLog,
      },
    });

    assert.equal(
      fs.readFileSync(trackerLog, "utf8"),
      "--once\n--power-event\n",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test("reports charging status after a timeout when no battery ever starts charging", () => {
  const root = fs.mkdtempSync(path.join(testRoot, "monitor-power-"));
  const work = fs.mkdtempSync(path.join(testRoot, "monitor-state-"));
  const monitorStub = path.join(work, "upower-monitor");
  const trackerStub = path.join(work, "tracker");
  const trackerLog = path.join(work, "tracker-log");
  try {
    const ac = path.join(root, "AC");
    fs.mkdirSync(ac);
    fs.writeFileSync(path.join(ac, "type"), "Mains\n");
    fs.writeFileSync(path.join(ac, "online"), "0\n");
    const battery = path.join(root, "BAT0");
    fs.mkdirSync(battery);
    fs.writeFileSync(path.join(battery, "present"), "1\n");
    // The battery is already above its charge threshold, so it never
    // transitions to "Charging" once AC comes online.
    fs.writeFileSync(path.join(battery, "status"), "Not charging\n");
    executable(
      monitorStub,
      "#!/usr/bin/env bash\nprintf '1\\n' > \"$POWER_SUPPLY_ROOT/AC/online\"\nprintf 'device changed: /org/freedesktop/UPower/devices/line_power_AC\\n'\nsleep 2\n",
    );
    executable(
      trackerStub,
      '#!/usr/bin/env bash\nprintf \'%s\\n\' "$*" >> "$BATTERY_TRACKER_LOG"\n',
    );

    execFileSync(monitor, [], {
      env: {
        ...process.env,
        POWER_SUPPLY_ROOT: root,
        BATTERY_SESSION_MONITOR_COMMAND: monitorStub,
        BATTERY_SESSION_TRACKER_COMMAND: trackerStub,
        BATTERY_TRACKER_LOG: trackerLog,
        BATTERY_SESSION_PENDING_TIMEOUT: "1",
      },
      timeout: 5000,
    });

    assert.equal(
      fs.readFileSync(trackerLog, "utf8"),
      "--once\n--power-event\n",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test("ignores non-line-power UPower events", () => {
  const root = fs.mkdtempSync(path.join(testRoot, "monitor-power-"));
  const work = fs.mkdtempSync(path.join(testRoot, "monitor-state-"));
  const monitorStub = path.join(work, "upower-monitor");
  const trackerStub = path.join(work, "tracker");
  const trackerLog = path.join(work, "tracker-log");
  try {
    executable(
      monitorStub,
      "#!/usr/bin/env bash\nprintf 'device changed: /org/freedesktop/UPower/devices/battery_BAT0\\n'\n",
    );
    executable(
      trackerStub,
      '#!/usr/bin/env bash\nprintf \'%s\\n\' "$*" >> "$BATTERY_TRACKER_LOG"\n',
    );

    execFileSync(monitor, [], {
      env: {
        ...process.env,
        POWER_SUPPLY_ROOT: root,
        BATTERY_SESSION_MONITOR_COMMAND: monitorStub,
        BATTERY_SESSION_TRACKER_COMMAND: trackerStub,
        BATTERY_TRACKER_LOG: trackerLog,
      },
    });

    assert.equal(fs.existsSync(trackerLog), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  }
});
