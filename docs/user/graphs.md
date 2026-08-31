# Plot battery charge and health

Audience: anyone running the plugin.

Use this guide to draw what the tracker has recorded. Two charts are
available, and both read the raw observations only. For what the tracker
records, read [how the battery model works](concepts.md).

## Draw a chart

From the repository checkout:

```sh
make graph-charge
make graph-health
```

`make graph-charge` draws capacity over time. `make graph-health` draws
reported capacity against design capacity over time.

Each command draws one chart for each battery. A machine with two packs
gets two charts.

## What each chart shows

Both charts use the same layout, so you can read them side by side.

| Part | Meaning |
| --- | --- |
| Line | The measured series. On the charge chart, green is charging, amber is discharging, and blue is holding at the charge limit |
| Dashed marker | A power event: `plug`, `unplug`, `asleep`, `off`, `blind`, or `clock` |
| Shaded block | A span the tracker did not observe. See [gaps](#gaps-and-blind-time) |
| `profile` rail | The power profile in force |
| `load` rail | The 1-minute system load |
| Footer | The current value, the range, and the time on battery against the time plugged in |

The charge chart answers "why did the battery go down that fast". The
`profile` and `load` rails sit under the same time axis, so a steep fall
lines up with the profile and the load that caused it.

## Choose what to draw

| Option | Effect | Default |
| --- | --- | --- |
| `DAYS=n` | Plot the last `n` days | `1` for charge, `365` for health |
| `BATTERY=name` | Plot one battery. Accepts `BAT0` or a full key | every battery |
| `FORMAT=f` | `terminal`, `svg`, or `png` | `terminal` |
| `OUT=path` | Write to this file or directory | the current directory |
| `THEME=t` | `dark` or `light` | `dark` |

```sh
make graph-charge DAYS=7
make graph-charge BATTERY=BAT0
make graph-health DAYS=180 FORMAT=svg OUT=~/battery-health.svg
```

## Health needs months, not hours

Health moves in steps. The firmware recalculates the reported capacity every
few weeks, so the value holds still and then jumps.

The chart states this. A span under 14 days carries a note that says the data
is too short to show a trend. The vertical axis spans at least 10 points, so a
0.1-point move draws as the flat line it is.

The raw files keep every observation and are never pruned. The chart fills in
on its own as the tracker runs.

## Gaps and blind time

A shaded block marks a span the tracker did not observe. The cause comes from
`gaps.tsv`:

| Cause | Meaning |
| --- | --- |
| `off` | A shutdown, a reboot, or a hibernate |
| `asleep` | A suspend |
| `blind` | The machine was awake and the tracker was not running |
| `clock` | The clock moved backwards |

The line stops at a shaded block. Nothing is drawn across a span the tracker
did not measure.

## Install the optional tools

The chart is drawn as SVG, which needs `awk` alone. To show that SVG in this
terminal, two more packages are needed:

```sh
sudo pacman -S librsvg chafa
```

Neither package is a hard requirement. `make doctor` reports both, and reports
whether this terminal can show an image:

```sh
make doctor
```

`chafa` picks the best format the terminal accepts. Ghostty and Kitty show a
true image. Foot shows a sixel image. Alacritty has no image support, so
`chafa` falls back to block characters.

If a package is missing, `make graph-charge` refuses and names it. To draw a
chart without either package, write the document instead:

```sh
make graph-charge FORMAT=svg
```

Open the result in a browser or an image viewer.

## The rails start when you upgrade

The `profile` and `load` rails read two columns that arrived in raw format
v0.2.0. A row recorded before that upgrade never held them, so both rails read
`not recorded before raw format v0.2.0` for older data.

Run `make install` to record the new columns. The rails start at the first
poll after the upgrade.
