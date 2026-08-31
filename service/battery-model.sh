#!/usr/bin/env bash
# The battery runtime model: evidence gate, discharge-window arithmetic, and
# runtime projection. Sourced, not executed directly.
#
# This file is the single owner of every rule the model depends on. The tracker
# records windows with it, the view projects runtime with it, and the status
# report gates on it. Before this library the gate and the median existed twice
# — once in bash, once in awk — and had already drifted.
#
# Requires Bash 4.3+ (namerefs, associative arrays) and awk.

[[ -n ${BATTERY_MODEL_SOURCED-} ]] && return 0
BATTERY_MODEL_SOURCED=1

# --- Rules -----------------------------------------------------------------

# How often the fallback timer polls. Mirrored in
# service/battery-session-tracker.timer (OnUnitActiveSec); the timer file
# cannot read a shell constant, so the two are kept in step by hand and the
# timer comment points back here.
readonly BATTERY_MODEL_POLL_INTERVAL_SECONDS=180
# A longer gap than this between polls means a suspend or a clock change, not a
# late timer, so the open sampling window is thrown away rather than measured
# across the gap. Two missed polls are tolerated; the value stays well under
# BATTERY_MODEL_WINDOW_SECONDS so a suspend can never be folded into a
# completed window.
readonly BATTERY_MODEL_MAX_POLL_GAP_SECONDS=$((3 * BATTERY_MODEL_POLL_INTERVAL_SECONDS))

# A discharge window must run this long before it becomes evidence.
readonly BATTERY_MODEL_WINDOW_SECONDS=$((15 * 60))
# Only windows this recent take part in the model. Retention itself is a
# read-time interpretation now, not a write-time row cap (ADR-0001): raw
# observations and windows.tsv are never pruned.
readonly BATTERY_MODEL_LOOKBACK_SECONDS=$((30 * 24 * 60 * 60))
# The full evidence gate: the model is only "ready" at or above both counts.
readonly BATTERY_MODEL_MIN_WINDOWS=12
readonly BATTERY_MODEL_MIN_SESSIONS=3
# The provisional gate: enough to say something, with a wide band and a loud
# low-confidence label, instead of showing a new user nothing for days.
readonly BATTERY_MODEL_PROVISIONAL_WINDOWS=4
# How many of the newest windows form the "right now" estimate.
readonly BATTERY_MODEL_RECENT_WINDOWS=4
# A challenger estimator replaces the incumbent only when it is at least this
# much better. Scores drift window to window; without a margin the selection
# would flap between estimators separated by noise, and a projection that
# silently changes shape is worse than a slightly worse stable one.
readonly BATTERY_MODEL_ESTIMATOR_MARGIN_PERCENT=15
# No estimator is selected on less evidence than this. Below it the median is
# used, which is the estimator that degrades most gracefully when starved.
readonly BATTERY_MODEL_ESTIMATOR_MIN_SCORED=8
readonly BATTERY_MODEL_DEFAULT_ESTIMATOR="median"
# A window whose average draw falls outside this range is rejected as noise
# (a suspend, a hot-swapped battery, or a sysfs counter that jumped).
readonly BATTERY_MODEL_MIN_DRAW_MW=100
readonly BATTERY_MODEL_MAX_DRAW_MW=120000

# --- Raw-observation tier (ADR-0001) ----------------------------------------
#
# Every file from here on is semver format-versioned, independent of the
# legacy v1-v3 markers above. `FORMAT` describes how to parse a file; it is
# bumped only when a column is added, removed, or reinterpreted.
readonly BATTERY_RAW_FORMAT="v0.2.0"
readonly BATTERY_WINDOWS_FORMAT="v0.1.0"
readonly BATTERY_GAPS_FORMAT="v0.1.0"
readonly BATTERY_STATE_TIER_FORMAT="v0.1.0"

# `rules` stamped on every raw row: the recording rules in force when it was
# written (window length, draw formula, plausibility bounds, poll interval).
# Bump this, not the format, when one of those constants changes — it lets a
# reader tell rows apart without changing how the row is parsed.
readonly BATTERY_RECORDING_RULES_VERSION="v0.2.0"

readonly BATTERY_RAW_HEADER="# battery-raw-observations	${BATTERY_RAW_FORMAT}"
readonly BATTERY_WINDOWS_HEADER="# battery-windows	${BATTERY_WINDOWS_FORMAT}"
readonly BATTERY_GAPS_HEADER="# battery-gaps	${BATTERY_GAPS_FORMAT}"
readonly BATTERY_STATE_TIER_HEADER="# battery-state	${BATTERY_STATE_TIER_FORMAT}"

