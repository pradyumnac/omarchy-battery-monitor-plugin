const test = require("node:test");
const assert = require("node:assert/strict");
const Model = require("../Model.js");

test("selectProfileIndex clamps movement", () => {
  assert.equal(Model.selectProfileIndex(0, -1, ["balanced", "performance"]), 0);
  assert.equal(Model.selectProfileIndex(0, 1, ["balanced", "performance"]), 1);
  assert.equal(Model.selectProfileIndex(1, 1, ["balanced", "performance"]), 1);
  assert.equal(Model.selectProfileIndex(0, 1, []), 0);
});

test("parseView reads one view document into panel-ready values", () => {
  const document = {
    schema: "battery-view",
    version: 1,
    generated_epoch: 100,
    power: {
      state: "on-battery",
      phase: "discharging",
      ac_online: false,
      sysfs_available: true,
      state_since_epoch: 90,
      state_since_at_least: true,
      charge_start_epoch: 50,
    },
    energy: {
      now_uwh: 40000000,
      capacity_uwh: 50000000,
      percent: 80,
      draw_mw: 9500,
      charge_limit_percent: 80,
      live_time_seconds: 15158,
    },
    model: {
      state: "ready",
      windows: 12,
      sessions: 3,
      required_windows: 12,
      typical_draw_mw: 10000,
      remaining_seconds: 14400,
      full_seconds: 18000,
    },
    profiles: { available: ["balanced", "performance"], active: "balanced" },
    system: { uptime_seconds: 3600 },
    batteries: [
      {
        name: "BAT0",
        status: "Discharging",
        percent: 80,
        cycle_count: "112",
        model: "X1",
        vendor: "LGC",
        end_threshold_percent: 80,
      },
    ],
  };

  const view = Model.parseView(JSON.stringify(document));
  assert.equal(view.available, true);
  assert.equal(view.powerState, "on-battery");
  assert.equal(view.stateSinceAtLeast, true);
  assert.equal(view.sysfsAvailable, true);
  assert.equal(view.energyCapacityUwh, 50000000);
  assert.equal(view.remainingSeconds, 14400);
  assert.deepEqual(view.profiles, ["balanced", "performance"]);
  assert.equal(view.activeProfile, "balanced");
  assert.equal(view.uptimeSeconds, 3600);
  assert.equal(view.batteries.BAT0.cycles, "112");
  assert.equal(view.batteries.BAT0.endThreshold, 80);
});

test("parseView rejects anything it cannot safely read", () => {
  // Every rejection returns null so the panel keeps its last known good view
  // instead of blanking.
  assert.equal(Model.parseView(""), null);
  assert.equal(Model.parseView("not json"), null);
  assert.equal(Model.parseView('{"schema":"something-else","version":1}'), null);
  assert.equal(Model.parseView('{"schema":"battery-view","version":99}'), null);
});

test("parseView fills every field a panel binding reads", () => {
  // A document with nothing but its identity still yields the full shape.
  const view = Model.parseView('{"schema":"battery-view","version":1}');
  assert.deepEqual(Object.keys(view).sort(), Object.keys(Model.emptyView()).sort());
  assert.equal(view.remainingSeconds, 0);
  assert.deepEqual(view.profiles, []);
  assert.deepEqual(view.batteries, {});
});

test("labels a battery projection as the panel card writes it", () => {
  // Given a battery whose model has met the full gate
  // When the card label is built
  // Then it is the plain runtime, with no qualifier
  assert.equal(
    Model.batteryProjectionLabel({ state: "ready", remainingSeconds: 4680 }),
    "1h 18m",
  );
  // A provisional estimate is marked, so a rough number never reads as a firm one.
  assert.equal(
    Model.batteryProjectionLabel({ state: "provisional", remainingSeconds: 4680 }),
    "~ 1h 18m",
  );
  // A battery still gathering its own evidence shows progress, not a number.
  assert.equal(
    Model.batteryProjectionLabel({ state: "learning", windows: 3 }, 12),
    "learning 3/12",
  );
  assert.equal(
    Model.batteryProjectionLabel({ state: "blocked-energy" }),
    "no capacity reported",
  );
  assert.equal(
    Model.batteryProjectionLabel({ state: "unavailable" }),
    "history unreadable",
  );
  // Nothing to say is said with nothing, so the row hides entirely.
  assert.equal(Model.batteryProjectionLabel({}), "");
  assert.equal(Model.batteryProjectionLabel(undefined), "");
  assert.equal(
    Model.batteryProjectionLabel({ state: "ready", remainingSeconds: 0 }),
    "",
  );
});

