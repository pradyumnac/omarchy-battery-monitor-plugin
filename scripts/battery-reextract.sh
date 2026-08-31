#!/usr/bin/env bash
# Rebuild windows.tsv, gaps.tsv, and battery-state.tsv from raw observations.
#
# The tracker already derives these incrementally, one poll at a time, using
# the exact same extraction function this script calls in batch. Running both
# and diffing is the standing proof the two paths agree — the failure mode
# this exists to catch is a second implementation quietly drifting from the
# first, which is exactly how two earlier bugs in this project shipped.
#
# Default: regenerate to temporary files and diff against the live ones,
# reporting any difference without touching anything. --force replaces the
# live files with the regenerated ones.
#
# Usage: battery-reextract.sh [--force]

set -uo pipefail

service_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../service" && pwd -P)"
# shellcheck source=../service/battery-model.sh
source "$service_dir/battery-model.sh"

force=0
case ${1-} in
"") ;;
--force) force=1 ;;
*)
  printf 'Usage: %s [--force]\n' "${0##*/}" >&2
  exit 2
  ;;
esac

state_dir="${BATTERY_SESSION_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/battery-session}"
raw_root="$state_dir/raw"
now=${BATTERY_REEXTRACT_NOW:-$(date +%s)}

[[ -d "$raw_root" ]] || {
  printf 'No raw observations at %s. Nothing to extract.\n' "$raw_root" >&2
  exit 1
}

work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
: >"$work/windows.tsv.body"
: >"$work/gaps.tsv.body"
: >"$work/battery-state.tsv"
printf '%s\n' "$BATTERY_STATE_TIER_HEADER" >>"$work/battery-state.tsv"

battery_count=0
for battery_dir in "$raw_root"/*/; do
  [[ -d "$battery_dir" ]] || continue
  battery_count=$((battery_count + 1))
  # A raw row carries no identity column of its own — identity is the
  # directory, not a field, exactly as append_raw_row writes it. The
  # directory name IS the key verbatim except for the one character
  # battery_raw_dir_name() replaces (/), which essentially never appears in
  # a real vendor/model/serial string.
  key=${battery_dir%/}
  key=${key##*/}
  [[ -n "$key" ]] || continue

  tmp_gaps="$work/.gaps.$$"
  tmp_open="$work/.open.$$"
  : >"$tmp_gaps"

  # Every raw file for this battery, oldest date first (filenames are
  # YYYY-MM-DD, so a plain sort is chronological), concatenated and stripped
  # of headers — the extractor reads a plain row stream.
  windows=$(
    find "$battery_dir" -maxdepth 1 -name '*.tsv' | sort |
      xargs cat 2>/dev/null | grep -v '^#' |
      battery_extract_windows "$key" "$tmp_gaps" "$tmp_open"
  )
  [[ -n "$windows" ]] && printf '%s\n' "$windows" >>"$work/windows.tsv.body"
  [[ -s "$tmp_gaps" ]] && cat "$tmp_gaps" >>"$work/gaps.tsv.body"

  # Rescore against the freshly extracted windows for this battery.
  estimator="$BATTERY_MODEL_DEFAULT_ESTIMATOR"; scored=0; error=0
  selection=$(
    awk -F '\t' -v k="$key" '$3==k && $12==1 { print $4 }' "$work/windows.tsv.body" |
      battery_model_best_estimator
  )
  IFS=$'\t' read -r estimator scored error <<<"$selection"
  estimator=${estimator:-$BATTERY_MODEL_DEFAULT_ESTIMATOR}
  open_epoch=0 open_energy=0
  [[ -f "$tmp_open" ]] && IFS=$'\t' read -r open_epoch open_energy _ <"$tmp_open"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$key" "${open_epoch:-0}" "${open_energy:-0}" "$estimator" "${scored:-0}" "${error:-0}" "$now" \
    >>"$work/battery-state.tsv"
  rm -f -- "$tmp_gaps" "$tmp_open"
done

((battery_count > 0)) || {
  printf 'No per-battery raw directories under %s.\n' "$raw_root" >&2
  exit 1
}

{
  printf '%s\n' "$BATTERY_WINDOWS_HEADER"
  sort -n -k1,1 -- "$work/windows.tsv.body"
} >"$work/windows.tsv"
{
  printf '%s\n' "$BATTERY_GAPS_HEADER"
  sort -t $'\t' -k2,2n -- "$work/gaps.tsv.body"
} >"$work/gaps.tsv"

# What the comparison must ignore, and why each is not a disagreement about
# the data:
#
#   updated_epoch  A wall-clock stamp taken when the row is written. The live
#                  file was stamped by the tracker and the regenerated one by
#                  this run, so it differs on every run by construction.
#   row order      This script emits one row per raw directory in iteration
#                  order; the tracker emits them in its own. battery-state.tsv
#                  holds one row per battery and no reader depends on their
#                  order.
#
# Both differ on every single run, so comparing raw bytes made this check cry
# wolf every time and masked the drift it exists to catch. Only
# battery-state.tsv needs this: windows.tsv and gaps.tsv are already sorted
# deterministically above and carry no wall-clock column.
#
# This normalizes the COMPARISON only. --force still writes the file whole.
comparable() {
  local name=$1 file=$2
  case $name in
  battery-state.tsv)
    head -n 1 -- "$file"
    tail -n +2 -- "$file" | cut -f1-6 | sort
    ;;
  *) cat -- "$file" ;;
  esac
}

changed=0
for name in windows.tsv gaps.tsv battery-state.tsv; do
  live="$state_dir/$name"
  fresh="$work/$name"
  if [[ ! -f "$live" ]]; then
    [[ -s "$fresh" ]] && [[ $(wc -l <"$fresh") -gt 1 ]] && {
      printf '%s: would be created (%d rows)\n' "$name" "$(($(wc -l <"$fresh") - 1))"
      changed=1
    }
    continue
  fi
  comparable "$name" "$live" >"$work/.live.$name"
  comparable "$name" "$fresh" >"$work/.fresh.$name"
  if ! diff -q "$work/.live.$name" "$work/.fresh.$name" >/dev/null 2>&1; then
    printf '%s: differs from the live file\n' "$name"
    diff -u --label "$name (live)" --label "$name (regenerated)" \
      "$work/.live.$name" "$work/.fresh.$name" | head -n 20
    changed=1
  fi
done

if ((changed == 0)); then
  printf 'No difference: the incremental and batch extraction agree.\n'
  exit 0
fi

if ((force == 1)); then
  umask 077
  for name in windows.tsv gaps.tsv battery-state.tsv; do
    [[ -f "$work/$name" ]] && cp -- "$work/$name" "$state_dir/$name"
  done
  printf 'Replaced windows.tsv, gaps.tsv, and battery-state.tsv from raw observations.\n'
else
  printf '\nDifferences found. Re-run with --force to replace the live files.\n' >&2
  exit 1
fi
