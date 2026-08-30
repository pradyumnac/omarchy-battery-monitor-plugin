# State file reference

Audience: contributors reading or writing tracker state.

## Location

```text
${XDG_STATE_HOME:-$HOME/.local/state}/battery-session/state
```

`battery-session-tracker.sh` writes it. `battery-session-monitor.sh` triggers a
write on power events. Nothing else reads it directly: consumers read the
[aggregated view](view-reference.md), which this file feeds.

## Schema version

`state_schema_version` names the format. Version 2 removed the derived model
fields version 1 carried (`battery_energy_now_uwh`,
`battery_usable_capacity_uwh`, `usual_remaining_runtime_seconds`,
`usual_full_runtime_seconds`, `usual_sample_count`). The view recomputes those
from live sysfs and the discharge history on every read, so a second, staler
copy on disk had no reason to exist and could disagree with the first.

A version-1 file carries no `state_schema_version` key. The view reads it
without complaint: every field it needs exists in both versions, and it ignores
the derived fields version 1 also holds. No migration step is required.

## Fields

| Field | Meaning | Used for |
| --- | --- | --- |
| `state_schema_version` | Format of this file (currently `2`) | Lets a reader tell a v1 file from a v2 one |
| `previous_state` | Last observed state: `on-charge` or `on-battery` | Chooses the `Plugged` or `Unplugged` panel label |
| `state_since` | Exact transition time, or the first reliable observation when the transition time is unknown | Panel's session duration |
| `state_since_at_least` | `1` when `state_since` is only a lower-bound observation; otherwise `0` | Prefixes the panel duration with `>` |
| `last_charge_start` | Last observed battery-to-charge transition | Fallback source for `Plugged` duration |
| `last_charge_end` | Last observed charge-to-battery transition, or `0` | Marks the session end; not shown separately |
| `last_observed` | Time of the last successful poll | Detects a clock reversal or a gap over `BATTERY_MODEL_MAX_POLL_GAP_SECONDS` |
| `charge_start_levels` | Per-battery percentage at charge start | Produces one start-to-end row per battery on unplug |
| `charge_session_valid` | Whether continuity and the start snapshot are reliable | Blocks an invented duration or delta |
| `discharge_session_id` | Identifier for the active continuous discharge session | Groups runtime observations |
| `window_start_epoch` | Start of the active 15-minute energy window | Builds a discharge observation |
| `window_start_energy_uwh` | Aggregate energy at the active window start | Builds a discharge observation |
| `last_sample_energy_uwh` | Aggregate energy at the previous poll | Detects energy increases |
| `window_reset_reason` | Last actionable reason the active sample restarted/paused, or empty | Conditional `make status` sampling warning |
| `battery_fingerprint` | Names, measurement mode, and capacity of present batteries | Invalidates a window after topology changes |

## Session-duration confidence

The panel renders `> X` as **at least X**. The tracker uses the following
state matrix:

| Preconditions | Stored timestamp | `state_since_at_least` | Panel meaning |
| --- | --- | --- | --- |
| A real charge-to-battery or battery-to-charge transition is observed | Transition time | `0` | `X` is the observed session duration |
| The tracker starts with no previous power state | First observation time | `1` | `> X` because the session began no later than that observation |
| The same power state is observed after a gap over the poll-gap tolerance or a clock reversal | First reliable observation after the gap | `1` | `> X`; activity during the gap is unknown |
| An older state file has a current state but `state_since=0` or invalid | Recovery observation time | `1` | `> X`; the original transition time is unavailable |
| A later real power transition occurs | New transition time | `0` | Confidence resets and the `>` prefix disappears |

The lower bound is rounded down to whole minutes, so `> 5m` never claims
more observed time than the tracker has measured. Exact durations retain the
normal session-duration rounding.

## Discharge history

`discharge-history.tsv` uses the version-1 format:

```text
# battery-discharge-history<TAB>v1
<epoch><TAB><session-id><TAB><draw-mW><TAB><capacity-uWh>
```

Only the most recent 96 valid rows younger than 180 days are retained. The
prune runs when a row is appended — the only moment the file can grow — rather
than on every poll. The
model uses only rows from the most recent 30 days that are not future-dated,
requires at least 12 rows across 3 sessions for a full estimate (4 rows for a
provisional one), and uses their median draw. This
makes `Usual` responsive to recent usage while retaining a limited longer
back-reference. Future-dated rows survive bounded retention for diagnosis but
do not count as evidence.

## Guarantees

- Only `BAT*` names, percentages, presence, and timestamps — never a serial
  number, model ID, or other host-identifying data.
- Every state and history write is atomic: write to a temp file, then rename.
- Every write is user-only (`umask 077`).
- A gap longer than `BATTERY_MODEL_MAX_POLL_GAP_SECONDS` in the same observed
  state starts a lower-bound observed session. The panel prefixes its duration with `>` rather than claiming to
  know what happened while the service was inactive. See
  [architecture](architecture.md#open-edge-cases) for suspend and shutdown
  cases that can also hide a power-state change.

## Inspecting it

Use the combined, formatted report for normal diagnostics:

```sh
make status
```

The default report intentionally shows only interpreted battery and model
facts. Use `make status VERBOSE=1` for collection diagnostics; see the
[status output reference](status-output-reference.md). To inspect every
persisted field, read the file directly:

```sh
cat "${XDG_STATE_HOME:-$HOME/.local/state}/battery-session/state"
```

This is useful when a panel value looks wrong and you need to confirm whether
the tracker or the panel is at fault. To see what the panel actually reads,
print the view instead:

```sh
make view
```

Every rule in this file is written down once, in `service/battery-model.sh`:
the poll interval and gap tolerance, the window length, the lookback and
retention, the evidence gate, and the plausibility bounds.
