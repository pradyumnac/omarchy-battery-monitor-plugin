# View reference

Audience: anyone writing a consumer of this plugin's battery data — the panel,
`make status`, or a widget this repository will never see.

## What it is

One versioned JSON document holding everything a consumer needs about the
machine's power state. `service/battery-view.sh` is the only thing that
produces it.

```sh
make view                  # print the document
service/battery-view.sh    # the same, directly
```

`Panel.qml` reads it with one `Process`, replacing six spawns and five ad-hoc
parsers. `scripts/battery-intelligence-status.sh` sources the producer and
renders the same values without re-parsing anything.

## The rule

**The view is derived output, never a second source of truth.** If a consumer
needs a field the view lacks, add it to the view. Do not let a consumer read
the state file, the discharge history, or sysfs directly — that leak is exactly
what this seam exists to prevent.

## Versioning

`schema` is always `battery-view`. `version` is currently `1`. A consumer must
check both and refuse a document it does not recognise, keeping whatever it
last read rather than rendering a half-understood payload. `Model.parseView()`
does this and returns `null` on every rejection.

Adding a field is a compatible change and does not raise `version`. Removing or
repurposing one does.

## Fields

### `power`

| Field | Meaning |
| --- | --- |
| `state` | The tracker's last observed state: `on-battery`, `on-charge`, or `unknown` |
| `phase` | What sysfs says right now: `charging`, `full`, `held`, `plugged`, `discharging`, `absent`, or `unknown` |
| `ac_online` | Whether a mains supply reports itself online |
| `sysfs_available` | `false` when the power-supply tree cannot be read at all — a different fact from a tree holding no battery |
| `state_since_epoch` | Start of the current power session |
| `state_since_at_least` | `true` when `state_since_epoch` is only a lower bound; render the duration as `> X` |
| `charge_start_epoch` / `charge_end_epoch` | Last observed transitions, or `0` |

### `energy`

Pack totals across every present battery, read live from sysfs on each view.

| Field | Meaning |
| --- | --- |
| `now_uwh` / `capacity_uwh` / `design_uwh` | Stored, full-charge, and design energy in µWh |
| `percent` | Charge as a whole percent, or `-1` when energy is unavailable |
| `draw_mw` | Live power flow in mW, in whichever direction current moves |
| `charge_limit_percent` | Highest charge-stop threshold set on any battery, or `0` |
| `live_time_seconds` | Time to empty or to full at the live draw — not the learned model |

### `model`

The pack-level learned runtime model — the sum of every battery's own
`projection` (below). Every duration is in seconds and is `0` when the model
has nothing to say.

| Field | Meaning |
| --- | --- |
| `state` | `ready`, `provisional`, `learning`, `blocked-energy`, `blocked-runtime`, or `unavailable` |
| `windows` / `sessions` | Evidence inside the 30-day lookback |
| `required_windows` / `required_sessions` | The full evidence gate, so a consumer can draw progress without hardcoding it |
| `typical_draw_mw` | Median draw over the lookback |
| `remaining_seconds` | Stored energy at the typical draw |
| `full_seconds` | Full usable capacity at the typical draw |
| `remaining_low_seconds` / `remaining_high_seconds` | p25–p75 band. A heavier draw buys less time, so the p75 draw sets the *low* edge |
| `updated_epoch` | Timestamp of the newest window in evidence |

`state` values in detail:

| `state` | Meaning |
| --- | --- |
| `ready` | Full gate met; estimates are trustworthy |
| `provisional` | Enough evidence for a rough answer; render it with a loud low-confidence label |
| `learning` | Below the provisional gate; no estimate is offered |
| `blocked-energy` | Evidence is complete but the battery reports no energy |
| `blocked-runtime` | Evidence is complete but yields no usable draw |
| `unavailable` | `windows.tsv` is in a format this version does not read |

### `history`, `sampling`, `tracker`

