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
