function clampIndex(index, length) {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(length - 1, index));
}

function selectProfileIndex(index, delta, profiles) {
  var values = Array.isArray(profiles) ? profiles : [];
  if (values.length === 0) return 0;
  return clampIndex(index + delta, values.length);
}

// --- The aggregated view ---------------------------------------------------
// service/battery-view.sh is the only wire format this file parses. Every
// panel field that is not pushed live over D-Bus by UPower comes from one read
// of that document, so there is one place to add a field and one place to
// change when the schema moves.

var VIEW_SCHEMA = "battery-view";
var VIEW_VERSION = 1;

function viewNumber(value) {
  var number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

// An all-defaults view. Bindings read the same shape whether or not a document
// has arrived yet, so no panel field has to guard for undefined.
function emptyView() {
  return {
    available: false,
    version: 0,
    generatedEpoch: 0,
    powerState: "",
    powerPhase: "unknown",
    acOnline: false,
    sysfsAvailable: false,
    stateSinceEpoch: 0,
    stateSinceAtLeast: false,
    chargeStartEpoch: 0,
    chargeEndEpoch: 0,
    energyNowUwh: 0,
    energyCapacityUwh: 0,
    energyPercent: -1,
    drawMw: 0,
    chargeLimitPercent: 0,
    liveTimeSeconds: 0,
    modelState: "learning",
    modelWindows: 0,
    modelSessions: 0,
    requiredWindows: 0,
    requiredSessions: 0,
    typicalDrawMw: 0,
    remainingSeconds: 0,
    fullSeconds: 0,
    remainingLowSeconds: 0,
    remainingHighSeconds: 0,
    recentDrawMw: 0,
    recentRemainingSeconds: 0,
    foreignPackWindows: 0,
    unattributedWindows: 0,
    previousPack: "",
    packKey: "",
    packKeyWeak: false,
    uptimeSeconds: 0,
    profiles: [],
    activeProfile: "",
    batteries: {},
  };
}

// Parse one view document. Returns null when the payload is missing, not JSON,
// not a battery view, or from a schema version this panel does not know how to
// read — the caller keeps its last known good view in every one of those
// cases, so a transient failure never blanks the panel.
function parseView(raw) {
  var parsed = null;
  try {
    parsed = JSON.parse(String(raw || ""));
  } catch (error) {
    return null;
  }
  if (!parsed || parsed.schema !== VIEW_SCHEMA) return null;
  if (viewNumber(parsed.version) !== VIEW_VERSION) return null;

  var power = parsed.power || {};
  var energy = parsed.energy || {};
  var model = parsed.model || {};
  var profiles = parsed.profiles || {};
  var system = parsed.system || {};

  var view = emptyView();
  view.available = true;
  view.version = viewNumber(parsed.version);
  view.generatedEpoch = viewNumber(parsed.generated_epoch);

  view.powerState = String(power.state || "");
  view.powerPhase = String(power.phase || "unknown");
  view.acOnline = power.ac_online === true;
  view.sysfsAvailable = power.sysfs_available === true;
  view.stateSinceEpoch = viewNumber(power.state_since_epoch);
  view.stateSinceAtLeast = power.state_since_at_least === true;
  view.chargeStartEpoch = viewNumber(power.charge_start_epoch);
  view.chargeEndEpoch = viewNumber(power.charge_end_epoch);

  view.energyNowUwh = viewNumber(energy.now_uwh);
  view.energyCapacityUwh = viewNumber(energy.capacity_uwh);
  view.energyPercent = viewNumber(energy.percent);
  view.drawMw = viewNumber(energy.draw_mw);
  view.chargeLimitPercent = viewNumber(energy.charge_limit_percent);
  view.liveTimeSeconds = viewNumber(energy.live_time_seconds);

  view.modelState = String(model.state || "learning");
  view.modelWindows = viewNumber(model.windows);
  view.modelSessions = viewNumber(model.sessions);
  view.requiredWindows = viewNumber(model.required_windows);
  view.requiredSessions = viewNumber(model.required_sessions);
  view.typicalDrawMw = viewNumber(model.typical_draw_mw);
  view.remainingSeconds = viewNumber(model.remaining_seconds);
  view.fullSeconds = viewNumber(model.full_seconds);
  view.remainingLowSeconds = viewNumber(model.remaining_low_seconds);
  view.remainingHighSeconds = viewNumber(model.remaining_high_seconds);
  view.recentDrawMw = viewNumber(model.recent_draw_mw);
  view.recentRemainingSeconds = viewNumber(model.recent_remaining_seconds);

  var history = parsed.history || {};
  // Evidence recorded on a battery set that is no longer installed. Non-zero
  // means the pack changed and earlier windows stopped counting.
  view.foreignPackWindows = viewNumber(history.foreign_pack);
  view.unattributedWindows = viewNumber(history.unattributed);
  view.previousPack = String(history.previous_pack || "");
  var sampling = parsed.sampling || {};
  view.packKey = String(sampling.pack_key || "");
  view.packKeyWeak = sampling.pack_key_weak === true;

  view.uptimeSeconds = viewNumber(system.uptime_seconds);

  var available = Array.isArray(profiles.available) ? profiles.available : [];
  for (var i = 0; i < available.length; i++) {
    view.profiles.push(String(available[i]));
  }
  view.activeProfile = String(profiles.active || "");

  // Keyed by sysfs name, which is what UPower reports as nativePath.
  var batteries = Array.isArray(parsed.batteries) ? parsed.batteries : [];
  for (var j = 0; j < batteries.length; j++) {
    var battery = batteries[j] || {};
    var name = String(battery.name || "");
    if (!name) continue;
    view.batteries[name] = {
      status: String(battery.status || ""),
      percentage: viewNumber(battery.percent),
      cycles: String(battery.cycle_count || ""),
      model: String(battery.model || ""),
      vendor: String(battery.vendor || ""),
      endThreshold: viewNumber(battery.end_threshold_percent),
      held: battery.held === true,
    };
  }
  return view;
}

// µWh as the panel writes capacity: whole watt-hours, no unit noise.
function formatWattHours(microWattHours) {
  var value = viewNumber(microWattHours);
  if (!(value > 0)) return "";
  return Math.round(value / 1000000) + "Wh";
}

// mW as the panel writes a draw or charge rate.
function formatWatts(milliWatts) {
  var value = viewNumber(milliWatts);
  if (!(value > 0)) return "";
  return (value / 1000).toFixed(1) + "W";
}

function formatPercent(value) {
  var number = viewNumber(value);
  if (!(number > 0)) return "";
  return Math.round(number) + "%";
}

function profileIcon(name) {
  if (name === "power-saver") return "󰌪";
  if (name === "balanced") return "󰊚";
  if (name === "performance") return "󰓅";
  return "󰂄";
}

function batteryFraction(device) {
  return device && device.isPresent
    ? Math.max(0, Math.min(1, device.percentage))
    : 0;
}

// The view is definitive about a threshold hold: it compares each battery
// against its own configured cap. UPower exposes no equivalent field, so the
// heuristic below is only a fallback for when the view cannot be trusted.
//
// The bar stays visible while the panel is closed, and the view is only
// re-read while the panel is open, so a stale document must not outrank
// UPower's live state. The view's own AC reading is the staleness check:
// plugging or unplugging is exactly what invalidates it, and within a single
// power state a hold does not appear or vanish abruptly.
function viewThresholdAuthoritative(view, onBattery) {
  return !!(view && view.available && view.acOnline === !onBattery);
}

function chargeThresholdActive(device, fraction, onBattery, states, view) {
  var d = device || {};
  var s = states || {};
  if (!(d && d.isPresent && !onBattery)) return false;
  if (viewThresholdAuthoritative(view, onBattery)) {
    return view.powerPhase === "held";
  }

  if (d.state === s.Discharging) return false;
  if (d.state === s.PendingCharge) return true;
  if (d.state === s.FullyCharged && fraction < 0.99) return true;
  if (d.state !== s.Charging || fraction >= 0.99) return false;

  return (
    Number(d.changeRate || 0) <= 0.2 || Number(d.timeToFull || 0) >= 8 * 60 * 60
  );
}

function batteryIcon(device, fraction, onBattery, states, view) {
  var d = device || {};
  if (!d.isPresent) return "";

  var chargingIcons = ["󰢜", "󰂆", "󰂇", "󰂈", "󰢝", "󰂉", "󰢞", "󰂊", "󰂋", "󰂅"];
  var defaultIcons = ["󰁺", "󰁻", "󰁼", "󰁽", "󰁾", "󰁿", "󰂀", "󰂁", "󰂂", "󰁹"];
  var index = Math.max(0, Math.min(9, Math.floor(fraction * 10)));
  var threshold = chargeThresholdActive(d, fraction, onBattery, states, view);

  if (threshold) return defaultIcons[index];
  if (d.state === states.FullyCharged) return "󰂅";
  if (!onBattery) return chargingIcons[index];
  return defaultIcons[index];
}

function modeLabel(device, fraction, onBattery, states, view) {
  var d = device || {};
  if (!d.isPresent) return "";

  if (chargeThresholdActive(d, fraction, onBattery, states, view))
    return "Threshold";
  if (onBattery) return "On battery";
  if (!onBattery && fraction >= 1) return "Fully charged";
  return "Charging";
}

function deviceStateString(device, states) {
  if (!device || !device.isPresent) return "Not present";
  var s = states || {};
  if (device.state === s.Charging) return "Charging";
  if (device.state === s.Discharging) return "Discharging";
  if (device.state === s.FullyCharged) return "Fully charged";
  if (device.state === s.PendingCharge) return "Pending charge";
  if (device.state === s.PendingDischarge) return "Pending discharge";
  if (device.state === s.Empty) return "Empty";
  return "Idle";
}

function deviceStateIcon(device, states) {
  var s = states || {};
  if (!device || !device.isPresent || device.state === s.Unknown) return "󰀦";
  if (device.state === s.Charging) return "ϟ";
  if (device.state === s.Discharging) return "↓";
  return "󰁹";
}

// Whether one battery is parked at its own configured charge cap. The rule
// itself lives in battery_model_threshold_held(); the view applies it per
// battery and ships the answer, so this reads the seam rather than deriving
// it a second time from the raw status string and threshold.
function sysfsThresholdActive(extra) {
  return !!(extra && extra.held);
}

// Severity token for one battery's state icon. Panel.qml maps these onto theme
// colors; keeping the model free of literal colors lets the neutral step follow
// the active Omarchy theme.
function deviceStateSeverity(device, extra, states) {
  var fraction = batteryFraction(device);
  var s = states || {};
  if ((device && device.state === s.Empty) || fraction < 0.1) return "critical";
  if (fraction < 0.2) return "low";
  if (sysfsThresholdActive(extra)) return "held";
  if (device && device.state === s.FullyCharged) return "full";
  return "normal";
}

function deviceBatteryIcon(device, states) {
  if (!device || !device.isPresent) return "󰂎";
  var chargingIcons = ["󰢜", "󰂆", "󰂇", "󰂈", "󰢝", "󰂉", "󰢞", "󰂊", "󰂋", "󰂅"];
  var defaultIcons = ["󰁺", "󰁻", "󰁼", "󰁽", "󰁾", "󰁿", "󰂀", "󰂁", "󰂂", "󰁹"];
  var index = Math.max(0, Math.min(9, Math.floor(device.percentage * 10)));
  var s = states || {};
  if (device.state === s.FullyCharged) return "󰂅";
  if (device.state === s.Charging) return chargingIcons[index];
  return defaultIcons[index];
}

function getLaptopBatteries(devices) {
  var list = [];
  var values = devices && devices.values ? devices.values : [];
  for (var i = 0; i < values.length; i++) {
    var dev = values[i];
    if (dev && dev.isLaptopBattery && dev.isPresent) {
      list.push(dev);
    }
  }
  list.sort((a, b) => {
    var na = a.nativePath || "";
    var nb = b.nativePath || "";
    return na.localeCompare(nb);
  });
  return list;
}

function totalEnergy(laptopBatteries) {
  var sum = 0;
  var list = Array.isArray(laptopBatteries) ? laptopBatteries : [];
  for (var i = 0; i < list.length; i++) {
    sum += Number(list[i].energy || 0);
  }
  return sum;
}

function totalEnergyCapacity(laptopBatteries) {
  var sum = 0;
  var list = Array.isArray(laptopBatteries) ? laptopBatteries : [];
  for (var i = 0; i < list.length; i++) {
    sum += Number(list[i].energyCapacity || 0);
  }
  return sum;
}

function totalChangeRate(laptopBatteries) {
  var sum = 0;
  var list = Array.isArray(laptopBatteries) ? laptopBatteries : [];
  for (var i = 0; i < list.length; i++) {
    sum += Number(list[i].changeRate || 0);
  }
  return sum;
}

function aggregateFraction(laptopBatteries, fallbackDevice) {
  var list = Array.isArray(laptopBatteries) ? laptopBatteries : [];
  var capacity = totalEnergyCapacity(list);
  if (capacity > 0) {
    return Math.max(0, Math.min(1, totalEnergy(list) / capacity));
  }
  return batteryFraction(fallbackDevice);
}

function formatDuration(hours) {
  if (!(hours > 0) || !Number.isFinite(hours)) return "";
  var totalMinutes = Math.round(hours * 60);
  var h = Math.floor(totalMinutes / 60);
  var m = totalMinutes % 60;
  if (h > 0 && m > 0) return h + "h " + m + "m";
  if (h > 0) return h + "h";
  return m + "m";
}

// Aggregate time-to-empty/full across the whole pack, derived from combined
// energy/capacity/rate rather than any single battery's upower reading.
function aggregateTimeLabel(energy, capacity, rate, onBattery) {
  if (!(rate > 0.05)) return "";
  if (onBattery) return formatDuration(energy / rate);
  var remaining = capacity - energy;
  if (remaining <= 0) return "";
  return formatDuration(remaining / rate);
}

function formatElapsed(seconds) {
  var totalMinutes = Math.max(0, Math.floor(Number(seconds || 0) / 60));
  var days = Math.floor(totalMinutes / (24 * 60));
  var hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  var minutes = totalMinutes % 60;
  var parts = [];
  if (days > 0) parts.push(days + "d");
  if (hours > 0 || days > 0) parts.push(hours + "h");
  parts.push(minutes + "m");
  return parts.join(" ");
}

function formatTimestamp(epoch) {
  var value = Number(epoch);
  if (!(value > 0) || !Number.isFinite(value)) return "—";
  var date = new Date(value * 1000);
  function pad(number) {
    return number < 10 ? "0" + number : String(number);
  }
  return (
    pad(date.getDate()) +
    "/" +
    pad(date.getMonth() + 1) +
    " " +
    pad(date.getHours()) +
    ":" +
    pad(date.getMinutes())
  );
}

function formatSessionDuration(seconds, atLeast) {
  var value = Number(seconds || 0);
  if (atLeast) return "> " + formatElapsed(Math.max(0, value));
  var totalMinutes = Math.max(1, Math.ceil(value / 60));
  return formatElapsed(totalMinutes * 60);
}

function formatRuntimeEstimate(seconds) {
  var value = Number(seconds);
  if (!(value > 0) || !Number.isFinite(value)) return "";
  return formatElapsed(value);
}

if (typeof module === "object" && module !== null) {
  module.exports = {
    clampIndex: clampIndex,
    selectProfileIndex: selectProfileIndex,
    emptyView: emptyView,
    parseView: parseView,
    formatWattHours: formatWattHours,
    formatWatts: formatWatts,
    formatPercent: formatPercent,
    profileIcon: profileIcon,
    batteryFraction: batteryFraction,
    chargeThresholdActive: chargeThresholdActive,
    batteryIcon: batteryIcon,
    modeLabel: modeLabel,
    deviceStateString: deviceStateString,
    deviceStateIcon: deviceStateIcon,
    sysfsThresholdActive: sysfsThresholdActive,
    viewThresholdAuthoritative: viewThresholdAuthoritative,
    deviceStateSeverity: deviceStateSeverity,
    deviceBatteryIcon: deviceBatteryIcon,
    getLaptopBatteries: getLaptopBatteries,
    totalEnergy: totalEnergy,
    totalEnergyCapacity: totalEnergyCapacity,
    totalChangeRate: totalChangeRate,
    aggregateFraction: aggregateFraction,
    formatDuration: formatDuration,
    aggregateTimeLabel: aggregateTimeLabel,
    formatElapsed: formatElapsed,
    formatTimestamp: formatTimestamp,
    formatSessionDuration: formatSessionDuration,
    formatRuntimeEstimate: formatRuntimeEstimate,
  };
}
