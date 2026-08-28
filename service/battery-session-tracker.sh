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
mkdir -p "$state_dir"

# shellcheck source=power-supply.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/power-supply.sh"
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

history_schema_valid() {
  [[ -f "$state_dir/discharge-history.tsv" ]] \
    && [[ "$(head -n 1 "$state_dir/discharge-history.tsv" 2>/dev/null)" == $'# battery-discharge-history\tv1' ]]
}

prune_history() {
  local history_file="$state_dir/discharge-history.tsv"
  local tmp_file cutoff
  [[ -f "$history_file" ]] || return 0
  history_schema_valid || return 0
  cutoff=$((now - 180 * 24 * 60 * 60))
  umask 077
  tmp_file="$history_file.tmp.$$"
  {
    printf '# battery-discharge-history\tv1\n'
    awk -F '\t' -v cutoff="$cutoff" \
      '$1 ~ /^[0-9]+$/ && $1 >= cutoff && $2 != "" && $3 ~ /^[1-9][0-9]*$/ && $4 ~ /^[1-9][0-9]*$/ { print }' \
      "$history_file" | sort -n -k1,1 | tail -n 96
  } > "$tmp_file"
  mv -f -- "$tmp_file" "$history_file"
}

compute_usual_runtime() {
  local history_file="$state_dir/discharge-history.tsv"
  local line epoch session draw historical_capacity
  local current_capacity median left right draw_count=0 session_count=0
  local model_cutoff=$((now - 30 * 24 * 60 * 60))
  local -a draws=()
  local -A sessions=()

  usual_full_runtime_seconds=0
  usual_sample_count=0
  [[ -f "$history_file" ]] || return 0
  history_schema_valid || return 0
  current_capacity=$(capture_energy_capacity_uwh)
  ((current_capacity > 0)) || return 0

  while IFS=$'\t' read -r epoch session draw historical_capacity; do
    [[ "$epoch" =~ ^[0-9]+$ && "$epoch" -ge "$model_cutoff" && -n "$session" && "$draw" =~ ^[1-9][0-9]*$ ]] || continue
    draws+=("$draw")
    ((draw_count += 1))
    if [[ -z ${sessions[$session]+x} ]]; then
      sessions["$session"]=1
      ((session_count += 1))
    fi
  done < <(grep -v '^#' "$history_file" 2>/dev/null || true)

  ((draw_count >= 12 && session_count >= 3)) || return 0
  mapfile -t draws < <(printf '%s\n' "${draws[@]}" | sort -n)
  if ((draw_count % 2 == 1)); then
    median=${draws[$((draw_count / 2))]}
  else
    left=${draws[$((draw_count / 2 - 1))]}
    right=${draws[$((draw_count / 2))]}
    median=$(((left + right) / 2))
  fi
  ((median > 0)) || return 0
  # capacity is µWh and draw is mW; divide by 1000 to convert milli-hours.
  usual_full_runtime_seconds=$(( (current_capacity * 3600 + median * 500) / (median * 1000) ))
  usual_sample_count=$draw_count
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

send_charge_notification() {
  local battery_dir name status capacity detail description charging_block held_block
  local -a charging_parts=() held_parts=()

  for battery_dir in "${battery_dirs[@]}"; do
    name=${battery_dir##*/}
    status=""
    capacity=""
    [[ -f "$battery_dir/status" ]] && status=$(<"$battery_dir/status")
    [[ -f "$battery_dir/capacity" ]] && capacity=$(<"$battery_dir/capacity")
    detail="$name"
    is_nonnegative_integer "$capacity" && detail+=" · ${capacity}%"

    if [[ $status == "Charging" ]]; then
      charging_parts+=("$detail")
    elif [[ $status == "Not charging" ]]; then
      held_parts+=("$detail")
    fi
  done

  charging_block=$(join_with_newline "${charging_parts[@]}")
  if ((${#held_parts[@]} > 0)); then
    held_block=$(join_with_newline "⚠ Charge threshold:" "${held_parts[@]}")
    if [[ -n $charging_block ]]; then
      description="$charging_block"$'\n'"$held_block"
    else
      description="$held_block"
    fi
  else
    description="$charging_block"
  fi

  if [[ -n $notification_command ]] && command -v -- "$notification_command" >/dev/null 2>&1; then
    "$notification_command" --app-name doe.power -u low -g "󰂆" -t 6000 \
      "Plugged" "$description" || true
  fi
}

send_unplug_notification() {
  local entry name start end duration description
  local -a entries=() rows=() start_names=() end_names=()
  local -A starts=() ends=() seen=()

  IFS=',' read -r -a entries <<< "$charge_start_levels"
  for entry in "${entries[@]}"; do
    [[ $entry == BAT*:* ]] || continue
    name=${entry%%:*}
    start=${entry#*:}
    if is_nonnegative_integer "$start"; then
      starts["$name"]=$start
      start_names+=("$name")
    fi
  done

  IFS=',' read -r -a entries <<< "$(capture_battery_levels)"
  for entry in "${entries[@]}"; do
    [[ $entry == BAT*:* ]] || continue
    name=${entry%%:*}
    end=${entry#*:}
    if is_nonnegative_integer "$end"; then
      ends["$name"]=$end
      end_names+=("$name")
    fi
  done

  if [[ $charge_session_valid == 1 ]] && is_nonnegative_integer "$last_charge_start" \
    && is_nonnegative_integer "$last_charge_end" && ((last_charge_end >= last_charge_start)); then
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
(( ac_online == 1 )) && current_state="on-charge"
previous_state=""
state_since=0
last_charge_end=0
last_charge_start=0
last_observed=0
charge_start_levels=""
charge_session_valid=0
discharge_session_id=""
window_start_epoch=0
window_start_energy_uwh=0
last_sample_energy_uwh=0
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
if [[ "$last_observed" =~ ^[0-9]+$ ]] && (( last_observed > 0 )) && (( now < last_observed || now - last_observed > 90 )); then
  continuity=0
fi
current_battery_fingerprint=$(capture_battery_fingerprint)
if [[ -n "$battery_fingerprint" && "$current_battery_fingerprint" != "$battery_fingerprint" ]]; then
  window_start_epoch=0
  window_start_energy_uwh=0
  last_sample_energy_uwh=0
fi
battery_fingerprint="$current_battery_fingerprint"

if [[ -n "$previous_state" && "$previous_state" != "$current_state" ]]; then
  state_since="$now"
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
  # Unknown initial or interrupted session: wait for a real transition before showing a time.
  state_since=0
  charge_session_valid=0
fi

record_discharge_window() {
  local current_energy elapsed energy_used draw history_file tmp_file
  current_energy=$(capture_energy_now_uwh)
  if [[ ! "$current_energy" =~ ^[1-9][0-9]*$ ]]; then
    window_start_epoch=0
    window_start_energy_uwh=0
    last_sample_energy_uwh=0
    return 0
  fi
  if [[ "$last_sample_energy_uwh" =~ ^[1-9][0-9]*$ ]] && ((current_energy > last_sample_energy_uwh)); then
    window_start_epoch=$now
    window_start_energy_uwh=$current_energy
    last_sample_energy_uwh=$current_energy
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
  if ((elapsed < 15 * 60 || elapsed <= 0)); then
    return 0
  fi
  if ((energy_used <= 0)); then
    window_start_epoch=$now
    window_start_energy_uwh=$current_energy
    return 0
  fi
  draw=$(( (energy_used * 3600 + elapsed * 500) / (elapsed * 1000) ))
  if ((draw < 100 || draw > 120000)); then
    window_start_epoch=$now
    window_start_energy_uwh=$current_energy
    return 0
  fi

  history_file="$state_dir/discharge-history.tsv"
  if [[ -f "$history_file" ]] && ! history_schema_valid; then
    window_start_epoch=$now
    window_start_energy_uwh=$current_energy
    return 0
  fi
  umask 077
  tmp_file="$history_file.tmp.$$"
  {
    if [[ -f "$history_file" ]]; then
      cat -- "$history_file"
    else
      printf '# battery-discharge-history\tv1\n'
    fi
    printf '%s\t%s\t%s\t%s\n' "$now" "$discharge_session_id" "$draw" "$(capture_energy_capacity_uwh)"
  } > "$tmp_file"
  mv -f -- "$tmp_file" "$history_file"
  window_start_epoch=$now
  window_start_energy_uwh=$current_energy
}

# Start or continue a sampling window only while running on battery.
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
fi

prune_history
compute_usual_runtime

# An event is authoritative even if the fallback timer observed the state first.
if ((power_event == 1)) && [[ $current_state == "on-charge" && $charge_session_valid != 1 ]]; then
  state_since=$now
  last_charge_start=$now
  charge_start_levels=$(capture_battery_levels)
  charge_session_valid=1
fi

umask 077
tmp_file="$state_file.tmp.$$"
{
  printf 'previous_state=%q\n' "$current_state"
  printf 'state_since=%q\n' "$state_since"
  printf 'last_charge_end=%q\n' "$last_charge_end"
  printf 'last_charge_start=%q\n' "$last_charge_start"
  printf 'last_observed=%q\n' "$now"
  printf 'charge_start_levels=%q\n' "$charge_start_levels"
  printf 'charge_session_valid=%q\n' "$charge_session_valid"
  printf 'usual_full_runtime_seconds=%q\n' "$usual_full_runtime_seconds"
  printf 'usual_sample_count=%q\n' "$usual_sample_count"
  printf 'discharge_session_id=%q\n' "$discharge_session_id"
  printf 'window_start_epoch=%q\n' "$window_start_epoch"
  printf 'window_start_energy_uwh=%q\n' "$window_start_energy_uwh"
  printf 'last_sample_energy_uwh=%q\n' "$last_sample_energy_uwh"
  printf 'battery_fingerprint=%q\n' "$battery_fingerprint"
} > "$tmp_file"
mv -f "$tmp_file" "$state_file"

if ((power_event == 1)); then
  if [[ $current_state == "on-charge" ]]; then
    send_charge_notification
  else
    send_unplug_notification
  fi
fi
