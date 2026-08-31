#!/usr/bin/env bash
# Check that this machine can run the battery session tracker before
# install-session-tracker touches anything. Safe to run standalone and
# repeatedly (`make doctor`) — it never writes state.
#
# Exits 0 when every hard requirement passes (warnings are informational and
# do not block install). Exits 1 and prints a report otherwise.

set -uo pipefail

power_supply_root="${POWER_SUPPLY_ROOT:-/sys/class/power_supply}"
systemctl_command="${BATTERY_SESSION_SYSTEMCTL_COMMAND:-systemctl}"
monitor_command="${BATTERY_SESSION_MONITOR_COMMAND:-upower}"
awk_command="${BATTERY_SESSION_AWK_COMMAND:-awk}"
zip_command="${BATTERY_SESSION_ZIP_COMMAND:-zip}"
notification_command="${BATTERY_SESSION_NOTIFY_COMMAND:-omarchy-notification-send}"

hard_failures=0
report=()

check_ok() {
  report+=("  [ok]   $1")
}

check_fail() {
  report+=("  [fail] $1")
  hard_failures=$((hard_failures + 1))
}

check_warn() {
  report+=("  [warn] $1")
}

# A laptop battery must be present, or the tracker has nothing to track.
battery_found=0
if [[ -d "$power_supply_root" ]]; then
  for battery_dir in "$power_supply_root"/BAT*; do
    [[ -d "$battery_dir" ]] || continue
    if [[ -f "$battery_dir/present" ]]; then
      [[ "$(<"$battery_dir/present")" == "1" ]] || continue
    else
      [[ -f "$battery_dir/status" || -f "$battery_dir/capacity" ]] || continue
    fi
    battery_found=1
    break
  done
fi
if ((battery_found == 1)); then
  check_ok "battery present under $power_supply_root"
else
  check_fail "no present battery under $power_supply_root (this looks like a desktop; the tracker refuses to install without a battery)"
fi

if command -v -- "$systemctl_command" >/dev/null 2>&1; then
  if "$systemctl_command" --user show-environment >/dev/null 2>&1; then
    check_ok "systemd user session reachable ($systemctl_command --user)"
  else
    check_fail "$systemctl_command found but the user session is unreachable; the tracker installs as a user service and needs a logind session (is this an SSH session without lingering enabled?)"
  fi
else
  check_fail "$systemctl_command not found; the tracker installs as a systemd --user service"
fi

if command -v -- "$monitor_command" >/dev/null 2>&1; then
  check_ok "$monitor_command found"
else
  check_fail "$monitor_command not found; battery-session-monitor needs it to watch power events"
fi

# Every model computation in the tracker, the view, and the status report goes
# through awk. Nothing degrades gracefully without it.
if command -v -- "$awk_command" >/dev/null 2>&1; then
  check_ok "$awk_command found"
else
  check_fail "$awk_command not found; the discharge model cannot be computed without it"
fi

# make export bundles every tier of collected data into one archive; without
# zip that command cannot produce its output at all.
if command -v -- "$zip_command" >/dev/null 2>&1; then
  check_ok "$zip_command found"
else
  check_fail "$zip_command not found; make export cannot write its archive without it"
fi

# Bash 4.3 or newer: the scripts use associative arrays, mapfile, and namerefs.
if ((BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 3))); then
  check_ok "bash ${BASH_VERSINFO[0]}.${BASH_VERSINFO[1]} (4.3+ required)"
else
  check_fail "bash ${BASH_VERSINFO[0]}.${BASH_VERSINFO[1]} is too old; 4.3+ is required for namerefs and associative arrays"
fi

# The panel calls these to draw and change the power profile. If Omarchy
# renames one upstream, the widget fails silently with blank fields, so name
# them here rather than letting the failure show up as an empty panel.
for panel_command in omarchy-powerprofiles-list omarchy-powerprofiles-set; do
  if command -v -- "$panel_command" >/dev/null 2>&1; then
    check_ok "$panel_command found"
  else
    check_warn "$panel_command not found; the panel's power-profile picker will be empty"
  fi
done

if command -v -- "$notification_command" >/dev/null 2>&1; then
  check_ok "$notification_command found"
else
  check_warn "$notification_command not found; sessions will still be recorded but no desktop notifications will be sent"
fi

printf 'Battery session tracker preflight:\n'
printf '%s\n' "${report[@]}"

if ((hard_failures > 0)); then
  printf '\n%d check(s) failed; refusing to install.\n' "$hard_failures" >&2
  exit 1
fi

printf '\nReady to install.\n'
