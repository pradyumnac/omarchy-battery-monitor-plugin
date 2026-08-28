const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const statusScript = path.join(
  __dirname,
  "..",
  "scripts",
  "battery-intelligence-status",
);
const testRoot = path.join(
  os.homedir(),
  ".cache",
  "omarchy-battery-monitor-plugin-tests",
);
fs.mkdirSync(testRoot, { recursive: true });

function runStatus(stateDir, extraEnv = {}) {
  return spawnSync(statusScript, [], {
    env: {
      ...process.env,
      BATTERY_SESSION_STATE_DIR: stateDir,
      BATTERY_INTELLIGENCE_NOW: "20000000",
      BATTERY_INTELLIGENCE_SYSTEMCTL_COMMAND: "/bin/true",
      ...extraEnv,
    },
    encoding: "utf8",
  });
}

test("reports model readiness, active window, and recorded history", () => {
  const stateDir = fs.mkdtempSync(path.join(testRoot, "intelligence-status-"));
  try {
    fs.writeFileSync(
      path.join(stateDir, "state"),
      [
        "usual_full_runtime_seconds=18000",
        "usual_sample_count=12",
        "discharge_session_id=19999000",
        "window_start_epoch=19999550",
        "window_start_energy_uwh=40000000",
        "last_sample_energy_uwh=39900000",
        "battery_fingerprint=BAT0:energy:50000000",
      ].join("\n") + "\n",
    );
    fs.writeFileSync(
      path.join(stateDir, "discharge-history.tsv"),
      [
        "# battery-discharge-history\tv1",
        "19999900\tsession-a\t10000\t50000000",
        "19999910\tsession-b\t11000\t50000000",
      ].join("\n") + "\n",
    );

    const result = runStatus(stateDir);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Monitor: active/);
    assert.match(result.stdout, /Poller: active/);
    assert.match(result.stdout, /Workflow: model ready/);
    assert.match(result.stdout, /Usual full runtime: 18000s/);
    assert.match(result.stdout, /Active window: 50% \(450s\/900s\)/);
    assert.match(result.stdout, /History: 2 valid rows \(2 recent \/ 2 sessions\)/);
    assert.match(result.stdout, /Last recorded window: 19999910\tsession-b/);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("reports learning state before any observations", () => {
  const stateDir = fs.mkdtempSync(path.join(testRoot, "intelligence-status-empty-"));
  try {
    const result = runStatus(stateDir);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Workflow: waiting for first tracker poll/);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