| Field | Meaning |
| --- | --- |
| `history.state` | `ready`, `missing`, or `unsupported` |
| `history.total` / `recent` / `archived` / `future` | Row counts from `windows.tsv`; `future` rows are retained for diagnosis but are never evidence |
| `history.ineligible` | Windows that spanned a gap (see [ADR-0001](../adr/0001-raw-observation-tier.md)) — retained for reconstruction, never counted as evidence |
| `sampling.fingerprint` | Names and measurement mode of the batteries installed now |
| `sampling.pack_key` | Identity of the set installed now: `NAME:VENDOR:MODEL:SERIAL` per battery, comma separated in name order |
| `sampling.pack_key_weak` | `true` when the firmware publishes no serial, so two identical spare batteries cannot be told apart. Say so rather than implying certainty |
| `tracker.last_observed_epoch` / `age_seconds` | When the tracker last ran |
| `tracker.freshness` | `live`, `cached`, `clock-mismatch`, or `unknown` |

Top-level `sampling` carries only pack identity. Everything about the *open
discharge window* — start, elapsed seconds, and the most recent
interruption — is per battery now, not pooled: see `batteries[].sampling`
below. There is no top-level `sampling.session_id` or `reset_reason`; a
continuous discharge run's identity (`session_epoch`) lives in `windows.tsv`
itself, and the per-battery `sampling.last_gap_cause` replaces the old single
reset reason.

### `batteries`, `profiles`, `system`

`batteries` is one object per present battery: `name`, `status`, `percent`,
`energy_now_uwh`, `energy_full_uwh`, `energy_full_design_uwh`, `power_now_uw`,
`cycle_count`, `model`, `vendor`, `end_threshold_percent`, `held`, `key`,
`sampling`, and `projection`. `model` is the cell's model name; `projection`
is its own runtime model, deliberately named apart so the two never collide.
`name` is the sysfs directory name, which is what UPower reports as
`nativePath`, so a consumer can join the two without a lookup table.

`batteries[].sampling` is this battery's own open discharge window, read from
`battery-state.tsv` and `gaps.tsv` (see the
[state file reference](state-file-reference.md)):

| Field | Meaning |
| --- | --- |
| `window_start_epoch` | Start of this battery's currently open sampling window, or `0` if none is open |
| `window_seconds` | Elapsed seconds in the open window |
| `window_target_seconds` | The window length a poll needs to reach before it can be recorded (`BATTERY_MODEL_WINDOW_SECONDS`) |
| `last_gap_cause` | This battery's most recent interruption: `off`, `asleep`, `blind`, `clock`, or empty if none recorded |
| `last_gap_epoch` | End time of that gap, or `0` |

`batteries[].projection` is this battery's own runtime model — the same
shape as the pack-level `model` above, minus the evidence-gate constants
(`required_windows`/`required_sessions`, which are pack-wide), plus two
fields specific to a battery's own estimator:

| Field | Meaning |
| --- | --- |
| `estimator` | Which estimator this battery projects with, chosen by the tracker from its own held-out score |
| `estimator_error_mw` | That estimator's held-out mean error on this battery, so the choice is auditable |

`held` is the answer to "is this battery parked at its own configured charge
cap". Read it; do not re-derive it. sysfs reports both a genuine hold and "not
this battery's turn to charge yet" with the identical `status` string
`"Not charging"`, so a status match alone gets it wrong on any multi-battery
machine. `battery_model_threshold_held()` owns the rule, the view applies it
per battery, and `power.phase` becomes `held` only when some battery really is.

`profiles` carries `available` and `active` for a power-profile picker.
`system.uptime_seconds` is the machine's uptime.

## Cost

The panel re-reads this document every five seconds while it is open, so the
producer avoids forks on principle: sysfs fields are read with `$(<file)`, the
history takes a single `awk` pass, and JSON escaping happens in one bash
function rather than a command substitution per field. Adding a `$(...)` to a
per-battery or per-field path undoes that; use a nameref output parameter, as
`battery_view_read` and `battery_view_json_string` do.

## Adding a field

1. Collect it into a `view_*` variable in `battery_view_collect*`.
2. Emit it in `battery_view_emit_json`, escaping any string through
   `battery_view_json_string`.
3. Read it in `Model.parseView()` and add it to `Model.emptyView()`, so every
   binding has a defined value before the first document arrives.
4. Document it above.
5. Cover it in `tests/view.test.js`.

Adding a field never raises `version`.
