#!/usr/bin/env bash
# The aggregated battery view: one producer, one document.
#
# Everything a consumer needs about this machine's power state is computed
# here, once, and handed out as a single versioned JSON document. Panel.qml
# reads it instead of spawning six processes and parsing five ad-hoc formats;
# `make status` sources this file and renders the same values without going
# back to the raw state file; any future widget (waybar, eww, a CLI) reads the
# same document.
#
# The view is derived output, never a second source of truth. If a consumer
# needs a field the view lacks, add it here — do not read the state file
# directly from the consumer.
#
# Run directly to print the document. Source it to call battery_view_collect()
# and read the view_* variables.
#
# Requires Bash 4.3+ and awk.

[[ -n ${BATTERY_VIEW_SOURCED-} ]] && return 0
BATTERY_VIEW_SOURCED=1

readonly BATTERY_VIEW_SCHEMA="battery-view"
readonly BATTERY_VIEW_VERSION=1

battery_view_lib_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=power-supply.sh
source "$battery_view_lib_dir/power-supply.sh"
# shellcheck source=battery-model.sh
source "$battery_view_lib_dir/battery-model.sh"

# --- Collected view --------------------------------------------------------

view_generated_epoch=0
view_power_state="unknown"
view_power_phase="unknown"
view_ac_online=0
# 0 when the sysfs power-supply tree is not readable at all, which is a
# different fact from "the tree is there and holds no battery".
view_sysfs_available=0
view_state_since_epoch=0
view_state_since_at_least=0
view_charge_start_epoch=0
view_charge_end_epoch=0
view_session_id=""
view_window_start_epoch=0
view_window_seconds=0
view_window_reset_reason=""
view_battery_fingerprint=""
view_last_observed_epoch=0
view_tracker_age_seconds=0
view_freshness="unknown"
view_energy_now_uwh=0
view_energy_capacity_uwh=0
view_energy_design_uwh=0
view_charge_percent=-1
view_draw_mw=0
view_charge_limit_percent=0
view_live_time_seconds=0
view_model_state="learning"
view_model_windows=0
view_model_sessions=0
view_typical_draw_mw=0
view_remaining_seconds=0
view_full_seconds=0
view_remaining_low_seconds=0
view_remaining_high_seconds=0
view_recent_draw_mw=0
view_recent_remaining_seconds=0
view_recent_window_count=0
view_model_updated_epoch=0
view_history_state="missing"
view_history_total=0
view_history_recent=0
view_history_archived=0
view_history_future=0
view_uptime_seconds=0
view_active_profile=""
view_profiles=()
view_bat_name=()
view_bat_status=()
view_bat_percent=()
view_bat_energy_now_uwh=()
view_bat_energy_full_uwh=()
view_bat_energy_design_uwh=()
view_bat_power_now_uw=()
view_bat_cycle_count=()
view_bat_model=()
view_bat_vendor=()
view_bat_end_threshold=()

# --- Helpers ---------------------------------------------------------------

# Read one sysfs field into a named variable. Deliberately not a command
# substitution: the panel refreshes this view every few seconds while it is
# open, and `$(cat field)` per battery field is exactly the fork burst the
# view exists to remove. `$(<file)` is read by bash itself, without a fork.
battery_view_read() {
  local -n _bv_read_out=$1
  _bv_read_out=""
  [[ -f "$2" ]] || return 1
  _bv_read_out=$(<"$2")
  return 0
}

battery_view_positive_int() {
  [[ $1 =~ ^[1-9][0-9]*$ ]]
}

battery_view_nonnegative_int() {
  [[ $1 =~ ^[0-9]+$ ]]
}

# --- Collection ------------------------------------------------------------

# Populate every view_* variable. Reads sysfs, the tracker state file, the
# discharge history, /proc/uptime, and the power-profile list.
battery_view_collect() {
  local state_dir history_file state_file
  local battery_dir name raw value energy full design power threshold
  local stale_after

  state_dir="${BATTERY_SESSION_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/battery-session}"
  state_file="$state_dir/state"
  history_file="$state_dir/discharge-history.tsv"
  power_supply_root="${POWER_SUPPLY_ROOT:-${BATTERY_STATUS_POWER_SUPPLY_ROOT:-/sys/class/power_supply}}"
  stale_after="${BATTERY_STATUS_STALE_AFTER:-$BATTERY_MODEL_MAX_POLL_GAP_SECONDS}"

  if [[ -n ${BATTERY_VIEW_NOW-} ]]; then
    view_generated_epoch=$BATTERY_VIEW_NOW
  elif [[ -n ${BATTERY_INTELLIGENCE_NOW-} ]]; then
    view_generated_epoch=$BATTERY_INTELLIGENCE_NOW
  else
    printf -v view_generated_epoch '%(%s)T' -1
  fi

  battery_view_collect_state "$state_file"
  battery_view_collect_batteries
  battery_view_collect_model "$history_file"
  battery_view_collect_freshness "$stale_after"
  battery_view_collect_system
}

