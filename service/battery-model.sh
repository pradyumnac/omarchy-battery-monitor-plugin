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
# Only windows this recent take part in the model.
readonly BATTERY_MODEL_LOOKBACK_SECONDS=$((30 * 24 * 60 * 60))
# Rows older than this are pruned from the history file.
readonly BATTERY_MODEL_RETENTION_SECONDS=$((180 * 24 * 60 * 60))
# Rows kept after a prune, newest last.
readonly BATTERY_MODEL_RETENTION_ROWS=96
# The full evidence gate: the model is only "ready" at or above both counts.
readonly BATTERY_MODEL_MIN_WINDOWS=12
readonly BATTERY_MODEL_MIN_SESSIONS=3
# The provisional gate: enough to say something, with a wide band and a loud
# low-confidence label, instead of showing a new user nothing for days.
readonly BATTERY_MODEL_PROVISIONAL_WINDOWS=4
# How many of the newest windows form the "right now" estimate.
readonly BATTERY_MODEL_RECENT_WINDOWS=4
# A window whose average draw falls outside this range is rejected as noise
# (a suspend, a hot-swapped battery, or a sysfs counter that jumped).
readonly BATTERY_MODEL_MIN_DRAW_MW=100
readonly BATTERY_MODEL_MAX_DRAW_MW=120000

# Version 2 added a fifth column: the identity of the battery set a window was
# measured on. Version-1 rows stay readable and still count as draw evidence —
# draw is a machine property — but they carry no identity, so they can never be
# attributed to a set. The header is rewritten to v2 the next time a row is
# appended.
readonly BATTERY_MODEL_HISTORY_HEADER=$'# battery-discharge-history\tv2'
readonly BATTERY_MODEL_HISTORY_HEADER_V1=$'# battery-discharge-history\tv1'

# The tracker state file's schema. v1 files carry no version key and also carry
# derived model fields (battery_energy_now_uwh, usual_*) that v2 dropped: the
# view recomputes those from live sysfs and the history, so there is no longer
# a second, staler copy of them on disk.
readonly BATTERY_STATE_SCHEMA_VERSION=2

# --- Loaded history --------------------------------------------------------
# battery_model_load_history() writes every variable below. They are globals
# rather than nameref outputs so one load can feed several readers.

battery_model_state=""          # missing | unsupported | ready
battery_model_total_rows=0      # valid rows in the file, any age
battery_model_window_count=0    # valid rows inside the lookback
battery_model_session_count=0   # distinct sessions inside the lookback
battery_model_future_rows=0     # rows dated after `now`, ignored by the model
battery_model_latest_epoch=0
battery_model_latest_draw_mw=0
battery_model_latest_capacity_uwh=0
battery_model_draws=()          # in-window draws, ascending
battery_model_recent_draws=()   # newest BATTERY_MODEL_RECENT_WINDOWS draws
# Attribution of the evidence inside the lookback. Every row still counts as
# draw evidence — draw belongs to the machine — but the split says which
# battery set produced it, so a swap is visible instead of silent.
battery_model_foreign_windows=0      # measured on a different, identified set
battery_model_unattributed_windows=0 # version-1 rows, recorded before identity
battery_model_previous_pack=""       # key of the most recent other set

battery_model_history_valid() {
  local first_line
  [[ -f "$1" ]] || return 1
  # Read the header in bash rather than forking `head`: the view calls this on
  # every panel refresh.
  IFS= read -r first_line <"$1" 2>/dev/null || return 1
  [[ $first_line == "$BATTERY_MODEL_HISTORY_HEADER" ||
    $first_line == "$BATTERY_MODEL_HISTORY_HEADER_V1" ]]
}

# Sort a numeric array in place, ascending. Insertion sort with no subprocess:
# the history file is capped at BATTERY_MODEL_RETENTION_ROWS, so this is always
# cheaper than forking `sort`.
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

