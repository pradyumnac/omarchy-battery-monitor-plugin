const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

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
const testRoot = path.join(
  os.homedir(),
  ".cache",
  "omarchy-battery-monitor-plugin-tests",
);
fs.mkdirSync(testRoot, { recursive: true });

test("preflight fails on a desktop with no battery", () => {
  const root = fs.mkdtempSync(path.join(testRoot, "preflight-nobattery-"));
  try {
    const ac = path.join(root, "AC");
    fs.mkdirSync(ac);
    fs.writeFileSync(path.join(ac, "type"), "Mains\n");
    fs.writeFileSync(path.join(ac, "online"), "1\n");

    const result = spawnSync(preflight, [], {
      env: { ...process.env, POWER_SUPPLY_ROOT: root },
      encoding: "utf8",
    });

    assert.equal(result.status, 1);
    assert.match(result.stdout, /\[fail\]\s+no present battery/);
    assert.match(result.stderr, /refusing to install/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("preflight fails when a required command is missing", () => {
  const root = fs.mkdtempSync(path.join(testRoot, "preflight-battery-"));
  try {
    const battery = path.join(root, "BAT0");
    fs.mkdirSync(battery);
    fs.writeFileSync(path.join(battery, "present"), "1\n");

    const result = spawnSync(preflight, [], {
      env: {
        ...process.env,
        POWER_SUPPLY_ROOT: root,
        BATTERY_SESSION_MONITOR_COMMAND: "definitely-not-a-real-command",
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 1);
    assert.match(
      result.stdout,
      /\[fail\]\s+definitely-not-a-real-command not found/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("preflight passes when a battery and all commands are present", () => {
  const root = fs.mkdtempSync(path.join(testRoot, "preflight-ready-"));
  try {
    const battery = path.join(root, "BAT0");
    fs.mkdirSync(battery);
    fs.writeFileSync(path.join(battery, "present"), "1\n");

    const result = spawnSync(preflight, [], {
      env: { ...process.env, POWER_SUPPLY_ROOT: root },
      encoding: "utf8",
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Ready to install\./);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("preflight accepts a battery with no present file", () => {
  const root = fs.mkdtempSync(path.join(testRoot, "preflight-nopresent-"));
  try {
    const battery = path.join(root, "BAT0");
    fs.mkdirSync(battery);
    fs.writeFileSync(path.join(battery, "status"), "Discharging\n");
    fs.writeFileSync(path.join(battery, "capacity"), "57\n");

    const result = spawnSync(preflight, [], {
      env: { ...process.env, POWER_SUPPLY_ROOT: root },
      encoding: "utf8",
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Ready to install\./);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("installer refuses to install on a machine with no battery", () => {
  const root = fs.mkdtempSync(path.join(testRoot, "install-nobattery-"));
  const plugin = fs.mkdtempSync(path.join(testRoot, "install-plugin-"));
  try {
    const result = spawnSync(installer, [], {
      env: {
        ...process.env,
        POWER_SUPPLY_ROOT: root,
        PLUGIN_DIR: plugin,
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 1);
    assert.match(result.stdout, /\[fail\]\s+no present battery/);
    assert.equal(fs.existsSync(path.join(plugin, "scripts")), false);
    assert.equal(fs.existsSync(path.join(plugin, "service")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(plugin, { recursive: true, force: true });
  }
});
