# Usable-capacity and runtime diagnostics

## Implemented diagnostic split

`make status` separates the two questions that were previously conflated:

```text
Current stored energy: 15.0 Wh / 37.0 Wh
Observed peak capacity: 37.0 Wh (12 observations)
Usual remaining runtime: 2h 21m
Expected runtime at peak: 5h 52m
```

- **Current stored energy** is the aggregate `energy_now` reading used for the
  panel estimate.
- **Observed peak capacity** is the median of positive full-capacity values
  already recorded in valid windows from the recent 30-day model period. The
  observation count is shown because this remains a diagnostic metric.
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
period. Before that gate, status reports `learning` and runtime values remain
`not ready`.

The peak-capacity diagnostic may be shown from fewer observations while the
model is learning. Showing it does not make the widget ready.

## Scope

This correction does not alter the learned-load model. The current model is a
robust deterministic baseline: median valid discharge-window draw, multiplied by
either current stored energy or current full usable capacity. More advanced
model-tuning approaches are research-only for now; see
[`docs/research/battery-runtime-modelling.md`](../research/battery-runtime-modelling.md).
