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

# What has to change before an open sampling window is thrown away.
#
# Deliberately identity plus measurement mode, and deliberately NOT capacity.
# A cell recalibrates its reported energy_full as it deep-discharges — this
# hardware moved 26.00 Wh to 26.39 Wh inside one session — and a fingerprint
# built on capacity reads every such adjustment as a battery swap. That
# discarded the open window each time, so a battery could discharge for hours
# and record no evidence at all.
#
# Measurement mode stays: a battery that stops reporting energy_* and starts
# reporting charge_* really has invalidated the accounting mid-window.
capture_battery_fingerprint() {
  local battery_dir mode result=""
  for battery_dir in "${battery_dirs[@]}"; do
    if [[ -f "$battery_dir/energy_now" ]]; then
      mode="energy"
    else
      mode="unsupported"
    fi
    [[ -z "$result" ]] || result+=","
    result+="$(capture_one_battery_key "$battery_dir"):$mode"
  done
  printf '%s' "$result"
}

# This battery's identity key.
capture_one_battery_key() {
  local battery_dir=$1 name vendor="" model="" serial=""
  name=${battery_dir##*/}
  [[ -f "$battery_dir/manufacturer" ]] && vendor=$(<"$battery_dir/manufacturer")
  [[ -f "$battery_dir/model_name" ]] && model=$(<"$battery_dir/model_name")
  [[ -f "$battery_dir/serial_number" ]] && serial=$(<"$battery_dir/serial_number")
  battery_model_battery_key "$name" "$vendor" "$model" "$serial"
}

# --- Raw-observation tier (ADR-0001) ----------------------------------------

raw_root="$state_dir/raw"

# The last raw trigger recorded for one battery, from the tail of its most
# recent raw file. Empty when the battery has no raw history yet.
last_raw_status_for() {
  local battery_dir=$1 latest
  latest=$(raw_latest_file "$battery_dir") || return 0
  [[ -n "$latest" ]] || return 0
  tail -n 1 -- "$latest" 2>/dev/null | cut -f4
}

raw_latest_file() {
  local battery_dir=$1 dir name
  dir="$raw_root/$(battery_raw_dir_name "$(capture_one_battery_key "$battery_dir")")"
  [[ -d "$dir" ]] || return 1
  name=$(find "$dir" -maxdepth 1 -name '*.tsv' -printf '%f\n' 2>/dev/null | sort | tail -n 1)
  [[ -n "$name" ]] && printf '%s' "$dir/$name"
}

# Append one raw row for one battery. Called every poll, for every present
# battery, unconditionally — the poll row is the liveness proof. Rotation is
# implicit: the local date is the filename, so a new day needs no logic here.
append_raw_row() {
  local battery_dir=$1 trigger=$2
  local key dir today file is_new
  local status energy_now energy_full energy_full_design voltage_now power_now
  local capacity cycle_count end_threshold

  key=$(capture_one_battery_key "$battery_dir")
  dir="$raw_root/$(battery_raw_dir_name "$key")"
  mkdir -p "$dir"
  printf -v today '%(%Y-%m-%d)T' -1
  file="$dir/$today.tsv"
  is_new=1
  [[ -f "$file" ]] && is_new=0

  status=""; energy_now=0; energy_full=0; energy_full_design=0
  voltage_now=0; power_now=0; capacity=0; cycle_count=0; end_threshold=0
  [[ -f "$battery_dir/status" ]] && status=$(<"$battery_dir/status")
  [[ -f "$battery_dir/energy_now" ]] && energy_now=$(<"$battery_dir/energy_now")
  [[ -f "$battery_dir/energy_full" ]] && energy_full=$(<"$battery_dir/energy_full")
  [[ -f "$battery_dir/energy_full_design" ]] && energy_full_design=$(<"$battery_dir/energy_full_design")
  [[ -f "$battery_dir/voltage_now" ]] && voltage_now=$(<"$battery_dir/voltage_now")
  [[ -f "$battery_dir/power_now" ]] && power_now=$(<"$battery_dir/power_now")
  [[ -f "$battery_dir/capacity" ]] && capacity=$(<"$battery_dir/capacity")
  [[ -f "$battery_dir/cycle_count" ]] && cycle_count=$(<"$battery_dir/cycle_count")
  [[ -f "$battery_dir/charge_control_end_threshold" ]] && end_threshold=$(<"$battery_dir/charge_control_end_threshold")

  umask 077
  {
    ((is_new == 1)) && printf '%s\n' "$BATTERY_RAW_HEADER"
    battery_raw_row "$now" "$trigger" "$status" "$energy_now" "$energy_full" \
      "$energy_full_design" "$voltage_now" "$power_now" "$capacity" \
      "$cycle_count" "$end_threshold" "$ac_online" \
      "$(battery_raw_boot_id)" "$(battery_raw_suspend_count)" \
      "$(battery_raw_uptime_seconds)"
  } >>"$file"
}

# Extract this battery's newest windows and gaps from a bounded tail of its
# raw file, then append only what has not already been recorded — the same
# extraction function `make reextract` runs over the whole file (ADR-0001).
extract_battery() {
  local battery_dir=$1 key file windows_seen tmp_gaps tmp_open
  local last_window_epoch=0 last_gap_epoch=0

  key=$(capture_one_battery_key "$battery_dir")
  file=$(raw_latest_file "$battery_dir") || return 0
  [[ -n "$file" ]] || return 0

  [[ -f "$state_dir/windows.tsv" ]] &&
    last_window_epoch=$(awk -F '\t' -v k="$key" '$3==k{e=$1} END{print e+0}' "$state_dir/windows.tsv")
  [[ -f "$state_dir/gaps.tsv" ]] &&
    last_gap_epoch=$(awk -F '\t' -v k="$key" '$1==k{e=$3} END{print e+0}' "$state_dir/gaps.tsv")

  tmp_gaps="$state_dir/.gaps.$$.tmp"
  tmp_open="$state_dir/.open.$$.tmp"
  : >"$tmp_gaps"

  windows_seen=$(
    tail -n 20 -- "$file" 2>/dev/null |
      battery_extract_windows "$key" "$tmp_gaps" "$tmp_open"
  )

  umask 077
  if [[ -n "$windows_seen" ]]; then
    [[ -f "$state_dir/windows.tsv" ]] || printf '%s\n' "$BATTERY_WINDOWS_HEADER" >"$state_dir/windows.tsv"
    awk -F '\t' -v since="$last_window_epoch" '$1+0 > since' <<<"$windows_seen" >>"$state_dir/windows.tsv"
  fi
  if [[ -s "$tmp_gaps" ]]; then
    [[ -f "$state_dir/gaps.tsv" ]] || printf '%s\n' "$BATTERY_GAPS_HEADER" >"$state_dir/gaps.tsv"
    awk -F '\t' -v since="$last_gap_epoch" '$3+0 > since' "$tmp_gaps" >>"$state_dir/gaps.tsv"
  fi
  rm -f -- "$tmp_gaps"
  update_battery_state_tier "$key" "$tmp_open"
  rm -f -- "$tmp_open"
}

# Tier 3: one row per battery, rewritten whole. Merges the open-sampling-window
# state the view needs every refresh with the currently selected estimator.
update_battery_state_tier() {
  local key=$1 open_file=$2
  local open_epoch=0 open_energy=0 open_last=0
  local -A rows=()
  local existing_key existing_line line

  if [[ -f "$open_file" ]]; then
    IFS=$'\t' read -r open_epoch open_energy open_last <"$open_file"
  fi

  if [[ -f "$state_dir/battery-state.tsv" ]]; then
    while IFS= read -r existing_line; do
      [[ $existing_line == \#* ]] && continue
      existing_key=${existing_line%%$'\t'*}
      [[ -n $existing_key ]] && rows["$existing_key"]=$existing_line
    done <"$state_dir/battery-state.tsv"
  fi

  # Rescore this battery against its own eligible windows in windows.tsv — the
  # same file the view reads, so scoring and projection never disagree about
  # what counts as evidence.
  local estimator="$BATTERY_MODEL_DEFAULT_ESTIMATOR" scored=0 error=0 selection
  if [[ -f "$state_dir/windows.tsv" ]]; then
    selection=$(
      awk -F '\t' -v k="$key" '$3==k && $12==1 { print $4 }' "$state_dir/windows.tsv" |
        battery_model_best_estimator
    )
    IFS=$'\t' read -r estimator scored error <<<"$selection"
    estimator=${estimator:-$BATTERY_MODEL_DEFAULT_ESTIMATOR}
    scored=${scored:-0}
    error=${error:-0}
  fi
  rows["$key"]=$(printf '%s\t%s\t%s\t%s\t%s\t%s\t%s' \
    "$key" "$open_epoch" "$open_energy" "$estimator" "$scored" "$error" "$now")

  umask 077
  {
    printf '%s\n' "$BATTERY_STATE_TIER_HEADER"
    for line in "${rows[@]}"; do printf '%s\n' "$line"; done
  } >"$state_dir/battery-state.tsv.tmp.$$"
  mv -f -- "$state_dir/battery-state.tsv.tmp.$$" "$state_dir/battery-state.tsv"
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

  # Duration and per-battery deltas are two different claims with two
  # different confidences, and used to share one flag: charge_session_valid
  # gated both, so a session that ran through an untracked gap lost its
  # deltas too even though the start levels were genuinely observed. A start
  # level captured at plug time and an end level read right now are both
  # real regardless of what happened between them; only the duration needs
  # the gap-free guarantee.
  local have_start_levels=0
  ((${#start_names[@]} > 0)) && have_start_levels=1

  if is_nonnegative_integer "$last_charge_start" && is_nonnegative_integer "$last_charge_end" &&
    ((last_charge_end >= last_charge_start)); then
    duration=$(format_session_minutes "$((last_charge_end - last_charge_start))")
    if [[ $charge_session_valid == 1 ]]; then
      rows+=("Charged for ~$duration")
    else
      # The window was open the whole time, but a poll or suspend gap
      # happened somewhere inside it, so the wall-clock span is real but the
      # session was not observed continuously — say so rather than stating a
      # duration with more confidence than the data supports.
      rows+=("Charged over ~$duration (interrupted)")
    fi
  fi

  if ((have_start_levels == 1)); then
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
fi
# Recorded for make status only now: raw observations already live in a
# per-identity directory, so a battery swap needs no reset logic here — it
# simply starts writing to a different directory. See ADR-0001.
battery_fingerprint=$(capture_battery_fingerprint)

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

# ADR-0001: capture a raw observation for every present battery, every poll,
# unconditionally — the poll row is the liveness proof, on AC or on battery.
# A transition row (plug/unplug/status change) is written on the same poll,
# never in place of it.
for battery_dir in "${battery_dirs[@]}"; do
  raw_trigger="poll"
  prior_status=$(last_raw_status_for "$battery_dir")
  current_status=""
  [[ -f "$battery_dir/status" ]] && current_status=$(<"$battery_dir/status")
  if [[ -z "$prior_status" ]]; then
    raw_trigger="start"
  elif [[ "$continuity" == 0 ]]; then
    raw_trigger="resume"
  elif [[ "$prior_status" != "$current_status" ]]; then
    raw_trigger="status"
  fi
  append_raw_row "$battery_dir" "$raw_trigger"
  extract_battery "$battery_dir"
done

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
