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
| `discharge-history.tsv`               | Per-battery window and session counts, that battery's draw, last learned time                   |
| `estimators.tsv`                      | Which estimator each battery projects with, and the held-out error that earned it               |
| `/sys/class/power_supply/BAT*/status` | Distinguishes charging, full, and charge-threshold hold; detects no present battery             |
| `/sys/class/power_supply/BAT*/energy_full`, `energy_full_design`, `power_now` | Per-battery health, full-charge energy, and live power flow (`charge_*` files are the fallback) |

Tests can override the last source with `BATTERY_STATUS_POWER_SUPPLY_ROOT`.

## Concise fields

Fields are conditional; absent information is not printed as a misleading zero.

| Field              | When shown                                  | Meaning                                                                                      |
| ------------------ | ------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `Services`         | Always                                      | `healthy`, or individual tracker/monitor states                                              |
| `BAT*` directory name | One block for each present battery       | Opens with the cell's identity: vendor, model, and serial                                       |
| `Battery`          | Inside each battery block                   | That cell's current charge and energy, its health against design capacity, its sysfs status, and the live power flow while current moves |
| `Model`            | Inside each battery block                   | That cell's own lifecycle state and evidence counts; a projection is built only from the battery's own windows |
| `Typical draw`     | Battery has a usable model                  | Its learned draw, and the estimator chosen for it when that is not the default                  |
| `From this level` / `At full` / `Range` | Battery has a usable model | That cell's own projection                                                                      |
| `Current sample`   | Battery is discharging with a window open   | Progress of the window being measured, reported against the battery it measures                 |
| `Not installed`    | Evidence exists for an absent battery       | Names it; this is the only place such evidence appears, and it is never modelled                |
| `Battery`          | No present battery                          | Runtime state is suppressed because persisted data may be stale                              |
| `Power`            | State exists                                | On battery, charging, full, held, or generically plugged; includes observed session duration |
| `Energy`           | State exists                                | Current aggregate energy / current full usable capacity and derived percentage               |
| `Pack model`       | Always after state/history inspection        | `waiting`, `learning`, `provisional`, `ready`, or `unavailable`; only as certain as its least certain battery |
| `Confidence`       | Model provisional                           | Says the estimate is low-confidence and how much evidence is still missing                    |
| `Evidence`         | Model blocked after its gate                | Recent windows and sessions prove learning is complete                                       |
| `Pack remaining`   | Some battery has a usable model, discharging | Sum of the per-battery projections from current stored energy                                |
| `If unplugged now` | Ready and plugged below full                | The same current-energy projection, labelled for charging context                            |
| `At full`          | Some battery has a usable model, below full  | Sum of the per-battery projections from full usable capacity                                 |
| `Pack runtime`     | Some battery has a usable model, at full     | Single full runtime; avoids duplicate current/full lines                                     |
| `Typical draw`     | Ready or provisional                        | Median recent valid-window draw                                                              |
| `Range`            | A p25–p75 band is available                 | How wrong the estimate could be; the p75 draw sets the low edge                               |
| `Right now`        | Recent windows exist                        | Estimate over the newest few windows, which tracks a workload shift within the hour           |
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
| The tracker has never run (`last_observed` is `0`)   | `waiting for first tracker poll`               |
| A readable sysfs tree holds no battery              | `unavailable · no present battery`             |
| Unknown history header                              | `unavailable · unsupported history format`     |
| Fewer than 4 recent windows                         | `learning` with capped progress                |
| Gate incomplete but 4 or more recent windows        | `provisional`, with a low-confidence line      |
| Gate complete but the median draw is unusable       | `blocked · learned runtime unavailable`        |
| Gate complete but current energy/capacity missing   | `blocked · current battery energy unavailable` |
| Gate complete and both projections valid            | `ready`                                        |

The full gate is 12 recent windows across 3 sessions. There is no upgrade
special case: a version-1 state file simply lacks fields the view no longer
reads, and every estimate is recomputed from live sysfs and the discharge
history on each render.

## Freshness and cached values

Tracker state is live only when both services are active and `last_observed` is
newer than the poll-gap tolerance (`BATTERY_MODEL_MAX_POLL_GAP_SECONDS`). Older state, a future timestamp, or an inactive
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