# A raw observation row. `trigger` is poll|plug|unplug|status|resume|start.
# Columns after `capacity_control_end_threshold` mirror what sysfs publishes
# for the battery; `ac_online`/`boot_id`/`suspend_count`/`uptime_s` are
# machine-level facts repeated on every row (denormalized: a single battery's
# file must be readable without joining to anything else). `power_profile`
# and `load1` are the same kind of fact: they explain why a given draw was
# what it was, which no battery-local column can.
#
# New columns are only ever APPENDED. A raw file is append-only and is never
# rewritten, so a file written across a format bump holds rows of two widths.
# Every reader keys on the column count, never on the header, and takes an
# absent trailing column as "not recorded". See the state file reference.
battery_raw_row() {
  local epoch=$1 trigger=$2 status=$3 energy_now=$4 energy_full=$5 \
    energy_full_design=$6 voltage_now=$7 power_now=$8 capacity=$9 \
    cycle_count=${10} end_threshold=${11} ac_online=${12} boot_id=${13} \
    suspend_count=${14} uptime_s=${15} power_profile=${16-} load1=${17-}
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$epoch" "$trigger" "$BATTERY_RECORDING_RULES_VERSION" "$status" \
    "$energy_now" "$energy_full" "$energy_full_design" "$voltage_now" \
    "$power_now" "$capacity" "$cycle_count" "$end_threshold" \
    "$ac_online" "$boot_id" "$suspend_count" "$uptime_s" \
    "${power_profile:-unknown}" "${load1:-0}"
}

