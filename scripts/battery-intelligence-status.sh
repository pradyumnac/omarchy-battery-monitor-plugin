#!/usr/bin/env bash
# Render the concise, human-facing `make status` report without changing
# runtime data. Set BATTERY_STATUS_VERBOSE=1 (via `make status VERBOSE=1`) for
# low-level collection details. ANSI styling is automatic on a TTY, forced
# with BATTERY_STATUS_COLOR=always, and disabled by NO_COLOR or =never.
#
# This script computes nothing about the battery. It renders the aggregated
# view from service/battery-view.sh — the same document Panel.qml reads — plus
# the systemd service health, which is the one fact only an operator report
# cares about.

set -uo pipefail

view_source="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../service" && pwd -P)"
# shellcheck source=../service/battery-view.sh
source "$view_source/battery-view.sh"

systemctl_command="${BATTERY_INTELLIGENCE_SYSTEMCTL_COMMAND:-systemctl}"
verbose=${BATTERY_STATUS_VERBOSE:-0}

[[ $verbose == 0 || $verbose == 1 ]] || {
  printf 'Invalid BATTERY_STATUS_VERBOSE: %s (expected 0 or 1)\n' "$verbose" >&2
  exit 2
}

color_enabled=0
if [[ -z ${NO_COLOR-} ]]; then
  case ${BATTERY_STATUS_COLOR:-auto} in
  always) color_enabled=1 ;;
  never) color_enabled=0 ;;
  auto) [[ -t 1 ]] && color_enabled=1 ;;
  *)
    printf 'Invalid BATTERY_STATUS_COLOR: %s (expected auto, always, or never)\n' \
      "$BATTERY_STATUS_COLOR" >&2
    exit 2
    ;;
  esac
fi

bold=""
cyan=""
green=""
yellow=""
red=""
dim=""
reset=""
if ((color_enabled == 1)); then
  bold=$'\033[1m'
  cyan=$'\033[36m'
  green=$'\033[32m'
  yellow=$'\033[33m'
  red=$'\033[31m'
  dim=$'\033[2m'
  reset=$'\033[0m'
fi

heading() {
  printf '%bBATTERY STATUS%b\n%b────────────────────────────────────────%b\n' \
    "$bold$cyan" "$reset" "$cyan" "$reset"
}

field() {
  local label=$1 text=$2 color=${3-}
  printf '  %b%s:%b %b%s%b\n' "$bold$cyan" "$label" "$reset" \
    "$color" "$text" "$reset"
}

subfield() {
  local label=$1 text=$2 color=${3-}
  printf '      %b%-16s%b %b%s%b\n' "$dim" "$label" "$reset" "$color" "$text" "$reset"
}

format_duration() {
  local seconds=$1 minutes hours days
  minutes=$(((seconds + 59) / 60))
  days=$((minutes / (24 * 60)))
  hours=$(((minutes % (24 * 60)) / 60))
  minutes=$((minutes % 60))
  if ((days > 0)); then
    printf '%dd %dh' "$days" "$hours"
  elif ((hours > 0 && minutes > 0)); then
    printf '%dh %dm' "$hours" "$minutes"
  elif ((hours > 0)); then
    printf '%dh' "$hours"
  else
    printf '%dm' "$minutes"
  fi
}

format_age() {
  local seconds=$1
  if ((seconds < 0)); then
    printf 'clock mismatch'
  elif ((seconds < 60)); then
    printf '%ds ago' "$seconds"
  else
    printf '%s ago' "$(format_duration "$seconds")"
  fi
}

format_energy() {
  awk -v value="$1" 'BEGIN { printf "%.1f Wh", value / 1000000 }'
}

format_power() {
  awk -v value="$1" 'BEGIN { printf "%.1f W", value / 1000 }'
}

service_state() {
  local unit=$1
  if command -v -- "$systemctl_command" >/dev/null 2>&1 &&
    "$systemctl_command" --user is-active --quiet "$unit" 2>/dev/null; then
    printf 'active'
  else
    printf 'inactive'
  fi
}

