# State file reference

Audience: contributors reading or writing tracker state.

## Location

```text
${XDG_STATE_HOME:-$HOME/.local/state}/battery-session/state
```

`battery-session-tracker` writes it. `battery-session-monitor` triggers a
write on power events. The panel reads it every refresh.

## Fields

| Field | Meaning | Used for |
| --- | --- | --- |
| `previous_state` | Last observed state: `on-charge` or `on-battery` | Chooses the `Plugged` or `Unplugged` panel label |
| `state_since` | Start of the current observed state, or `0` | Panel's session duration |
| `last_charge_start` | Last observed battery-to-charge transition | Fallback source for `Plugged` duration |
| `last_charge_end` | Last observed charge-to-battery transition, or `0` | Marks the session end; not shown separately |
| `last_observed` | Time of the last successful poll | Detects a clock reversal or a gap over 90s |
| `charge_start_levels` | Per-battery percentage at charge start | Produces one start-to-end row per battery on unplug |
| `charge_session_valid` | Whether continuity and the start snapshot are reliable | Blocks an invented duration or delta |
| `usual_full_runtime_seconds` | Current-capacity projection from the recent median discharge draw, or `0` | Panel's `≈ Usual` value |
| `usual_sample_count` | Number of recent valid windows used by the projection | Confidence/debugging |
| `discharge_session_id` | Identifier for the active continuous discharge session | Groups runtime observations |
| `window_start_epoch` | Start of the active 15-minute energy window | Builds a discharge observation |
| `window_start_energy_uwh` | Aggregate energy at the active window start | Builds a discharge observation |
| `last_sample_energy_uwh` | Aggregate energy at the previous poll | Detects energy increases |
| `battery_fingerprint` | Names, measurement mode, and capacity of present batteries | Invalidates a window after topology changes |

## Discharge history

`discharge-history.tsv` uses the version-1 format:

```text
# battery-discharge-history<TAB>v1
<epoch><TAB><session-id><TAB><draw-mW><TAB><capacity-uWh>
```

Only the most recent 96 valid rows younger than 180 days are retained. The
model uses only rows from the most recent 30 days, requires at least 12 rows
across 3 sessions, and uses their median draw. This makes `Usual` responsive
to recent usage while retaining a limited longer back-reference.

## Guarantees

- Only `BAT*` names, percentages, presence, and timestamps — never a serial
  number, model ID, or other host-identifying data.
- Every state and history write is atomic: write to a temp file, then rename.
- Every write is user-only (`umask 077`).
- A gap over 90s in the same observed state clears `state_since` — the
  panel shows `—` rather than an invented duration. See
  [architecture](architecture.md#open-edge-cases) for gaps longer than a
  normal poll interval (suspend, shutdown).

## Reading it directly

```sh
cat "${XDG_STATE_HOME:-$HOME/.local/state}/battery-session/state"
```

Useful when a panel value looks wrong and you need to confirm whether the
tracker or the panel is at fault.