# Read the discharge history once and populate every battery_model_* global.
# Usage: battery_model_load_history HISTORY_FILE NOW_EPOCH
battery_model_load_history() {
  local history_file=$1 now=$2 current_pack_key=${3-}
  local kind first second third session pack index
  local -A seen_sessions=()

  battery_model_state="missing"
  battery_model_total_rows=0
  battery_model_window_count=0
  battery_model_session_count=0
  battery_model_future_rows=0
  battery_model_latest_epoch=0
  battery_model_latest_draw_mw=0
  battery_model_latest_capacity_uwh=0
  battery_model_draws=()
  battery_model_recent_draws=()
  battery_model_foreign_windows=0
  battery_model_unattributed_windows=0
  battery_model_previous_pack=""

  [[ -f "$history_file" ]] || return 0
  if ! battery_model_history_valid "$history_file"; then
    battery_model_state="unsupported"
    return 0
  fi
  battery_model_state="ready"

  # One pass over the file. Each `D` line is a row inside the lookback, in file
  # order, so the tail is the newest evidence; the trailing `S` line carries
  # the counters that need the whole file to compute.
  while IFS=$'\t' read -r kind first second third session pack; do
    case $kind in
    D)
      # Draw is a property of the machine and its workload, so every row feeds
      # the draw model whichever set measured it. Identity only decides how the
      # evidence is attributed and reported.
      if [[ -z $pack ]]; then
        battery_model_unattributed_windows=$((battery_model_unattributed_windows + 1))
      elif [[ -n $current_pack_key && $pack != "$current_pack_key" ]]; then
        # Rows arrive oldest first, so this ends on the most recent other set.
        battery_model_foreign_windows=$((battery_model_foreign_windows + 1))
        battery_model_previous_pack=$pack
      fi
      battery_model_draws+=("$second")
      battery_model_window_count=$((battery_model_window_count + 1))
      if [[ -n $session && -z ${seen_sessions[$session]+x} ]]; then
        seen_sessions["$session"]=1
        battery_model_session_count=$((battery_model_session_count + 1))
      fi
      ;;
    S)
      battery_model_total_rows=$first
      battery_model_future_rows=$second
      battery_model_latest_epoch=$third
      ;;
    L)
      battery_model_latest_draw_mw=$first
      battery_model_latest_capacity_uwh=$second
      ;;
    esac
  done < <(
    awk -F '\t' -v now="$now" -v lookback="$BATTERY_MODEL_LOOKBACK_SECONDS" '
      BEGIN { cutoff = now - lookback; total = future = latest = 0 }
      $1 ~ /^[0-9]+$/ && $2 != "" && $3 ~ /^[1-9][0-9]*$/ && $4 ~ /^[1-9][0-9]*$/ {
        total++
        if ($1 > now) { future++; next }
        if ($1 < cutoff) next
        printf "D\t%s\t%s\t%s\t%s\t%s\n", $1, $3, $4, $2, $5
        if ($1 >= latest) { latest = $1; last_draw = $3; last_capacity = $4 }
      }
      END {
        printf "S\t%d\t%d\t%d\t\t\n", total, future, latest
        printf "L\t%d\t%d\t0\t\t\n", last_draw + 0, last_capacity + 0
      }
    ' "$history_file"
  )

  # The newest windows, captured in file order before the value sort below
  # reorders them.
  for ((index = ${#battery_model_draws[@]} - BATTERY_MODEL_RECENT_WINDOWS; index < ${#battery_model_draws[@]}; index++)); do
    ((index >= 0)) || continue
    battery_model_recent_draws+=("${battery_model_draws[index]}")
  done

  battery_model_sort_numbers battery_model_draws
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

# --- Discharge-window arithmetic -------------------------------------------
# Values in, values out. The tracker owns the on-disk round trip; the rules for
# turning two energy samples into evidence live here.

# Average draw in mW over a window, from the energy it consumed and how long it
# ran. Prints nothing and fails when the inputs cannot produce a draw.
battery_model_window_draw_mw() {
  local energy_used_uwh=$1 elapsed_seconds=$2
  ((energy_used_uwh > 0 && elapsed_seconds > 0)) || return 1
  printf '%s' "$(((energy_used_uwh * 3600 + elapsed_seconds * 500) / (elapsed_seconds * 1000)))"
}

# Has the window run long enough to count as evidence?
battery_model_window_complete() {
  local elapsed_seconds=$1
  ((elapsed_seconds >= BATTERY_MODEL_WINDOW_SECONDS))
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

# Is this draw physically believable for a laptop battery?
battery_model_draw_plausible() {
  local draw_mw=$1
  [[ $draw_mw =~ ^[0-9]+$ ]] &&
    ((draw_mw >= BATTERY_MODEL_MIN_DRAW_MW && draw_mw <= BATTERY_MODEL_MAX_DRAW_MW))
}