sampling_reason_label() {
  case $1 in
  battery-set-changed) printf 'battery set changed' ;;
  battery-baseline-missing) printf 'per-battery baseline missing after upgrade' ;;
  no-battery-evidence) printf 'no battery measurably discharged' ;;
  polling-gap) printf 'polling gap or clock change' ;;
  energy-unavailable) printf 'battery energy unavailable' ;;
  energy-increased) printf 'stored energy increased' ;;
  no-energy-used) printf 'no discharge measured' ;;
  implausible-draw) printf 'implausible draw rejected' ;;
  history-schema-unsupported) printf 'unsupported history format' ;;
  *) printf '%s' "$1" ;;
  esac
}

# One block per battery: who it is, then what it is doing, then what its own
# evidence says about it. Identity comes first because two batteries in the
# same machine are different hardware with different ages and capacities, and a
# metric means little until you know which cell produced it.
battery_block() {
  local index=$1
  local name=${view_bat_name[index]}
  local vendor=${view_bat_vendor[index]}
  local model=${view_bat_model[index]}
  local serial=${view_bat_serial[index]}
  local full=${view_bat_energy_full_uwh[index]}
  local design=${view_bat_energy_design_uwh[index]}
  local power=${view_bat_power_now_uw[index]}
  local state=${view_bat_model_state[index]}
  local windows=${view_bat_windows[index]}
  local sessions=${view_bat_sessions[index]}
  local draw=${view_bat_typical_draw_mw[index]}
  local identity detail health energy

  # Trim the padding sysfs puts around some serials.
  serial=${serial#"${serial%%[![:space:]]*}"}
  serial=${serial%"${serial##*[![:space:]]}"}
  identity=""
  [[ -n $vendor ]] && identity+="$vendor "
  [[ -n $model ]] && identity+="$model"
  [[ -n $serial ]] && identity+=" · SN $serial"
  [[ -n $identity ]] || identity="identity unavailable"
  field "$name" "$identity"

  if ((design > 0)); then
    health="health $((full * 100 / design))%"
  else
    health="health N/A"
  fi
  energy="-"
  ((full > 0)) && energy=$(format_energy "$full")
  detail="$health · $energy · ${view_bat_status[index]:-unknown}"
  case ${view_bat_status[index]} in
  Discharging) detail+=" · draw $(format_power $((power / 1000)))" ;;
  Charging) detail+=" · charging at $(format_power $((power / 1000)))" ;;
  esac
  ((view_bat_held[index] == 1)) && detail+=" · held at ${view_bat_end_threshold[index]}%"
  subfield "Battery" "$detail"

  case $state in
  ready)
    subfield "Model" "ready · $windows windows / $sessions sessions" "$green"
    ;;
  provisional)
    subfield "Model" "provisional · $windows windows / $sessions sessions" "$yellow"
    ;;
  blocked-energy)
    subfield "Model" "blocked · this battery reports no capacity" "$yellow"
    ;;
  unavailable)
    subfield "Model" "unavailable · unsupported history format" "$red"
    ;;
  *)
    local window_progress=$windows session_progress=$sessions
    ((window_progress > BATTERY_MODEL_MIN_WINDOWS)) && window_progress=$BATTERY_MODEL_MIN_WINDOWS
    ((session_progress > BATTERY_MODEL_MIN_SESSIONS)) && session_progress=$BATTERY_MODEL_MIN_SESSIONS
    subfield "Model" \
      "learning · $window_progress/$BATTERY_MODEL_MIN_WINDOWS windows · $session_progress/$BATTERY_MODEL_MIN_SESSIONS sessions" \
      "$yellow"
    ;;
  esac

  if ((draw > 0)); then
    subfield "Typical draw" "$(format_power "$draw")"
  fi
  # The sampling window measures whichever battery is actually discharging, so
  # its progress is reported against that battery rather than the pack.
  if [[ ${view_bat_status[index]} == Discharging ]] && ((view_window_start_epoch > 0)); then
    local progress=$((view_window_seconds * 100 / BATTERY_MODEL_WINDOW_SECONDS))
    ((progress > 100)) && progress=100
    subfield "Current sample" \
      "$progress% · $(format_duration "$view_window_seconds") of $(format_duration "$BATTERY_MODEL_WINDOW_SECONDS")" \
      "$cyan"
  fi
  if ((view_bat_remaining_seconds[index] > 0)); then
    subfield "From this level" "$(format_duration "${view_bat_remaining_seconds[index]}")"
    subfield "At full" "$(format_duration "${view_bat_full_seconds[index]}")"
    if ((view_bat_remaining_low_seconds[index] > 0 &&
      view_bat_remaining_high_seconds[index] > view_bat_remaining_low_seconds[index])); then
      subfield "Range" \
        "$(format_duration "${view_bat_remaining_low_seconds[index]}") – $(format_duration "${view_bat_remaining_high_seconds[index]}") · p25–p75" \
        "$dim"
    fi
  fi
}

