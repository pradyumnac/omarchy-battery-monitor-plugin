#!/usr/bin/env bash
# Trigger battery session notifications from UPower line-power events.

set -euo pipefail

power_supply_root="${POWER_SUPPLY_ROOT:-/sys/class/power_supply}"
monitor_command="${BATTERY_SESSION_MONITOR_COMMAND:-upower}"
tracker_command="${BATTERY_SESSION_TRACKER_COMMAND:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/battery-session-tracker.sh}"
# How long to wait for UPower's battery-state event after AC comes online
# before giving up and reporting whatever the battery status actually is
# (a battery already above its charge threshold never reports "Charging").
pending_charge_timeout="${BATTERY_SESSION_PENDING_TIMEOUT:-15}"

# shellcheck source=power-supply.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/power-supply.sh"

current_power_state() {
  if ac_mains_online; then
    printf 'on-charge'
  else
    printf 'on-battery'
  fi
}

any_battery_charging() {
  local battery_dir
  local present
  for battery_dir in "$power_supply_root"/BAT*; do
    if [[ -f "$battery_dir/present" ]]; then
      present=$(<"$battery_dir/present")
      [[ $present == "1" ]] || continue
    elif [[ ! -f "$battery_dir/status" && ! -f "$battery_dir/capacity" ]]; then
      continue
    fi
    if [[ -f "$battery_dir/status" && "$(<"$battery_dir/status")" == "Charging" ]]; then
      return 0
    fi
  done
  return 1
}

command -v -- "$monitor_command" >/dev/null 2>&1 || {
  printf 'UPower monitor command not found: %s\n' "$monitor_command" >&2
  exit 1
}
[[ -x $tracker_command ]] || {
  printf 'Battery tracker is not executable: %s\n' "$tracker_command" >&2
  exit 1
}

last_state=$(current_power_state)
pending_charge=0
pending_deadline=0
while :; do
  if ((pending_charge == 1)); then
    remaining=$((pending_deadline - $(date +%s)))
    if ((remaining <= 0)); then
      # Gave up waiting for a definitive battery-state event: report
      # whatever the battery status actually is (it may never reach
      # "Charging" if the battery is already above its charge threshold).
      # A zero timeout would make `read -t` return the same status as EOF,
      # so the deadline is checked directly instead of racing a 0s read.
      "$tracker_command" --power-event || true
      pending_charge=0
      continue
    fi
    if IFS= read -r -t "$remaining" event; then
      read_status=0
    else
      read_status=$?
    fi
    if ((read_status > 128)); then
      "$tracker_command" --power-event || true
      pending_charge=0
      continue
    elif ((read_status != 0)); then
      break
    fi
  else
    IFS= read -r event || break
  fi
  case $event in
  *line_power_*)
    current_state=$(current_power_state)
    if [[ $current_state != "$last_state" ]]; then
      last_state=$current_state
      if [[ $current_state == "on-charge" ]]; then
        # Capture the session immediately, then wait for UPower's battery-state
        # event before describing which battery is actually charging.
        "$tracker_command" --once || true
        if any_battery_charging; then
          "$tracker_command" --power-event || true
          pending_charge=0
        else
          pending_charge=1
          pending_deadline=$(( $(date +%s) + pending_charge_timeout ))
        fi
      else
        pending_charge=0
        "$tracker_command" --power-event || true
      fi
    fi
    ;;
  *battery_BAT*)
    if ((pending_charge == 1)) && any_battery_charging; then
      "$tracker_command" --power-event || true
      pending_charge=0
    fi
    ;;
  esac
done < <("$monitor_command" --monitor)
