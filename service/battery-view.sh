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
view_model_updated_epoch=0
view_history_state="missing"
view_history_total=0
view_history_recent=0
view_history_archived=0
view_history_future=0
view_history_legacy=0         # pack-level rows from schema v1 and v2
view_pack_key=""              # identity of the set installed now
view_pack_key_weak=0          # 1 when no serial separates identical spares
# Batteries this machine has evidence for that are not installed right now.
# Reported so a swapped-out cell is visible; never used for a projection.
view_absent_key=()
view_absent_windows=()
view_absent_last=()
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
view_bat_held=()          # parked at its own configured charge cap
view_bat_serial=()
# One model per battery: a projection for a cell is built from that cell's own
# evidence, never from another's.
view_bat_key=()
view_bat_model_state=()
view_bat_windows=()
view_bat_sessions=()
view_bat_typical_draw_mw=()
view_bat_remaining_seconds=()
view_bat_full_seconds=()
view_bat_remaining_low_seconds=()
view_bat_remaining_high_seconds=()
view_bat_estimator=()          # the estimator this battery projects with
view_bat_estimator_error=()    # its held-out mean error, mW

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
  local present cycles model vendor serial battery_key
  local charging=0 full_count=0 held=0 count=0
  local -a pack_keys=()

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
    battery_view_read serial "$battery_dir/serial_number"

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
    view_bat_serial+=("$serial")
    battery_key=$(battery_model_battery_key "$name" "$vendor" "$model" "$serial")
    view_bat_key+=("$battery_key")
    pack_keys+=("$battery_key")
    view_bat_end_threshold+=("$threshold")
    if battery_model_threshold_held "$status" "$capacity" "$threshold"; then
      view_bat_held+=(1)
      ((held += 1))
    else
      view_bat_held+=(0)
    fi

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
    esac
  done

  if ((${#pack_keys[@]} > 0)); then
    view_pack_key=$(battery_model_pack_key "${pack_keys[@]}")
    battery_model_pack_key_is_weak "$view_pack_key" && view_pack_key_weak=1
  fi

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

# The learned model, one per battery.
#
# A projection answers "how long will this cell last from where it is now", so
# it is built from that cell's own windows. Another battery's evidence is never
# mixed in: it describes a different capacity, a different age, and a different
# discharge curve. The pack figure is the sum of the per-battery projections,
# which holds because these batteries discharge in sequence rather than
# together — while one supplies the system the other sits idle.
battery_view_collect_model() {
  local history_file=$1
  local index key confidence draw p25 p75 energy_now energy_full estimator
  local ready_count=0 modelled=0 present_count=${#view_bat_name[@]}
  local absent

  battery_model_load_history "$history_file" "$view_generated_epoch"
  # Which estimator each battery projects with was decided by the tracker when
  # it last recorded a window. Reading the answer keeps the scoring cost off
  # the panel refresh path.
  battery_model_load_estimators "${history_file%/*}/estimators.tsv"
  view_history_state=$battery_model_state
  view_history_total=$battery_model_total_rows
  view_history_future=$battery_model_future_rows
  view_history_legacy=$battery_model_legacy_rows

  for ((index = 0; index < present_count; index++)); do
    key=${view_bat_key[index]}
    energy_now=${view_bat_energy_now_uwh[index]}
    energy_full=${view_bat_energy_full_uwh[index]}
    battery_model_select_battery "$key"

    view_bat_windows+=("$battery_model_window_count")
    view_bat_sessions+=("$battery_model_session_count")
    ((battery_model_latest_epoch > view_model_updated_epoch)) &&
      view_model_updated_epoch=$battery_model_latest_epoch
    view_history_recent=$((view_history_recent + battery_model_window_count))

    confidence=$(battery_model_confidence)
    estimator=$(battery_model_estimator_for "$key")
    view_bat_estimator+=("$estimator")
    view_bat_estimator_error+=("${battery_model_estimator_error[$key]:-0}")
    draw=0
    if [[ $confidence == ready || $confidence == provisional ]]; then
      draw=$(battery_model_estimator_draw "$estimator")
    fi
    if ((draw <= 0)); then
      view_bat_model_state+=("$confidence")
      view_bat_typical_draw_mw+=(0)
      view_bat_remaining_seconds+=(0)
      view_bat_full_seconds+=(0)
      view_bat_remaining_low_seconds+=(0)
      view_bat_remaining_high_seconds+=(0)
      continue
    fi
    if ((energy_full <= 0)); then
      view_bat_model_state+=("blocked-energy")
      view_bat_typical_draw_mw+=("$draw")
      view_bat_remaining_seconds+=(0)
      view_bat_full_seconds+=(0)
      view_bat_remaining_low_seconds+=(0)
      view_bat_remaining_high_seconds+=(0)
      continue
    fi

    p25=$(battery_model_percentile battery_model_draws 25)
    p75=$(battery_model_percentile battery_model_draws 75)
    view_bat_model_state+=("$confidence")
    view_bat_typical_draw_mw+=("$draw")
    view_bat_remaining_seconds+=("$(battery_model_project_seconds "$energy_now" "$draw")")
    view_bat_full_seconds+=("$(battery_model_project_seconds "$energy_full" "$draw")")
    # A heavier draw buys less time, so the p75 draw sets the low edge.
    view_bat_remaining_low_seconds+=("$(battery_model_project_seconds "$energy_now" "$p75")")
    view_bat_remaining_high_seconds+=("$(battery_model_project_seconds "$energy_now" "$p25")")

    modelled=$((modelled + 1))
    [[ $confidence == ready ]] && ready_count=$((ready_count + 1))
    view_remaining_seconds=$((view_remaining_seconds + view_bat_remaining_seconds[index]))
    view_full_seconds=$((view_full_seconds + view_bat_full_seconds[index]))
    view_remaining_low_seconds=$((view_remaining_low_seconds + view_bat_remaining_low_seconds[index]))
    view_remaining_high_seconds=$((view_remaining_high_seconds + view_bat_remaining_high_seconds[index]))
    view_typical_draw_mw=$((view_typical_draw_mw + draw))
    view_model_windows=$((view_model_windows + battery_model_window_count))
    ((battery_model_session_count > view_model_sessions)) &&
      view_model_sessions=$battery_model_session_count
  done

  # The pack is only as certain as its least certain modelled battery.
  if [[ $battery_model_state == unsupported ]]; then
    view_model_state="unavailable"
  elif ((present_count == 0 || modelled == 0)); then
    view_model_state="learning"
  elif ((ready_count == present_count)); then
    view_model_state="ready"
  else
    view_model_state="provisional"
  fi

  # Every other battery this machine has evidence for. Reported so a swapped
  # cell stays visible; never mixed into a projection.
  for key in ${battery_model_keys[@]+"${battery_model_keys[@]}"}; do
    absent=1
    for ((index = 0; index < present_count; index++)); do
      [[ ${view_bat_key[index]} == "$key" ]] && absent=0 && break
    done
    ((absent == 1)) || continue
    battery_model_select_battery "$key"
    view_absent_key+=("$key")
    view_absent_windows+=("$battery_model_window_count")
    view_absent_last+=("$battery_model_latest_epoch")
    # Their windows are still inside the lookback, so they are recent evidence
    # about this machine even though no projection may use them.
    view_history_recent=$((view_history_recent + battery_model_window_count))
  done

  view_history_archived=$((view_history_total - view_history_recent -
    view_history_future - view_history_legacy))
  ((view_history_archived >= 0)) || view_history_archived=0
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
  local index separator="" name status cycles model vendor held key state estimator
  _bv_bat_out=""
  for ((index = 0; index < ${#view_bat_name[@]}; index++)); do
    battery_view_json_string name "${view_bat_name[index]}"
    battery_view_json_string status "${view_bat_status[index]}"
    battery_view_json_string cycles "${view_bat_cycle_count[index]}"
    battery_view_json_string model "${view_bat_model[index]}"
    battery_view_json_string vendor "${view_bat_vendor[index]}"
    battery_view_json_bool held "${view_bat_held[index]}"
    battery_view_json_string key "${view_bat_key[index]}"
    battery_view_json_string state "${view_bat_model_state[index]}"
    battery_view_json_string estimator "${view_bat_estimator[index]}"
    printf -v _bv_bat_out '%s%s\n    {"name": %s, "status": %s, "percent": %s, "energy_now_uwh": %s, "energy_full_uwh": %s, "energy_full_design_uwh": %s, "power_now_uw": %s, "cycle_count": %s, "model": %s, "vendor": %s, "end_threshold_percent": %s, "held": %s, "key": %s, "model": {"state": %s, "estimator": %s, "estimator_error_mw": %s, "windows": %s, "sessions": %s, "typical_draw_mw": %s, "remaining_seconds": %s, "full_seconds": %s, "remaining_low_seconds": %s, "remaining_high_seconds": %s}}' \
      "$_bv_bat_out" "$separator" "$name" "$status" \
      "${view_bat_percent[index]}" \
      "${view_bat_energy_now_uwh[index]}" \
      "${view_bat_energy_full_uwh[index]}" \
      "${view_bat_energy_design_uwh[index]}" \
      "${view_bat_power_now_uw[index]}" \
      "$cycles" "$model" "$vendor" \
      "${view_bat_end_threshold[index]}" "$held" "$key" "$state" "$estimator" \
      "${view_bat_estimator_error[index]}" \
      "${view_bat_windows[index]}" "${view_bat_sessions[index]}" \
      "${view_bat_typical_draw_mw[index]}" \
      "${view_bat_remaining_seconds[index]}" "${view_bat_full_seconds[index]}" \
      "${view_bat_remaining_low_seconds[index]}" \
      "${view_bat_remaining_high_seconds[index]}"
    separator=","
  done
  [[ -n $separator ]] && _bv_bat_out+=$'\n  '
  return 0
}

# Batteries with recorded evidence that are not installed now.
battery_view_json_absent() {
  local -n _bv_absent_out=$1
  local index separator="" key
  _bv_absent_out=""
  for ((index = 0; index < ${#view_absent_key[@]}; index++)); do
    battery_view_json_string key "${view_absent_key[index]}"
    printf -v _bv_absent_out '%s%s\n    {"key": %s, "windows": %s, "last_seen_epoch": %s}' \
      "$_bv_absent_out" "$separator" "$key" \
      "${view_absent_windows[index]}" "${view_absent_last[index]}"
    separator=","
  done
  [[ -n $separator ]] && _bv_absent_out+=$'\n  '
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
  local pack_key pack_key_weak absent

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
  battery_view_json_string pack_key "$view_pack_key"
  battery_view_json_bool pack_key_weak "$view_pack_key_weak"
  battery_view_json_string active_profile "$view_active_profile"
  battery_view_json_batteries batteries
  battery_view_json_absent absent
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
  # The pack summary. Estimator selection and recency are per battery and live
  # in each battery's own object; the pack carries only the totals.
  printf '  "model": {"state": %s, "windows": %s, "sessions": %s, "required_windows": %s, "required_sessions": %s, "typical_draw_mw": %s, "remaining_seconds": %s, "full_seconds": %s, "remaining_low_seconds": %s, "remaining_high_seconds": %s, "updated_epoch": %s},\n' \
    "$model_state" "$view_model_windows" "$view_model_sessions" \
    "$BATTERY_MODEL_MIN_WINDOWS" "$BATTERY_MODEL_MIN_SESSIONS" \
    "$view_typical_draw_mw" "$view_remaining_seconds" "$view_full_seconds" \
    "$view_remaining_low_seconds" "$view_remaining_high_seconds" \
    "$view_model_updated_epoch"
  printf '  "history": {"state": %s, "total": %s, "recent": %s, "archived": %s, "future": %s, "legacy": %s},\n' \
    "$history_state" "$view_history_total" "$view_history_recent" \
    "$view_history_archived" "$view_history_future" "$view_history_legacy"
  printf '  "sampling": {"session_id": %s, "window_start_epoch": %s, "window_seconds": %s, "window_target_seconds": %s, "reset_reason": %s, "fingerprint": %s, "pack_key": %s, "pack_key_weak": %s},\n' \
    "$session_id" "$view_window_start_epoch" "$view_window_seconds" \
    "$BATTERY_MODEL_WINDOW_SECONDS" "$reset_reason" "$fingerprint" \
    "$pack_key" "$pack_key_weak"
  printf '  "tracker": {"last_observed_epoch": %s, "age_seconds": %s, "freshness": %s},\n' \
    "$view_last_observed_epoch" "$view_tracker_age_seconds" "$freshness"
  printf '  "batteries": [%s],\n' "$batteries"
  printf '  "absent_batteries": [%s],\n' "$absent"
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
