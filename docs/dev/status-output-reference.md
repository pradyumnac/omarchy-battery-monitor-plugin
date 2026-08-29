# Status output reference

Audience: contributors changing `make status`, tracker state, or lifecycle
diagnostics.

## Commands

| Command                                   | Output contract                                   |
| ----------------------------------------- | ------------------------------------------------- |
| `make status`                             | Concise, human-facing lifecycle summary           |
| `make status VERBOSE=1`                   | The same summary plus low-level collection fields |
| `NO_COLOR=1 make status`                  | Plain output with no ANSI escapes                 |
| `BATTERY_STATUS_COLOR=always make status` | ANSI output even when redirected                  |

`scripts/battery-intelligence-status.sh` renders both modes. It is internal;
there is no separate user-facing intelligence target.

## Data sources

| Source                                | Used for                                                                                        |
| ------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `systemctl --user is-active`          | Tracker and monitor health                                                                      |
| Tracker `state`                       | Power session, current/full energy, runtime projections, freshness, active window, reset reason |
| `discharge-history.tsv`               | Recent/archived counts, distinct sessions, median draw/capacity, last learned time              |
| `/sys/class/power_supply/BAT*/status` | Distinguishes charging, full, and charge-threshold hold; detects no present battery             |

Tests can override the last source with `BATTERY_STATUS_POWER_SUPPLY_ROOT`.

## Concise fields

Fields are conditional; absent information is not printed as a misleading zero.

| Field              | When shown                                  | Meaning                                                                                      |
| ------------------ | ------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `Services`         | Always                                      | `healthy`, or individual tracker/monitor states                                              |
| `Battery`          | No present battery                          | Runtime state is suppressed because persisted data may be stale                              |
| `Power`            | State exists                                | On battery, charging, full, held, or generically plugged; includes observed session duration |
| `Energy`           | State exists                                | Current aggregate energy / current full usable capacity and derived percentage               |
| `Model`            | Always after state/history inspection       | `waiting`, `learning`, `ready`, `blocked`, or `unavailable`                                  |
| `Evidence`         | Model blocked after its gate                | Recent windows and sessions prove learning is complete                                       |
| `Usual remaining`  | Ready and discharging                       | Current stored energy / learned median draw                                                  |
| `If unplugged now` | Ready and plugged below full                | The same current-energy projection, labelled for charging context                            |
| `At full`          | Ready below full                            | Full usable capacity / learned median draw                                                   |
| `Usual runtime`    | Ready and full                              | Single full runtime; avoids duplicate current/full lines                                     |
| `Typical draw`     | Ready                                       | Median recent valid-window draw                                                              |
| `History`          | Archived rows exist                         | Recent versus older retained observations                                                    |
| `History warning`  | Future-dated rows exist                     | Rows are retained but excluded from learning                                                 |
| `Sampling`         | Active sampling was reset/paused            | Human label for `window_reset_reason`                                                        |
| `Current sample`   | Learning, or verbose mode                   | Progress through the active 15-minute window                                                 |
| `Updated`          | Live tracker                                | Age of the latest tracker poll                                                               |
| `Data`             | Stale, clock mismatch, or unknown freshness | Runtime values are cached or may be cached                                                   |
| `Action`           | A service is inactive                       | Short recovery path; systemd logs remain opt-in                                              |

## Model-state precedence

The first matching row wins:

| Condition                                           | Model state                                    |
| --------------------------------------------------- | ---------------------------------------------- |
| No state file                                       | `waiting for first tracker poll`               |
| No present battery                                  | `unavailable · no present battery`             |
| Unknown history header                              | `unavailable · unsupported history format`     |
| Fewer than 12 recent windows or 3 sessions          | `learning` with capped progress                |
| Gate complete but learned draw/full runtime missing | `blocked · learned runtime unavailable`        |
| Gate complete but current energy/capacity missing   | `blocked · current battery energy unavailable` |
| Gate complete and both projections valid            | `ready`                                        |

A legacy state may derive remaining runtime by scaling its full runtime with
`last_sample_energy_uwh / median_recent_capacity`. This prevents a false
`learning` state during upgrade; the installed tracker writes explicit current
and remaining fields on its next poll.

## Freshness and cached values

Tracker state is live only when both services are active and `last_observed` is
no more than 90 seconds old. Older state, a future timestamp, or an inactive
service marks current-energy runtime as cached. The learned model itself can
remain ready because its 30-day evidence is independent of one missed poll.

`learned <age> ago` comes from the latest accepted history row. It is separate
from `Updated`, which measures tracker polling freshness. Future-dated history
rows are never model evidence; status reports how many were ignored.

## Charging phase

For present batteries, phase precedence is:

1. Any `Charging` battery → `charging`.
2. Every battery `Full` → `full`.
3. Any `Not charging` battery and none charging → `charge held`.
4. Otherwise → generic `plugged in`.

On-battery state always wins over those plugged-only labels.

## Sampling reset reasons

| Persisted value              | Concise output                              |
| ---------------------------- | ------------------------------------------- |
| `battery-set-changed`        | Battery set changed                         |
| `polling-gap`                | Polling gap or clock change                 |
| `energy-unavailable`         | Battery energy unavailable; sampling paused |
| `energy-increased`           | Stored energy increased                     |
| `no-energy-used`             | No discharge measured                       |
| `implausible-draw`           | Implausible draw rejected                   |
| `history-schema-unsupported` | Unsupported history format                  |
| Empty                        | No reset warning                            |

A valid accepted window clears the reason. Charging also clears it because no
discharge sample is expected.

## Verbose-only fields

`VERBOSE=1` adds:

- state-file path;
- retained/recent/session history totals;
- age, draw, and capacity of the last accepted window;
- discharge session ID;
- active window start/last energy;
- battery fingerprint.

These are collection diagnostics, not normal user-facing status. Full systemd
logs and raw state remain available through `systemctl --user status ...` and
direct file inspection rather than being duplicated in the default report.