heading
battery_view_collect

monitor_state=$(service_state battery-session-monitor.service)
poller_state=$(service_state battery-session-tracker.timer)
services_healthy=0
if [[ $monitor_state == active && $poller_state == active ]]; then
  services_healthy=1
  field "Services" "healthy" "$green"
else
  field "Services" "tracker $poller_state · monitor $monitor_state" "$red"
fi

for ((index = 0; index < ${#view_bat_name[@]}; index++)); do
  battery_block "$index"
done

# Batteries this machine has learned about that are not installed right now.
# This is the only place their evidence is ever shown: it is never mixed into a
# projection for a battery that is actually present.
if ((${#view_absent_key[@]} > 0)); then
  for ((index = 0; index < ${#view_absent_key[@]}; index++)); do
    absent_label=${view_absent_key[index]//:/ }
    absent_detail="${view_absent_windows[index]} window(s)"
    if ((view_absent_last[index] > 0)); then
      absent_detail+=" · last seen $(format_age $((view_generated_epoch - view_absent_last[index])))"
    fi
    field "Not installed" "$absent_label · $absent_detail" "$dim"
  done
fi

window_progress=$view_model_windows
session_progress=$view_model_sessions
((window_progress > BATTERY_MODEL_MIN_WINDOWS)) && window_progress=$BATTERY_MODEL_MIN_WINDOWS
((session_progress > BATTERY_MODEL_MIN_SESSIONS)) && session_progress=$BATTERY_MODEL_MIN_SESSIONS
learning_label="$window_progress/$BATTERY_MODEL_MIN_WINDOWS windows · $session_progress/$BATTERY_MODEL_MIN_SESSIONS sessions"

# A power-supply tree we cannot read at all is not the same as one that
# holds no battery; only the second is worth reporting as a missing battery.
if ((view_sysfs_available == 1 && ${#view_bat_name[@]} == 0)); then
  field "Battery" "not detected" "$red"
  field "Model" "unavailable · no present battery" "$red"
  ((services_healthy == 0)) && field "Action" "run make install, then inspect failed user services" "$yellow"
  exit 0
fi

if ((view_last_observed_epoch == 0)); then
  field "Model" "waiting for first tracker poll" "$yellow"
  if [[ $view_history_state == unsupported ]]; then
    field "History" "unsupported format" "$red"
  else
    field "Learning" "$learning_label" "$yellow"
  fi
  ((services_healthy == 0)) && field "Action" "run make install, then inspect failed user services" "$yellow"
  exit 0
fi

# The tracker being down makes every estimate cached, whatever its age says.
freshness=$view_freshness
[[ $freshness == live && $services_healthy == 0 ]] && freshness="cached"

case $view_power_state in
on-battery) power_label="on battery" ;;
on-charge)
  case $view_power_phase in
  charging) power_label="charging" ;;
  full) power_label="full" ;;
  held) power_label="plugged in · charge held" ;;
  *) power_label="plugged in" ;;
  esac
  ;;
*) power_label="unknown" ;;
esac
if ((view_state_since_epoch > 0 && view_generated_epoch >= view_state_since_epoch)); then
  power_label+=" · $(format_duration $((view_generated_epoch - view_state_since_epoch)))"
fi
field "Power" "$power_label"

if ((view_charge_percent >= 0)); then
  field "Energy" "$(format_energy "$view_energy_now_uwh") / $(format_energy "$view_energy_capacity_uwh") · $view_charge_percent%"
else
  field "Energy" "not available" "$yellow"
fi

model_learned=""
if ((view_model_updated_epoch > 0)); then
  model_learned=" · learned $(format_age $((view_generated_epoch - view_model_updated_epoch)))"
fi
runtime_color=$green
runtime_suffix=""
if [[ $freshness != live ]]; then
  runtime_color=$yellow
  runtime_suffix=" (cached)"
fi

# The pack summary. Per-battery figures are above; this is their total, which
# holds because these batteries discharge one after another rather than
# together.
case $view_model_state in
ready | provisional)
  if [[ $view_model_state == provisional ]]; then
    runtime_color=$yellow
    field "Pack model" "provisional · not every battery has its own evidence yet$model_learned" "$yellow"
  else
    field "Pack model" "ready$model_learned" "$green"
  fi
  if [[ $view_power_state == on-charge && $view_power_phase == full ]]; then
    field "Pack runtime$runtime_suffix" "$(format_duration "$view_full_seconds") · battery full" "$runtime_color"
  elif [[ $view_power_state == on-charge ]]; then
    field "If unplugged now$runtime_suffix" "$(format_duration "$view_remaining_seconds")" "$runtime_color"
    field "At full" "$(format_duration "$view_full_seconds")"
  else
    field "Pack remaining$runtime_suffix" "$(format_duration "$view_remaining_seconds")" "$runtime_color"
    field "At full" "$(format_duration "$view_full_seconds")"
  fi
  ;;
unavailable)
  field "Pack model" "unavailable · unsupported history format" "$red"
  ;;
*)
  field "Pack model" "learning · no battery has enough of its own evidence yet" "$yellow"
  ;;
esac

if ((view_history_legacy > 0)); then
  field "Legacy rows" \
    "$view_history_legacy pack-level row(s) from an older schema · not usable per battery" "$dim"
fi
if ((view_history_archived > 0)); then
  field "History" "$view_history_recent recent · $view_history_archived archived" "$dim"
fi
if ((view_history_future > 0)); then
  field "History warning" "$view_history_future future-dated row(s) ignored" "$yellow"
fi

if [[ -n $view_window_reset_reason ]]; then
  if [[ $view_window_reset_reason == energy-unavailable ]] && ((view_window_start_epoch == 0)); then
    field "Sampling" "paused · $(sampling_reason_label "$view_window_reset_reason")" "$yellow"
  else
    field "Sampling" "restarted · $(sampling_reason_label "$view_window_reset_reason")" "$yellow"
  fi
fi

case $freshness in
live) field "Updated" "$(format_age "$view_tracker_age_seconds")" "$dim" ;;
cached) field "Data" "stale · tracker updated $(format_age "$view_tracker_age_seconds"); estimates are cached" "$yellow" ;;
clock-mismatch) field "Data" "clock mismatch · estimates are cached" "$yellow" ;;
*) field "Data" "freshness unknown · estimates may be cached" "$yellow" ;;
esac
if ((services_healthy == 0)); then
  field "Action" "run make install, then inspect failed user services" "$yellow"
fi

if [[ $verbose == 1 ]]; then
  state_dir="${BATTERY_SESSION_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/battery-session}"
  field "State file" "$state_dir/state" "$dim"
  field "View schema" "$BATTERY_VIEW_SCHEMA v$BATTERY_VIEW_VERSION · state v$BATTERY_STATE_SCHEMA_VERSION" "$dim"
  field "History detail" "$view_history_total retained · $view_history_recent recent · $view_model_sessions recent sessions · $view_history_future future" "$dim"
  if ((view_model_updated_epoch > 0)); then
    field "Last learned" "$(format_age $((view_generated_epoch - view_model_updated_epoch)))" "$dim"
  fi
  field "Session" "${view_session_id:-none}" "$dim"
  if ((view_window_start_epoch > 0)); then
    field "Window" "open $(format_duration "$view_window_seconds") of $(format_duration "$BATTERY_MODEL_WINDOW_SECONDS")" "$dim"
  else
    field "Window" "inactive" "$dim"
  fi
  field "Battery fingerprint" "${view_battery_fingerprint//\\,/, }" "$dim"
  field "Battery set key" "${view_pack_key//,/, }" "$dim"
fi
