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

# Schema history. Version 2 added the identity of the battery set a window was
# measured on. Version 3 replaced the pack-level row with one row per battery,
# carrying that battery's own draw and its full metric set, because a
# projection for a cell must be built from that cell's own evidence.
#
# Version 1 and 2 rows stay readable, but they describe a pack rather than a
# battery, so they can never be attributed to one. They are reported as legacy
# and never modelled.
readonly BATTERY_MODEL_HISTORY_HEADER=$'# battery-discharge-history\tv3'
readonly BATTERY_MODEL_HISTORY_HEADER_V2=$'# battery-discharge-history\tv2'
readonly BATTERY_MODEL_HISTORY_HEADER_V1=$'# battery-discharge-history\tv1'

# The tracker state file's schema. v1 files carry no version key and also carry
# derived model fields (battery_energy_now_uwh, usual_*) that v2 dropped: the
# view recomputes those from live sysfs and the history, so there is no longer
# a second, staler copy of them on disk.
readonly BATTERY_STATE_SCHEMA_VERSION=2

# --- Loaded history --------------------------------------------------------
# battery_model_load_history() reads the file once and indexes every window by
# the battery that measured it. battery_model_select_battery() then narrows the
# working set to one battery, because a projection for a given cell must use
# only that cell's own evidence.

battery_model_state=""               # missing | unsupported | ready
battery_model_history_version=0
battery_model_total_rows=0           # valid rows in the file, any age
battery_model_future_rows=0          # rows dated after `now`
battery_model_legacy_rows=0          # pack-level rows from schema v1 and v2
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
battery_model_recent_draws=()        # newest BATTERY_MODEL_RECENT_WINDOWS

battery_model_history_valid() {
  local first_line
  [[ -f "$1" ]] || return 1
  # Read the header in bash rather than forking `head`: the view calls this on
  # every panel refresh.
  IFS= read -r first_line <"$1" 2>/dev/null || return 1
  case $first_line in
  "$BATTERY_MODEL_HISTORY_HEADER") return 0 ;;
  "$BATTERY_MODEL_HISTORY_HEADER_V2") return 0 ;;
  "$BATTERY_MODEL_HISTORY_HEADER_V1") return 0 ;;
  esac
  return 1
}

# 3, 2, 1, or 0 when the file is missing or in a format this version cannot read.
battery_model_history_format() {
  local first_line
  [[ -f "$1" ]] || {
    printf '0'
    return 0
  }
  IFS= read -r first_line <"$1" 2>/dev/null || {
    printf '0'
    return 0
  }
  case $first_line in
  "$BATTERY_MODEL_HISTORY_HEADER") printf '3' ;;
  "$BATTERY_MODEL_HISTORY_HEADER_V2") printf '2' ;;
  "$BATTERY_MODEL_HISTORY_HEADER_V1") printf '1' ;;
  *) printf '0' ;;
  esac
}

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

# Read the discharge history once and index it by battery.
# Usage: battery_model_load_history HISTORY_FILE NOW_EPOCH
battery_model_load_history() {
  local history_file=$1 now=$2
  local kind epoch key draw session energy_full cycles

  battery_model_state="missing"
  battery_model_total_rows=0
  battery_model_future_rows=0
  battery_model_legacy_rows=0
  battery_model_keys=()
  battery_model_key_draws=()
  battery_model_key_sessions=()
  battery_model_key_last=()
  battery_model_key_energy_full=()
  battery_model_key_cycles=()
  battery_model_select_battery ""

  [[ -f "$history_file" ]] || return 0
  battery_model_history_version=$(battery_model_history_format "$history_file")
  if ((battery_model_history_version == 0)); then
    battery_model_state="unsupported"
    return 0
  fi
  battery_model_state="ready"

  while IFS=$'\t' read -r kind epoch key draw session energy_full cycles; do
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
      battery_model_key_energy_full["$key"]=$energy_full
      battery_model_key_cycles["$key"]=$cycles
      ;;
    S)
      battery_model_total_rows=$epoch
      battery_model_future_rows=$key
      battery_model_legacy_rows=$draw
      ;;
    esac
  done < <(
    awk -F '\t' -v now="$now" -v lookback="$BATTERY_MODEL_LOOKBACK_SECONDS" \
      -v version="$battery_model_history_version" '
      BEGIN { cutoff = now - lookback; total = future = legacy = 0 }
      /^#/ { next }
      $1 !~ /^[0-9]+$/ { next }
      {
        total++
        if ($1 > now) { future++; next }
        if ($1 < cutoff) next
        # Schema 1 and 2 record one row per pack, with no battery identity, so
        # they can never be attributed to a cell. They are counted and reported,
        # never modelled.
        if (version < 3) { legacy++; next }
        if ($3 == "" || $4 !~ /^[1-9][0-9]*$/) next
        printf "D\t%s\t%s\t%s\t%s\t%s\t%s\n", $1, $3, $4, $2, $6, $11
      }
      END { printf "S\t%d\t%d\t%d\t\t\t\n", total, future, legacy }
    ' "$history_file"
  )
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
  battery_model_recent_draws=()
  [[ -n $key ]] || return 0
  [[ -n ${battery_model_key_draws[$key]+x} ]] || return 0

  for draw in ${battery_model_key_draws[$key]}; do
    battery_model_draws+=("$draw")
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
