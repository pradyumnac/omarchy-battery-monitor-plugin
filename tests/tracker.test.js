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

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "battery-power-"));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "battery-state-"));
  fs.mkdirSync(path.join(root, "BAT0"));
  fs.writeFileSync(path.join(root, "BAT0", "present"), "1\n");
  return { root, state };
}

function runTracker(fixture) {
  execFileSync(tracker, [], {
    env: {
      ...process.env,
      POWER_SUPPLY_ROOT: fixture.root,
      BATTERY_SESSION_STATE_DIR: fixture.state,
    },
  });
  return fs.readFileSync(path.join(fixture.state, "state"), "utf8");
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "battery-power-"));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "battery-state-"));
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