# The tracker writes the state file with printf %q, so sourcing it is the
# format's own reader. The file is created and owned by this user's service.
battery_view_collect_state() {
  local state_file=$1
  local previous_state="" state_since=0 state_since_at_least=0
  local last_charge_start=0 last_charge_end=0 last_observed=0
  local discharge_session_id="" window_start_epoch=0 window_reset_reason=""
  local battery_fingerprint=""

  if [[ -f "$state_file" ]]; then
    # shellcheck disable=SC1090
    source "$state_file" 2>/dev/null || true
  fi

  view_power_state=${previous_state:-unknown}
  battery_view_nonnegative_int "$state_since" && view_state_since_epoch=$state_since
  [[ $state_since_at_least == 1 ]] && view_state_since_at_least=1
  battery_view_nonnegative_int "$last_charge_start" && view_charge_start_epoch=$last_charge_start
  battery_view_nonnegative_int "$last_charge_end" && view_charge_end_epoch=$last_charge_end
  battery_view_nonnegative_int "$last_observed" && view_last_observed_epoch=$last_observed
  view_session_id=$discharge_session_id
  battery_view_nonnegative_int "$window_start_epoch" && view_window_start_epoch=$window_start_epoch
  view_window_reset_reason=$window_reset_reason
  view_battery_fingerprint=$battery_fingerprint

  if battery_view_positive_int "$view_window_start_epoch" &&
    ((view_generated_epoch >= view_window_start_epoch)); then
    view_window_seconds=$((view_generated_epoch - view_window_start_epoch))
  fi
}

