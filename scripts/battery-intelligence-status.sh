#!/usr/bin/env bash
# Render the concise, human-facing `make status` report without changing
# runtime data. Set BATTERY_STATUS_VERBOSE=1 (via `make status VERBOSE=1`) for
# low-level collection details. ANSI styling is automatic on a TTY, forced
# with BATTERY_STATUS_COLOR=always, and disabled by NO_COLOR or =never.

set -uo pipefail

state_dir="${BATTERY_SESSION_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/battery-session}"
state_file="$state_dir/state"
history_file="$state_dir/discharge-history.tsv"
power_supply_root="${BATTERY_STATUS_POWER_SUPPLY_ROOT:-/sys/class/power_supply}"
systemctl_command="${BATTERY_INTELLIGENCE_SYSTEMCTL_COMMAND:-systemctl}"
now=${BATTERY_INTELLIGENCE_NOW:-$(date +%s)}
stale_after=${BATTERY_STATUS_STALE_AFTER:-90}
verbose=${BATTERY_STATUS_VERBOSE:-0}

[[ $verbose == 0 || $verbose == 1 ]] || {
  printf 'Invalid BATTERY_STATUS_VERBOSE: %s (expected 0 or 1)\n' "$verbose" >&2
  exit 2
}

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
  awk -F= -v key="$key" '$1 == key {
    result = substr($0, index($0, "=") + 1)
    if (result == "\047\047" || result == "\"\"") result = ""
    print result
    exit
  }' "$file"
}

format_duration() {
  local seconds=$1 minutes hours days
  minutes=$(((seconds + 59) / 60))
  days=$((minutes / (24 * 60)))
  hours=$(((minutes % (24 * 60)) / 60))
  minutes=$((minutes % 60))
  if ((days > 0)); then
    printf '%dd %dh' "$days" "$hours"
  elif ((hours > 0 && minutes > 0)); then
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
  history_state="missing"
  total=0
  recent=0
  sessions=0
  future_rows=0
  model_updated_epoch=0
  last_draw_mw=0
  last_capacity_uwh=0
  typical_draw_mw=0
  observed_peak_capacity_uwh=0
  [[ -f "$history_file" ]] || return 0
  if [[ "$(head -n 1 "$history_file" 2>/dev/null)" != $'# battery-discharge-history\tv1' ]]; then
    history_state="unsupported"
    return 0
  fi
  history_state="ready"

  history_stats=$(awk -F '\t' -v now="$now" '
    BEGIN { total = recent = sessions = future = latest = last_draw = last_capacity = 0; cutoff = now - 30 * 24 * 60 * 60 }
    $1 ~ /^[0-9]+$/ && $2 != "" && $3 ~ /^[1-9][0-9]*$/ && $4 ~ /^[1-9][0-9]*$/ {
      total++
      if ($1 > now) {
        future++
      } else if ($1 >= cutoff) {
        recent++
        if (!recent_seen[$2]++) sessions++
        if ($1 >= latest) {
          latest = $1
          last_draw = $3
          last_capacity = $4
        }
      }
    }
    END { printf "%d\t%d\t%d\t%d\t%d\t%d\t%d", total, recent, sessions, future, latest, last_draw, last_capacity }
  ' "$history_file")
  IFS=$'\t' read -r total recent sessions future_rows model_updated_epoch last_draw_mw last_capacity_uwh <<<"$history_stats"

  mapfile -t recent_draws < <(
    awk -F '\t' -v now="$now" '
      BEGIN { cutoff = now - 30 * 24 * 60 * 60 }
      $1 ~ /^[0-9]+$/ && $1 >= cutoff && $1 <= now && $2 != "" &&
        $3 ~ /^[1-9][0-9]*$/ && $4 ~ /^[1-9][0-9]*$/ { print $3 }
    ' "$history_file" | sort -n
  )
  mapfile -t recent_capacities < <(
    awk -F '\t' -v now="$now" '
      BEGIN { cutoff = now - 30 * 24 * 60 * 60 }
      $1 ~ /^[0-9]+$/ && $1 >= cutoff && $1 <= now && $2 != "" &&
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

inspect_batteries() {
  battery_presence="unknown"
  charge_phase="unknown"
  battery_count=0
  charging_count=0
  full_count=0
  held_count=0
  [[ -d "$power_supply_root" ]] || return 0
  battery_presence="absent"

  local battery_dir status
  for battery_dir in "$power_supply_root"/BAT*; do
    [[ -d "$battery_dir" ]] || continue
    if [[ -f "$battery_dir/present" ]]; then
      [[ "$(<"$battery_dir/present")" == 1 ]] || continue
    elif [[ ! -f "$battery_dir/status" && ! -f "$battery_dir/capacity" ]]; then
      continue
    fi
    battery_presence="present"
    ((battery_count += 1))
    status=""
    [[ -f "$battery_dir/status" ]] && status=$(<"$battery_dir/status")
    case $status in
    Charging) ((charging_count += 1)) ;;
    Full) ((full_count += 1)) ;;
    "Not charging") ((held_count += 1)) ;;
    esac
  done

  if ((charging_count > 0)); then
    charge_phase="charging"
  elif ((battery_count > 0 && full_count == battery_count)); then
    charge_phase="full"
  elif ((held_count > 0)); then
    charge_phase="held"
  elif ((battery_count > 0)); then
    charge_phase="plugged"
  fi
}

