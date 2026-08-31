# Check battery and model health

Audience: anyone running the plugin.

Use this guide when the panel looks wrong, `≈ Usual` is missing, or you want to
know whether the model is still learning. For why the model behaves this way,
read [how the battery model works](concepts.md).

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
  BAT0: LGC 01AV420 · SN 1020
      Battery          72% · 8.7 Wh / 12.1 Wh · health 50% · Discharging · draw 6.1 W
      Model            ready · 18 windows / 3 sessions
      Typical draw     6.4 W
      From this level  1h 25m
      At full          1h 58m
      Range            1h 12m – 1h 41m · p25–p75
      Current sample   40% · 6m of 15m
  BAT1: SMP 01AV425 · SN 783
      Battery          88% · 22.9 Wh / 26.0 Wh · health 52% · Not charging
      Model            ready · 21 windows / 4 sessions
      Typical draw     6.2 W
      From this level  3h 41m
      At full          4h 11m
  Power: on battery · 1h 2m
  Energy: 31.6 Wh / 38.1 Wh · 82%
  Pack model: ready · learned 4m ago
  Pack remaining: 5h 6m
  At full: 6h 9m
  Updated: 8s ago
```

The report prints one **block per battery**, opening with that cell's identity:
vendor, model, and serial. Everything under it belongs to that battery alone.

- `Battery` is its current charge and energy, its health against design
  capacity, its sysfs status, and the live power flow while current moves.
- `Model` is how much of its *own* evidence it has gathered.
- `From this level` answers how long that battery normally lasts from where it
  is now; `At full` projects the same workload from its full charge.
- `Current sample` appears only on the battery actually discharging, because
  that is the one being measured.

`Pack remaining` below is the sum of the per-battery figures. See
[why the pack figure is a sum](concepts.md#why-the-pack-figure-is-a-sum).

The block name is the sysfs directory name, so a laptop with other battery
names shows those names.

## Understand `Typical draw`

The estimator named beside the draw is the one currently measuring best for
that battery, chosen by scoring candidates against its own held-out windows.
When no candidate clearly beats the default, none is named. Run `make backtest`
to see the scores behind the choice.

## Follow the lifecycle state

Each battery reaches these states on its own evidence, so the two blocks can
sit at different states at the same time.

### While learning

```text
      Model            learning · 3/12 windows · 1/3 sessions
      Current sample   53% · 8m of 15m
```

Leave the tracker running across ordinary battery use. Charging, suspend gaps,
battery swaps, missing energy, and implausible measurements do not count.

After 4 accepted windows a battery starts offering a rough answer and says so:

```text
      Model            provisional · 5 windows / 1 sessions
      From this level  3h 48m
```

It reaches `ready` at 12 accepted 15-minute windows from 3 discharge sessions.

### Reading the range

```text
      From this level  3h 48m
      Range            3h 20m – 4h 15m · p25–p75
```

`From this level` is the typical answer for that battery. `Range` says how
wrong it can be. See [why the estimate has a range](concepts.md#why-the-estimate-has-a-range).

### While charging

`If unplugged now` uses the energy currently stored. `At full` shows the
full-battery projection:

```text
Power: charging
If unplugged now: 3h
At full: 5h
```

A charge threshold appears as `plugged in · charge held`, and the battery
holding at its cap says `held at 90%` on its own line. A battery that reports
`Not charging` merely because it is not its turn to charge is **not** reported
as held. At full charge the report removes the duplicate projections and shows
one `Pack runtime` line.

### When collection restarts

A short warning explains why a battery's active 15-minute sample most
recently restarted:

```text
Sampling: restarted · machine was suspended
```

The interrupted window stays on file and never counts as evidence. Earlier
valid history is untouched. The reason names what happened to the machine:

| Reason | Meaning |
| --- | --- |
| `machine was off (shutdown, reboot, or hibernate)` | A reboot happened between polls |
| `machine was suspended` | The machine slept and resumed |
| `the tracker was not running` | The machine stayed awake, but the collection service was down |
| `the system clock changed` | The clock jumped backward beyond ordinary drift |

Each battery reports its own most recent interruption, inside its own block.
A suspend affects every battery at once, so both blocks can show the same
reason. The report does not collapse them, because each battery's evidence is
tracked on its own.

## Respond to warnings

| Report state                                          | Meaning                                                                     | What to do                                                                                         |
| ----------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `Model: blocked · this battery reports no capacity`   | Enough history exists, but that cell cannot provide the numerator            | Check `make status VERBOSE=1`; confirm the battery exposes compatible energy data                  |
| `Model: unavailable · unsupported history format`     | `windows.tsv` is from an unknown schema                                     | Keep the file for diagnosis; do not edit it in place. `make reextract FORCE=1` rebuilds it from raw |
| `Ineligible windows: N window(s) spanned an interruption` | A gap fell inside a discharge window while it was open                  | Nothing; the window is kept for diagnosis but never counted as evidence                            |
| `Data: stale`                                         | The tracker has not refreshed state for several poll intervals              | Run `make install`, then inspect failed user services if the warning remains                       |
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

Verbose mode adds the state-file location, the view and state schema versions,
retained/recent/future window counts, the last accepted model observation, and
the battery fingerprint and set key. Each battery's own open sampling window
is already shown in its block above (`Current sample`), not repeated here.

Battery identity — vendor, model, and serial — is recorded, because evidence
has to be anchored to the cell that produced it and capacity is not identity.
It stays in your own state directory (`raw/<battery-key>/`, `windows.tsv`,
`gaps.tsv`, `battery-state.tsv`) and is never transmitted; anything that
later shares it must ask first. Application names and other personal data are
still never collected.

For exhaustive field and state definitions, see the
[status output reference](../dev/status-output-reference.md). For installation
or service recovery, see [install and uninstall](install.md).