# One pass over sysfs. Fills the per-battery arrays and the pack totals the
# panel shows, so no consumer forks `cat` per battery field.
battery_view_collect_batteries() {
  local battery_dir name status capacity energy full design power threshold
  local present cycles model vendor
  local charging=0 full_count=0 held=0 count=0

  [[ -d "$power_supply_root" ]] || return 0
  view_sysfs_available=1
  ac_mains_online && view_ac_online=1

  for battery_dir in "$power_supply_root"/BAT*; do
    [[ -d "$battery_dir" ]] || continue
    if [[ -f "$battery_dir/present" ]]; then
      battery_view_read present "$battery_dir/present"
      [[ $present == "1" ]] || continue
    elif [[ ! -f "$battery_dir/status" && ! -f "$battery_dir/capacity" ]]; then
      continue
    fi

    name=${battery_dir##*/}
    battery_view_read status "$battery_dir/status"
    battery_view_read capacity "$battery_dir/capacity"
    battery_view_read energy "$battery_dir/energy_now" ||
      battery_view_read energy "$battery_dir/charge_now"
    battery_view_read full "$battery_dir/energy_full" ||
      battery_view_read full "$battery_dir/charge_full"
    battery_view_read design "$battery_dir/energy_full_design" ||
      battery_view_read design "$battery_dir/charge_full_design"
    battery_view_read power "$battery_dir/power_now"
    battery_view_read threshold "$battery_dir/charge_control_end_threshold"
    battery_view_read cycles "$battery_dir/cycle_count"
    battery_view_read model "$battery_dir/model_name"
    battery_view_read vendor "$battery_dir/manufacturer"

    battery_view_nonnegative_int "$capacity" || capacity=0
    battery_view_nonnegative_int "$energy" || energy=0
    battery_view_nonnegative_int "$full" || full=0
    battery_view_nonnegative_int "$design" || design=0
    battery_view_nonnegative_int "$power" || power=0
    battery_view_nonnegative_int "$threshold" || threshold=0

    view_bat_name+=("$name")
    view_bat_status+=("$status")
    view_bat_percent+=("$capacity")
    view_bat_energy_now_uwh+=("$energy")
    view_bat_energy_full_uwh+=("$full")
    view_bat_energy_design_uwh+=("$design")
    view_bat_power_now_uw+=("$power")
    view_bat_cycle_count+=("$cycles")
    view_bat_model+=("$model")
    view_bat_vendor+=("$vendor")
    view_bat_end_threshold+=("$threshold")

    view_energy_now_uwh=$((view_energy_now_uwh + energy))
    view_energy_capacity_uwh=$((view_energy_capacity_uwh + full))
    view_energy_design_uwh=$((view_energy_design_uwh + design))
    # sysfs reports power in µW; the model speaks mW.
    view_draw_mw=$((view_draw_mw + power / 1000))
    ((threshold > view_charge_limit_percent)) && view_charge_limit_percent=$threshold
    ((count += 1))

    case $status in
    Charging) ((charging += 1)) ;;
    Full) ((full_count += 1)) ;;
    "Not charging") ((held += 1)) ;;
    esac
  done

  if ((view_energy_capacity_uwh > 0 && view_energy_now_uwh > 0)); then
    view_charge_percent=$((view_energy_now_uwh * 100 / view_energy_capacity_uwh))
    ((view_charge_percent > 100)) && view_charge_percent=100
  fi

  if ((count == 0)); then
    view_power_phase="absent"
  elif ((charging > 0)); then
    view_power_phase="charging"
  elif ((view_ac_online == 0)); then
    view_power_phase="discharging"
  elif ((full_count == count)); then
    view_power_phase="full"
  elif ((held > 0)); then
    view_power_phase="held"
  else
    view_power_phase="plugged"
  fi
  if [[ $view_power_phase == plugged ]] && ((view_charge_percent >= 99)); then
    view_power_phase="full"
  fi

  # What the pack is doing right now, from the live draw rather than history.
  if ((view_draw_mw > 0)); then
    if ((view_ac_online == 0)); then
      view_live_time_seconds=$(battery_model_project_seconds "$view_energy_now_uwh" "$view_draw_mw")
    elif ((view_energy_capacity_uwh > view_energy_now_uwh)); then
      view_live_time_seconds=$(battery_model_project_seconds \
        "$((view_energy_capacity_uwh - view_energy_now_uwh))" "$view_draw_mw")
    fi
  fi
}