sampling_reason_label() {
  case $1 in
  battery-set-changed) printf 'battery set changed' ;;
  polling-gap) printf 'polling gap or clock change' ;;
  energy-unavailable) printf 'battery energy unavailable' ;;
  energy-increased) printf 'stored energy increased' ;;
  no-energy-used) printf 'no discharge measured' ;;
  implausible-draw) printf 'implausible draw rejected' ;;
  history-schema-unsupported) printf 'unsupported history format' ;;
  *) printf '%s' "$1" ;;
  esac
}

heading
monitor_state=$(service_state battery-session-monitor.service)
poller_state=$(service_state battery-session-tracker.timer)
services_healthy=0
if [[ $monitor_state == active && $poller_state == active ]]; then
  services_healthy=1
  field "Services" "healthy" "$green"
else
  field "Services" "tracker $poller_state · monitor $monitor_state" "$red"
fi

compute_history_stats
inspect_batteries
field "BAT0" "$(awk -v dir="$power_supply_root/BAT0" 'BEGIN { status=""; if ((getline value < (dir "/status")) > 0) status=value; full=0; if ((getline value < (dir "/energy_full")) > 0) full=value; if (full == 0 && (getline value < (dir "/charge_full")) > 0) full=value; design=0; if ((getline value < (dir "/energy_full_design")) > 0) design=value; if (design == 0 && (getline value < (dir "/charge_full_design")) > 0) design=value; power=0; if ((getline value < (dir "/power_now")) > 0) power=value; health=(design > 0 ? sprintf("health %d%%", full * 100 / design) : "health N/A"); energy=(full > 0 ? sprintf("%.1f Wh", full / 1000000) : "-"); if (status == "Discharging") detail=sprintf("Discharging · draw %.1f W", power / 1000000); else if (status == "Charging") detail=sprintf("Charging · charging power %.1f W", power / 1000000); else detail=""; printf "%s · %s%s", health, energy, (detail != "" ? " · " detail : "") }')"
field "BAT1" "$(awk -v dir="$power_supply_root/BAT1" 'BEGIN { status=""; if ((getline value < (dir "/status")) > 0) status=value; full=0; if ((getline value < (dir "/energy_full")) > 0) full=value; if (full == 0 && (getline value < (dir "/charge_full")) > 0) full=value; design=0; if ((getline value < (dir "/energy_full_design")) > 0) design=value; if (design == 0 && (getline value < (dir "/charge_full_design")) > 0) design=value; power=0; if ((getline value < (dir "/power_now")) > 0) power=value; health=(design > 0 ? sprintf("health %d%%", full * 100 / design) : "health N/A"); energy=(full > 0 ? sprintf("%.1f Wh", full / 1000000) : "-"); if (status == "Discharging") detail=sprintf("Discharging · draw %.1f W", power / 1000000); else if (status == "Charging") detail=sprintf("Charging · charging power %.1f W", power / 1000000); else detail=""; printf "%s · %s%s", health, energy, (detail != "" ? " · " detail : "") }')"
window_progress=$recent
session_progress=$sessions
((window_progress > 12)) && window_progress=12
((session_progress > 3)) && session_progress=3

if [[ $battery_presence == absent ]]; then
  field "Battery" "not detected" "$red"
  field "Model" "unavailable · no present battery" "$red"
  ((services_healthy == 0)) && field "Action" "run make install, then inspect failed user services" "$yellow"
  exit 0
