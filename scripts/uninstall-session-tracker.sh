#!/usr/bin/env bash
# Remove everything install-session-tracker.sh created: the running service,
# its systemd units, the copied tracker files, and the recorded session
# state. The machine is left as if the plugin had never been installed.
# The operation is repeatable and never requires root access. Every path
# removed is printed as it happens.

set -euo pipefail

log_remove() {
  printf 'uninstall: removed %s\n' "$1"
}

remove_path() {
  [[ -e $1 || -L $1 ]] || return 0
  rm -rf -- "$1"
  log_remove "$1"
}

scripts_source="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source_dir="$(dirname "$scripts_source")"

account_home=$(getent passwd "$(id -u)" | cut -d: -f6)
[[ -n $account_home ]] || {
  printf 'Unable to determine the current user home directory.\n' >&2
  exit 1
}
home_dir=$(realpath -m -- "$account_home")
plugin_dir=$(realpath -m -- "${PLUGIN_DIR:-$home_dir/.config/omarchy/plugins/doe.power}")
unit_dir=$(realpath -m -- "${XDG_CONFIG_HOME:-$home_dir/.config}/systemd/user")
state_dir=$(realpath -m -- "${BATTERY_SESSION_STATE_DIR:-${XDG_STATE_HOME:-$home_dir/.local/state}/battery-session}")
for write_dir in "$plugin_dir" "$unit_dir" "$state_dir"; do
  case "$write_dir/" in
  "$home_dir"/*) ;;
  *)
    printf 'Refusing uninstall path outside HOME: %s\n' "$write_dir" >&2
    exit 1
    ;;
  esac
done

# Take the bar widget out of the bar before anything else. Omarchy restores
# the omarchy.power layout entry it replaced (per manifest.json's
# clonedFrom) only while manifest.json is still readable from plugin_dir, so
# this has to run before the plugin files are removed below. A no-op if
# omarchy-shell isn't reachable (e.g. no live session).
if command -v omarchy-shell >/dev/null 2>&1; then
  omarchy-shell -q shell rescanPlugins
  omarchy-shell -q shell setPluginEnabled doe.power false
fi

systemctl --user disable --now \
  battery-session-tracker.timer battery-session-monitor.service \
  >/dev/null 2>&1 || true
systemctl --user stop battery-session-tracker.service >/dev/null 2>&1 || true

remove_path "$unit_dir/battery-session-tracker.sh"
remove_path "$unit_dir/battery-session-tracker.service"
remove_path "$unit_dir/battery-session-tracker.timer"
remove_path "$unit_dir/battery-session-monitor.service"

systemctl --user daemon-reload
systemctl --user reset-failed \
  battery-session-tracker.timer battery-session-tracker.service \
  battery-session-monitor.service >/dev/null 2>&1 || true

# Only remove the copied plugin and tracker files, and only when this
# checkout was copied into the plugin dir rather than running from it
# directly (the same guard install-session-tracker uses before copying).
if [[ "$source_dir" != "$(realpath -m "$plugin_dir")" ]]; then
  plugin_files=(Panel.qml Model.js manifest.json README.md LICENSE AGENTS.md)
  for name in "${plugin_files[@]}"; do
    remove_path "$plugin_dir/$name"
  done
  remove_path "$plugin_dir/scripts"
  remove_path "$plugin_dir/service"
  rmdir -- "$plugin_dir" 2>/dev/null && log_remove "$plugin_dir"
fi

remove_path "$state_dir"

printf 'Battery session tracker uninstalled; session state removed.\n'
