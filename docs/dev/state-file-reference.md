# State file reference

Audience: contributors reading or writing tracker-collected data.

Since [ADR-0001](../adr/0001-raw-observation-tier.md), this data spans four
files with different jobs. `state` is the one thing that is not a cache;
everything else is derived from raw observations and can be rebuilt with
`make reextract`.

## Location

```text
${XDG_STATE_HOME:-$HOME/.local/state}/battery-session/
├── state                    session bookkeeping — not derivable, never a cache
├── raw/<battery-key>/       tier 1 — one file per battery per local day
│   └── YYYY-MM-DD.tsv         append-only, never edited or pruned
├── windows.tsv               tier 2 — derived discharge windows
├── gaps.tsv                  tier 2 — derived interruptions
└── battery-state.tsv         tier 3 — open-window state and selected estimator
```

`battery-session-tracker.sh` writes all of these. `battery-session-monitor.sh`
triggers a write on power events. Nothing else reads any of them directly:
consumers read the [aggregated view](view-reference.md), which these files
feed.

## `state`: session bookkeeping

This file holds session bookkeeping only. It holds no derived model value,
because the view recomputes each one from `raw/` and `battery-state.tsv` on
every read. A second, staler copy on disk can only disagree with the first.

`state_schema_version` names the format. A version-1 file carries no such key
and still reads without complaint. The view ignores the extra fields a version-1
file carries. No migration step is needed.

### Fields

| Field | Meaning | Used for |
| --- | --- | --- |
| `state_schema_version` | Format of this file (currently `2`) | Lets a reader tell a v1 file from a v2 one |
| `previous_state` | Last observed state: `on-charge` or `on-battery` | Chooses the `Plugged` or `Unplugged` panel label |
| `state_since` | Exact transition time, or the first reliable observation when the transition time is unknown | Panel's session duration |
| `state_since_at_least` | `1` when `state_since` is only a lower-bound observation; otherwise `0` | Prefixes the panel duration with `>` |
| `last_charge_start` | Last observed battery-to-charge transition, or `0` if never observed | Fallback source for `Plugged` duration |
| `last_charge_end` | Last observed charge-to-battery transition, or `0` | Marks the session end; not shown separately |
| `last_observed` | Time of the last successful poll | Detects a clock reversal or a gap over `BATTERY_MODEL_MAX_POLL_GAP_SECONDS` |
| `charge_start_levels` | Per-battery percentage at charge start | Produces one start-to-end row per battery on unplug |
| `charge_session_valid` | Whether continuity and the start snapshot are reliable | Gates the exact-vs-qualified duration line; see below |
| `battery_fingerprint` | Names and measurement mode of present batteries | Informational (`make status VERBOSE=1`); carries no reset logic — see [ADR-0001](../adr/0001-raw-observation-tier.md) |