# Sanitize a battery key for use as a directory name: replace only what the
# filesystem actually forbids (/, NUL). No other transformation — this is a
# continuation of identity-anchoring, not a new privacy boundary.
battery_raw_dir_name() {
  local key=$1
  key=${key//\//-}
  key=${key//$'\0'/-}
  printf '%s' "$key"
}

# Machine-level facts stamped on every raw row. Every read is $(<file); no
# fork. boot_id changes only across a reboot; suspend_count only increments
# across a successful suspend/resume, so consecutive raw rows can tell a
# reboot apart from a suspend apart from neither (see battery_extract_windows).
battery_raw_boot_id() {
  local id=""
  [[ -f /proc/sys/kernel/random/boot_id ]] && id=$(</proc/sys/kernel/random/boot_id)
  printf '%s' "${id:-unknown}"
}

battery_raw_suspend_count() {
  local count=""
  [[ -f /sys/power/suspend_stats/success ]] && count=$(</sys/power/suspend_stats/success)
  [[ $count =~ ^[0-9]+$ ]] && printf '%s' "$count" || printf '0'
}

battery_raw_uptime_seconds() {
  local uptime=""
  [[ -f /proc/uptime ]] && uptime=$(</proc/uptime)
  uptime=${uptime%% *}
  uptime=${uptime%%.*}
  [[ $uptime =~ ^[0-9]+$ ]] && printf '%s' "$uptime" || printf '0'
}

# The 1-minute load average, scaled by 100 and stored as an integer, so the
# raw tier stays free of locale-dependent decimal separators. 2.30 -> 230.
battery_raw_load1_centi() {
  local load=""
  [[ -f /proc/loadavg ]] && load=$(</proc/loadavg)
  load=${load%% *}
  local whole=${load%%.*} fraction=${load#*.}
  [[ $whole =~ ^[0-9]+$ ]] || { printf '0'; return; }
  [[ $fraction =~ ^[0-9]+$ ]] || fraction=0
  fraction=${fraction}00
  printf '%s' $((whole * 100 + 10#${fraction:0:2}))
}

# The active platform power profile, or "unknown" when the machine exposes
# none. The ACPI node is a plain file read and costs no fork, so it is tried
# first; `powerprofilesctl` is a D-Bus round trip and is only reached on
# hardware without the node (the T480 among them). The call is wrapped in a
# timeout because a hung D-Bus service must not stall a poll: a lost profile
# reading costs one column, a stalled poll costs the liveness row.
battery_raw_power_profile() {
  local profile="" node="${BATTERY_PLATFORM_PROFILE_NODE:-/sys/firmware/acpi/platform_profile}"
  if [[ -r $node ]]; then
    profile=$(<"$node")
  else
    local command=${BATTERY_POWER_PROFILE_COMMAND:-powerprofilesctl}
    if command -v -- "$command" >/dev/null 2>&1; then
      profile=$(timeout 2 "$command" get 2>/dev/null || true)
    fi
  fi
  profile=${profile//[$'\t\n\r']/}
  printf '%s' "${profile:-unknown}"
}


# The tracker's session-bookkeeping state file (previous_state, state_since,
# charge_start_levels, ...). v1 files carry no version key and also carried
# derived model fields (battery_energy_now_uwh, usual_*) that v2 dropped, since
# the view now recomputes those from live sysfs and windows.tsv rather than
# keeping a second, staler copy on disk. Unrelated to the raw/windows/gaps/
# state-tier format versions above: this file was never derivable from raw and
# remains the one thing that is not a cache.
readonly BATTERY_STATE_SCHEMA_VERSION=2

# --- Loaded history --------------------------------------------------------
# battery_model_load_windows() (below) reads windows.tsv once and indexes
# every window by the battery that measured it. battery_model_select_battery()
# then narrows the working set to one battery, because a projection for a
# given cell must use only that cell's own evidence.

battery_model_state=""               # missing | unsupported | ready
declare -A battery_model_key_draws=()      # key -> space separated draws
declare -A battery_model_key_sessions=()   # key -> space separated session ids
declare -A battery_model_key_last=()       # key -> newest epoch
declare -A battery_model_key_energy_full=()
declare -A battery_model_key_cycles=()
battery_model_keys=()                # every battery seen inside the lookback

# Filled by battery_model_select_battery().
battery_model_window_count=0
battery_model_session_count=0
battery_model_latest_epoch=0
battery_model_draws=()               # selected battery's draws, ascending
battery_model_draws_ordered=()       # the same draws, oldest first
battery_model_recent_draws=()        # newest BATTERY_MODEL_RECENT_WINDOWS

# Sort a numeric array in place, ascending. Insertion sort with no subprocess:
# the history file is capped per battery, so this is always cheaper than
# forking `sort`.
battery_model_sort_numbers() {
  local -n _bm_array=$1
  local index candidate probe
  for ((index = 1; index < ${#_bm_array[@]}; index++)); do
    candidate=${_bm_array[index]}
    for ((probe = index - 1; probe >= 0 && _bm_array[probe] > candidate; probe--)); do
      _bm_array[probe + 1]=${_bm_array[probe]}
    done
    _bm_array[probe + 1]=$candidate
  done
}

# Narrow the working set to one battery. Every projection is made from the
# evidence of the cell it is about; another battery's windows are never mixed in.
battery_model_select_battery() {
  local key=$1 draw session index
  local -A seen=()

  battery_model_window_count=0
  battery_model_session_count=0
  battery_model_latest_epoch=0
  battery_model_draws=()
  battery_model_draws_ordered=()
  battery_model_recent_draws=()
  [[ -n $key ]] || return 0
  [[ -n ${battery_model_key_draws[$key]+x} ]] || return 0

  for draw in ${battery_model_key_draws[$key]}; do
    battery_model_draws+=("$draw")
    battery_model_draws_ordered+=("$draw")
    battery_model_window_count=$((battery_model_window_count + 1))
  done
  for session in ${battery_model_key_sessions[$key]}; do
    if [[ -z ${seen[$session]+x} ]]; then
      seen["$session"]=1
      battery_model_session_count=$((battery_model_session_count + 1))
    fi
  done
  battery_model_latest_epoch=${battery_model_key_last[$key]:-0}

  # Newest windows, in file order, before the value sort reorders them.
  for ((index = ${#battery_model_draws[@]} - BATTERY_MODEL_RECENT_WINDOWS;
    index < ${#battery_model_draws[@]}; index++)); do
    ((index >= 0)) || continue
    battery_model_recent_draws+=("${battery_model_draws[index]}")
  done
  battery_model_sort_numbers battery_model_draws
}

# --- Loading windows.tsv / gaps.tsv / battery-state.tsv (ADR-0001) ---------
#
# Reads the current-generation files the raw extractor produces, into the
# battery_model_key_* globals declared above, so battery_model_select_battery()
# and everything built on it needs no changes to work from this generation.

battery_model_windows_total_rows=0
battery_model_windows_future_rows=0
battery_model_windows_ineligible_rows=0

battery_model_load_windows() {
  local windows_file=$1 now=$2
  local kind epoch key draw session

  battery_model_state="missing"
  battery_model_windows_total_rows=0
  battery_model_windows_future_rows=0
  battery_model_windows_ineligible_rows=0
  battery_model_keys=()
  battery_model_key_draws=()
  battery_model_key_sessions=()
  battery_model_key_last=()
  battery_model_select_battery ""

  [[ -f "$windows_file" ]] || return 0
  local first_line
  IFS= read -r first_line <"$windows_file" 2>/dev/null || return 0
  if [[ "$first_line" != "$BATTERY_WINDOWS_HEADER" ]]; then
    battery_model_state="unsupported"
    return 0
  fi
  battery_model_state="ready"

  while IFS=$'\t' read -r kind epoch key draw session; do
    case $kind in
    D)
      if [[ -z ${battery_model_key_draws[$key]+x} ]]; then
        battery_model_keys+=("$key")
        battery_model_key_draws["$key"]=""
        battery_model_key_sessions["$key"]=""
      fi
      battery_model_key_draws["$key"]+="$draw "
      battery_model_key_sessions["$key"]+="$session "
      battery_model_key_last["$key"]=$epoch
      ;;
    S)
      battery_model_windows_total_rows=$epoch
      battery_model_windows_future_rows=$key
      battery_model_windows_ineligible_rows=$draw
      ;;
    esac
  done < <(
    awk -F '\t' -v now="$now" -v lookback="$BATTERY_MODEL_LOOKBACK_SECONDS" '
      BEGIN { cutoff = now - lookback; total = future = ineligible = 0 }
      /^#/ { next }
      $1 !~ /^[0-9]+$/ { next }
      {
        total++
        if ($1 > now) { future++; next }
        if ($1 < cutoff) next
        if ($12 != 1) { ineligible++; next }
        printf "D\t%s\t%s\t%s\t%s\n", $1, $3, $4, $2
      }
      END { printf "S\t%d\t%d\t%d\n", total, future, ineligible }
    ' "$windows_file"
  )
}

# Batteries this machine has evidence for in windows.tsv that are not in the
# CURRENT_KEYS list passed in. Prints one key per line.
battery_model_absent_keys() {
  local -n _bm_current=$1
  local key present k
  for key in "${battery_model_keys[@]}"; do
    present=0
    for k in "${_bm_current[@]}"; do
      [[ "$k" == "$key" ]] && present=1 && break
    done
    ((present == 1)) || printf '%s\n' "$key"
  done
}

# Gaps recorded for one battery, most recent first, as
# start_epoch\tend_epoch\tcause\tenergy_delta_uwh lines.
battery_model_gaps_for() {
  local gaps_file=$1 key=$2
  [[ -f "$gaps_file" ]] || return 0
  awk -F '\t' -v k="$key" '!/^#/ && $1==k { print $2"\t"$3"\t"$4"\t"$9 }' "$gaps_file" |
    sort -t $'\t' -k1,1 -rn
}

# Tier 3: load one battery's open-window state and selected estimator.
# Sets: battery_model_tier3_open_epoch/_energy, _estimator, _scored, _error,
# _updated. All zero/default when the battery has no tier-3 row yet.
battery_model_tier3_open_epoch=0
battery_model_tier3_open_energy=0
battery_model_tier3_estimator="$BATTERY_MODEL_DEFAULT_ESTIMATOR"
battery_model_tier3_scored=0
battery_model_tier3_error=0
battery_model_tier3_updated=0

battery_model_load_tier3() {
  local state_file=$1 key=$2
  local first_line line row_key open_epoch open_energy estimator scored error updated

  battery_model_tier3_open_epoch=0
  battery_model_tier3_open_energy=0
  battery_model_tier3_estimator="$BATTERY_MODEL_DEFAULT_ESTIMATOR"
  battery_model_tier3_scored=0
  battery_model_tier3_error=0
  battery_model_tier3_updated=0

  [[ -f "$state_file" ]] || return 0
  IFS= read -r first_line <"$state_file" 2>/dev/null || return 0
  [[ "$first_line" == "$BATTERY_STATE_TIER_HEADER" ]] || return 0

  while IFS=$'\t' read -r row_key open_epoch open_energy estimator scored error updated; do
    [[ "$row_key" == "$key" ]] || continue
    battery_model_tier3_open_epoch=${open_epoch:-0}
    battery_model_tier3_open_energy=${open_energy:-0}
    battery_model_tier3_estimator=${estimator:-$BATTERY_MODEL_DEFAULT_ESTIMATOR}
    battery_model_tier3_scored=${scored:-0}
    battery_model_tier3_error=${error:-0}
    battery_model_tier3_updated=${updated:-0}
    return 0
  done < <(tail -n +2 -- "$state_file")
}

# --- Statistics ------------------------------------------------------------

# Median of an ascending numeric array, averaging the two middle values on an
# even count. Prints 0 for an empty array.
battery_model_median() {
  local -n _bm_values=$1
  local count=${#_bm_values[@]} middle
  ((count > 0)) || {
    printf '0'
    return 0
  }
  middle=$((count / 2))
  if ((count % 2 == 1)); then
    printf '%s' "${_bm_values[middle]}"
  else
    printf '%s' "$(((_bm_values[middle - 1] + _bm_values[middle]) / 2))"
  fi
}

# Nearest-rank percentile of an ascending numeric array: the smallest value at
# or above the requested rank. Unlike the median it never interpolates, so a
# reported band edge is always a draw that was really measured.
battery_model_percentile() {
  local -n _bm_values=$1
  local percentile=$2 count=${#_bm_values[@]} index
  ((count > 0)) || {
    printf '0'
    return 0
  }
  index=$(((percentile * count + 99) / 100 - 1))
  ((index >= 0)) || index=0
  ((index < count)) || index=$((count - 1))
  printf '%s' "${_bm_values[index]}"
}

# Arithmetic mean of a numeric array, rounded to nearest. Prints 0 when empty.
battery_model_mean() {
  local -n _bm_values=$1
  local count=${#_bm_values[@]} total=0 value
  ((count > 0)) || {
    printf '0'
    return 0
  }
  for value in "${_bm_values[@]}"; do total=$((total + value)); done
  printf '%s' "$(((total + count / 2) / count))"
}

# --- Estimator scoring -----------------------------------------------------
#
# The one implementation of held-out scoring. `make backtest` renders it for a
# human; the tracker uses it to choose the estimator each battery projects
# with. A second copy would be free to disagree with the first, which is the
# failure this whole seam exists to prevent.
#
# Reads draws on stdin, oldest first, one per line. At each window it predicts
# using only the windows before it, never the window itself. Prints one row per
# estimator: NAME, scored count, mean absolute error, median absolute error,
# and bias (signed, so a consistently high or low estimator is visible).
battery_model_score_draws() {
  local warmup=${1:-$BATTERY_MODEL_PROVISIONAL_WINDOWS}
  awk -v warmup="$warmup" -v recent_windows="$BATTERY_MODEL_RECENT_WINDOWS" '
    function median(count,   sorted, i, j, key, middle) {
      for (i = 1; i <= count; i++) sorted[i] = window[i]
      for (i = 2; i <= count; i++) {
        key = sorted[i]
        for (j = i - 1; j >= 1 && sorted[j] > key; j--) sorted[j + 1] = sorted[j]
        sorted[j + 1] = key
      }
      middle = int(count / 2)
      if (count % 2 == 1) return sorted[middle + 1]
      return int((sorted[middle] + sorted[middle + 1]) / 2)
    }
    function mean_of_last(count, howmany,   i, total, taken) {
      total = 0; taken = 0
      for (i = count; i >= 1 && taken < howmany; i--) { total += window[i]; taken++ }
      if (taken == 0) return 0
      return int(total / taken + 0.5)
    }
    function score(name, predicted, actual,   error) {
      if (predicted <= 0) return
      error = predicted - actual
      bias[name] += error
      if (error < 0) error = -error
      total[name] += error
      scored[name]++
      errors[name "\t" scored[name]] = error
    }
    function percentile_error(name, p,   i, count, list, j, key, rank) {
      count = scored[name]
      if (count == 0) return 0
      for (i = 1; i <= count; i++) list[i] = errors[name "\t" i]
      for (i = 2; i <= count; i++) {
        key = list[i]
        for (j = i - 1; j >= 1 && list[j] > key; j--) list[j + 1] = list[j]
        list[j + 1] = key
      }
      rank = int((p * count + 99) / 100)
      if (rank < 1) rank = 1
      if (rank > count) rank = count
      return list[rank]
    }
    $1 ~ /^[1-9][0-9]*$/ {
      actual = $1 + 0
      if (held >= warmup) {
        score("median", median(held), actual)
        score("recent", mean_of_last(held, recent_windows), actual)
        score("last", window[held], actual)
        if (ewma > 0) score("ewma", int(ewma + 0.5), actual)
      }
      window[++held] = actual
      if (ewma == 0) ewma = actual
      else ewma = 0.3 * actual + 0.7 * ewma
    }
    END {
      split("median recent ewma last", names, " ")
      for (n = 1; n <= 4; n++) {
        name = names[n]
        if (scored[name] == 0) continue
        printf "%s\t%d\t%d\t%d\t%d\n", name, scored[name],
          int(total[name] / scored[name] + 0.5),
          percentile_error(name, 50),
          int(bias[name] / scored[name] + 0.5)
      }
    }
  '
}

# Choose the estimator a battery should project with, from its own ordered
# draws on stdin. Prints: NAME<TAB>SCORED<TAB>MEAN_ERROR.
#
# The median is the incumbent and keeps the job unless a challenger beats it by
# BATTERY_MODEL_ESTIMATOR_MARGIN_PERCENT. Selection is deliberately sticky: an
# estimate that changes shape between refreshes is harder to trust than one
# that is consistently a little worse.
battery_model_best_estimator() {
  local name scored mean p50 bias
  local best=$BATTERY_MODEL_DEFAULT_ESTIMATOR best_scored=0 best_mean=0 row
  local median_mean=0 median_scored=0
  local -a rows=()

  while IFS=$'\t' read -r name scored mean p50 bias; do
    [[ -n $name ]] || continue
    rows+=("$name"$'\t'"$scored"$'\t'"$mean")
    if [[ $name == median ]]; then
      median_mean=$mean
      median_scored=$scored
    fi
  done < <(battery_model_score_draws)

  best_scored=$median_scored
  best_mean=$median_mean
  if ((median_scored >= BATTERY_MODEL_ESTIMATOR_MIN_SCORED && median_mean > 0)); then
    for row in "${rows[@]}"; do
      IFS=$'\t' read -r name scored mean <<<"$row"
      [[ $name != median ]] || continue
      ((scored >= BATTERY_MODEL_ESTIMATOR_MIN_SCORED)) || continue
      ((mean > 0)) || continue
      # Strictly better by the margin, measured against the incumbent.
      if ((mean * 100 <= median_mean * (100 - BATTERY_MODEL_ESTIMATOR_MARGIN_PERCENT))); then
        if [[ $best == "$BATTERY_MODEL_DEFAULT_ESTIMATOR" ]] || ((mean < best_mean)); then
          best=$name
          best_mean=$mean
          best_scored=$scored
        fi
      fi
    done
  fi
  printf '%s\t%s\t%s' "$best" "$best_scored" "$best_mean"
}

# The draw an estimator would project with, for the currently selected battery.
battery_model_estimator_draw() {
  local estimator=$1 count=${#battery_model_draws_ordered[@]} index total=0 taken=0 ewma=0
  ((count > 0)) || {
    printf '0'
    return 0
  }
  case $estimator in
  recent)
    battery_model_mean battery_model_recent_draws
    ;;
  last)
    printf '%s' "${battery_model_draws_ordered[count - 1]}"
    ;;
  ewma)
    for ((index = 0; index < count; index++)); do
      if ((index == 0)); then
        ewma=$((battery_model_draws_ordered[index] * 1000))
      else
        ewma=$(((3 * battery_model_draws_ordered[index] * 1000 + 7 * ewma) / 10))
      fi
    done
    printf '%s' "$(((ewma + 500) / 1000))"
    ;;
  *)
    battery_model_median battery_model_draws
    ;;
  esac
}

# --- Gate ------------------------------------------------------------------

# "ready" once the full gate is met, "provisional" once there is enough
# evidence to say something with a wide band, "learning" below that, and
# "unavailable" when the history file cannot be read at all.
battery_model_confidence() {
  if [[ $battery_model_state == unsupported ]]; then
    printf 'unavailable'
    return 0
  fi
  if ((battery_model_window_count >= BATTERY_MODEL_MIN_WINDOWS &&
    battery_model_session_count >= BATTERY_MODEL_MIN_SESSIONS)); then
    printf 'ready'
  elif ((battery_model_window_count >= BATTERY_MODEL_PROVISIONAL_WINDOWS)); then
    printf 'provisional'
  else
    printf 'learning'
  fi
}

# --- Projection ------------------------------------------------------------

# Seconds of runtime that ENERGY_UWH of stored energy buys at DRAW_MW.
# Energy is µWh and draw is mW, so the milli-hour conversion divides by 1000.
# This is the only place the projection is written down.
battery_model_project_seconds() {
  local energy_uwh=$1 draw_mw=$2
  if [[ ! $energy_uwh =~ ^[0-9]+$ ]] || [[ ! $draw_mw =~ ^[1-9][0-9]*$ ]] ||
    ((energy_uwh <= 0)); then
    printf '0'
    return 0
  fi
  printf '%s' "$(((energy_uwh * 3600 + draw_mw * 500) / (draw_mw * 1000)))"
}

# --- Extraction (ADR-0001): raw -> windows + gaps + battery-state ---------
#
# The one place raw observations become windows. Called two ways: once per
# poll, over a bounded tail of each battery's raw file (cheap, incremental);
# and by `make reextract`, over the complete file (expensive, exhaustive).
# Both call this function. A second implementation is exactly the failure
# this ADR exists to remove — the threshold rule and the capacity-fingerprint
# bug each shipped because a second copy quietly disagreed with the first.
#
# Reads raw rows (oldest first, tab-separated, battery_raw_row's column
# order) on stdin for ONE battery's file. Writes windows.tsv rows to stdout.
# Writes gaps.tsv rows to GAPS_FILE if given (appended, caller truncates
# first if a full rewrite is wanted). Does not read or open the raw file
# itself — callers own I/O so the same function serves a tail (incremental)
# or a whole file (batch, make reextract) identically.
#
# A window is written even when interrupted; the trailing `eligible` column
# is 0 for one that spans a gap, 1 otherwise. Nothing is discarded — a
# battery's evidence is never smaller than what battery_extract_windows()
# has ever seen, only some of it is marked unusable for modelling.
battery_extract_windows() {
  local battery_key=$1 gaps_file=${2-/dev/null} open_file=${3-/dev/null}
  awk -F '\t' -v key="$battery_key" -v gaps_file="$gaps_file" -v open_file="$open_file" \
    -v window_seconds="$BATTERY_MODEL_WINDOW_SECONDS" \
    -v max_gap="$BATTERY_MODEL_MAX_POLL_GAP_SECONDS" \
    -v min_draw="$BATTERY_MODEL_MIN_DRAW_MW" -v max_draw="$BATTERY_MODEL_MAX_DRAW_MW" '
    function abs(x) { return x < 0 ? -x : x }
    function classify_gap(prev_boot, boot, prev_susp, susp) {
      if (boot != prev_boot) return "off"
      if (susp + 0 > prev_susp + 0) return "asleep"
      return "blind"
    }
    BEGIN { have_start = 0; eligible = 1; have_prev = 0; session_epoch = 0 }
    NF < 16 { next }
    {
      epoch=$1+0; status=$4; energy_now=$5+0
      ac_online=$13; boot_id=$14; suspend_count=$15+0

      if (have_prev) {
        gap = epoch - prev_epoch
        # Clock-jitter tolerance: routine NTP slew is well under this: a
        # genuine backward step, or a forward gap past the poll tolerance,
        # breaks continuity.
        if (gap < -5 || gap > max_gap) {
          cause = (gap < -5) ? "clock" : classify_gap(prev_boot, boot_id, prev_suspend, suspend_count)
          printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n", \
            key, prev_epoch, epoch, cause, prev_ac, ac_online, \
            prev_energy_now, energy_now, abs(energy_now - prev_energy_now) \
            >> gaps_file
          eligible = 0
          # Reset before this rows own discharge processing runs below, so a
          # resumed-discharging row always starts a clean window rather than
          # computing elapsed across the gap itself.
          have_start = 0
        }
      }

      if (energy_now > 0 && status == "Discharging") {
        if (!have_start) {
          # A continuous discharge run is one session even when it spans
          # several completed windows; the session id is the runs own
          # start epoch, not each individual windows. A fresh session is
          # never itself ineligible, whatever the row before it was doing.
          start_epoch = epoch; start_energy = energy_now; have_start = 1
          session_epoch = epoch; eligible = 1
        } else if (energy_now > start_energy) {
          # Energy rose: not a discharge window, but still the same run.
          start_epoch = epoch; start_energy = energy_now; eligible = 1
        } else {
          elapsed = epoch - start_epoch
          if (elapsed >= window_seconds) {
            used = start_energy - energy_now
            if (used > 0) {
              draw = int((used * 3600 + elapsed * 500) / (elapsed * 1000))
              if (draw >= min_draw && draw <= max_draw) {
                printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n", \
                  epoch, session_epoch, key, draw, energy_now, $6, $7, $8, $9, $10, $11, eligible
              }
            }
            start_epoch = epoch; start_energy = energy_now; eligible = 1
          }
        }
      } else {
        have_start = 0
      }

      prev_epoch = epoch; prev_ac = ac_online; prev_boot = boot_id
      prev_suspend = suspend_count; prev_energy_now = energy_now
      have_prev = 1
    }
    END {
      # The still-open window, if any: what the view shows as "Current
      # sample" without ever reading raw itself.
      if (have_start) {
        printf "%s\t%s\t%s\n", start_epoch, start_energy, prev_epoch > open_file
      } else {
        printf "0\t0\t0\n" > open_file
      }
    }
  '
}

# --- Battery-set identity --------------------------------------------------
#
# Capacity is not identity. A cell's reported energy_full drifts with wear and
# recalibration, and two different batteries can report the same capacity, so
# telling battery sets apart by capacity is guesswork. sysfs already publishes
# a real identity — manufacturer, model, serial — and that is what evidence is
# anchored to.
#
# What the anchor is for: system draw is a property of the machine and its
# workload, not of the battery, so draw evidence is shared across every set.
# How long a given charge level lasts is a property of the battery, because a
# worn cell's reported energy is exactly the number that stops being true. The
# identity is what lets those two be told apart, audited, and — once battery
# data is pooled across machines — matched against the same model elsewhere.

# One field of an identity, made safe for the tab-separated history and for the
# ":" and "," the key itself uses as separators.
battery_model_sanitize_field() {
  local value=$1
  value=${value//[$'\t\n\r']/ }
  value=${value//:/_}
  value=${value//,/_}
  # Trim surrounding whitespace: sysfs pads some serials (" 1020").
  value=${value#"${value%%[![:space:]]*}"}
  value=${value%"${value##*[![:space:]]}"}
  printf '%s' "$value"
}

# A stable key for one battery: NAME:VENDOR:MODEL:SERIAL.
#
# Serial is what separates two otherwise identical spare batteries. When the
# firmware leaves it empty the key still forms, but it can no longer tell such
# spares apart — battery_model_pack_key_is_weak() reports that rather than
# letting the ambiguity pass silently.
battery_model_battery_key() {
  local name=$1 vendor=$2 model=$3 serial=$4
  printf '%s:%s:%s:%s' \
    "$(battery_model_sanitize_field "$name")" \
    "$(battery_model_sanitize_field "$vendor")" \
    "$(battery_model_sanitize_field "$model")" \
    "$(battery_model_sanitize_field "$serial")"
}

# A key for the whole installed set: every battery key, comma separated, in
# name order so the same physical set always produces the same string.
battery_model_pack_key() {
  local sorted
  sorted=$(printf '%s\n' "$@" | LC_ALL=C sort | paste -sd,)
  printf '%s' "$sorted"
}

# Does this key identify its batteries only by model, with no serial to
# separate two identical spares?
battery_model_pack_key_is_weak() {
  local key=$1 entry
  [[ -n $key ]] || return 1
  local IFS=','
  for entry in $key; do
    [[ $entry == *:*:*: ]] && return 0
  done
  return 1
}

# --- Charge-threshold holds ------------------------------------------------

# Is this battery genuinely parked at a configured charge cap?
#
# sysfs reports two different situations with the identical status string
# "Not charging": a battery held at its configured charge-stop threshold, and a
# battery in a multi-battery pack that is simply not its turn to charge yet. A
# status match alone cannot tell them apart, so a hold is only claimed once the
# battery's own percentage has actually reached its own configured cap.
#
# This is the single owner of that rule. The view labels each battery and the
# pack phase with it, and the tracker's plug notification uses the same call —
# before it lived here, each of those had its own answer and they disagreed.
battery_model_threshold_held() {
  local status=$1 percent=$2 threshold=$3
  [[ $status == "Not charging" ]] || return 1
  [[ $percent =~ ^[0-9]+$ && $threshold =~ ^[0-9]+$ ]] || return 1
  ((threshold > 0 && percent >= threshold))
}
