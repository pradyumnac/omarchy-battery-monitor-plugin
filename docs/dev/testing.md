# Testing

Audience: contributors who verify a change before they open it.

## Automated checks

```sh
make check   # syntax, unit files, qmllint, JS parse, doc links
make test    # the Node suite
```

Run both before you open a change. `make check` is fast and catches most
mistakes.

The test files are the coverage record. Read the `describe` and `test` names
in `tests/` to see what each behaviour proves. This page does not mirror them,
because a hand-written mirror drifts from the suite and then misleads.

| Suite | Covers |
| --- | --- |
| `tests/extract.test.js` | The shared extractor: windows, sessions, gap classification, eligibility |
| `tests/tracker.test.js` | Raw capture, incremental extraction, identity, notifications, permissions |
| `tests/model-lib.test.js` | The model seam: identity keys, statistics, estimator scoring and selection |
| `tests/view.test.js` | The aggregated view: per-battery projections, schema, weak identity |
| `tests/intelligence-status.test.js` | `make status` rendering, lifecycle states, colour control |
| `tests/backtest.test.js` | Held-out scoring and the selection the tracker would make |
| `tests/export.test.js` | The export bundle and its members |
| `tests/monitor.test.js` | UPower event handling and notification triggers |
| `tests/model.test.js` | `Model.js`: view parsing, icons, duration rendering |
| `tests/preflight.test.js` | Install-time requirement checks |
| `tests/uninstall.test.js` | Uninstall, purge, and shell restart |
| `tests/write-boundary.test.js` | Every write stays below the user's home directory |

## Verify the extraction paths agree

`battery_extract_windows()` runs incrementally after each poll and in batch
under `make reextract`. Both paths must produce the same result.

```sh
make reextract
```

The command rebuilds tiers 2 and 3 and diffs them against the live files. A
clean diff proves the paths agree. Run it after you change extraction logic.

The comparison ignores two fields of `battery-state.tsv`, because both differ
on every run and neither is derived from raw:

| Ignored | Reason |
| --- | --- |
| `updated_epoch` | A wall-clock stamp taken when the row is written |
| Row order | One row per battery, and no reader depends on the order |

Every other column is compared. `tests/tracker.test.js` holds this from both
sides: a changed stamp and a reversed order must still report no difference,
and a changed estimator must still fail.

`--force` writes the file whole. The rule above applies to the comparison
only.

## Manual check before a release

Run these on real hardware. The automated suite cannot prove them.

- [ ] Connect the charger with BAT0 and BAT1 present.
- [ ] Confirm `Plugged` shows only the charging battery and its percentage.
- [ ] Confirm a battery below its charge cap is listed under `Not charging`,
      not under `⚠ Charge threshold`.
- [ ] Confirm the panel shows `⌁ Limit` only once a battery reaches its
      configured cap.
- [ ] Confirm the bar shows the combined percentage without opening the panel.
- [ ] Disconnect the charger and confirm the response is immediate.
- [ ] Confirm `Unplugged` shows the approximate duration.
- [ ] Confirm each battery has one start-to-end row and no added gain.
- [ ] Confirm the panel shows one `Plugged` or `Unplugged` field, not two.
- [ ] Restart tracking while already unplugged and confirm the panel shows
      `> X` rather than an exact-looking duration.
- [ ] Complete a real plug and unplug transition and confirm `>` disappears.
- [ ] Repeat with one battery absent, and with a charge threshold active.
- [ ] Confirm repeated polls create no duplicate notification.
- [ ] Confirm an unknown session shows current facts, not an invented delta.
- [ ] After enough real use, confirm `≈ Usual` decreases with stored energy.
- [ ] Confirm `make status` reports the full runtime separately.
- [ ] Suspend the machine, resume, and confirm `make status` names the cause as
      `machine was suspended`.
- [ ] Reboot and confirm the cause reads `machine was off`.
- [ ] Confirm a gap does not inflate `≈ Usual`.
- [ ] Run `make status` while discharging, charging, full, and held at a charge
      threshold. Confirm the runtime labels match each phase.
- [ ] Stop one user service. Confirm the runtime becomes `(cached)`, a stale
      warning appears, and the report gives one recovery action.
- [ ] Run `make status VERBOSE=1` and confirm identity appears, per
      [ADR-0001](../adr/0001-raw-observation-tier.md).
- [ ] Confirm each battery block shows its own window and session progress, and
      that `NO_COLOR=1 make status` removes the ANSI styling.
- [ ] Run `make uninstall`, reinstall, and confirm the data is retained.
- [ ] Run `make uninstall-purge-data` on disposable data only. Confirm the
      state directory is removed.

Not covered: real-hardware verification on laptop models other than the T480.
See [backlog](backlog.md).

## Screenshots

Update the matching screenshot in `screenshots/` when a change alters the panel
layout or a notification's title or body. Capture at the same width as the
existing images so the set stays consistent.
