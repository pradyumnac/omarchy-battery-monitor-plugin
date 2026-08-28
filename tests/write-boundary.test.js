const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const tracker = path.join(
  __dirname,
  "..",
  "service",
  "battery-session-tracker.sh",
);
const installer = path.join(
  __dirname,
  "..",
  "scripts",
  "install-session-tracker.sh",
);

test("tracker rejects a state path outside the user home", () => {
  const result = spawnSync(tracker, [], {
    env: {
      ...process.env,
      BATTERY_SESSION_STATE_DIR: "/var/lib/omarchy-battery-monitor-forbidden",
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Refusing state path outside HOME/);
});

test("installer rejects a plugin path outside the user home", () => {
  const result = spawnSync(installer, [], {
    env: {
      ...process.env,
      PLUGIN_DIR: "/var/lib/omarchy-battery-monitor-forbidden",
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Refusing install path outside HOME/);
});