fi

if [[ ! -f "$state_file" ]]; then
  field "Model" "waiting for first tracker poll" "$yellow"
  if [[ $history_state == unsupported ]]; then
    field "History" "unsupported format" "$red"
  else
    field "Learning" "$window_progress/12 windows · $session_progress/3 sessions" "$yellow"
  fi
  ((services_healthy == 0)) && field "Action" "run make install, then inspect failed user services" "$yellow"
  exit 0
fi

power_state=$(value previous_state "$state_file")
state_since=$(value state_since "$state_file")
last_observed=$(value last_observed "$state_file")
window_start=$(value window_start_epoch "$state_file")
window_start_energy=$(value window_start_energy_uwh "$state_file")
last_sample_energy=$(value last_sample_energy_uwh "$state_file")
current_energy=$(value battery_energy_now_uwh "$state_file")
current_capacity=$(value battery_usable_capacity_uwh "$state_file")
usual_remaining=$(value usual_remaining_runtime_seconds "$state_file")
usual_full=$(value usual_full_runtime_seconds "$state_file")
sampling_reset_reason=$(value window_reset_reason "$state_file")
discharge_session=$(value discharge_session_id "$state_file")
battery_fingerprint=$(value battery_fingerprint "$state_file")

# A repository may render status before `make install` updates the live tracker.
# Derive the new fields from compatible legacy state so a complete evidence gate
# never incorrectly reports "learning" during an upgrade.
[[ "$current_energy" =~ ^[1-9][0-9]*$ ]] || current_energy=$last_sample_energy
if [[ ! "$current_capacity" =~ ^[1-9][0-9]*$ ]] && ((observed_peak_capacity_uwh > 0)); then
  current_capacity=$observed_peak_capacity_uwh
fi
if [[ ! "$usual_remaining" =~ ^[1-9][0-9]*$ ]] &&
  [[ "$usual_full" =~ ^[1-9][0-9]*$ && "$current_energy" =~ ^[1-9][0-9]*$ && "$current_capacity" =~ ^[1-9][0-9]*$ ]]; then
  usual_remaining=$(((usual_full * current_energy + current_capacity / 2) / current_capacity))
fi

freshness="unknown"
tracker_age=0
if [[ "$last_observed" =~ ^[1-9][0-9]*$ && "$now" =~ ^[0-9]+$ ]]; then
  tracker_age=$((now - last_observed))
  if ((tracker_age < 0)); then
    freshness="clock-mismatch"
  elif ((tracker_age > stale_after || services_healthy == 0)); then
    freshness="cached"
  else
    freshness="live"
  fi
elif ((services_healthy == 0)); then
  freshness="cached"
fi

case $power_state in
on-battery) power_label="on battery" ;;
on-charge)
  case $charge_phase in
  charging) power_label="charging" ;;
  full) power_label="full" ;;
  held) power_label="plugged in · charge held" ;;
  *) power_label="plugged in" ;;
  esac
  ;;
*) power_label="unknown" ;;
esac
if [[ "$state_since" =~ ^[1-9][0-9]*$ && "$now" =~ ^[0-9]+$ && $now -ge $state_since ]]; then
  power_label+=" · $(format_duration $((now - state_since)))"
fi
field "Power" "$power_label"

charge_percent=-1
if [[ "$current_energy" =~ ^[1-9][0-9]*$ && "$current_capacity" =~ ^[1-9][0-9]*$ ]]; then
  charge_percent=$((current_energy * 100 / current_capacity))
  ((charge_percent > 100)) && charge_percent=100
  field "Energy" "$(format_energy "$current_energy") / $(format_energy "$current_capacity") · $charge_percent%"
else
  field "Energy" "not available" "$yellow"
fi
if [[ $power_state == on-charge && $charge_phase == unknown && $charge_percent -ge 99 ]]; then
  charge_phase="full"
fi

model_state="learning"
if [[ $history_state == unsupported ]]; then
  model_state="unavailable"
elif ((recent >= 12 && sessions >= 3)); then
  if [[ ! "$usual_full" =~ ^[1-9][0-9]*$ || typical_draw_mw -le 0 ]]; then
    model_state="blocked-runtime"
  elif [[ ! "$current_energy" =~ ^[1-9][0-9]*$ || ! "$current_capacity" =~ ^[1-9][0-9]*$ || ! "$usual_remaining" =~ ^[1-9][0-9]*$ ]]; then
    model_state="blocked-energy"
  else
    model_state="ready"
  fi
