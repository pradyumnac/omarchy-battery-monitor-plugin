#!/usr/bin/env bash
# Shared sysfs helpers for battery-session-tracker and battery-session-monitor.
# Sourced, not executed directly. Callers must set power_supply_root first.

ac_mains_online() {
  local supply_dir
  for supply_dir in "$power_supply_root"/*; do
    if [[ -f "$supply_dir/type" && "$(<"$supply_dir/type")" == "Mains" \
      && -f "$supply_dir/online" && "$(<"$supply_dir/online")" == "1" ]]; then
      return 0
    fi
  done
  return 1
}
