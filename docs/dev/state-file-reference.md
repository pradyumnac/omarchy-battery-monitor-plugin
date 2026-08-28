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

## Guarantees

- Only `BAT*` names, percentages, presence, and timestamps — never a serial
  number, model ID, or other host-identifying data.
- Every write is atomic: write to a temp file, then rename.
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
