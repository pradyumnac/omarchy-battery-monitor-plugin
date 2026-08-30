const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { withFixture } = require("./support/fixture");

const preflight = path.join(
  __dirname,
  "..",
  "scripts",
  "battery-session-preflight.sh",
);
const installer = path.join(
  __dirname,
  "..",
  "scripts",
  "install-session-tracker.sh",
);

test("preflight fails on a desktop with no battery", () => {
  withFixture({ root: "preflight-nobattery" }, (f) => {
    const ac = path.join(f.root, "AC");
    fs.mkdirSync(ac);
    fs.writeFileSync(path.join(ac, "type"), "Mains\n");
    fs.writeFileSync(path.join(ac, "online"), "1\n");

    const result = spawnSync(preflight, [], {
      env: { ...process.env, POWER_SUPPLY_ROOT: f.root },
      encoding: "utf8",
    });

    assert.equal(result.status, 1);
    assert.match(result.stdout, /\[fail\]\s+no present battery/);
    assert.match(result.stderr, /refusing to install/);
  });
});

test("preflight fails when a required command is missing", () => {
  withFixture({ root: "preflight-battery" }, (f) => {
    const battery = path.join(f.root, "BAT0");
    fs.mkdirSync(battery);
    fs.writeFileSync(path.join(battery, "present"), "1\n");

    const result = spawnSync(preflight, [], {
      env: {
        ...process.env,
        POWER_SUPPLY_ROOT: f.root,
        BATTERY_SESSION_MONITOR_COMMAND: "definitely-not-a-real-command",
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 1);
    assert.match(
      result.stdout,
      /\[fail\]\s+definitely-not-a-real-command not found/,
    );
  });
});

test("preflight passes when a battery and all commands are present", () => {
  withFixture({ root: "preflight-ready" }, (f) => {
    const battery = path.join(f.root, "BAT0");
    fs.mkdirSync(battery);
    fs.writeFileSync(path.join(battery, "present"), "1\n");

    const result = spawnSync(preflight, [], {
      env: { ...process.env, POWER_SUPPLY_ROOT: f.root },
      encoding: "utf8",
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Ready to install\./);
  });
});

test("preflight accepts a battery with no present file", () => {
  withFixture({ root: "preflight-nopresent" }, (f) => {
    const battery = path.join(f.root, "BAT0");
    fs.mkdirSync(battery);
    fs.writeFileSync(path.join(battery, "status"), "Discharging\n");
    fs.writeFileSync(path.join(battery, "capacity"), "57\n");

    const result = spawnSync(preflight, [], {
      env: { ...process.env, POWER_SUPPLY_ROOT: f.root },
      encoding: "utf8",
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Ready to install\./);
  });
});

test("installer refuses to install on a machine with no battery", () => {
  withFixture({ root: "install-nobattery", plugin: "install-plugin" }, (f) => {
    const result = spawnSync(installer, [], {
      env: {
        ...process.env,
        POWER_SUPPLY_ROOT: f.root,
        PLUGIN_DIR: f.plugin,
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 1);
    assert.match(result.stdout, /\[fail\]\s+no present battery/);
    assert.equal(fs.existsSync(path.join(f.plugin, "scripts")), false);
    assert.equal(fs.existsSync(path.join(f.plugin, "service")), false);
  });
});
