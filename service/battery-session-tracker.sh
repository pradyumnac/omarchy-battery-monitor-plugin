#!/usr/bin/env bash
# Persist real AC/battery transitions for the Omarchy power widget.
# This is intentionally a user-level poller: no udev or root access required.

set -euo pipefail

power_event=0
case ${1-} in
"") ;;
--once) ;;
--power-event) power_event=1 ;;
*)
  printf 'Usage: %s [--once|--power-event]\n' "${0##*/}" >&2
  exit 2
  ;;
esac

account_home=$(getent passwd "$(id -u)" | cut -d: -f6)
[[ -n $account_home ]] || {
  printf 'Unable to determine the current user home directory.\n' >&2
  exit 1
}
home_dir=$(realpath -m -- "$account_home")
state_dir=$(realpath -m -- "${BATTERY_SESSION_STATE_DIR:-${XDG_STATE_HOME:-$home_dir/.local/state}/battery-session}")
case "$state_dir/" in
"$home_dir"/*) ;;
*)
  printf 'Refusing state path outside HOME: %s\n' "$state_dir" >&2
  exit 1
  ;;
esac
state_file="$state_dir/state"
power_supply_root="${POWER_SUPPLY_ROOT:-/sys/class/power_supply}"
notification_command="${BATTERY_SESSION_NOTIFY_COMMAND:-omarchy-notification-send}"
[[ -d "$state_dir" ]] || mkdir -p "$state_dir"

service_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=power-supply.sh
source "$service_dir/power-supply.sh"
# shellcheck source=battery-model.sh
source "$service_dir/battery-model.sh"
ac_online=0
ac_mains_online && ac_online=1

# Do not create a fake battery session on desktops.
battery_dirs=()
for battery_dir in "$power_supply_root"/BAT*; do
  [[ -d "$battery_dir" ]] || continue
  if [[ -f "$battery_dir/present" ]]; then
    [[ "$(<"$battery_dir/present")" == "1" ]] || continue
  else
    [[ -f "$battery_dir/status" || -f "$battery_dir/capacity" ]] || continue
  fi
  battery_dirs+=("$battery_dir")
done
((${#battery_dirs[@]} > 0)) || exit 0

is_nonnegative_integer() {
  [[ $1 =~ ^[0-9]+$ ]]
}

join_with_newline() {
  local result="" part
  for part in "$@"; do
    [[ -n $part ]] || continue
    [[ -z $result ]] || result+=$'\n'
    result+="$part"
  done
  printf '%s' "$result"
}

capture_battery_levels() {
  local battery_dir name capacity result=""
  for battery_dir in "${battery_dirs[@]}"; do
    name=${battery_dir##*/}
    capacity=""
    [[ -f "$battery_dir/capacity" ]] && capacity=$(<"$battery_dir/capacity")
    is_nonnegative_integer "$capacity" || continue
    [[ -z $result ]] || result+=","
    result+="$name:$capacity"
  done
  printf '%s' "$result"
}

capture_energy_capacity_uwh() {
  local battery_dir energy result=0
  for battery_dir in "${battery_dirs[@]}"; do
    energy=""
    if [[ -f "$battery_dir/energy_full" ]]; then
      energy=$(<"$battery_dir/energy_full")
    elif [[ -f "$battery_dir/charge_full" ]]; then
      energy=$(<"$battery_dir/charge_full")
    fi
    is_nonnegative_integer "$energy" || continue
    ((energy > 0)) || continue
    result=$((result + energy))
  done
  printf '%s' "$result"
}

capture_energy_now_uwh() {
  local battery_dir energy result=0
  for battery_dir in "${battery_dirs[@]}"; do
    energy=""
    [[ -f "$battery_dir/energy_now" ]] && energy=$(<"$battery_dir/energy_now")
    is_nonnegative_integer "$energy" || return 0
    ((energy > 0)) || return 0
    result=$((result + energy))
  done
  printf '%s' "$result"
}

