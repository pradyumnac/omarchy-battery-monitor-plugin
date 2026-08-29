#!/usr/bin/env bash
# Render the concise, human-facing `make status` report without changing
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

heading() {
  printf '%bBATTERY STATUS%b\n%b────────────────────────────────────────%b\n' \
    "$bold$cyan" "$reset" "$cyan" "$reset"
}

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

compute_history_stats() {
  recent=0
  sessions=0
  typical_draw_mw=0
  observed_peak_capacity_uwh=0
  [[ -f "$history_file" ]] || return 0

  history_stats=$(awk -F '\t' -v now="$now" '
    BEGIN { recent = sessions = 0; cutoff = now - 30 * 24 * 60 * 60 }
    $1 ~ /^[0-9]+$/ && $2 != "" && $3 ~ /^[1-9][0-9]*$/ && $4 ~ /^[1-9][0-9]*$/ {
      if ($1 >= cutoff) {
        recent++
        if (!recent_seen[$2]++) sessions++
      }
    }
    END { printf "%d\t%d", recent, sessions }
  ' "$history_file")
  IFS=$'\t' read -r recent sessions <<<"$history_stats"

  mapfile -t recent_draws < <(
    awk -F '\t' -v now="$now" '
      BEGIN { cutoff = now - 30 * 24 * 60 * 60 }
      $1 ~ /^[0-9]+$/ && $1 >= cutoff && $2 != "" &&
        $3 ~ /^[1-9][0-9]*$/ && $4 ~ /^[1-9][0-9]*$/ { print $3 }
    ' "$history_file" | sort -n
  )
  mapfile -t recent_capacities < <(
    awk -F '\t' -v now="$now" '
      BEGIN { cutoff = now - 30 * 24 * 60 * 60 }
      $1 ~ /^[0-9]+$/ && $1 >= cutoff && $2 != "" &&
        $3 ~ /^[1-9][0-9]*$/ && $4 ~ /^[1-9][0-9]*$/ { print $4 }
    ' "$history_file" | sort -n
  )

  local count=${#recent_draws[@]} middle
  ((count > 0)) || return 0
  middle=$((count / 2))
  if ((count % 2 == 1)); then
    typical_draw_mw=${recent_draws[$middle]}
    observed_peak_capacity_uwh=${recent_capacities[$middle]}
  else
    typical_draw_mw=$(((recent_draws[middle - 1] + recent_draws[middle]) / 2))
    observed_peak_capacity_uwh=$(((recent_capacities[middle - 1] + recent_capacities[middle]) / 2))
  fi
}

heading
monitor_state=$(service_state battery-session-monitor.service)
poller_state=$(service_state battery-session-tracker.timer)
if [[ $monitor_state == active && $poller_state == active ]]; then
  field "Services" "tracker active · monitor active" "$green"
else
  field "Services" "tracker $poller_state · monitor $monitor_state" "$red"
fi

compute_history_stats
window_progress=$recent
session_progress=$sessions
((window_progress > 12)) && window_progress=12
((session_progress > 3)) && session_progress=3

if [[ ! -f "$state_file" ]]; then
  field "Model" "waiting for first tracker poll" "$yellow"
  field "Learning" "$window_progress/12 windows · $session_progress/3 sessions" "$yellow"
  exit 0
fi

power_state=$(value previous_state "$state_file")
state_since=$(value state_since "$state_file")
last_observed=$(value last_observed "$state_file")
window_start=$(value window_start_epoch "$state_file")
current_energy=$(value battery_energy_now_uwh "$state_file")
current_capacity=$(value battery_usable_capacity_uwh "$state_file")
usual_remaining=$(value usual_remaining_runtime_seconds "$state_file")
usual_full=$(value usual_full_runtime_seconds "$state_file")

# A repository may render status before `make install` updates the live tracker.
# Derive the new fields from compatible legacy state so readiness never says
# "learning" after the evidence gate is already complete.
[[ "$current_energy" =~ ^[1-9][0-9]*$ ]] || current_energy=$(value last_sample_energy_uwh "$state_file")
if [[ ! "$current_capacity" =~ ^[1-9][0-9]*$ ]] && ((observed_peak_capacity_uwh > 0)); then
  current_capacity=$observed_peak_capacity_uwh
fi
if [[ ! "$usual_remaining" =~ ^[1-9][0-9]*$ ]] &&
  [[ "$usual_full" =~ ^[1-9][0-9]*$ && "$current_energy" =~ ^[1-9][0-9]*$ && "$current_capacity" =~ ^[1-9][0-9]*$ ]]; then
  usual_remaining=$(((usual_full * current_energy + current_capacity / 2) / current_capacity))
fi

case $power_state in
on-battery) power_label="on battery" ;;
on-charge) power_label="plugged in" ;;
*) power_label="unknown" ;;
esac
if [[ "$state_since" =~ ^[1-9][0-9]*$ && "$now" =~ ^[0-9]+$ && $now -ge $state_since ]]; then
  power_label+=" · $(format_duration $((now - state_since)))"
fi
field "Power" "$power_label"

if [[ "$current_energy" =~ ^[1-9][0-9]*$ && "$current_capacity" =~ ^[1-9][0-9]*$ ]]; then
  charge_percent=$((current_energy * 100 / current_capacity))
  ((charge_percent > 100)) && charge_percent=100
  field "Energy" "$(format_energy "$current_energy") / $(format_energy "$current_capacity") · $charge_percent%"
else
  field "Energy" "not available" "$yellow"
fi

if ((recent >= 12 && sessions >= 3)) && [[ "$usual_remaining" =~ ^[1-9][0-9]*$ ]]; then
  field "Model" "ready · $recent windows across $sessions sessions" "$green"
  field "Usual remaining" "$(format_duration "$usual_remaining")" "$green"
  if [[ "$usual_full" =~ ^[1-9][0-9]*$ ]]; then
    field "At full" "$(format_duration "$usual_full")"
  fi
  ((typical_draw_mw > 0)) && field "Typical draw" "$(format_power "$typical_draw_mw")"
else
  field "Model" "learning · $window_progress/12 windows · $session_progress/3 sessions" "$yellow"
fi

if [[ "$window_start" =~ ^[1-9][0-9]*$ && "$now" =~ ^[0-9]+$ && $now -ge $window_start ]]; then
  elapsed=$((now - window_start))
  progress=$((elapsed * 100 / (15 * 60)))
  ((progress > 100)) && progress=100
  field "Current sample" "$progress% · $(format_duration "$elapsed") of 15m" "$cyan"
fi
if [[ "$last_observed" =~ ^[1-9][0-9]*$ && "$now" =~ ^[0-9]+$ ]]; then
  field "Updated" "$(format_age $((now - last_observed)))" "$dim"
fi
