# Requirements and verification spec

Audience: contributors verifying a change or picking up backlog work.

This doc is the single source of pending work. GitHub issues are archived
(closed, not deleted) rather than kept in sync with this file — see
[Archived issues](#archived-issues).

## Test coverage

| Behavior | Covered by |
| --- | --- |
| Alternate mains supply name, `type=Mains` | `tests/tracker.test.js` |
| Battery-to-charge transition | `tests/tracker.test.js` |
| Charge-to-battery transition | `tests/tracker.test.js` |
| Reconnect clears `last_charge_end` | `tests/tracker.test.js` |
| Same-state gap beyond the poll tolerance starts a lower-bound session | `tests/tracker.test.js` |
| Initial or recovered unknown session start sets `state_since_at_least=1` | `tests/tracker.test.js` |
| Real power transition clears `state_since_at_least` | `tests/tracker.test.js` |
| Lower-bound duration renders as `> X`, rounded down | `tests/model.test.js` |
| Desktop with no battery creates no session | `tests/tracker.test.js` |
| Two-battery aggregation | `tests/model.test.js` |
| Charge-threshold detection | `tests/model.test.js` |
| UPower event triggers a notification | `tests/monitor.test.js` |
| Held-threshold battery still gets `Plugged` after the wait times out | `tests/monitor.test.js` |
| Poll alone never sends a notification | `tests/tracker.test.js` |
| `Plugged` notification content | `tests/tracker.test.js` |
| `Unplugged` notification content | `tests/tracker.test.js` |
| Duplicate notifications on repeated events | `tests/tracker.test.js` |
| Notification delivery failure doesn't block state persistence | `tests/tracker.test.js` |
| Unknown session start falls back to current facts only | `tests/tracker.test.js` |
| Battery removed mid-session reports `removed` on unplug | `tests/tracker.test.js` |
| Battery added mid-session reports `added` on unplug | `tests/tracker.test.js` |
| Held battery reported in the `⚠ Charge threshold:` block | `tests/tracker.test.js` |
| Battery with no `present` file is still tracked | `tests/tracker.test.js`, `tests/preflight.test.js` |
| Every file write stays under the user's home directory | `tests/write-boundary.test.js` |
| Normal uninstall retains all session and intelligence data | `tests/uninstall.test.js` |
| Purge uninstall removes the complete data directory | `tests/uninstall.test.js` |
| Unknown uninstall options fail before removing files | `tests/uninstall.test.js` |
| Install and both uninstall targets perform a full shell restart | `tests/uninstall.test.js` |
| Install refuses on a machine with no battery | `tests/preflight.test.js` |
| A valid 15-minute discharge window is recorded | `tests/tracker.test.js` |
| Future-dated history is retained for diagnosis but excluded from learning | `tests/tracker.test.js`, `tests/intelligence-status.test.js` |
| History is bounded to 96 rows per battery over 180 days | `tests/tracker.test.js` |
| Invalid/discontinuous windows are rejected | `tests/tracker.test.js` |
| Battery topology changes invalidate only the active window | `tests/tracker.test.js` |
| Unknown history schemas are ignored safely | `tests/tracker.test.js` |
| `make status` renders a concise summary without systemd logs or raw state | `tests/intelligence-status.test.js` |
| Learning, ready, blocked, unavailable, stale/cached, and clock states are distinct | `tests/intelligence-status.test.js` |
| Charging, full, and charge-threshold hold use context-specific runtime labels | `tests/intelligence-status.test.js` |
| No present battery suppresses stale persisted runtime | `tests/intelligence-status.test.js` |
| Model freshness, archived history, and sampling reset reasons are conditional | `tests/intelligence-status.test.js`, `tests/tracker.test.js` |
| `VERBOSE=1` adds collection diagnostics without changing the concise default | `tests/intelligence-status.test.js` |
| Status colors can be forced or disabled for noninteractive output | `tests/intelligence-status.test.js` |
| Each battery reports capped 12-window and 3-session progress of its own | `tests/intelligence-status.test.js` |
| One block per present battery, identity first, whatever it is named | `tests/intelligence-status.test.js` |
| Charge-threshold hold requires the battery to have reached its own cap | `tests/model-lib.test.js`, `tests/tracker.test.js`, `tests/intelligence-status.test.js` |
| State icon severity ranks charge level above threshold hold and full charge | `tests/model.test.js` |
| Battery identity built from vendor, model and serial, with separators neutralised | `tests/model-lib.test.js` |
| A pack key is stable regardless of the order its batteries are presented | `tests/model-lib.test.js` |
| Firmware with no serial is reported as weak identity, not silently merged | `tests/model-lib.test.js`, `tests/view.test.js` |
| One battery's evidence never reaches another battery's projection | `tests/model-lib.test.js`, `tests/view.test.js` |
| A battery with no evidence of its own stays unmodelled | `tests/view.test.js` |
| Evidence for a battery that is not installed is listed but never modelled | `tests/view.test.js`, `tests/intelligence-status.test.js` |
| Only the battery that actually discharged records a window | `tests/tracker.test.js` |
| Capacity recalibration does not restart sampling; an identity change does | `tests/tracker.test.js` |
| A window with no per-battery baseline restarts and names the reason | `tests/tracker.test.js` |
| An append is only claimed when a row was actually written | `tests/tracker.test.js` |
| Pack-level rows from schema v1 and v2 are dropped on migration | `tests/tracker.test.js` |
| Held-out scoring never sees the window it predicts | `tests/model-lib.test.js`, `tests/backtest.test.js` |
| Estimator selection holds on steady load, switches on a real shift, ignores noise | `tests/model-lib.test.js` |
| Estimator selection refuses to choose on thin evidence | `tests/model-lib.test.js` |
| A corrupt or missing estimator store falls back to the default | `tests/model-lib.test.js` |
| The tracker records a selected estimator when it records a window | `tests/tracker.test.js` |
| The view projects with each battery's recorded estimator | `tests/view.test.js` |
| The backtest reports the selection the tracker would make | `tests/backtest.test.js` |
| The view is one versioned document that rejects a schema it cannot read | `tests/view.test.js`, `tests/model.test.js` |
| The panel keeps its last good view rather than blanking on a bad payload | `tests/model.test.js` |
| Each battery's current charge is reported, with fallbacks when it is unavailable | `tests/intelligence-status.test.js` |
| The sampling window is reported against the battery being measured | `tests/intelligence-status.test.js` |
| CSV export splits identity into columns and quotes text fields | `tests/export.test.js` |

## Manual check before a release

- [ ] Connect the charger with BAT0 and BAT1 present.
- [ ] Confirm `Plugged` shows only the charging battery and its percentage.
- [ ] Confirm a battery below its charge cap is listed under `Not charging`,
      not under `⚠ Charge threshold`.
- [ ] Confirm the panel shows `⌁ Limit` only once a battery really reaches its
      configured cap.
- [ ] Confirm the bar shows the combined percentage without opening the panel.
- [ ] Disconnect the charger and confirm the response is immediate.
- [ ] Confirm `Unplugged` shows the approximate duration.
- [ ] Confirm each battery has one start-to-end row and no added gain.
- [ ] Confirm the panel shows one `Plugged` or `Unplugged` field, not two.
- [ ] Restart tracking while already unplugged and confirm the panel shows
      `> X`, meaning at least X, rather than an exact-looking duration.
- [ ] Complete a real plug/unplug transition and confirm `>` disappears.
- [ ] Repeat with one battery absent, and with a charge threshold active.
- [ ] Confirm repeated polls create no duplicate notification.
- [ ] Confirm an unknown session shows current facts, not an invented delta.
- [ ] After enough real use, confirm `≈ Usual` decreases with stored energy and is plausible as remaining active runtime.
- [ ] Confirm `make status` reports the longer full/peak runtime separately.
- [ ] Confirm suspend/gaps do not inflate `Usual`.
- [ ] Run `make status` while discharging, charging, full, and held at a charge
      threshold; confirm runtime labels match each phase.
- [ ] Stop one user service and confirm runtime becomes `(cached)`, a stale-data
      warning appears, and the report gives one recovery action.
- [ ] Run `make status VERBOSE=1` and confirm diagnostics appear without serials,
      model IDs, applications, or other personal data.
- [ ] Confirm each battery block shows its own `X/12 windows` and `Y/3 sessions`, and
      `NO_COLOR=1 make status` removes ANSI styling.
- [ ] Run `make uninstall`, reinstall, and confirm history is retained.
- [ ] Run `make uninstall-purge-data` only on disposable test data and confirm
      the battery-session state directory is removed.

For a screenshot, follow the capture steps in the screenshot backlog in
`HANDOFF.md` (untracked; ask the maintainer if you don't have it).

**Not yet covered:** real-hardware verification across laptop models
beyond the T480. See [Backlog](#backlog).

## Backlog

Edge cases with no defined behavior yet. Each is a data-consistency
question about the state file across a system transition — does the next
observation correctly tell "stale from a gap" apart from "a real new
session"?

| Case | Question | Notes |
| --- | --- | --- |
| Suspend / resume | Can a mains change and reversal entirely inside suspend be detected? | A gap produces `> X`, but hidden transitions cannot be reconstructed; see [architecture](architecture.md#open-edge-cases) |
| Shutdown / poweroff mid-session | Does the state file need a flush-on-shutdown path to recover transitions while stopped? | Restart produces `> X`; no flush path exists today |
| Last battery removed at runtime | Beyond the mid-session `removed` row, does the panel degrade gracefully to hidden if the battery never comes back? | Install-time preflight already refuses on zero-battery machines; this is the runtime case |
| Real-hardware verification | Confirm timing (settle time, notification text) on laptops other than the T480 | Was tracked as issue #4; see below |

## Archived issues

GitHub issue tracking was retired in favor of this file — fine-grained
issue bookkeeping cost more contributor time than the project's size
justified. Closed issues carry a comment pointing here.

| Issue | Was about | Where it lives now |
| --- | --- | --- |
| #2 | Slice 2: summarize a completed charging session | Covered — see test coverage above |
| #3 | Slice 3: harden transition notifications | Covered — see test coverage above |
| #4 | Verify charging notifications on supported hardware | [Backlog](#backlog), "Real-hardware verification" |