# The learned model: evidence gate, typical draw, projection, and band.
battery_view_collect_model() {
  local history_file=$1 confidence p25 p75

  battery_model_load_history "$history_file" "$view_generated_epoch"
  view_history_state=$battery_model_state
  view_history_total=$battery_model_total_rows
  view_history_recent=$battery_model_window_count
  view_history_future=$battery_model_future_rows
  view_history_archived=$((battery_model_total_rows - battery_model_window_count - battery_model_future_rows))
  ((view_history_archived >= 0)) || view_history_archived=0
  view_model_windows=$battery_model_window_count
  view_model_sessions=$battery_model_session_count
  view_model_updated_epoch=$battery_model_latest_epoch
  view_recent_window_count=${#battery_model_recent_draws[@]}

  confidence=$(battery_model_confidence)
  view_model_state=$confidence
  [[ $confidence == ready || $confidence == provisional ]] || return 0

  view_typical_draw_mw=$(battery_model_median battery_model_draws)
  if ((view_typical_draw_mw <= 0)); then
    view_model_state="blocked-runtime"
    return 0
  fi
  if ((view_energy_capacity_uwh <= 0)); then
    view_model_state="blocked-energy"
    return 0
  fi

  view_full_seconds=$(battery_model_project_seconds "$view_energy_capacity_uwh" "$view_typical_draw_mw")
  view_remaining_seconds=$(battery_model_project_seconds "$view_energy_now_uwh" "$view_typical_draw_mw")

  # A heavier draw buys less time, so the p75 draw is the low edge of the band.
  p25=$(battery_model_percentile battery_model_draws 25)
  p75=$(battery_model_percentile battery_model_draws 75)
  view_remaining_high_seconds=$(battery_model_project_seconds "$view_energy_now_uwh" "$p25")
  view_remaining_low_seconds=$(battery_model_project_seconds "$view_energy_now_uwh" "$p75")

  # "Right now": the newest few windows, which track a workload shift within
  # the hour that a 30-day median cannot see.
  if ((view_recent_window_count > 0)); then
    view_recent_draw_mw=$(battery_model_mean battery_model_recent_draws)
    view_recent_remaining_seconds=$(battery_model_project_seconds \
      "$view_energy_now_uwh" "$view_recent_draw_mw")
  fi
}

battery_view_collect_freshness() {
  local stale_after=$1
  if battery_view_positive_int "$view_last_observed_epoch"; then
    view_tracker_age_seconds=$((view_generated_epoch - view_last_observed_epoch))
    if ((view_tracker_age_seconds < 0)); then
      view_freshness="clock-mismatch"
    elif ((view_tracker_age_seconds > stale_after)); then
      view_freshness="cached"
    else
      view_freshness="live"
    fi
  fi
}

battery_view_collect_system() {
  local uptime_raw="" name active
  battery_view_read uptime_raw /proc/uptime
  uptime_raw=${uptime_raw%% *}
  uptime_raw=${uptime_raw%%.*}
  battery_view_nonnegative_int "$uptime_raw" && view_uptime_seconds=$uptime_raw

  local profiles_command="${BATTERY_VIEW_PROFILES_COMMAND:-omarchy-powerprofiles-list}"
  command -v -- "$profiles_command" >/dev/null 2>&1 || return 0
  while IFS=$'\t' read -r name active; do
    [[ -n $name ]] || continue
    view_profiles+=("$name")
    [[ $active == 1 ]] && view_active_profile=$name
  done < <("$profiles_command" --active-state 2>/dev/null || true)
}

# --- JSON emission ---------------------------------------------------------
# Every string in the document passes through battery_view_json_string, so the
# escaping rule is written down once. Nothing here uses a command substitution:
# the panel re-reads this document on a timer, and `$(escape ...)` per field
# would put back the forks the view was built to remove.

# battery_view_json_string OUTVAR TEXT — quote and escape TEXT into OUTVAR.
battery_view_json_string() {
  local -n _bv_json_out=$1
  local text=$2
  text=${text//\\/\\\\}
  text=${text//\"/\\\"}
  text=${text//$'\n'/\\n}
  text=${text//$'\r'/\\r}
  text=${text//$'\t'/\\t}
  _bv_json_out="\"$text\""
}

# battery_view_json_bool OUTVAR VALUE — 1 becomes true, anything else false.
battery_view_json_bool() {
  local -n _bv_bool_out=$1
  if [[ $2 == 1 ]]; then _bv_bool_out="true"; else _bv_bool_out="false"; fi
}

battery_view_json_batteries() {
  local -n _bv_bat_out=$1
  local index separator="" name status cycles model vendor
  _bv_bat_out=""
  for ((index = 0; index < ${#view_bat_name[@]}; index++)); do
    battery_view_json_string name "${view_bat_name[index]}"
    battery_view_json_string status "${view_bat_status[index]}"
    battery_view_json_string cycles "${view_bat_cycle_count[index]}"
    battery_view_json_string model "${view_bat_model[index]}"
    battery_view_json_string vendor "${view_bat_vendor[index]}"
    printf -v _bv_bat_out '%s%s\n    {"name": %s, "status": %s, "percent": %s, "energy_now_uwh": %s, "energy_full_uwh": %s, "energy_full_design_uwh": %s, "power_now_uw": %s, "cycle_count": %s, "model": %s, "vendor": %s, "end_threshold_percent": %s}' \
      "$_bv_bat_out" "$separator" "$name" "$status" \
      "${view_bat_percent[index]}" \
      "${view_bat_energy_now_uwh[index]}" \
      "${view_bat_energy_full_uwh[index]}" \
      "${view_bat_energy_design_uwh[index]}" \
      "${view_bat_power_now_uw[index]}" \
      "$cycles" "$model" "$vendor" \
      "${view_bat_end_threshold[index]}"
    separator=","
  done
  [[ -n $separator ]] && _bv_bat_out+=$'\n  '
  return 0
}

battery_view_json_profiles() {
  local -n _bv_prof_out=$1
  local profile quoted separator=""
  _bv_prof_out=""
  for profile in ${view_profiles[@]+"${view_profiles[@]}"}; do
    battery_view_json_string quoted "$profile"
    _bv_prof_out+="$separator$quoted"
    separator=", "
  done
  return 0
}

battery_view_emit_json() {
  local power_state power_phase ac_online since_at_least
  local model_state history_state session_id reset_reason fingerprint
  local freshness batteries profiles active_profile sysfs_available

  battery_view_json_string power_state "$view_power_state"
  battery_view_json_string power_phase "$view_power_phase"
  battery_view_json_bool ac_online "$view_ac_online"
  battery_view_json_bool sysfs_available "$view_sysfs_available"
  battery_view_json_bool since_at_least "$view_state_since_at_least"
  battery_view_json_string model_state "$view_model_state"
  battery_view_json_string history_state "$view_history_state"
  battery_view_json_string session_id "$view_session_id"
  battery_view_json_string reset_reason "$view_window_reset_reason"
  battery_view_json_string fingerprint "$view_battery_fingerprint"
  battery_view_json_string freshness "$view_freshness"
  battery_view_json_string active_profile "$view_active_profile"
  battery_view_json_batteries batteries
  battery_view_json_profiles profiles

  printf '{\n'
  printf '  "schema": "%s",\n' "$BATTERY_VIEW_SCHEMA"
  printf '  "version": %s,\n' "$BATTERY_VIEW_VERSION"
  printf '  "generated_epoch": %s,\n' "$view_generated_epoch"
  printf '  "power": {"state": %s, "phase": %s, "ac_online": %s, "sysfs_available": %s, "state_since_epoch": %s, "state_since_at_least": %s, "charge_start_epoch": %s, "charge_end_epoch": %s},\n' \
    "$power_state" "$power_phase" "$ac_online" "$sysfs_available" "$view_state_since_epoch" \
    "$since_at_least" "$view_charge_start_epoch" "$view_charge_end_epoch"
  printf '  "energy": {"now_uwh": %s, "capacity_uwh": %s, "design_uwh": %s, "percent": %s, "draw_mw": %s, "charge_limit_percent": %s, "live_time_seconds": %s},\n' \
    "$view_energy_now_uwh" "$view_energy_capacity_uwh" "$view_energy_design_uwh" \
    "$view_charge_percent" "$view_draw_mw" "$view_charge_limit_percent" \
    "$view_live_time_seconds"
  printf '  "model": {"state": %s, "windows": %s, "sessions": %s, "required_windows": %s, "required_sessions": %s, "typical_draw_mw": %s, "remaining_seconds": %s, "full_seconds": %s, "remaining_low_seconds": %s, "remaining_high_seconds": %s, "recent_draw_mw": %s, "recent_remaining_seconds": %s, "recent_windows": %s, "updated_epoch": %s},\n' \
    "$model_state" "$view_model_windows" "$view_model_sessions" \
    "$BATTERY_MODEL_MIN_WINDOWS" "$BATTERY_MODEL_MIN_SESSIONS" \
    "$view_typical_draw_mw" "$view_remaining_seconds" "$view_full_seconds" \
    "$view_remaining_low_seconds" "$view_remaining_high_seconds" \
    "$view_recent_draw_mw" "$view_recent_remaining_seconds" \
    "$view_recent_window_count" "$view_model_updated_epoch"
  printf '  "history": {"state": %s, "total": %s, "recent": %s, "archived": %s, "future": %s},\n' \
    "$history_state" "$view_history_total" "$view_history_recent" \
    "$view_history_archived" "$view_history_future"
  printf '  "sampling": {"session_id": %s, "window_start_epoch": %s, "window_seconds": %s, "window_target_seconds": %s, "reset_reason": %s, "fingerprint": %s},\n' \
    "$session_id" "$view_window_start_epoch" "$view_window_seconds" \
    "$BATTERY_MODEL_WINDOW_SECONDS" "$reset_reason" "$fingerprint"
  printf '  "tracker": {"last_observed_epoch": %s, "age_seconds": %s, "freshness": %s},\n' \
    "$view_last_observed_epoch" "$view_tracker_age_seconds" "$freshness"
  printf '  "batteries": [%s],\n' "$batteries"
  printf '  "profiles": {"available": [%s], "active": %s},\n' \
    "$profiles" "$active_profile"
  printf '  "system": {"uptime_seconds": %s}\n' "$view_uptime_seconds"
  printf '}\n'
}

# Run directly: collect and print the document.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  set -uo pipefail
  case ${1-} in
  "" | --json) ;;
  *)
    printf 'Usage: %s [--json]\n' "${0##*/}" >&2
    exit 2
    ;;
  esac
  battery_view_collect
  battery_view_emit_json
fi