fi

model_learned=""
if [[ "$model_updated_epoch" =~ ^[1-9][0-9]*$ && "$now" =~ ^[0-9]+$ ]]; then
  model_learned=" · learned $(format_age $((now - model_updated_epoch)))"
fi
case $model_state in
ready)
  field "Model" "ready · $recent windows / $sessions sessions$model_learned" "$green"
  runtime_color=$green
  runtime_suffix=""
  if [[ $freshness != live ]]; then
    runtime_color=$yellow
    runtime_suffix=" (cached)"
  fi
  if [[ $power_state == on-charge && $charge_phase == full ]]; then
    field "Usual runtime$runtime_suffix" "$(format_duration "$usual_full") · battery full" "$runtime_color"
  elif [[ $power_state == on-charge ]]; then
    field "If unplugged now$runtime_suffix" "$(format_duration "$usual_remaining")" "$runtime_color"
    field "At full" "$(format_duration "$usual_full")"
  else
    field "Usual remaining$runtime_suffix" "$(format_duration "$usual_remaining")" "$runtime_color"
    field "At full" "$(format_duration "$usual_full")"
  fi
  field "Typical draw" "$(format_power "$typical_draw_mw")"
  ;;
blocked-energy)
  field "Model" "blocked · current battery energy unavailable" "$yellow"
  field "Evidence" "$recent windows / $sessions sessions" "$dim"
  ;;
blocked-runtime)
  field "Model" "blocked · learned runtime unavailable" "$yellow"
  field "Evidence" "$recent windows / $sessions sessions" "$dim"
  ;;
unavailable)
  field "Model" "unavailable · unsupported history format" "$red"
  ;;
*)
  field "Model" "learning · $window_progress/12 windows · $session_progress/3 sessions" "$yellow"
  ;;
esac

archived=$((total - recent - future_rows))
if ((archived > 0)); then
  field "History" "$recent recent · $archived archived" "$dim"
fi
if ((future_rows > 0)); then
  field "History warning" "$future_rows future-dated row(s) ignored" "$yellow"
fi

if [[ -n $sampling_reset_reason ]]; then
  if [[ $sampling_reset_reason == energy-unavailable && ! "$window_start" =~ ^[1-9][0-9]*$ ]]; then
    field "Sampling" "paused · $(sampling_reason_label "$sampling_reset_reason")" "$yellow"
  else
    field "Sampling" "restarted · $(sampling_reason_label "$sampling_reset_reason")" "$yellow"
  fi
elif [[ "$window_start" =~ ^[1-9][0-9]*$ && "$now" =~ ^[0-9]+$ && $now -ge $window_start ]] &&
  [[ $model_state == learning || $verbose == 1 ]]; then
  elapsed=$((now - window_start))
  progress=$((elapsed * 100 / (15 * 60)))
  ((progress > 100)) && progress=100
  field "Current sample" "$progress% · $(format_duration "$elapsed") of 15m" "$cyan"
fi

case $freshness in
live) field "Updated" "$(format_age "$tracker_age")" "$dim" ;;
cached) field "Data" "stale · tracker updated $(format_age "$tracker_age"); estimates are cached" "$yellow" ;;
clock-mismatch) field "Data" "clock mismatch · estimates are cached" "$yellow" ;;
*) field "Data" "freshness unknown · estimates may be cached" "$yellow" ;;
esac
if ((services_healthy == 0)); then
  field "Action" "run make install, then inspect failed user services" "$yellow"
fi

if [[ $verbose == 1 ]]; then
  field "State file" "$state_file" "$dim"
  field "History detail" "$total retained · $recent recent · $sessions recent sessions · $future_rows future" "$dim"
  if ((model_updated_epoch > 0)); then
    field "Last learned" "$(format_age $((now - model_updated_epoch))) · $(format_power "$last_draw_mw") · $(format_energy "$last_capacity_uwh")" "$dim"
  fi
  field "Session" "${discharge_session:-none}" "$dim"
  if [[ "$window_start" =~ ^[1-9][0-9]*$ ]]; then
    field "Window" "start $(format_energy "${window_start_energy:-0}") · last $(format_energy "${last_sample_energy:-0}")" "$dim"
  else
    field "Window" "inactive" "$dim"
  fi
  field "Battery set" "${battery_fingerprint//\\,/, }" "$dim"
fi
