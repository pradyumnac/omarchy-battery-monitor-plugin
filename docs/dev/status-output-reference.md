# Status output reference

Audience: contributors who change `make status` or its lifecycle diagnostics.

`scripts/battery-intelligence-status.sh` renders this report. It computes
nothing. It reads the [aggregated view](view-reference.md) and adds systemd
service health, which is the one fact only an operator report needs.

## Commands

| Command | Output |
| --- | --- |
| `make status` | Concise lifecycle summary |
| `make status VERBOSE=1` | The same summary and the collection diagnostics |
| `NO_COLOR=1 make status` | Plain output with no ANSI escapes |
| `BATTERY_STATUS_COLOR=always make status` | ANSI output even when redirected |

`BATTERY_STATUS_COLOR` accepts `auto`, `always`, or `never`. An invalid value
for that variable or for `BATTERY_STATUS_VERBOSE` exits with status 2.

## Data sources

The report reads one document. It does not open a data file directly.

| Source | Used for |
| --- | --- |
| The aggregated view | Every battery, model, energy, session, and freshness fact |
| `systemctl --user is-active` | Tracker and monitor health |

Tests override the view's sysfs root with
`BATTERY_STATUS_POWER_SUPPLY_ROOT`. For the files behind the view, see the
[state file reference](state-file-reference.md).

## Per-battery fields

The report prints one block for each present battery. Identity comes first.
Every field under a block belongs to that battery alone.

| Field | When shown | Meaning |
| --- | --- | --- |
| Block heading | One for each present battery | The sysfs name, then vendor, model, and serial |
| `Battery` | Always | Charge, energy, health against design capacity, sysfs status, and live power flow |
| `Model` | Always | That battery's own lifecycle state and evidence counts |
| `Typical draw` | The battery has a usable draw | The learned draw, the chosen estimator, and its held-out error |
| `Current sample` | The battery discharges with a window open | Progress through the open window |
| `Sampling` | A gap ended recently | Why sampling restarted. See [sampling reasons](#sampling-reasons) |
| `From this level` / `At full` | The battery has a usable projection | That battery's own projection |
| `Range` | A p25–p75 band exists | How wrong the projection can be |

## Pack fields

| Field | When shown | Meaning |
| --- | --- | --- |
| `Services` | Always | `healthy`, or the failed tracker and monitor states |
| `Not installed` | Evidence exists for an absent battery | Names the battery. Such evidence is never modelled |
| `Power` | State exists | On battery, charging, full, held, or plugged, and the session duration |
| `Energy` | State exists | Aggregate energy against full capacity, and the percentage |
| `Pack model` | Always | The pack lifecycle state |
| `Pack remaining` | Some battery projects, on battery | Sum of the per-battery projections |
| `If unplugged now` | Some battery projects, charging below full | The same sum, labelled for charging |
| `At full` | Some battery projects, below full | Sum of the projections from full capacity |
| `Pack runtime` | Some battery projects, at full | One runtime line, because current and full agree |
| `Ineligible windows` | A window spanned a gap | Count of windows kept but never modelled |
| `History` | Archived rows exist | Recent against older retained windows |
| `History warning` | Future-dated rows exist | Rows are kept but excluded from learning |
| `Updated` | The tracker is live | Age of the last poll |
| `Data` | Stale, clock mismatch, or unknown freshness | Runtime values are cached |
| `Action` | A service is inactive | The recovery command |

A field is omitted when its information is absent. The report never prints a
missing value as a zero.

## Model-state precedence

The first matching row wins.

| Condition | Model state |
| --- | --- |
| A readable sysfs tree holds no battery | `unavailable · no present battery` |
| The tracker has never run | `waiting for first tracker poll` |
| `windows.tsv` has an unknown header | `unavailable · unsupported history format` |
| Fewer windows than the provisional gate | `learning`, with capped progress |
| The provisional gate is met, the full gate is not | `provisional` |
| The full gate is met, but the draw is unusable | `blocked · learned runtime unavailable` |
| The full gate is met, but current energy is missing | `blocked · this battery reports no capacity` |
| The full gate is met and both projections are valid | `ready` |

The first two rows exit the report early. `battery-model.sh` holds the gate
values; see [the constants table](state-file-reference.md#constants).

## Freshness

Tracker state is live only when both services are active and the last poll is
newer than the poll-gap tolerance. Older state, a future timestamp, or an
inactive service marks the runtime values as cached and appends `(cached)` to
the label.

The learned model can stay `ready` while the data is cached. Its evidence
covers 30 days, so one missed poll does not change it. `Last learned` measures
the newest window in evidence. `Updated` measures the last tracker poll. The
two are different facts.

## Charging phase

Phase precedence across present batteries:

1. Any battery reports `Charging` → `charging`.
2. Every battery reports `Full` → `full`.
3. Any battery reports `Not charging` and none charges → `charge held`.
4. Otherwise → `plugged in`.

On-battery state wins over every plugged label.

## Sampling reasons

Each battery reports its own most recent interruption. The report shows the
reason only while the gap is recent enough to explain what the reader sees.

| Gap cause | Concise output |
| --- | --- |
| `off` | machine was off (shutdown, reboot, or hibernate) |
| `asleep` | machine was suspended |
| `blind` | the tracker was not running |
| `clock` | the system clock changed |

The extractor derives these causes. See
[gap classification](architecture.md#raw-observations-and-one-extractor).

## Verbose-only fields

`VERBOSE=1` adds:

| Field | Meaning |
| --- | --- |
| `State file` | Path to the state directory |
| `View schema` | View schema name, view version, and state schema version |
| `History detail` | Retained, recent, session, and future window counts |
| `Last learned` | Age of the newest window in evidence |
| `Battery fingerprint` | Names and measurement mode of present batteries |
| `Battery set key` | Identity key of the installed set |

Each battery's open window appears in its own block as `Current sample`.
Verbose mode does not repeat it.

These are collection diagnostics. Read systemd logs with
`systemctl --user status`. The report never duplicates them.
