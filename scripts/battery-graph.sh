#!/usr/bin/env bash
# Plot collected battery data (ADR-0001, tier 1).
#
#   charge  capacity over time, with the power events that explain its shape
#           (plug, unplug, sleep, shutdown, blind time, clock jump) and the
#           power profile and system load in force underneath it.
#   health  energy_full against energy_full_design over time, drawn as steps
#           because firmware moves that number in recalibration jumps.
#
# Both metrics get the same layout and the same rails, so the two charts read
# side by side without relearning anything.
#
# The raw tier is the only source. Nothing here reads windows.tsv, whose rows
# are filtered to eligible discharge evidence — a chart that hid the
# ineligible parts would hide exactly the interruptions the chart is for.
#
# The renderer emits SVG. Displaying it in a terminal needs rsvg-convert and
# chafa, which are OPTIONAL: `--format svg` writes the document with no
# dependency beyond awk, and this script refuses with a plain message rather
# than degrading silently when the viewer is asked for and is not installed.
#
# Usage: battery-graph.sh --metric charge|health [options]
#   --days N        how far back to plot (default: 1 for charge, 365 health)
#   --battery NAME  restrict to one battery (matches BAT0, or a full key)
#   --format F      terminal (default) | svg | png
#   --out PATH      where to write, for --format svg|png
#   --theme T       dark (default) | light
#   --width N       document width in pixels (default 1240)
set -uo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
service_dir="$(cd -- "$script_dir/../service" && pwd -P)"
renderer="$script_dir/battery-graph.awk"
# shellcheck source=../service/battery-model.sh
source "$service_dir/battery-model.sh"

state_dir="${BATTERY_SESSION_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/battery-session}"
rsvg_command="${BATTERY_GRAPH_RSVG_COMMAND:-rsvg-convert}"
chafa_command="${BATTERY_GRAPH_CHAFA_COMMAND:-chafa}"

metric=""; days=""; battery_filter=""; format="terminal"; out=""; width=1240
theme="${BATTERY_GRAPH_THEME:-dark}"

while (($# > 0)); do
  case $1 in
  --metric) metric=${2-}; shift 2 ;;
  --days) days=${2-}; shift 2 ;;
  --battery) battery_filter=${2-}; shift 2 ;;
  --format) format=${2-}; shift 2 ;;
  --out) out=${2-}; shift 2 ;;
  --theme) theme=${2-}; shift 2 ;;
  --width) width=${2-}; shift 2 ;;
  -h | --help) sed -n '2,28p' -- "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) printf 'Unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
done

case $metric in
charge | health) ;;
*) printf 'Usage: %s --metric charge|health [--days N] [--battery NAME] [--format terminal|svg|png]\n' "${0##*/}" >&2; exit 2 ;;
esac
case $format in
terminal | svg | png) ;;
*) printf 'Unknown format "%s"; expected terminal, svg, or png.\n' "$format" >&2; exit 2 ;;
esac
case $theme in dark | light) ;; *) theme=dark ;; esac
[[ $width =~ ^[0-9]+$ ]] && ((width >= 400 && width <= 4000)) || width=1240
[[ $days =~ ^[0-9]+$ ]] && ((days > 0)) || days=$([[ $metric == charge ]] && echo 1 || echo 365)

