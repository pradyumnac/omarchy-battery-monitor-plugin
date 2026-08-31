#!/usr/bin/env bash
# Verify every relative Markdown link resolves, and that every in-page anchor
# names a heading that exists. A broken cross-reference is invisible in review
# and only shows up when a reader follows it, so `make check` catches it here.
#
# External links (http, https, mailto) are not fetched; this script is offline
# and deterministic by design.

set -uo pipefail

cd -- "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)" || exit 1

failures=0

# GitHub's heading-to-anchor rule: lowercase, drop anything that is not a
# word character, space, or hyphen, then turn spaces into hyphens.
slugify() {
  local text=$1
  text=${text,,}
  text=$(printf '%s' "$text" | sed -E 's/`//g; s/[^a-z0-9 _-]//g')
  printf '%s' "${text// /-}"
}

# Collect the anchors a file offers, one per line.
anchors_of() {
  local file=$1 line slug
  local -A seen=()
  while IFS= read -r line; do
    line=$(printf '%s' "$line" | sed -E 's/^#{1,6}[[:space:]]+//')
    slug=$(slugify "$line")
    [[ -n $slug ]] || continue
    # Repeated headings get -1, -2, ... suffixes.
    if [[ -n ${seen[$slug]-} ]]; then
      printf '%s-%d\n' "$slug" "${seen[$slug]}"
      seen[$slug]=$((seen[$slug] + 1))
    else
      printf '%s\n' "$slug"
      seen[$slug]=1
    fi
  done < <(grep -E '^#{1,6} ' "$file" 2>/dev/null)
}

while IFS= read -r source; do
  while IFS= read -r target; do
    [[ -n $target ]] || continue
    case $target in
    http://* | https://* | mailto:*) continue ;;
    esac

    path=${target%%#*}
    anchor=${target#*#}
    [[ $target == *#* ]] || anchor=""

    if [[ -n $path ]]; then
      resolved="$(dirname -- "$source")/$path"
      if [[ ! -e $resolved ]]; then
        printf 'broken link: %s -> %s\n' "$source" "$target" >&2
        failures=$((failures + 1))
        continue
      fi
    else
      resolved=$source
    fi

    # Only Markdown targets carry headings worth checking.
    [[ -n $anchor && $resolved == *.md ]] || continue

    # Capture first: `grep -q` exits early, and under `pipefail` the SIGPIPE
    # it sends would otherwise look like a failed lookup.
    available=$(anchors_of "$resolved")
    if ! printf '%s\n' "$available" | grep -qxF "$anchor"; then
      printf 'broken anchor: %s -> %s\n' "$source" "$target" >&2
      failures=$((failures + 1))
    fi
  done < <(grep -oE '\]\([^)]+\)' "$source" | sed -E 's/^\]\(//; s/\)$//' | sed -E 's/ +"[^"]*"$//')
done < <(git ls-files '*.md')

if ((failures > 0)); then
  printf '%d broken documentation reference(s)\n' "$failures" >&2
  exit 1
fi

printf 'documentation links OK\n'