test("names the estimator only when it is not the default", () => {
  // Given the incumbent estimator
  // When the draw label is built
  // Then only the draw is shown, because naming the default is noise
  assert.equal(
    Model.batteryDrawLabel({ typicalDrawMw: 9500, estimator: "median" }),
    "9.5W",
  );
  // A selected estimator earned its place and is worth surfacing.
  assert.equal(
    Model.batteryDrawLabel({ typicalDrawMw: 9500, estimator: "recent" }),
    "9.5W · recent",
  );
  assert.equal(Model.batteryDrawLabel({ typicalDrawMw: 0 }), "");
  assert.equal(Model.batteryDrawLabel(undefined), "");
});

test("formats the units the panel prints", () => {
  assert.equal(Model.formatWattHours(50000000), "50Wh");
  assert.equal(Model.formatWattHours(0), "");
  assert.equal(Model.formatWatts(9500), "9.5W");
  assert.equal(Model.formatWatts(0), "");
  assert.equal(Model.formatPercent(80), "80%");
  assert.equal(Model.formatPercent(0), "");
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

test("a threshold hold is read from the view, not re-derived", () => {
  // battery_model_threshold_held() decides this once, in the view. The panel
  // reads the answer; it must not reach past it to the raw status string.
  assert.equal(Model.sysfsThresholdActive({ held: true }), true);
  assert.equal(Model.sysfsThresholdActive({ held: false }), false);
  assert.equal(Model.sysfsThresholdActive(undefined), false);
  // A battery whose raw fields look like a hold but that the view did not
  // label as one stays not-held: the seam is the authority.
  assert.equal(
    Model.sysfsThresholdActive({
      status: "Not charging",
      endThreshold: 80,
      percentage: 80,
    }),
    false,
  );
});

test("the view outranks the UPower heuristic when it is fresh", () => {
  const states = { Charging: 1, Discharging: 2, FullyCharged: 3, PendingCharge: 4 };
  // UPower reports pending-charge, which the fallback heuristic alone calls a
  // threshold hold. A fresh view that says the pack is merely plugged wins.
  const device = { isPresent: true, state: states.PendingCharge };
  const plugged = Model.parseView(
    JSON.stringify({
      schema: "battery-view",
      version: 1,
      power: { phase: "plugged", ac_online: true },
    }),
  );
  const heldView = Model.parseView(
    JSON.stringify({
      schema: "battery-view",
      version: 1,
      power: { phase: "held", ac_online: true },
    }),
  );
  assert.equal(Model.chargeThresholdActive(device, 0.7, false, states, plugged), false);
  assert.equal(Model.chargeThresholdActive(device, 0.7, false, states, heldView), true);
  // No view at all falls back to the UPower heuristic.
  assert.equal(Model.chargeThresholdActive(device, 0.7, false, states, null), true);
});

test("a view from the other power state is stale and does not outrank UPower", () => {
  const states = { Charging: 1, Discharging: 2, FullyCharged: 3, PendingCharge: 4 };
  const device = { isPresent: true, state: states.PendingCharge };
  // Read while unplugged, now consulted while plugged in: the AC reading
  // disagrees with UPower's live state, so the document is stale.
  const stale = Model.parseView(
    JSON.stringify({
      schema: "battery-view",
      version: 1,
      power: { phase: "discharging", ac_online: false },
    }),
  );
  assert.equal(Model.viewThresholdAuthoritative(stale, false), false);
  assert.equal(Model.chargeThresholdActive(device, 0.7, false, states, stale), true);
});

test("state icon severity ranks charge level above threshold and full", () => {
  const states = {
    Charging: 1,
    Discharging: 2,
    FullyCharged: 3,
    Empty: 6,
  };
  const held = { held: true, endThreshold: 80, percentage: 80 };
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
});