# Missing viewer tools are a refusal, not a silent downgrade: a chart that
# quietly turned into something else would be worse than being told plainly
# which package to install. `--format svg` needs neither and is named here so
# the message always carries a way forward.
require_viewer() {
  local missing=()
  command -v -- "$rsvg_command" >/dev/null 2>&1 || missing+=("$rsvg_command (package: librsvg)")
  if [[ $format == terminal ]]; then
    command -v -- "$chafa_command" >/dev/null 2>&1 || missing+=("$chafa_command (package: chafa)")
  fi
  ((${#missing[@]} == 0)) && return 0
  {
    printf 'Cannot render this chart. Missing:\n'
    printf '  - %s\n' "${missing[@]}"
    printf '\nThese are optional dependencies, needed only to view a chart here.\n'
    printf 'Install them, or write the document instead and open it anywhere:\n'
    printf '  make graph-%s FORMAT=svg\n' "$metric"
    printf '\n`make doctor` reports the whole graph toolchain.\n'
  } >&2
  exit 1
}
[[ $format == svg ]] || require_viewer

[[ -d "$state_dir/raw" ]] || {
  printf 'No raw observations at %s.\n' "$state_dir/raw" >&2
  printf 'Run `make status` to check the tracker is installed and running.\n' >&2
  exit 1
}

now=$(printf '%(%s)T' -1)
since=$((now - days * 86400))

# The raw day files that can hold rows at or after `since`. The filename is a
# local date, so one extra day on the low side covers a file whose early rows
# fall before the cutoff and whose later rows do not.
raw_files_for() {
  local dir=$1 first_date file name
  printf -v first_date '%(%Y-%m-%d)T' $((since - 86400))
  while IFS= read -r file; do
    name=${file##*/}; name=${name%.tsv}
    [[ $name > $first_date || $name == "$first_date" ]] && printf '%s\n' "$file"
  done < <(find "$dir" -maxdepth 1 -name '*.tsv' -print 2>/dev/null | sort)
}

matches_filter() {
  [[ -z $battery_filter ]] && return 0
  [[ $1 == "$battery_filter" || ${1%%:*} == "$battery_filter" ]]
}

battery_dirs=()
for dir in "$state_dir/raw"/*/; do
  [[ -d $dir ]] || continue
  key=${dir%/}; key=${key##*/}
  matches_filter "$key" && battery_dirs+=("$dir")
done
((${#battery_dirs[@]} > 0)) || {
  if [[ -n $battery_filter ]]; then
    printf 'No recorded battery matches "%s".\n' "$battery_filter" >&2
  else
    printf 'No recorded batteries under %s.\n' "$state_dir/raw" >&2
  fi
  exit 1
}

gaps_file="$state_dir/gaps.tsv"
[[ -f $gaps_file ]] || gaps_file=/dev/null

work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT

# Where a written document lands. `--out` naming one file only makes sense
# for one chart, and this machine has two batteries, so a single path with
# several batteries to draw resolves to that path's directory instead of
# every chart overwriting the last one.
single=$(( ${#battery_dirs[@]} == 1 ))
out_dir=$PWD
out_file=""
if [[ -n $out ]]; then
  if [[ -d $out ]]; then
    out_dir=$out
  elif ((single == 1)); then
    out_dir=$(dirname -- "$out"); out_file=$out
  else
    out_dir=$(dirname -- "$out")
    printf 'Plotting %d batteries; writing into %s rather than the single path %s.\n' \
      "${#battery_dirs[@]}" "$out_dir" "$out" >&2
  fi
fi
[[ -d $out_dir ]] || mkdir -p "$out_dir" || exit 1

plotted=0
failed=0
for dir in "${battery_dirs[@]}"; do
  key=${dir%/}; key=${key##*/}
  mapfile -t files < <(raw_files_for "$dir")
  ((${#files[@]} > 0)) || continue

  svg="$work/${key//[^A-Za-z0-9._-]/-}-$metric.svg"
  cat -- "${files[@]}" 2>/dev/null |
    gawk -v metric="$metric" -v key="$key" -v since="$since" -v now="$now" \
      -v gaps_file="$gaps_file" -v theme="$theme" \
      -v max_gap="$BATTERY_MODEL_MAX_POLL_GAP_SECONDS" \
      -f "$renderer" >"$svg"
  render_status=$?
  # A renderer that dies part way still leaves a file behind, and a truncated
  # SVG renders as a plausible-looking chart with pieces silently missing.
  # Nothing is reported as written unless the document is whole.
  if ((render_status != 0)) || ! tail -c 16 -- "$svg" 2>/dev/null | grep -q '</svg>'; then
    printf 'Renderer failed for %s; no chart written.\n' "$key" >&2
    failed=$((failed + 1))
    continue
  fi

  case $format in
  svg)
    dest=${out_file:-"$out_dir/$(basename -- "$svg")"}
    cp -- "$svg" "$dest" && printf 'Wrote %s\n' "$dest"
    ;;
  png)
    dest=${out_file:-"$out_dir/$(basename -- "${svg%.svg}.png")"}
    "$rsvg_command" -w "$width" -o "$dest" "$svg" && printf 'Wrote %s\n' "$dest"
    ;;
  terminal)
    png="${svg%.svg}.png"
    "$rsvg_command" -w "$width" -o "$png" "$svg" || continue
    # chafa picks the best target the terminal actually supports — kitty
    # graphics, sixel, iTerm2 — and falls back to Unicode block art when it
    # supports none. One command covers every terminal this plugin runs in.
    "$chafa_command" --size "${COLUMNS:-100}x" -- "$png"
    ;;
  esac
  plotted=$((plotted + 1))
done

((failed == 0)) || exit 1
((plotted > 0)) || {
  printf 'No observations in the last %d day(s).\n' "$days" >&2
  exit 1
}