capture_battery_fingerprint() {
  local battery_dir name capacity mode result=""
  for battery_dir in "${battery_dirs[@]}"; do
    name=${battery_dir##*/}
    capacity=$(capture_battery_capacity "$battery_dir")
    [[ -n "$capacity" ]] || return 0
    if [[ -f "$battery_dir/energy_now" ]]; then
      mode="energy"
    else
      mode="unsupported"
    fi
    [[ -z "$result" ]] || result+=","
    result+="$name:$mode:$capacity"
  done
  printf '%s' "$result"
}

capture_battery_capacity() {
  local battery_dir=$1 capacity=""
  if [[ -f "$battery_dir/energy_full" ]]; then
    capacity=$(<"$battery_dir/energy_full")
  elif [[ -f "$battery_dir/charge_full" ]]; then
    capacity=$(<"$battery_dir/charge_full")
  fi
  is_nonnegative_integer "$capacity" && ((capacity > 0)) && printf '%s' "$capacity"
}

# Trim the history to the retention rules. Only ever called after a row was
# appended: the file cannot grow otherwise, and re-sorting a 96-row file on
# every poll was the tracker's largest recurring cost.
prune_history() {
  local history_file="$state_dir/discharge-history.tsv"
  local tmp_file cutoff
  battery_model_history_valid "$history_file" || return 0
  cutoff=$((now - BATTERY_MODEL_RETENTION_SECONDS))
  umask 077
  tmp_file="$history_file.tmp.$$"
  {
    printf '%s\n' "$BATTERY_MODEL_HISTORY_HEADER"
    awk -F '\t' -v cutoff="$cutoff" \
      '$1 ~ /^[0-9]+$/ && $1 >= cutoff && $2 != "" && $3 ~ /^[1-9][0-9]*$/ && $4 ~ /^[1-9][0-9]*$/ { print }' \
      "$history_file" | sort -n -k1,1 | tail -n "$BATTERY_MODEL_RETENTION_ROWS"
  } >"$tmp_file"
  mv -f -- "$tmp_file" "$history_file"
}

format_session_minutes() {
  local seconds=$1 minutes hours
  minutes=$(((seconds + 59) / 60))
  ((minutes > 0)) || minutes=1
  hours=$((minutes / 60))
  minutes=$((minutes % 60))
  if ((hours > 0 && minutes > 0)); then
    printf '%dh %dm' "$hours" "$minutes"
  elif ((hours > 0)); then
    printf '%dh' "$hours"
  else
    printf '%dm' "$minutes"
  fi
}

# Only claim "held at threshold" when battery_model_threshold_held() agrees;
# everything else that is merely not charging is reported plainly rather than
# with a false threshold claim. The rule lives in battery-model.sh so this
# notification, the view's pack phase, and the panel cannot disagree.
send_charge_notification() {
  local battery_dir name status capacity threshold detail
  local description charging_block held_block idle_block
  local -a charging_parts=() held_parts=() idle_parts=()

  for battery_dir in "${battery_dirs[@]}"; do
    name=${battery_dir##*/}
    status=""
    capacity=""
    threshold=""
    [[ -f "$battery_dir/status" ]] && status=$(<"$battery_dir/status")
    [[ -f "$battery_dir/capacity" ]] && capacity=$(<"$battery_dir/capacity")
    [[ -f "$battery_dir/charge_control_end_threshold" ]] &&
      threshold=$(<"$battery_dir/charge_control_end_threshold")
    detail="$name"
    is_nonnegative_integer "$capacity" && detail+=" · ${capacity}%"

    if [[ $status == "Charging" ]]; then
      charging_parts+=("$detail")
    elif [[ $status == "Not charging" ]]; then
      if battery_model_threshold_held "$status" "$capacity" "$threshold"; then
        held_parts+=("$detail")
      else
        idle_parts+=("$detail")
      fi
    fi
  done

  charging_block=$(join_with_newline "${charging_parts[@]}")
  held_block=""
  ((${#held_parts[@]} > 0)) && held_block=$(join_with_newline "⚠ Charge threshold:" "${held_parts[@]}")
  idle_block=""
  ((${#idle_parts[@]} > 0)) && idle_block=$(join_with_newline "Not charging:" "${idle_parts[@]}")

  description=""
  for block in "$charging_block" "$held_block" "$idle_block"; do
    [[ -n $block ]] || continue
    [[ -z $description ]] || description+=$'\n'
    description+="$block"
  done

  if [[ -n $notification_command ]] && command -v -- "$notification_command" >/dev/null 2>&1; then
    "$notification_command" --app-name doe.power -u low -g "󰂆" -t 6000 \
      "Plugged" "$description" || true
  fi
}

send_unplug_notification() {
  local entry name start end duration description
  local -a entries=() rows=() start_names=() end_names=()
  local -A starts=() ends=() seen=()

  IFS=',' read -r -a entries <<<"$charge_start_levels"
  for entry in "${entries[@]}"; do
    [[ $entry == BAT*:* ]] || continue
    name=${entry%%:*}
    start=${entry#*:}
    if is_nonnegative_integer "$start"; then
      starts["$name"]=$start
      start_names+=("$name")
    fi
  done

  IFS=',' read -r -a entries <<<"$(capture_battery_levels)"
  for entry in "${entries[@]}"; do
    [[ $entry == BAT*:* ]] || continue
    name=${entry%%:*}
    end=${entry#*:}
    if is_nonnegative_integer "$end"; then
      ends["$name"]=$end
      end_names+=("$name")
    fi
  done

  if [[ $charge_session_valid == 1 ]] && is_nonnegative_integer "$last_charge_start" &&
    is_nonnegative_integer "$last_charge_end" && ((last_charge_end >= last_charge_start)); then
    duration=$(format_session_minutes "$((last_charge_end - last_charge_start))")
    rows+=("Charged for ~$duration")

    for name in "${start_names[@]}"; do
      start=${starts[$name]}
      if [[ -n ${ends[$name]-} ]]; then
        end=${ends[$name]}
        rows+=("$name: ${start}% → ${end}%")
      else
        rows+=("$name: ${start}% → removed")
      fi
      seen["$name"]=1
    done

    for name in "${end_names[@]}"; do
      [[ -n ${seen[$name]-} ]] && continue
      rows+=("$name: added at ${ends[$name]}%")
    done
  else
    for name in "${end_names[@]}"; do
      rows+=("$name: ${ends[$name]}%")
    done
  fi

  description=$(join_with_newline "${rows[@]}")
  [[ -n $description ]] || description="Battery level unavailable"
  if [[ -n $notification_command ]] && command -v -- "$notification_command" >/dev/null 2>&1; then
    "$notification_command" --app-name doe.power -u low -g "󰂄" -t 8000 \
      "Unplugged" "$description" || true
  fi
}

current_state="on-battery"
((ac_online == 1)) && current_state="on-charge"
previous_state=""
state_since=0
state_since_at_least=0
last_charge_end=0
last_charge_start=0
last_observed=0
charge_start_levels=""
charge_session_valid=0
discharge_session_id=""
window_start_epoch=0
window_start_energy_uwh=0
last_sample_energy_uwh=0
window_reset_reason=""
battery_fingerprint=""
if [[ -f "$state_file" ]]; then
  # The file is created and owned by this user-level service.
  # shellcheck disable=SC1090
  source "$state_file"
fi

now=${BATTERY_SESSION_NOW:-$(date +%s)}
is_nonnegative_integer "$now" || {
  printf 'Invalid BATTERY_SESSION_NOW: %s\n' "$now" >&2
  exit 1
}
continuity=1
if [[ "$last_observed" =~ ^[0-9]+$ ]] && ((last_observed > 0)) &&
  ((now < last_observed || now - last_observed > BATTERY_MODEL_MAX_POLL_GAP_SECONDS)); then
  continuity=0
  window_reset_reason="polling-gap"
fi
current_battery_fingerprint=$(capture_battery_fingerprint)
if [[ -n "$battery_fingerprint" && "$current_battery_fingerprint" != "$battery_fingerprint" ]]; then
  window_start_epoch=0
  window_start_energy_uwh=0
  last_sample_energy_uwh=0
  window_reset_reason="battery-set-changed"
fi
battery_fingerprint="$current_battery_fingerprint"

if [[ -n "$previous_state" && "$previous_state" != "$current_state" ]]; then
  state_since="$now"
  state_since_at_least=0
  if [[ "$previous_state" == "on-charge" && "$current_state" == "on-battery" ]]; then
    last_charge_end="$now"
    ((continuity == 1)) || charge_session_valid=0
  elif [[ "$previous_state" == "on-battery" && "$current_state" == "on-charge" ]]; then
    last_charge_start="$now"
    last_charge_end=0
    charge_start_levels=$(capture_battery_levels)
    charge_session_valid=$continuity
  fi
elif [[ -z "$previous_state" || "$continuity" == 0 ]]; then
  # We cannot recover the true start after an initial observation or polling
  # gap, so start a new observed session here instead of leaving the panel at
  # "—" forever until the next power transition.
  state_since="$now"
  state_since_at_least=1
  charge_session_valid=0
elif ! is_nonnegative_integer "$state_since" || ((state_since == 0)); then
  # Recover state files created by older installs while already in this power
  # state. Those files otherwise keep the panel at "—" indefinitely.
  state_since="$now"
  state_since_at_least=1
fi

# Advance the sampling window and, when it completes, append one row of
# evidence. The window's arithmetic and its plausibility rules live in
# battery-model.sh; this function owns only the on-disk round trip.
# Sets history_appended=1 when a row was written.
record_discharge_window() {
  local current_energy elapsed energy_used draw history_file tmp_file
  current_energy=$(capture_energy_now_uwh)
  if [[ ! "$current_energy" =~ ^[1-9][0-9]*$ ]]; then
    window_start_epoch=0
    window_start_energy_uwh=0
    last_sample_energy_uwh=0
    window_reset_reason="energy-unavailable"
    return 0
  fi
  if [[ "$last_sample_energy_uwh" =~ ^[1-9][0-9]*$ ]] && ((current_energy > last_sample_energy_uwh)); then
    window_start_epoch=$now
    window_start_energy_uwh=$current_energy
    last_sample_energy_uwh=$current_energy
    window_reset_reason="energy-increased"
    return 0
  fi
  last_sample_energy_uwh=$current_energy
  [[ "$window_start_epoch" =~ ^[1-9][0-9]*$ ]] || {
    window_start_epoch=$now
    window_start_energy_uwh=$current_energy
    return 0
  }
  [[ "$window_start_energy_uwh" =~ ^[1-9][0-9]*$ ]] || {
    window_start_epoch=$now
    window_start_energy_uwh=$current_energy
    return 0
  }
  elapsed=$((now - window_start_epoch))
  energy_used=$((window_start_energy_uwh - current_energy))
  ((elapsed > 0)) || return 0
  battery_model_window_complete "$elapsed" || return 0
  if ((energy_used <= 0)); then
    window_start_epoch=$now
    window_start_energy_uwh=$current_energy
    window_reset_reason="no-energy-used"
    return 0
  fi
  draw=$(battery_model_window_draw_mw "$energy_used" "$elapsed") || return 0
  if ! battery_model_draw_plausible "$draw"; then
    window_start_epoch=$now
    window_start_energy_uwh=$current_energy
    window_reset_reason="implausible-draw"
    return 0
  fi

  history_file="$state_dir/discharge-history.tsv"
  if [[ -f "$history_file" ]] && ! battery_model_history_valid "$history_file"; then
    window_start_epoch=$now
    window_start_energy_uwh=$current_energy
    window_reset_reason="history-schema-unsupported"
    return 0
  fi
  umask 077
  tmp_file="$history_file.tmp.$$"
  {
    if [[ -f "$history_file" ]]; then
      cat -- "$history_file"
    else
      printf '%s\n' "$BATTERY_MODEL_HISTORY_HEADER"
    fi
    printf '%s\t%s\t%s\t%s\n' "$now" "$discharge_session_id" "$draw" "$(capture_energy_capacity_uwh)"
  } >"$tmp_file"
  mv -f -- "$tmp_file" "$history_file"
  window_start_epoch=$now
  window_start_energy_uwh=$current_energy
  window_reset_reason=""
  history_appended=1
}

# Start or continue a sampling window only while running on battery.
history_appended=0
if [[ $current_state == "on-battery" ]]; then
  if [[ -z "$discharge_session_id" || "$continuity" == 0 ]]; then
    discharge_session_id="$now"
    window_start_epoch=$now
    window_start_energy_uwh=$(capture_energy_now_uwh)
    last_sample_energy_uwh=$window_start_energy_uwh
  fi
  record_discharge_window
else
  discharge_session_id=""
  window_start_epoch=0
  window_start_energy_uwh=0
  last_sample_energy_uwh=0
  window_reset_reason=""
fi

# Nothing can have aged out of a file that did not just grow, and on AC there
# is no window at all — so the poll ends here in the common case.
((history_appended == 1)) && prune_history

# An event is authoritative even if the fallback timer observed the state first.
if ((power_event == 1)) && [[ $current_state == "on-charge" && $charge_session_valid != 1 ]]; then
  state_since=$now
  state_since_at_least=0
  last_charge_start=$now
  charge_start_levels=$(capture_battery_levels)
  charge_session_valid=1
fi

umask 077
tmp_file="$state_file.tmp.$$"
{
  printf 'state_schema_version=%q\n' "$BATTERY_STATE_SCHEMA_VERSION"
  printf 'previous_state=%q\n' "$current_state"
  printf 'state_since=%q\n' "$state_since"
  printf 'state_since_at_least=%q\n' "$state_since_at_least"
  printf 'last_charge_end=%q\n' "$last_charge_end"
  printf 'last_charge_start=%q\n' "$last_charge_start"
  printf 'last_observed=%q\n' "$now"
  printf 'charge_start_levels=%q\n' "$charge_start_levels"
  printf 'charge_session_valid=%q\n' "$charge_session_valid"
  printf 'discharge_session_id=%q\n' "$discharge_session_id"
  printf 'window_start_epoch=%q\n' "$window_start_epoch"
  printf 'window_start_energy_uwh=%q\n' "$window_start_energy_uwh"
  printf 'last_sample_energy_uwh=%q\n' "$last_sample_energy_uwh"
  printf 'window_reset_reason=%q\n' "$window_reset_reason"
  printf 'battery_fingerprint=%q\n' "$battery_fingerprint"
} >"$tmp_file"
mv -f "$tmp_file" "$state_file"

if ((power_event == 1)); then
  if [[ $current_state == "on-charge" ]]; then
    send_charge_notification
  else
    send_unplug_notification
  fi
fi
