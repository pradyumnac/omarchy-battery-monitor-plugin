const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { withFixture, executable } = require("./support/fixture");

const monitor = path.join(
  __dirname,
  "..",
  "service",
  "battery-session-monitor.sh",
);

function writePowerSupply(root, batteryStatus) {
  const ac = path.join(root, "AC");
  fs.mkdirSync(ac);
  fs.writeFileSync(path.join(ac, "type"), "Mains\n");
  fs.writeFileSync(path.join(ac, "online"), "0\n");
  const battery = path.join(root, "BAT0");
  fs.mkdirSync(battery);
  fs.writeFileSync(path.join(battery, "present"), "1\n");
  fs.writeFileSync(path.join(battery, "status"), `${batteryStatus}\n`);
}

function runMonitor(f, monitorScript, extraEnv = {}) {
  const monitorStub = path.join(f.work, "upower-monitor");
  const trackerStub = path.join(f.work, "tracker");
  const trackerLog = path.join(f.work, "tracker-log");
  executable(monitorStub, monitorScript);
  executable(
    trackerStub,
    '#!/usr/bin/env bash\nprintf \'%s\\n\' "$*" >> "$BATTERY_TRACKER_LOG"\n',
  );

  execFileSync(monitor, [], {
    env: {
      ...process.env,
      POWER_SUPPLY_ROOT: f.root,
      BATTERY_SESSION_MONITOR_COMMAND: monitorStub,
      BATTERY_SESSION_TRACKER_COMMAND: trackerStub,
      BATTERY_TRACKER_LOG: trackerLog,
      ...extraEnv,
    },
    timeout: 5000,
  });

  return trackerLog;
}

test("waits for a battery charging event before notifying", () => {
  withFixture({ root: "monitor-power", work: "monitor-state" }, (f) => {
    writePowerSupply(f.root, "Discharging");
    const trackerLog = runMonitor(
      f,
      "#!/usr/bin/env bash\nprintf '1\\n' > \"$POWER_SUPPLY_ROOT/AC/online\"\nprintf 'device changed: /org/freedesktop/UPower/devices/line_power_AC\\n'\nsleep 0.1\nprintf 'Charging\\n' > \"$POWER_SUPPLY_ROOT/BAT0/status\"\nprintf 'device changed: /org/freedesktop/UPower/devices/battery_BAT0\\n'\n",
    );
    assert.equal(fs.readFileSync(trackerLog, "utf8"), "--once\n--power-event\n");
  });
});

test("reports charging status after a timeout when no battery ever starts charging", () => {
  withFixture({ root: "monitor-power", work: "monitor-state" }, (f) => {
    // The battery is already above its charge threshold, so it never
    // transitions to "Charging" once AC comes online.
    writePowerSupply(f.root, "Not charging");
    const trackerLog = runMonitor(
      f,
      "#!/usr/bin/env bash\nprintf '1\\n' > \"$POWER_SUPPLY_ROOT/AC/online\"\nprintf 'device changed: /org/freedesktop/UPower/devices/line_power_AC\\n'\nsleep 2\n",
      { BATTERY_SESSION_PENDING_TIMEOUT: "1" },
    );
    assert.equal(fs.readFileSync(trackerLog, "utf8"), "--once\n--power-event\n");
  });
});

test("ignores non-line-power UPower events", () => {
  withFixture({ root: "monitor-power", work: "monitor-state" }, (f) => {
    const trackerLog = runMonitor(
      f,
      "#!/usr/bin/env bash\nprintf 'device changed: /org/freedesktop/UPower/devices/battery_BAT0\\n'\n",
    );
    assert.equal(fs.existsSync(trackerLog), false);
  });
});
