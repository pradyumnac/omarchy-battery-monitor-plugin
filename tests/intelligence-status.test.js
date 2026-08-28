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
  "battery-intelligence-status.sh",
);
const repository = path.join(__dirname, "..");
const ansi = String.fromCharCode(27);
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
        ...Array.from(
          { length: 12 },
          (_, index) =>
            `${19999900 + index}\tsession-${index % 3}\t${10000 + index * 100}\t50000000`,
        ),
      ].join("\n") + "\n",
    );

    const result = runStatus(stateDir);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Monitor: active/);
    assert.match(result.stdout, /Poller: active/);
    assert.match(
      result.stdout,
      /Usual readiness: ready \(12\/12 windows, 3\/3 sessions\)/,
    );
    assert.match(result.stdout, /Usual full runtime: 5h/);
    assert.match(result.stdout, /Active window: 50% \(8m \/ 15m\)/);
    assert.match(
      result.stdout,
      /History: 12 valid rows \(12 recent \/ 3 recent sessions\)/,
    );
    assert.match(
      result.stdout,
      /Last recorded window: 15m at 19999911 \(11.1 W draw, 50.0 Wh capacity\)/,
    );
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("uses ANSI colors only when requested", () => {
  const stateDir = fs.mkdtempSync(path.join(testRoot, "intelligence-color-"));
  try {
    const colored = runStatus(stateDir, { BATTERY_STATUS_COLOR: "always" });
    const plain = runStatus(stateDir, { BATTERY_STATUS_COLOR: "never" });
    assert.equal(colored.status, 0, colored.stderr);
    assert.equal(colored.stdout.includes(`${ansi}[36m`), true);
    assert.equal(colored.stdout.includes(`${ansi}[33m`), true);
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(plain.stdout.includes(ansi), false);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("make status combines service, tracker, and intelligence sections", () => {
  const root = fs.mkdtempSync(path.join(testRoot, "combined-status-"));
  const stateDir = path.join(root, "battery-session");
  const bin = path.join(root, "bin");
  fs.mkdirSync(stateDir);
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(stateDir, "state"),
    "previous_state=on-battery\nusual_sample_count=0\n",
  );
  fs.writeFileSync(
    path.join(bin, "systemctl"),
    "#!/usr/bin/env bash\nif [[ $* == *' status '* ]]; then printf 'stub service details\\n'; fi\nexit 0\n",
    { mode: 0o700 },
  );
  try {
    const statusEnv = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      XDG_STATE_HOME: root,
      BATTERY_INTELLIGENCE_NOW: "20000000",
      BATTERY_INTELLIGENCE_SYSTEMCTL_COMMAND: path.join(bin, "systemctl"),
    };
    const result = spawnSync(
      "make",
      ["--no-print-directory", "status"],
      {
        cwd: repository,
        env: { ...statusEnv, NO_COLOR: "1" },
        encoding: "utf8",
      },
    );
    const colored = spawnSync(
      "make",
      ["--no-print-directory", "status"],
      {
        cwd: repository,
        env: { ...statusEnv, BATTERY_STATUS_COLOR: "always" },
        encoding: "utf8",
      },
    );
    const removedTarget = spawnSync(
      "make",
      ["--no-print-directory", "intelligence-status"],
      { cwd: repository, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /SERVICE STATUS[\s\S]*stub service details/);
    assert.match(result.stdout, /TRACKER STATE[\s\S]*previous_state = on-battery/);
    assert.match(
      result.stdout,
      /BATTERY INTELLIGENCE[\s\S]*Usual readiness: learning \(0\/12 windows, 0\/3 sessions\)/,
    );
    assert.equal(result.stdout.includes(ansi), false);
    assert.equal(colored.status, 0, colored.stderr);
    assert.equal(
      colored.stdout.includes(`${ansi}[1m${ansi}[36mSERVICE STATUS`),
      true,
    );
    assert.equal(colored.stdout.includes(`${ansi}[33mlearning`), true);
    assert.notEqual(removedTarget.status, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("reports learning state before any observations", () => {
  const stateDir = fs.mkdtempSync(
    path.join(testRoot, "intelligence-status-empty-"),
  );
  try {
    const result = runStatus(stateDir);
    assert.equal(result.status, 0);
    assert.match(
      result.stdout,
      /Usual readiness: waiting for first tracker poll \(0\/12 windows, 0\/3 sessions\)/,
    );
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
