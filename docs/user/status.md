# Check battery and model health

Use this guide when the panel looks wrong, `≈ Usual` is missing, or you want to
know whether battery intelligence is still learning.

## Run the concise report

From the repository checkout:

```sh
make status
```

A healthy discharging system looks like:

```text
BATTERY STATUS
────────────────────────────────────────
  Services: healthy
  BAT0: health 91% · 24.0 Wh · Discharging · draw 6.1 W
  BAT1: health 88% · 13.2 Wh
  Power: on battery · 1h 2m
  Energy: 10.1 Wh / 37.2 Wh · 27%
  Model: ready · 18 windows / 3 sessions · learned 4m ago
  Usual remaining: 1h 35m
  At full: 5h 48m
  Typical draw: 6.4 W
  Updated: 8s ago
```

`Usual remaining` answers how long the currently stored energy normally lasts.
`At full` is the same learned workload projected from full usable capacity.

The report prints one line for each present battery. The line gives the health
against the design capacity, the full-charge energy, and the live power flow
while current moves. The line name is the sysfs directory name, so a laptop
with other battery names shows those names.

## Read physical-battery state icons

Each physical battery has one state icon in its health row. The glyph shows the
battery state. The icon colour shows that battery's charge level.

| Condition | Glyph | Colour |
| --- | --- | --- |
| State is unknown, missing, or unsupported | Exclamation | Charge-level colour, or the theme foreground when the percentage is missing |
| Charging | Lightning | Charge-level colour |
| Discharging | Down arrow | Charge-level colour |
| Charge threshold holds the battery | Battery | Orange |
| Fully charged without a threshold hold | Battery | Green |
| Empty | Battery | Red |
| Any other known state | Battery | Charge-level colour |

The colour order is: empty or less than 10% is red; 10% through 19% is yellow;
a threshold hold is orange; full charge is green; all other levels use the
theme foreground colour. Red and the foreground colour follow the active
Omarchy theme. A threshold hold takes priority over full charge. Each battery
uses its own state, percentage, and threshold status.

## Follow the lifecycle state

### While learning

```text
Model: learning · 4/12 windows · 1/3 sessions
Current sample: 8m of 15m
```

Leave the tracker running across ordinary battery use. It needs 12 accepted
15-minute windows from 3 discharge sessions. Charging, suspend gaps, battery
changes, missing energy, and implausible measurements do not count.

### While charging

`If unplugged now` uses the energy currently stored. `At full` shows the
full-battery projection:

```text
Power: charging
If unplugged now: 3h
At full: 5h
```

A charge threshold appears as `plugged in · charge held`. At full charge the
report removes the duplicate projections and shows one `Usual runtime` line.

### When collection restarts

A short warning explains why the active 15-minute sample restarted or paused:

```text
Sampling: restarted · battery set changed
```

This does not discard earlier valid history.

## Respond to warnings

| Report state                                          | Meaning                                                                     | What to do                                                                                         |
| ----------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `Model: blocked · current battery energy unavailable` | Enough history exists, but the current battery cannot provide the numerator | Check `make status VERBOSE=1`; confirm every present battery exposes compatible energy data        |
| `Model: unavailable · unsupported history format`     | The history file is from an unknown schema                                  | Keep the file for diagnosis; do not edit it in place                                               |
| `Data: stale`                                         | The tracker has not refreshed state for over 90 seconds                     | Run `make install`, then inspect failed user services if the warning remains                       |
| `Data: clock mismatch`                                | The recorded update is in the future relative to the current clock          | Correct the clock and wait for a tracker poll                                                      |
| `Battery: not detected`                               | No present `BAT*` supply exists                                             | Reinsert a removable battery or verify `/sys/class/power_supply`                                   |
| An inactive service                                   | Collection or notifications are stopped                                     | Run `make install`; use verbose status and `systemctl --user status <unit>` if it remains inactive |

Cached runtime values are explicitly labelled `(cached)`; do not treat them as
live estimates.

## Inspect collection details

Keep the default report concise. Add diagnostics only when troubleshooting:

```sh
make status VERBOSE=1
```

Verbose mode adds the state-file location, retained/recent history counts, last
accepted model observation, active session/window, and battery-set fingerprint.
It still avoids serial numbers, model IDs, application names, and personal data.

For exhaustive field and state definitions, see the
[status output reference](../dev/status-output-reference.md). For installation
or service recovery, see [install and uninstall](install.md).
