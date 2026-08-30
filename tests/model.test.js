const test = require("node:test");
const assert = require("node:assert/strict");
const Model = require("../Model.js");

test("selectProfileIndex clamps movement", () => {
  assert.equal(Model.selectProfileIndex(0, -1, ["balanced", "performance"]), 0);
  assert.equal(Model.selectProfileIndex(0, 1, ["balanced", "performance"]), 1);
  assert.equal(Model.selectProfileIndex(1, 1, ["balanced", "performance"]), 1);
  assert.equal(Model.selectProfileIndex(0, 1, []), 0);
});

test("parses key/value and profile output", () => {
  assert.deepEqual(Model.parseKeyValue("rate\t12.5\nempty\t\ninvalid"), {
    rate: "12.5",
    empty: "",
  });
  assert.deepEqual(
    Model.parseKeyValue("previous_state=on-charge\nstate_since=42"),
    {
      previous_state: "on-charge",
      state_since: "42",
    },
  );
  assert.deepEqual(Model.parseProfiles("performance\t0\nbalanced\t1\n"), {
    profiles: ["performance", "balanced"],
    activeProfile: "balanced",
    profileIndex: 0,
  });
});

test("aggregates present laptop batteries in stable order", () => {
  const batteries = Model.getLaptopBatteries({
    values: [
      {
        nativePath: "/BAT1",
        isLaptopBattery: true,
        isPresent: true,
        energy: 20,
        energyCapacity: 40,
        changeRate: 2,
      },
      {
        nativePath: "/BAT0",
        isLaptopBattery: true,
        isPresent: true,
        energy: 30,
        energyCapacity: 60,
        changeRate: 3,
      },
      { nativePath: "/UPS", isLaptopBattery: false, isPresent: true },
    ],
  });
  assert.deepEqual(
    batteries.map((battery) => battery.nativePath),
    ["/BAT0", "/BAT1"],
  );
  assert.equal(Model.totalEnergy(batteries), 50);
  assert.equal(Model.totalEnergyCapacity(batteries), 100);
  assert.equal(Model.totalChangeRate(batteries), 5);
  assert.equal(
    Model.aggregateFraction(batteries, { percentage: 0.1, isPresent: true }),
    0.5,
  );
});

test("handles threshold and time boundaries", () => {
  const states = {
    Charging: 1,
    Discharging: 2,
    FullyCharged: 3,
    PendingCharge: 4,
  };
  const device = {
    isPresent: true,
    state: states.Charging,
    changeRate: 0.1,
    timeToFull: 0,
  };
  assert.equal(Model.chargeThresholdActive(device, 0.8, false, states), true);
  assert.equal(Model.chargeThresholdActive(device, 0.8, true, states), false);
  assert.equal(Model.aggregateTimeLabel(50, 100, 10, true), "5h");
  assert.equal(Model.aggregateTimeLabel(50, 100, 10, false), "5h");
  assert.equal(Model.aggregateTimeLabel(100, 100, 10, false), "");
});

test("parseChargeHistory drops entries after the given now", () => {
  assert.equal(
    Model.parseChargeHistory("2000\tcharging\n1000\tdischarging", 1500).entries
      .length,
    1,
  );
});

test("formats exact and lower-bound session durations", () => {
  assert.equal(Model.formatSessionDuration(5 * 60 + 20, false), "6m");
  assert.equal(Model.formatSessionDuration(5 * 60 + 20, true), "> 5m");
  assert.equal(Model.formatSessionDuration(20, true), "> 0m");
});

test("formats a usual full-runtime estimate", () => {
  assert.equal(Model.formatRuntimeEstimate(5 * 60 * 60 + 20 * 60), "5h 20m");
  assert.equal(Model.formatRuntimeEstimate(0), "");
  assert.equal(Model.formatRuntimeEstimate("invalid"), "");
});

