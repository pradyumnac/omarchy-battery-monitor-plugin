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
        "battery_energy_now_uwh=40000000",
        "battery_usable_capacity_uwh=50000000",
        "usual_remaining_runtime_seconds=14400",
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
            `${19999900 + index}\tsession-${index % 3}\t${
              10000 + index * 100
            }\t50000000`,
        ),
      ].join("\n") + "\n",
    );

    const result = runStatus(stateDir);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /BATTERY STATUS/);
    assert.match(result.stdout, /Services: tracker active · monitor active/);
    assert.match(result.stdout, /Power: unknown/);
    assert.match(result.stdout, /Energy: 40\.0 Wh \/ 50\.0 Wh · 80%/);
    assert.match(
      result.stdout,
      /Model: ready · 12 windows across 3 sessions/,
    );
    assert.match(result.stdout, /Usual remaining: 4h/);
    assert.match(result.stdout, /At full: 5h/);
    assert.match(result.stdout, /Typical draw: 10\.6 W/);
    assert.match(result.stdout, /Current sample: 50% · 8m of 15m/);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("derives remaining runtime from legacy tracker state", () => {
  const stateDir = fs.mkdtempSync(path.join(testRoot, "intelligence-legacy-"));
  try {
    fs.writeFileSync(
      path.join(stateDir, "state"),
      [
        "previous_state=on-battery",
        "state_since=19999000",
        "last_observed=19999990",
        "last_sample_energy_uwh=40000000",
        "usual_full_runtime_seconds=18000",
      ].join("\n") + "\n",
    );
    fs.writeFileSync(
      path.join(stateDir, "discharge-history.tsv"),
      [
        "# battery-discharge-history\tv1",
        ...Array.from(
          { length: 12 },
          (_, index) =>
            `${19999900 + index}\tsession-${index % 3}\t10000\t50000000`,
        ),
      ].join("\n") + "\n",
    );

    const result = runStatus(stateDir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Energy: 40\.0 Wh \/ 50\.0 Wh · 80%/);
    assert.match(
      result.stdout,
      /Model: ready · 12 windows across 3 sessions/,
    );
    assert.match(result.stdout, /Usual remaining: 4h/);
    assert.doesNotMatch(result.stdout, /learning/);
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

test("make status renders only the concise human-facing report", () => {
  const root = fs.mkdtempSync(path.join(testRoot, "combined-status-"));
  const stateDir = path.join(root, "battery-session");
  const bin = path.join(root, "bin");
  fs.mkdirSync(stateDir);
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(stateDir, "state"),
    "previous_state=on-battery\nusual_sample_count=0\n",
  );
  fs.writeFileSync(path.join(bin, "systemctl"), "#!/bin/sh\nexit 0\n", {
    mode: 0o700,
  });
  try {
    const statusEnv = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      XDG_STATE_HOME: root,
      BATTERY_INTELLIGENCE_NOW: "20000000",
      BATTERY_INTELLIGENCE_SYSTEMCTL_COMMAND: path.join(bin, "systemctl"),
    };
    const result = spawnSync("make", ["--no-print-directory", "status"], {
      cwd: repository,
      env: { ...statusEnv, NO_COLOR: "1" },
      encoding: "utf8",
    });
    const colored = spawnSync("make", ["--no-print-directory", "status"], {
      cwd: repository,
      env: { ...statusEnv, BATTERY_STATUS_COLOR: "always" },
      encoding: "utf8",
    });
    const removedTarget = spawnSync(
      "make",
      ["--no-print-directory", "intelligence-status"],
      { cwd: repository, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^BATTERY STATUS/m);
    assert.match(result.stdout, /Services: tracker active · monitor active/);
    assert.match(
      result.stdout,
      /Model: learning · 0\/12 windows · 0\/3 sessions/,
    );
    assert.equal(result.stdout.includes("previous_state"), false);
    assert.equal(result.stdout.includes("stub service details"), false);
    assert.equal(result.stdout.includes(ansi), false);
    assert.equal(colored.status, 0, colored.stderr);
    assert.equal(
      colored.stdout.includes(`${ansi}[1m${ansi}[36mBATTERY STATUS`),
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
    assert.match(result.stdout, /Model: waiting for first tracker poll/);
    assert.match(result.stdout, /Learning: 0\/12 windows · 0\/3 sessions/);
    assert.equal(result.stdout.includes("Energy:"), false);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