Sampling-window state is not in this file. It lives per battery in
`battery-state.tsv`. A battery swap writes to a different `raw/` directory
instead of resetting a field here. See
[ADR-0001](../adr/0001-raw-observation-tier.md#alternatives-considered).

### Session-duration confidence

The panel renders `> X` as **at least X**. The tracker uses the following
state matrix:

| Preconditions | Stored timestamp | `state_since_at_least` | Panel meaning |
| --- | --- | --- | --- |
| A real charge-to-battery or battery-to-charge transition is observed | Transition time | `0` | `X` is the observed session duration |
| The tracker starts with no previous power state | First observation time | `1` | `> X` because the session began no later than that observation |
| The same power state is observed after a gap over the poll-gap tolerance or a clock reversal | First reliable observation after the gap | `1` | `> X`; activity during the gap is unknown |
| An older state file has a current state but `state_since=0` or invalid | Recovery observation time | `1` | `> X`; the original transition time is unavailable |
| A later real power transition occurs | New transition time | `0` | Confidence resets and the `>` prefix disappears |

The lower bound is rounded down to whole minutes, so `> 5m` never claims more
observed time than the tracker has measured.

### The unplug notification's duration and deltas

`charge_session_valid` used to gate both the session duration and the
per-battery percentage deltas together, which meant a session that ran
through an untracked gap lost deltas that were genuinely observed. The two
are independent now:

- Per-battery deltas (`BAT0: 44% → 89%`) show whenever a start level was
  captured, regardless of whether the session was polled continuously.
- Duration shows as `Charged for ~X` when `charge_session_valid == 1`
  (continuous), or `Charged over ~X (interrupted)` when the wall-clock span
  is real but a gap happened somewhere inside it. `last_charge_start == 0`
  is the "never observed" sentinel and produces neither line.

## Tier 1 — `raw/<battery-key>/<date>.tsv`

One directory per battery, named after its identity key. Only `/` and NUL are
replaced, with `-`, because those are the only characters the filesystem
forbids. This is not a privacy boundary. See
[Properties of these files](#properties-of-these-files). One file per local
date, append-only, never edited or pruned.

```text
# battery-raw-observations<TAB>v0.1.0
<epoch><TAB><trigger><TAB><rules><TAB><status><TAB><energy_now_uwh><TAB><energy_full_uwh><TAB><energy_full_design_uwh><TAB><voltage_now_uv><TAB><power_now_uw><TAB><capacity_percent><TAB><cycle_count><TAB><end_threshold_percent><TAB><ac_online><TAB><boot_id><TAB><suspend_count><TAB><uptime_seconds>
```

A row is written every poll, unconditionally — the poll row is the liveness
proof, independent of whether a window can be built from it. `trigger` is
one of:

| Trigger | When |
| --- | --- |
| `start` | The first row ever written for this battery's identity |
| `poll` | An ordinary follow-up poll, nothing changed |
| `status` | This battery's sysfs status string changed since the last row |
| `resume` | The first poll after a gap beyond the poll tolerance |

`rules` stamps the recording-rules version in force when the row was written
(window length, draw formula, plausibility bounds, poll interval) — distinct
from the file's own format version, which describes how to parse the row.
Machine-level facts (`ac_online`, `boot_id`, `suspend_count`,
`uptime_seconds`) are repeated on every row rather than normalized into a
separate file, so one battery's raw file is independently readable.

Rotation is implicit: the local date is the filename, so a new day needs no
rotation logic. Nothing is ever pruned.

## Tier 2 — `windows.tsv`, `gaps.tsv`

Both derived from tier 1 by `battery_extract_windows()` — the same function
called incrementally after every poll and by `make reextract` in batch. See
[the extraction algorithm in ADR-0001](../adr/0001-raw-observation-tier.md#decision).

```text
# battery-windows<TAB>v0.1.0
<epoch><TAB><session_epoch><TAB><battery-key><TAB><draw_mw><TAB><energy_now_uwh><TAB><energy_full_uwh><TAB><energy_full_design_uwh><TAB><voltage_now_uv><TAB><power_now_uw><TAB><capacity_percent><TAB><cycle_count><TAB><eligible>
```

`session_epoch` groups windows from one continuous discharge run. A run that
spans several completed windows counts as one session for the evidence gate,
not several. `eligible` is `0` for a window that spanned an
interruption; such a window is retained for reconstruction but never counts
as evidence.

```text
# battery-gaps<TAB>v0.1.0
<battery-key><TAB><start_epoch><TAB><end_epoch><TAB><cause><TAB><ac_online_start><TAB><ac_online_end><TAB><energy_before_uwh><TAB><energy_after_uwh><TAB><energy_delta_uwh>
```

`cause` is `off` (shutdown, reboot, or hibernate — a different `boot_id`),
`asleep` (suspend — same boot, `suspend_count` increased), `blind` (the
machine was awake but the tracker was not running), or `clock` (a backward
time jump beyond ordinary NTP jitter).

### Which windows the model reads

The model reads a window only when the window is `eligible`, is not
future-dated, and falls inside `BATTERY_MODEL_LOOKBACK_SECONDS`. It needs
`BATTERY_MODEL_MIN_WINDOWS` windows across `BATTERY_MODEL_MIN_SESSIONS`
sessions for a full estimate, and `BATTERY_MODEL_PROVISIONAL_WINDOWS` for a
provisional one. See [Constants](#constants).

For why evidence is anchored per battery, see
[one model per battery](architecture.md#one-model-per-battery).

## Tier 3 — `battery-state.tsv`

One row per battery. The tracker rewrites the whole file each time it records
a window. It never rewrites the file on a poll that only advances an open
window.

```text
# battery-state<TAB>v0.1.0
<battery-key><TAB><open_window_epoch><TAB><open_window_energy_uwh><TAB><estimator><TAB><scored><TAB><mean_error_mw><TAB><updated_epoch>
```

The view reads this file on the panel refresh path. It reads neither `raw/`
nor `windows.tsv` there, so panel latency does not grow with history.

`BATTERY_MODEL_DEFAULT_ESTIMATOR` keeps the job until a challenger beats it by
`BATTERY_MODEL_ESTIMATOR_MARGIN_PERCENT` on that battery's held-out windows.
See [the estimator each battery uses](architecture.md#the-estimator-each-battery-uses).

Delete this file at no cost. Every battery falls back to the default
estimator, and the next recorded window rebuilds the row.

## Properties of these files

| Property | Applies to |
| --- | --- |
| Append-only. Never edited, never pruned | `raw/` |
| Grows without bound. Retention applies at read time | `windows.tsv`, `gaps.tsv` |
| Rewritten in place. Safe to delete and rebuild | `state`, `battery-state.tsv` |
| Written atomically, through a temp file and a rename | All |
| Created with `umask 077`, readable only by the owner | All |

Battery identity is recorded in the clear. Each `raw/` directory and every
`windows.tsv`, `gaps.tsv`, and `battery-state.tsv` row carries manufacturer,
model, and serial. The data stays in the user's state directory. Nothing
transmits it. Anything that later shares it must ask first. For the reasoning,
see [ADR-0001](../adr/0001-raw-observation-tier.md).

## Commands

| Command | Effect |
| --- | --- |
| `make status` | Render the interpreted report. See [status output reference](status-output-reference.md) |
| `make status VERBOSE=1` | Add the collection diagnostics |
| `make view` | Print the exact document the panel reads |
| `make reextract` | Rebuild tiers 2 and 3 from raw and diff. Changes nothing |
| `make reextract FORCE=1` | Rebuild tiers 2 and 3 and replace the live files |
| `make export` | Bundle every tier and a manifest into one zip |

## Constants

`service/battery-model.sh` declares every value below exactly once. This table
is the only place the documentation repeats them. Cite the variable name
elsewhere; never write the number.

| Variable | Value | Governs |
| --- | --- | --- |
| `BATTERY_MODEL_POLL_INTERVAL_SECONDS` | 180 | How often the timer polls. The timer's `OnUnitActiveSec` must match |
| `BATTERY_MODEL_MAX_POLL_GAP_SECONDS` | 3 × the poll interval | The gap tolerance that starts a lower-bound session |
| `BATTERY_MODEL_WINDOW_SECONDS` | 900 | Length a window must reach before it records |
| `BATTERY_MODEL_LOOKBACK_SECONDS` | 30 days | How far back the model reads windows |
| `BATTERY_MODEL_MIN_WINDOWS` | 12 | Windows needed for `ready` |
| `BATTERY_MODEL_MIN_SESSIONS` | 3 | Sessions needed for `ready` |
| `BATTERY_MODEL_PROVISIONAL_WINDOWS` | 4 | Windows needed for `provisional` |
| `BATTERY_MODEL_RECENT_WINDOWS` | 4 | Windows the recent-draw estimators read |
| `BATTERY_MODEL_ESTIMATOR_MARGIN_PERCENT` | 15 | How far a challenger must beat the incumbent |
| `BATTERY_MODEL_ESTIMATOR_MIN_SCORED` | 8 | Scored windows needed before selection runs |
| `BATTERY_MODEL_DEFAULT_ESTIMATOR` | `median` | The incumbent estimator |
| `BATTERY_MODEL_MIN_DRAW_MW` | 100 | Lower plausibility bound |
| `BATTERY_MODEL_MAX_DRAW_MW` | 120000 | Upper plausibility bound |

Format versions are separate. `BATTERY_RAW_FORMAT`, `BATTERY_WINDOWS_FORMAT`,
`BATTERY_GAPS_FORMAT`, and `BATTERY_STATE_TIER_FORMAT` are each `v0.1.0` and
describe how to parse a file. `BATTERY_RECORDING_RULES_VERSION` is `v0.1.0`
and records which recording rules were in force. `BATTERY_STATE_SCHEMA_VERSION`
is `2` and describes the `state` file.

Retention is not a constant. The model reads the lookback window at read time.
No file is pruned.
