#!/usr/bin/env bash
# Render the battery-intelligence portion of `make status` without changing
# runtime data. ANSI styling is automatic on a TTY, forced with
# BATTERY_STATUS_COLOR=always, disabled with =never, and always disabled when
# NO_COLOR is set.

set -uo pipefail

state_dir="${BATTERY_SESSION_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/battery-session}"
state_file="$state_dir/state"
history_file="$state_dir/discharge-history.tsv"
systemctl_command="${BATTERY_INTELLIGENCE_SYSTEMCTL_COMMAND:-systemctl}"
now=${BATTERY_INTELLIGENCE_NOW:-$(date +%s)}

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

field() {
  local label=$1 text=$2 color=${3-}
  printf '  %b%s:%b %b%s%b\n' "$bold$cyan" "$label" "$reset" \
    "$color" "$text" "$reset"
}

value() {
  local key=$1 file=$2
  [[ -f "$file" ]] || return 0
  awk -F= -v key="$key" '$1 == key { print substr($0, index($0, "=") + 1); exit }' "$file"
}

format_duration() {
  local seconds=$1 minutes hours
  minutes=$(((seconds + 59) / 60))
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

format_energy() {
  awk -v value="$1" 'BEGIN { printf "%.1f Wh", value / 1000000 }'
}

format_power() {
  awk -v value="$1" 'BEGIN { printf "%.1f W", value / 1000 }'
}

compute_observed_peak_capacity() {
  observed_peak_capacity_uwh=0
  observed_peak_capacity_samples=0
  [[ -f "$history_file" ]] || return 0

  # Each history row captures the kernel's usable full-capacity value at the
  # end of a valid discharge window. Use their recent median as the observed
  # peak-capacity diagnostic rather than trusting one kernel reading.
  mapfile -t observed_peak_capacities < <(
    awk -F '\t' -v now="$now" '
      BEGIN { cutoff = now - 30 * 24 * 60 * 60 }
      $1 ~ /^[0-9]+$/ && $1 >= cutoff && $2 != "" &&
        $3 ~ /^[1-9][0-9]*$/ && $4 ~ /^[1-9][0-9]*$/ { print $4 }
    ' "$history_file" | sort -n
  )
  observed_peak_capacity_samples=${#observed_peak_capacities[@]}
  ((observed_peak_capacity_samples > 0)) || return 0
  local middle=$((observed_peak_capacity_samples / 2))
  if ((observed_peak_capacity_samples % 2 == 1)); then
    observed_peak_capacity_uwh=${observed_peak_capacities[$middle]}
  else
    observed_peak_capacity_uwh=$(((\
      observed_peak_capacities[middle - 1] + observed_peak_capacities[middle]) / 2))
  fi
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

monitor_state=$(service_state battery-session-monitor.service)
poller_state=$(service_state battery-session-tracker.timer)
field "Data" "$state_dir" "$dim"
if [[ $monitor_state == active ]]; then
  field "Monitor" "$monitor_state" "$green"
else
  field "Monitor" "$monitor_state" "$red"
fi
if [[ $poller_state == active ]]; then
  field "Poller" "$poller_state" "$green"
else
  field "Poller" "$poller_state" "$red"
fi

total=0
recent=0
sessions=0
last_row=""
if [[ -f "$history_file" ]]; then
  history_stats=$(awk -F '\t' -v now="$now" '
    BEGIN { total = recent = sessions = 0; cutoff = now - 30 * 24 * 60 * 60 }
    $1 ~ /^[0-9]+$/ && $2 != "" && $3 ~ /^[1-9][0-9]*$/ && $4 ~ /^[1-9][0-9]*$/ {
      total++
      if ($1 >= cutoff) {
        recent++
        if (!recent_seen[$2]++) sessions++
      }
      last = $0
    }
    END { printf "%d\t%d\t%d\t%s", total, recent, sessions, last }
  ' "$history_file")
  IFS=$'\t' read -r total recent sessions last_row <<<"$history_stats"
fi
window_progress=$recent
session_progress=$sessions
((window_progress > 12)) && window_progress=12
((session_progress > 3)) && session_progress=3
readiness_progress="$window_progress/12 windows, $session_progress/3 sessions"
compute_observed_peak_capacity

render_history() {
  if [[ -f "$history_file" ]]; then
    field "History" "$total valid rows ($recent recent / $sessions recent sessions)"
    if [[ -n ${last_row:-} ]]; then
      IFS=$'\t' read -r last_epoch _last_session last_draw last_capacity <<<"$last_row"
      field "Last recorded window" \
        "$(format_duration $((15 * 60))) at $last_epoch ($(format_power "$last_draw") draw, $(format_energy "$last_capacity") capacity)"
    else
      field "Last recorded window" "none" "$dim"
    fi
  else
    field "History" "no observations recorded" "$yellow"
  fi
}

if [[ ! -f "$state_file" ]]; then
  field "Usual readiness" "waiting for first tracker poll ($readiness_progress)" "$yellow"
  field "Current stored energy" "not available" "$dim"
  field "Observed peak capacity" "not available" "$dim"
  field "Usual remaining runtime" "not ready" "$yellow"
  field "Expected runtime at peak" "not ready" "$yellow"
  render_history
  exit 0
fi

usual_remaining=$(value usual_remaining_runtime_seconds "$state_file")
usual_full=$(value usual_full_runtime_seconds "$state_file")
current_energy=$(value battery_energy_now_uwh "$state_file")
current_capacity=$(value battery_usable_capacity_uwh "$state_file")
session=$(value discharge_session_id "$state_file")
window_start=$(value window_start_epoch "$state_file")
window_energy=$(value window_start_energy_uwh "$state_file")
last_energy=$(value last_sample_energy_uwh "$state_file")
fingerprint=$(value battery_fingerprint "$state_file")

if [[ "$usual_remaining" =~ ^[1-9][0-9]*$ ]]; then
  field "Usual readiness" "ready ($readiness_progress)" "$green"
else
  field "Usual readiness" "learning ($readiness_progress)" "$yellow"
fi
if [[ "$current_energy" =~ ^[1-9][0-9]*$ ]]; then
  if [[ "$current_capacity" =~ ^[1-9][0-9]*$ ]]; then
    field "Current stored energy" "$(format_energy "$current_energy") / $(format_energy "$current_capacity")"
  else
    field "Current stored energy" "$(format_energy "$current_energy")"
  fi
else
  field "Current stored energy" "not available" "$dim"
fi
if ((observed_peak_capacity_uwh > 0)); then
  field "Observed peak capacity" "$(format_energy "$observed_peak_capacity_uwh") ($observed_peak_capacity_samples observations)" "$dim"
elif [[ "$current_capacity" =~ ^[1-9][0-9]*$ ]]; then
  field "Observed peak capacity" "$(format_energy "$current_capacity") (current reading)" "$dim"
else
  field "Observed peak capacity" "not available" "$dim"
fi
if [[ "$usual_remaining" =~ ^[1-9][0-9]*$ ]]; then
  field "Usual remaining runtime" "$(format_duration "$usual_remaining")" "$green"
else
  field "Usual remaining runtime" "not ready" "$yellow"
fi
if [[ "$usual_full" =~ ^[1-9][0-9]*$ ]]; then
  field "Expected runtime at peak" "$(format_duration "$usual_full")" "$dim"
else
  field "Expected runtime at peak" "not ready" "$yellow"
fi

if [[ "$window_start" =~ ^[1-9][0-9]*$ && "$now" =~ ^[0-9]+$ ]]; then
  elapsed=$((now - window_start))
  if ((elapsed >= 0)); then
    progress=$((elapsed * 100 / (15 * 60)))
    ((progress > 100)) && progress=100
    field "Active window" "$progress% ($(format_duration "$elapsed") / 15m)" "$cyan"
  else
    field "Active window" "reset (clock moved backwards)" "$yellow"
  fi
else
  field "Active window" "waiting for valid energy samples" "$yellow"
fi

field "Discharge session" "${session:-none}"
if [[ "$window_energy" =~ ^[1-9][0-9]*$ ]]; then
  field "Window start energy" "$(format_energy "$window_energy")"
else
  field "Window start energy" "none" "$dim"
fi
if [[ "$last_energy" =~ ^[1-9][0-9]*$ ]]; then
  field "Last sample energy" "$(format_energy "$last_energy")"
else
  field "Last sample energy" "none" "$dim"
fi
field "Battery set" "${fingerprint//\\,/, }"
render_history
