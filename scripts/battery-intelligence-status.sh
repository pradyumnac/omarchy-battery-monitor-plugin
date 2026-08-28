#!/usr/bin/env bash
# Report battery-intelligence workflow state without changing runtime data.
# Safe to run repeatedly (`make intelligence-status`).

set -uo pipefail

state_dir="${BATTERY_SESSION_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/battery-session}"
state_file="$state_dir/state"
history_file="$state_dir/discharge-history.tsv"
systemctl_command="${BATTERY_INTELLIGENCE_SYSTEMCTL_COMMAND:-systemctl}"
now=${BATTERY_INTELLIGENCE_NOW:-$(date +%s)}

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

service_state() {
  local unit=$1
  if command -v -- "$systemctl_command" >/dev/null 2>&1 \
    && "$systemctl_command" --user is-active --quiet "$unit" 2>/dev/null; then
    printf 'active'
  else
    printf 'inactive'
  fi
}

printf 'Battery intelligence\n'
printf '  Data: %s\n' "$state_dir"
printf '  Monitor: %s\n' "$(service_state battery-session-monitor.service)"
printf '  Poller: %s\n' "$(service_state battery-session-tracker.timer)"

if [[ ! -f "$state_file" ]]; then
  printf '  Workflow: waiting for first tracker poll\n'
  exit 0
fi

usual=$(value usual_full_runtime_seconds "$state_file")
samples=$(value usual_sample_count "$state_file")
session=$(value discharge_session_id "$state_file")
window_start=$(value window_start_epoch "$state_file")
window_energy=$(value window_start_energy_uwh "$state_file")
last_energy=$(value last_sample_energy_uwh "$state_file")
fingerprint=$(value battery_fingerprint "$state_file")

if [[ "$usual" =~ ^[1-9][0-9]*$ ]]; then
  printf '  Workflow: model ready\n'
  printf '  Usual full runtime: %s\n' "$(format_duration "$usual")"
else
  printf '  Workflow: learning\n'
  printf '  Usual full runtime: not ready\n'
fi
printf '  Model samples: %s\n' "${samples:-0}"

if [[ "$window_start" =~ ^[1-9][0-9]*$ && "$now" =~ ^[0-9]+$ ]]; then
  elapsed=$((now - window_start))
  if ((elapsed >= 0)); then
    progress=$((elapsed * 100 / (15 * 60)))
    ((progress > 100)) && progress=100
    printf '  Active window: %s%% (%s / 15m)\n' "$progress" "$(format_duration "$elapsed")"
  else
    printf '  Active window: reset (clock moved backwards)\n'
  fi
else
  printf '  Active window: waiting for valid energy samples\n'
fi

printf '  Discharge session: %s\n' "${session:-none}"
if [[ "$window_energy" =~ ^[1-9][0-9]*$ ]]; then
  printf '  Window start energy: %s\n' "$(format_energy "$window_energy")"
else
  printf '  Window start energy: none\n'
fi
if [[ "$last_energy" =~ ^[1-9][0-9]*$ ]]; then
  printf '  Last sample energy: %s\n' "$(format_energy "$last_energy")"
else
  printf '  Last sample energy: none\n'
fi
printf '  Battery set: %s\n' "${fingerprint//\\,/, }"

if [[ -f "$history_file" ]]; then
  history_stats=$(awk -F '\t' -v now="$now" '
    BEGIN { total = recent = sessions = 0; cutoff = now - 30 * 24 * 60 * 60 }
    $1 ~ /^[0-9]+$/ && $2 != "" && $3 ~ /^[1-9][0-9]*$/ && $4 ~ /^[1-9][0-9]*$/ {
      total++
      if ($1 >= cutoff) recent++
      if (!seen[$2]++) sessions++
      last = $0
    }
    END { printf "%d\t%d\t%d\t%s", total, recent, sessions, last }
  ' "$history_file")
  IFS=$'\t' read -r total recent sessions last_row <<< "$history_stats"
  printf '  History: %s valid rows (%s recent / %s sessions)\n' "$total" "$recent" "$sessions"
  if [[ -n "${last_row:-}" ]]; then
    IFS=$'\t' read -r last_epoch _last_session last_draw last_capacity <<< "$last_row"
    printf '  Last recorded window: %s at %s (%s draw, %s capacity)\n' \
      "$(format_duration $((15 * 60)))" "$last_epoch" \
      "$(format_power "$last_draw")" "$(format_energy "$last_capacity")"
  else
    printf '  Last recorded window: none\n'
  fi
else
  printf '  History: no observations recorded\n'
fi
