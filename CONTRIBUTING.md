# Contributing

Thanks for helping improve T480 Omarchy Battery Monitor.

## Before opening a change

1. Check [docs/dev/backlog.md](docs/dev/backlog.md) for open work and explain
   the user problem. Issues are not used for tracking; that file is the source
   of pending work.
2. Keep changes focused and portable across laptops.
3. Follow the constraints in [README.md](README.md#constraints) —
   user-level paths only, no root, nothing host-identifying committed to Git.
   Battery identity is recorded in the user's own state directory by design;
   it must never end up in the repository or leave the machine.

## Local checks

```sh
make check   # syntax, unit files, qmllint, JS parse, doc links
make test    # the Node suite
```

See [docs/dev/testing.md](docs/dev/testing.md) for what each suite covers and
the manual checks before a release.

Three rules carry most of the weight here:

- **Model rules live in `service/battery-model.sh`.** The evidence gate, the
  window arithmetic, the projection, the threshold rule, and the scoring each
  exist exactly once. A second copy is free to disagree with the first, which
  is how several shipped bugs happened.
- **Consumers read the aggregated view, never the internals.** Add a field to
  `service/battery-view.sh` rather than reaching past it. See
  [the view reference](docs/dev/view-reference.md#the-rule).
- **Raw observations are the only source of truth.** `windows.tsv`,
  `gaps.tsv`, and `battery-state.tsv` are regenerable from `raw/` by one
  extraction function, called both incrementally (per poll) and in batch
  (`make reextract`). If a change to that function makes the two paths
  disagree, `make reextract`'s diff-by-default catches it — run it after
  touching extraction logic. See
  [ADR-0001](docs/adr/0001-raw-observation-tier.md).

No model change ships on plausibility. `make backtest` scores candidates
against each battery's own held-out windows, and `make export` bundles the
same data as a zip (raw, windows, gaps, battery state) for exploring a
question in a notebook first.

For UI changes, test on a laptop with one and two batteries when possible. Also check that the widget stays hidden on a desktop without laptop batteries.
Use `make status` for the concise lifecycle report and
`make status VERBOSE=1` for collection diagnostics. The
[status output reference](docs/dev/status-output-reference.md) defines its
state/field contract.

Keep documentation in its Diataxis mode: user goal steps are how-to guides,
design rationale is explanation, and field/state contracts are reference. Link
between them rather than duplicating content.

If your change affects the panel layout or a notification's title or body,
update the matching screenshot in `screenshots/`. See
[docs/dev/testing.md](docs/dev/testing.md#screenshots).

## Credit

Add your name or GitHub handle to [CONTRIBUTORS.md](CONTRIBUTORS.md) when you
make a meaningful contribution.

## Pull requests

Include:

- What changed and why
- How it was tested
- Any Omarchy, Quickshell, UPower, or hardware assumptions

Keep commits small and use clear imperative commit messages.
