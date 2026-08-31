#!/usr/bin/env bash
# Export every tier of collected battery data as one zip archive, for
# analysis outside this repo (ADR-0001).
#
# The archive holds each tier as its own file rather than one joined table,
# because joining forces a grain (per poll? per window?) that would discard
# the others — a notebook can join on its own terms:
#
#     import pandas as pd, zipfile, json
#     z = zipfile.ZipFile("battery-export-host-user-20260101T000000Z.zip")
#     windows = pd.read_csv(z.open("windows.csv"))
#     manifest = json.load(z.open("manifest.json"))
#
# No filtering: every raw file, every derived file, always. The export exists
# so nothing has to be decided about what might matter before looking at it.
#
# Usage: battery-export.sh [DEST_DIR]
# Default destination: ~/Downloads

set -uo pipefail

service_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../service" && pwd -P)"
# shellcheck source=../service/battery-model.sh
source "$service_dir/battery-model.sh"

state_dir="${BATTERY_SESSION_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/battery-session}"
dest_dir="${1:-${BATTERY_EXPORT_DEST:-$HOME/Downloads}}"

zip_command="${BATTERY_SESSION_ZIP_COMMAND:-zip}"
command -v -- "$zip_command" >/dev/null 2>&1 || {
  printf '%s not found; it is required to write the export archive.\n' "$zip_command" >&2
  exit 1
}

[[ -d "$state_dir" ]] || {
  printf 'No battery data at %s.\n' "$state_dir" >&2
  exit 1
}
mkdir -p "$dest_dir" || {
  printf 'Cannot write to %s.\n' "$dest_dir" >&2
  exit 1
}

# csv_from_windows FILE — the ADR-0001 windows.tsv as CSV, identity split
# into its own columns so a notebook can group by vendor/model/serial without
# parsing the key string.
csv_from_windows() {
  awk -F '\t' '
    function csv(value) {
      gsub(/"/, "\"\"", value)
      return "\"" value "\""
    }
    BEGIN {
      OFS = ","
      print "timestamp", "epoch", "session_epoch", "battery_key", "vendor",
        "model", "serial", "draw_mw", "energy_now_uwh", "energy_full_uwh",
        "energy_full_design_uwh", "voltage_now_uv", "power_now_uw",
        "capacity_percent", "cycle_count", "eligible", "health_percent",
        "energy_now_wh", "energy_full_wh", "draw_w"
    }
    /^#/ { next }
    NF < 12 { next }
    {
      split($3, identity, ":")
      health = ($7 > 0) ? ($6 * 100.0 / $7) : ""
      print strftime("%Y-%m-%dT%H:%M:%S", $1), $1, $2, csv($3),
        csv(identity[2]), csv(identity[3]), csv(identity[4]),
        $4, $5, $6, $7, $8, $9, $10, $11, $12,
        health, ($5 / 1000000.0), ($6 / 1000000.0), ($4 / 1000.0)
    }
  ' "$1"
}

# csv_from_gaps FILE — one row per recorded interruption.
csv_from_gaps() {
  awk -F '\t' '
    function csv(value) { gsub(/"/, "\"\"", value); return "\"" value "\"" }
    BEGIN {
      OFS = ","
      print "battery_key", "start_epoch", "end_epoch", "cause",
        "ac_online_start", "ac_online_end", "energy_before_uwh",
        "energy_after_uwh", "energy_delta_uwh", "duration_seconds"
    }
    /^#/ { next }
    NF < 9 { next }
    { print csv($1), $2, $3, csv($4), $5, $6, $7, $8, $9, ($3 - $2) }
  ' "$1"
}

# csv_from_raw FILE — one poll or transition observation.
csv_from_raw() {
  awk -F '\t' '
    function csv(value) { gsub(/"/, "\"\"", value); return "\"" value "\"" }
    BEGIN {
      OFS = ","
      print "timestamp", "epoch", "trigger", "rules", "status",
        "energy_now_uwh", "energy_full_uwh", "energy_full_design_uwh",
        "voltage_now_uv", "power_now_uw", "capacity_percent", "cycle_count",
        "end_threshold_percent", "ac_online", "boot_id", "suspend_count",
        "uptime_seconds"
    }
    /^#/ { next }
    NF < 15 { next }
    {
      print strftime("%Y-%m-%dT%H:%M:%S", $1), $1, csv($2), csv($3), csv($4),
        $5, $6, $7, $8, $9, $10, $11, $12, ($13 == 1 ? "true" : "false"),
        csv($14), $15, $16
    }
  ' "$1"
}

work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT

file_count=0

if [[ -f "$state_dir/windows.tsv" ]]; then
  csv_from_windows "$state_dir/windows.tsv" >"$work/windows.csv"
  file_count=$((file_count + 1))
fi
if [[ -f "$state_dir/gaps.tsv" ]]; then
  csv_from_gaps "$state_dir/gaps.tsv" >"$work/gaps.csv"
  file_count=$((file_count + 1))
fi
if [[ -f "$state_dir/battery-state.tsv" ]]; then
  cp -- "$state_dir/battery-state.tsv" "$work/battery-state.tsv"
  file_count=$((file_count + 1))
fi

if [[ -d "$state_dir/raw" ]]; then
  mkdir -p "$work/raw"
  for battery_dir in "$state_dir/raw"/*/; do
    [[ -d "$battery_dir" ]] || continue
    battery_name=${battery_dir%/}
    battery_name=${battery_name##*/}
    out_dir="$work/raw/$battery_name"
    mkdir -p "$out_dir"
    for day_file in "$battery_dir"*.tsv; do
      [[ -f "$day_file" ]] || continue
      csv_from_raw "$day_file" >"$out_dir/$(basename "$day_file" .tsv).csv"
      file_count=$((file_count + 1))
    done
  done
fi

((file_count > 0)) || {
  printf 'No exportable data at %s.\n' "$state_dir" >&2
  exit 1
}

now_utc=$(date -u +%Y%m%dT%H%M%SZ)
host=$(hostname 2>/dev/null || printf 'unknown-host')
account=$(id -un 2>/dev/null || printf 'unknown-user')
archive_name="battery-export-${host}-${account}-${now_utc}.zip"
archive_path="$dest_dir/$archive_name"

cat >"$work/manifest.json" <<EOF
{
  "generated_at_utc": "$now_utc",
  "host": "$host",
  "user": "$account",
  "raw_format": "$BATTERY_RAW_FORMAT",
  "windows_format": "$BATTERY_WINDOWS_FORMAT",
  "gaps_format": "$BATTERY_GAPS_FORMAT",
  "battery_state_format": "$BATTERY_STATE_TIER_FORMAT",
  "recording_rules_version": "$BATTERY_RECORDING_RULES_VERSION",
  "source_state_dir": "$state_dir"
}
EOF

(cd "$work" && "$zip_command" -qr "$archive_path" .)
printf 'Wrote %s\n' "$archive_path"
