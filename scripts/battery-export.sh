#!/usr/bin/env bash
# Export the discharge history as CSV, for analysis outside this repo.
#
# The history is a tab-separated file with a schema-versioned header, which is
# right for a shell tool reading it on every panel refresh and wrong for a
# notebook. This writes a plain CSV with a header row, one record per battery
# per window, so `pandas.read_csv()` needs no arguments:
#
#     import pandas as pd
#     df = pd.read_csv("battery-history.csv", parse_dates=["timestamp"])
#     df.groupby("battery_key").draw_mw.describe()
#
# Identity is split into its own columns rather than left as one opaque key, so
# a notebook can group by vendor, model or serial without parsing strings.
#
# Usage: battery-export.sh [HISTORY_FILE] > battery-history.csv

set -uo pipefail

service_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../service" && pwd -P)"
# shellcheck source=../service/battery-model.sh
source "$service_dir/battery-model.sh"

state_dir="${BATTERY_SESSION_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/battery-session}"
history_file="${1:-$state_dir/discharge-history.tsv}"

if [[ ! -f "$history_file" ]]; then
  printf 'No discharge history at %s.\n' "$history_file" >&2
  exit 1
fi
history_format=$(battery_model_history_format "$history_file")
if ((history_format == 0)); then
  printf 'Unsupported history format at %s.\n' "$history_file" >&2
  exit 1
fi
if ((history_format < 3)); then
  printf 'History at %s predates per-battery records (schema v%s).\n' \
    "$history_file" "$history_format" >&2
  exit 1
fi

awk -F '\t' '
  function csv(value) {
    # Quote unconditionally and double any embedded quote: model names are
    # vendor strings and nothing guarantees they are comma free.
    gsub(/"/, "\"\"", value)
    return "\"" value "\""
  }
  BEGIN {
    OFS = ","
    print "timestamp", "epoch", "session_id", "battery_key", "battery_name",
      "vendor", "model", "serial", "draw_mw", "energy_now_uwh",
      "energy_full_uwh", "energy_full_design_uwh", "voltage_now_uv",
      "power_now_uw", "capacity_percent", "cycle_count", "status",
      "health_percent", "energy_now_wh", "energy_full_wh", "draw_w"
  }
  /^#/ { next }
  $1 ~ /^[0-9]+$/ && $3 != "" && $4 ~ /^[1-9][0-9]*$/ {
    split($3, identity, ":")
    health = ($7 > 0) ? ($6 * 100.0 / $7) : ""
    print strftime("%Y-%m-%dT%H:%M:%S", $1), $1, csv($2), csv($3),
      csv(identity[1]), csv(identity[2]), csv(identity[3]), csv(identity[4]),
      $4, $5, $6, $7, $8, $9, $10, $11, csv($12),
      health, ($5 / 1000000.0), ($6 / 1000000.0), ($4 / 1000.0)
  }
' "$history_file"
