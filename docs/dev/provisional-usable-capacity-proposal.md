# Usable-capacity and runtime diagnostics

## Implemented diagnostic split

`make status` separates the two questions that were previously conflated:

```text
Energy: 15.0 Wh / 37.0 Wh · 40%
Model: ready · 12 windows / 3 sessions · learned 8m ago
Usual remaining: 2h 21m
At full: 5h 52m
Typical draw: 6.3 W
```

- **Current stored energy** is the aggregate `energy_now` reading used for the
  panel estimate.
- The energy denominator is the current full usable capacity. Recent observed
  full-capacity values remain available internally as a compatibility fallback.
- **Usual remaining runtime** divides current stored energy by the learned
  median draw. This is the value exposed as `≈ Usual` in the panel.
- **Expected runtime at peak** divides current full usable capacity by the same
  learned draw. It is diagnostic only and is not shown as the panel's remaining
  runtime.

The distinction matters at partial charge. A learned full runtime of `5h 52m` at
40% charge corresponds to about `2h 21m` of usual remaining runtime, not
`5h 52m`.

## Readiness

Both runtime projections use the existing model gate: at least 12 valid
15-minute windows across at least 3 discharge sessions in the recent 30-day
period. Before that gate, status reports progress as `X/12 windows` and
`Y/3 sessions`. After the gate, missing current energy is `blocked`, not
`learning`; stale current state is explicitly cached. A legacy state file can
derive remaining runtime from current energy and full runtime, so a completed
evidence gate never incorrectly reports `learning` during an upgrade.

The full lifecycle and field precedence are defined in the
[status output reference](status-output-reference.md).

## Scope

This correction does not alter the learned-load model. The current model is a
robust deterministic baseline: median valid discharge-window draw, multiplied by
either current stored energy or current full usable capacity. More advanced
model-tuning approaches are research-only for now; see
[`docs/research/battery-runtime-modelling.md`](../research/battery-runtime-modelling.md).
