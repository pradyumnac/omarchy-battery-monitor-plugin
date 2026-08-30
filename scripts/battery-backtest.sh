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
  report=$(

    awk -F '\t' \
      -v want="$battery_key" \
      -v warmup="$warmup" \
    -v recent_windows="$BATTERY_MODEL_RECENT_WINDOWS" \
    -v lookback="$BATTERY_MODEL_LOOKBACK_SECONDS" '
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
    /^#/ { next }
    $1 ~ /^[0-9]+$/ && $3 == want && $4 ~ /^[1-9][0-9]*$/ {
      actual = $4 + 0
      epoch = $1 + 0
      rows++

      # Drop prior windows that this row would no longer look back to, so the
      # replay sees exactly the evidence the live model would have had.
      start = 1
      for (i = 1; i <= held; i++) {
        if (stamp[i] >= epoch - lookback) break
        start = i + 1
      }
      if (start > 1) {
        newheld = 0
        for (i = start; i <= held; i++) {
          newheld++
          window[newheld] = window[i]
          stamp[newheld] = stamp[i]
        }
        held = newheld
      }

      if (held >= warmup) {
        predicted_count++
        score("median", median(held), actual)
        score("recent", mean_of_last(held, recent_windows), actual)
        score("last", window[held], actual)
        if (ewma > 0) score("ewma", int(ewma + 0.5), actual)
      }

      held++
      window[held] = actual
      stamp[held] = epoch
      if (ewma == 0) ewma = actual
      else ewma = 0.3 * actual + 0.7 * ewma
    }
    END {
      printf "rows\t%d\n", rows
      printf "scored\t%d\n", predicted_count
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
    ' "$history_file"
  )

  rows=$(awk -F '\t' '$1 == "rows" { print $2 }' <<<"$report")
  scored=$(awk -F '\t' '$1 == "scored" { print $2 }' <<<"$report")

  printf '  %s\n' "${battery_key//:/ · }"
  printf '    %d window(s) · %d scored prediction(s) · warmup %d\n' \
    "$rows" "$scored" "$warmup"

  if ((scored == 0)); then
    printf '    not enough of its own history to hold anything out yet\n\n'
    continue
  fi
  scored_any=1

  printf '    %-8s %8s %12s %12s %10s\n' ESTIMATOR SCORED "MEAN ERROR" "P50 ERROR" BIAS
  while IFS=$'\t' read -r name count mean p50 bias; do
    case $name in
    rows | scored | "") continue ;;
    esac
    printf '    %-8s %8s %9s mW %9s mW %7s mW\n' "$name" "$count" "$mean" "$p50" "$bias"
  done <<<"$report"
  printf '\n'
done

if ((scored_any == 0)); then
  printf 'No battery has enough history to hold anything out. Collect more\n' >&2
  printf 'windows first.\n' >&2
  exit 1
fi

printf 'A candidate estimator ships only when it beats "median" on mean and p50\n'
printf 'error for the batteries it will run on. "last" is the naive baseline: an\n'
printf 'estimator that cannot beat it is not learning anything.\n'
