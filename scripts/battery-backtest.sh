#!/usr/bin/env bash
# Score the runtime model against what actually happened, one battery at a time.
#
# docs/research/battery-runtime-modelling.md requires a measurable held-out
# improvement before any model change ships. This is the harness that produces
# that measurement. For each battery it walks that battery's own windows in
# order and, at each one, predicts the draw using only the windows before it —
# never the window itself — then scores each candidate estimator against what
# was actually measured.
#
# Scoring is per battery because the model is per battery: a cell's evidence
# describes its own capacity, age and discharge curve, and an estimator that
# suits a healthy cell may not suit a worn one. A single blended score would
# hide exactly that.
#
# Estimators scored:
#   median    the 30-day median of prior windows — what ships today
#   recent    the mean of the newest few windows — the "right now" estimate
#   ewma      an exponentially weighted moving average of prior windows
#   last      simply the previous window; the naive baseline to beat
#
# Draw is what the model predicts; runtime is that draw divided into the stored
# energy, so an error in draw is the whole error. Scoring draw keeps the
# harness independent of how full the battery happened to be.
#
# Usage: battery-backtest.sh [HISTORY_FILE]
# Exits 1 when no battery has enough history to hold anything out.

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
  printf 'There is nothing to score per battery. Collect windows on the\n' >&2
  printf 'current schema first.\n' >&2
  exit 1
fi

# Predictions only begin once a battery has at least this much of its own
# evidence, so no estimator is scored on almost nothing.
warmup=${BATTERY_BACKTEST_WARMUP:-$BATTERY_MODEL_PROVISIONAL_WINDOWS}

printf 'Backtest of %s\n\n' "$history_file"

mapfile -t battery_keys < <(
  awk -F '\t' '!/^#/ && $3 != "" && $4 ~ /^[1-9][0-9]*$/ { print $3 }' \
    "$history_file" | LC_ALL=C sort -u
)
if ((${#battery_keys[@]} == 0)); then
  printf 'No per-battery windows recorded yet.\n' >&2
  exit 1
fi

scored_any=0
for battery_key in "${battery_keys[@]}"; do
  # Draws for this battery, oldest first. Scoring itself lives in
  # battery-model.sh, so this report and the tracker's estimator selection can
  # never disagree about what "better" means.
  mapfile -t draws < <(
    awk -F '\t' -v want="$battery_key" \
      '!/^#/ && $1 ~ /^[0-9]+$/ && $3 == want && $4 ~ /^[1-9][0-9]*$/ { print $1 "\t" $4 }' \
      "$history_file" | LC_ALL=C sort -n -k1,1 | cut -f2
  )

  printf '  %s\n' "${battery_key//:/ · }"
  report=$(printf '%s\n' ${draws[@]+"${draws[@]}"} | battery_model_score_draws "$warmup")
  scored=$(awk -F '\t' '$1 == "median" { print $2 }' <<<"$report")
  scored=${scored:-0}
  printf '    %d window(s) · %d scored prediction(s) · warmup %d\n' \
    "${#draws[@]}" "$scored" "$warmup"

  if ((scored == 0)); then
    printf '    not enough of its own history to hold anything out yet\n\n'
    continue
  fi
  scored_any=1

  printf '    %-8s %8s %12s %12s %10s\n' ESTIMATOR SCORED "MEAN ERROR" "P50 ERROR" BIAS
  while IFS=$'\t' read -r name count mean p50 bias; do
    [[ -n $name ]] || continue
    printf '    %-8s %8s %9s mW %9s mW %7s mW\n' "$name" "$count" "$mean" "$p50" "$bias"
  done <<<"$report"

  # What the tracker would actually pick, so the report and the running model
  # cannot tell different stories.
  IFS=$'\t' read -r chosen chosen_scored chosen_mean < <(
    printf '%s\n' ${draws[@]+"${draws[@]}"} | battery_model_best_estimator
  )
  printf '    selected: %s' "$chosen"
  if [[ $chosen == "$BATTERY_MODEL_DEFAULT_ESTIMATOR" ]]; then
    printf ' (no challenger beat it by %s%%)\n\n' "$BATTERY_MODEL_ESTIMATOR_MARGIN_PERCENT"
  else
    printf ' (beats %s by at least %s%%)\n\n' \
      "$BATTERY_MODEL_DEFAULT_ESTIMATOR" "$BATTERY_MODEL_ESTIMATOR_MARGIN_PERCENT"
  fi
done

if ((scored_any == 0)); then
  printf 'No battery has enough history to hold anything out. Collect more\n' >&2
  printf 'windows first.\n' >&2
  exit 1
fi

printf 'A candidate estimator ships only when it beats "%s" on the held-out\n' "$BATTERY_MODEL_DEFAULT_ESTIMATOR"
printf 'windows of the battery it will run on. "last" is the naive baseline: an\n'
printf 'estimator that cannot beat it is not learning anything.\n'
