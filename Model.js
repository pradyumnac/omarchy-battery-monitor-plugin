function clampIndex(index, length) {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(length - 1, index));
}

function selectProfileIndex(index, delta, profiles) {
  var values = Array.isArray(profiles) ? profiles : [];
  if (values.length === 0) return 0;
  return clampIndex(index + delta, values.length);
}

function parseKeyValue(raw) {
  var next = {};
  var lines = String(raw || "").split("\n");
  for (var i = 0; i < lines.length; i++) {
    var separator = lines[i].indexOf("\t");
    var separatorLength = 1;
    if (separator < 0) {
      separator = lines[i].indexOf("=");
    }
    if (separator <= 0) continue;
    next[lines[i].slice(0, separator)] = lines[i]
      .slice(separator + separatorLength)
      .trim();
  }
  return next;
}

function parseProfiles(raw, previousIndex) {
  var lines = String(raw || "").split("\n");
  var list = [];
  var active = "";
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;
    var parts = line.split("\t");
    list.push(parts[0]);
    if (parts[1] === "1") active = parts[0];
  }
  return {
    profiles: list,
    activeProfile: active,
    profileIndex: clampIndex(previousIndex || 0, list.length),
  };
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

function chargeThresholdActive(device, fraction, onBattery, states) {
  var d = device || {};
  var s = states || {};
  if (!(d && d.isPresent && !onBattery)) return false;

  if (d.state === s.Discharging) return false;
  if (d.state === s.PendingCharge) return true;
  if (d.state === s.FullyCharged && fraction < 0.99) return true;
  if (d.state !== s.Charging || fraction >= 0.99) return false;

  return (
    Number(d.changeRate || 0) <= 0.2 || Number(d.timeToFull || 0) >= 8 * 60 * 60
  );
}

function batteryIcon(device, fraction, onBattery, states) {
  var d = device || {};
  if (!d.isPresent) return "";

  var chargingIcons = ["󰢜", "󰂆", "󰂇", "󰂈", "󰢝", "󰂉", "󰢞", "󰂊", "󰂋", "󰂅"];
  var defaultIcons = ["󰁺", "󰁻", "󰁼", "󰁽", "󰁾", "󰁿", "󰂀", "󰂁", "󰂂", "󰁹"];
  var index = Math.max(0, Math.min(9, Math.floor(fraction * 10)));
  var threshold = chargeThresholdActive(d, fraction, onBattery, states);

  if (threshold) return defaultIcons[index];
  if (d.state === states.FullyCharged) return "󰂅";
  if (!onBattery) return chargingIcons[index];
  return defaultIcons[index];
}

function modeLabel(device, fraction, onBattery, states) {
  var d = device || {};
  if (!d.isPresent) return "";

  if (chargeThresholdActive(d, fraction, onBattery, states)) return "Threshold";
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
  if (!device || !device.isPresent) return "󰂎";
  var s = states || {};
  if (device.state === s.Charging) return "󰂆";
  if (device.state === s.PendingCharge) return "󰂄";
  if (device.state === s.Discharging) return "󰂀";
  if (device.state === s.FullyCharged) return "󰂅";
  if (device.state === s.Empty) return "󰂎";
  return "󰂄";
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

// UPower prints charge history newest-first. The transition from charging to
// discharging is the end of the most recent charge/discharge session.
function parseChargeHistory(raw, nowEpoch) {
  var entries = [];
  var lines = String(raw || "").split("\n");
  for (var i = 0; i < lines.length; i++) {
    var parts = lines[i].trim().split("\t");
    var epoch = Number(parts[0]);
    // Ignore stale UPower samples that are in the future after a clock
    // correction; they must not make a recent discharge look like a charge.
    var futureLimit =
      Number(nowEpoch) > 0 ? Number(nowEpoch) + 5 * 60 : Infinity;
    if (epoch > 0 && epoch <= futureLimit && parts[1]) {
      entries.push({ epoch: epoch, state: parts[1] });
    }
  }
  // Keep UPower's order: its first entry is the newest sample. This is more
  // reliable than sorting timestamps because suspend/resume can move the
  // system clock while the history is being collected.
  var lastEnd = 0;
  var stateStart = 0;
  if (entries.length > 1) {
    var currentState = entries[0].state;
    for (var j = 1; j < entries.length; j++) {
      if (entries[j].state === currentState) continue;
      stateStart = entries[0].epoch;
      break;
    }
  }
  for (var k = 0; k + 1 < entries.length; k++) {
    if (
      entries[k].state === "discharging" &&
      entries[k + 1].state === "charging"
    ) {
      lastEnd = entries[k].epoch;
      break;
    }
  }
  return {
    chargeEndEpoch: lastEnd,
    stateStartEpoch: stateStart,
    entries: entries,
  };
}

function parseUptime(raw) {
  var value = parseFloat(
    String(raw || "")
      .trim()
      .split(/\s+/)[0],
  );
  return Number.isFinite(value) && value >= 0 ? value : 0;
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
    parseKeyValue: parseKeyValue,
    parseProfiles: parseProfiles,
    profileIcon: profileIcon,
    batteryFraction: batteryFraction,
    chargeThresholdActive: chargeThresholdActive,
    batteryIcon: batteryIcon,
    modeLabel: modeLabel,
    deviceStateString: deviceStateString,
    deviceStateIcon: deviceStateIcon,
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
    parseChargeHistory: parseChargeHistory,
    parseUptime: parseUptime,
  };
}