test("sysfs threshold hold needs a reached stop threshold", () => {
  const held = { status: "Not charging", endThreshold: 80, percentage: 80 };
  assert.equal(Model.sysfsThresholdActive(held), true);
  assert.equal(Model.sysfsThresholdActive({ ...held, percentage: 60 }), false);
  assert.equal(Model.sysfsThresholdActive({ ...held, endThreshold: 0 }), false);
  assert.equal(
    Model.sysfsThresholdActive({ ...held, status: "Discharging" }),
    false,
  );
  assert.equal(Model.sysfsThresholdActive(undefined), false);
});

test("state icon severity ranks charge level above threshold and full", () => {
  const states = {
    Charging: 1,
    Discharging: 2,
    FullyCharged: 3,
    Empty: 6,
  };
  const held = { status: "Not charging", endThreshold: 80, percentage: 80 };
  function severity(device, extra) {
    return Model.deviceStateSeverity(device, extra, states);
  }
  assert.equal(
    severity({ isPresent: true, percentage: 0.02, state: states.Discharging }),
    "critical",
  );
  assert.equal(
    severity({ isPresent: true, percentage: 0.5, state: states.Empty }),
    "critical",
  );
  assert.equal(
    severity({ isPresent: true, percentage: 0.07, state: states.Discharging }),
    "critical",
  );
  assert.equal(
    severity({ isPresent: true, percentage: 0.1, state: states.Discharging }),
    "low",
  );
  assert.equal(
    severity({ isPresent: true, percentage: 0.8, state: states.Charging }, held),
    "held",
  );
  assert.equal(
    severity(
      { isPresent: true, percentage: 0.8, state: states.FullyCharged },
      held,
    ),
    "held",
  );
  assert.equal(
    severity({ isPresent: true, percentage: 1, state: states.FullyCharged }),
    "full",
  );
  assert.equal(
    severity({ isPresent: true, percentage: 0.6, state: states.Discharging }),
    "normal",
  );
});

test("maps charge fraction to icon glyph and mode label", () => {
  const states = {
    Charging: 1,
    Discharging: 2,
    FullyCharged: 3,
    PendingCharge: 4,
  };
  assert.equal(Model.batteryFraction({ isPresent: true, percentage: 1.4 }), 1);
  assert.equal(Model.batteryFraction({ isPresent: false, percentage: 0.5 }), 0);
  // changeRate avoids the charge-threshold-hold branch so these hit the
  // charging/discharging icon selection instead.
  assert.equal(
    Model.batteryIcon(
      { isPresent: true, state: states.Charging, changeRate: 5 },
      0,
      false,
      states,
    ),
    "󰢜",
  );
  assert.equal(
    Model.batteryIcon(
      { isPresent: true, state: states.Discharging },
      0.95,
      true,
      states,
    ),
    "󰁹",
  );
  assert.equal(
    Model.deviceStateString({ isPresent: true, state: states.Charging }, states),
    "Charging",
  );
  assert.equal(Model.deviceStateString({ isPresent: false }, states), "Not present");
  assert.equal(
    Model.deviceStateIcon({ isPresent: true, state: states.Charging }, states),
    "ϟ",
  );
  assert.equal(Model.deviceStateIcon({ isPresent: false }, states), "󰀦");
  assert.equal(
    Model.deviceBatteryIcon(
      { isPresent: true, state: states.FullyCharged, percentage: 1 },
      states,
    ),
    "󰂅",
  );
  assert.equal(
    Model.modeLabel(
      { isPresent: true, state: states.Charging, changeRate: 5 },
      0.5,
      false,
      states,
    ),
    "Charging",
  );
});

test("formats elapsed time across minute, hour, and day boundaries", () => {
  assert.equal(Model.formatElapsed(90), "1m");
  assert.equal(Model.formatElapsed(3661), "1h 1m");
  assert.equal(Model.formatElapsed(90000), "1d 1h 0m");
  assert.equal(Model.formatDuration(1.5), "1h 30m");
  assert.equal(Model.formatDuration(0), "");
  assert.equal(Model.formatTimestamp(0), "—");
  assert.equal(Model.parseUptime("12345.67 890.12"), 12345.67);
  assert.equal(Model.parseUptime("not-a-number"), 0);
});
