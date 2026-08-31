# State file reference

Audience: contributors reading or writing tracker-collected data.

Since [ADR-0001](adr/0001-raw-observation-tier.md), this data spans four
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

`state_schema_version` names the format. Version 2 removed the derived model
fields version 1 carried (`battery_energy_now_uwh`,
`battery_usable_capacity_uwh`, `usual_remaining_runtime_seconds`,
`usual_full_runtime_seconds`, `usual_sample_count`, and — as of ADR-0001 —
`discharge_session_id`, `window_start_epoch`, `window_start_energy_uwh`,
`last_sample_energy_uwh`, `window_reset_reason`). Every one of those is now
derived from `raw/` and `battery-state.tsv` on every read rather than kept as
a second, staler copy on disk.

A version-1 file carries no `state_schema_version` key and still reads
without complaint: every field the view needs from `state` exists in both
versions.

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
| `battery_fingerprint` | Names and measurement mode of present batteries | Informational (`make status VERBOSE=1`); carries no reset logic — see [ADR-0001](adr/0001-raw-observation-tier.md) |

Sampling-window state (what used to be `discharge_session_id`/
`window_start_epoch`/`window_reset_reason`) is no longer here at all. It
lives per battery in `battery-state.tsv`, because a battery swap is now
handled by writing to a different `raw/` directory rather than by resetting
a field in this file — see
[Alternatives considered in ADR-0001](adr/0001-raw-observation-tier.md#alternatives-considered).

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

One directory per battery, named after its identity key with `/` and NUL
replaced by `-` (the only characters the filesystem actually forbids — this
is not a privacy boundary, see Guarantees below). One file per local date,
append-only, never edited or pruned.

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
[the extraction algorithm in ADR-0001](adr/0001-raw-observation-tier.md#decision).

```text
# battery-windows<TAB>v0.1.0
<epoch><TAB><session_epoch><TAB><battery-key><TAB><draw_mw><TAB><energy_now_uwh><TAB><energy_full_uwh><TAB><energy_full_design_uwh><TAB><voltage_now_uv><TAB><power_now_uw><TAB><capacity_percent><TAB><cycle_count><TAB><eligible>
```

`session_epoch` groups windows from one continuous discharge run — a run
spanning several completed 15-minute windows is one session for the evidence
gate, not several. `eligible` is `0` for a window that spanned an
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

### What identity is, and is not, used for

Draw is a property of the machine and its workload — the laptop pulls the
same watts whichever cell supplies them — so **every window still feeds the
draw model**, whichever battery measured it. What genuinely is
battery-specific is how much runtime a reported charge level actually buys,
because a worn cell's `energy_full` is exactly the number that stops being
true. Identity anchors that, keeps the evidence auditable, and is what
attributes each window to the right `raw/` directory in the first place.

The model uses only windows from the most recent 30 days that are not
future-dated and are `eligible`, requires at least 12 windows across 3
sessions for a full estimate (4 windows for a provisional one), and uses
their median draw by default (or whichever estimator currently scores best —
see below). Retention is a read-time interpretation now, not a write-time row
cap: nothing in `windows.tsv` is ever pruned.

## Tier 3 — `battery-state.tsv`

One row per battery, rewritten whole each time the tracker records a window
for it — at most once every 15 minutes, never on the poll that merely
advances an open window.

```text
# battery-state<TAB>v0.1.0
<battery-key><TAB><open_window_epoch><TAB><open_window_energy_uwh><TAB><estimator><TAB><scored><TAB><mean_error_mw><TAB><updated_epoch>
```

This is what the view reads on its 5-second panel-refresh path — never
`raw/`, never `windows.tsv` — so panel latency is unaffected by how much
history has accumulated.

`median` is the incumbent and keeps the job unless a challenger beats it by
`BATTERY_MODEL_ESTIMATOR_MARGIN_PERCENT` on that battery's own held-out
windows. The margin exists because scores drift window to window: without it
the selection would flap between estimators separated by noise, and a
projection that silently changes shape is harder to trust than one that is
consistently a little worse. Deleting this file costs nothing — every
battery falls back to `median` and the next recorded window rebuilds it.

## Guarantees

- Battery identity **is** recorded: each `raw/` directory and every
  `windows.tsv`/`gaps.tsv`/`battery-state.tsv` row is keyed by manufacturer,
  model, and serial. This is deliberate and replaces an earlier guarantee
  that stored none of it.

  Serial is what separates two otherwise identical spare batteries, so
  without it a user who swaps between spares cannot have their evidence
  attributed correctly — and capacity is not a substitute, because it drifts
  with wear and collides between different cells. Manufacturer and model are
  what will let observations be pooled across machines with the same battery
  later, which is the point of recording them in the clear rather than as a
  digest.

  The data stays in the user's own state directory and is never
  transmitted. Anything that later shares it must ask first.
- Nothing is ever pruned or rewritten: `raw/` is append-only, `windows.tsv`
  and `gaps.tsv` grow without bound, and their retention is a read-time
  interpretation. `state` and `battery-state.tsv` are the only files
  rewritten in place, and both are safe to delete — the tracker rebuilds
  what it needs from raw on the next poll.
- Every write is atomic (temp file, then rename) and user-only (`umask
  077`).
- A gap longer than `BATTERY_MODEL_MAX_POLL_GAP_SECONDS` in the same
  observed power state starts a lower-bound observed session; the panel
  prefixes its duration with `>` rather than claiming to know what happened
  while the service was inactive. See
  [architecture](architecture.md#open-edge-cases) for suspend and shutdown
  cases that can also hide a power-state change.

## Inspecting it

Use the combined, formatted report for normal diagnostics:

```sh
make status
```

The default report intentionally shows only interpreted battery and model
facts. Use `make status VERBOSE=1` for collection diagnostics; see the
[status output reference](status-output-reference.md). To see exactly what
the panel reads:

```sh
make view
```

To rebuild `windows.tsv`, `gaps.tsv`, and `battery-state.tsv` from raw and
confirm the incremental and batch extraction paths still agree:

```sh
make reextract          # diffs against the live files, changes nothing
make reextract FORCE=1  # replaces them
```

To bundle everything — raw, windows, gaps, battery-state, and a manifest —
into one zip for a notebook:

```sh
make export
```

Every rule that shapes these files is written down once, in
`service/battery-model.sh`: the poll interval and gap tolerance, the window
length, the lookback, the evidence gate, and the plausibility bounds.
