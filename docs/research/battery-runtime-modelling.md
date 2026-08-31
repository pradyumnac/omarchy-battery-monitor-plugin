# Battery runtime modelling approaches

Status: background research only. This document does not authorize a model
change.

## Problem definition

The panel needs **time to empty under a representative recent workload**. This
is different from battery-health “remaining useful life” research, which
predicts degradation across future charge cycles.

For runtime, the physical relationship is:

```text
remaining_hours = current_stored_energy_Wh / expected_draw_W
```

The modelling choice is therefore mainly how to estimate `expected_draw` without
making the UI either noisy or stale.

UPower defines `Energy` as currently available Wh, `EnergyFull` as Wh when full,
`EnergyRate` as W being drained, and `TimeToEmpty` as seconds to empty (or zero
when unknown). Those definitions support keeping current-energy and
full-capacity projections separate [1].

## Existing open-source approaches

### 1. Direct energy/rate division

Noctalia Shell falls back to the following when UPower returns no estimate:

```text
time_to_empty = energy / energy_rate * 3600
time_to_full  = (energy_full - energy) / energy_rate * 3600
```

This is simple and responds immediately, but one short CPU/GPU burst can make it
swing sharply [2]. A bar-rs implementation similarly derives aggregate remaining
time from summed `energy_now` and `power_now` values [3].

### 2. Fixed rolling-average draw

BatteryScope records samples locally and uses:

```text
expected_draw = average(power_now over the last 15 minutes)
time_to_empty = energy_now / expected_draw
```

Its stated goal is stability under short workload spikes [4]. The approach is
easy to explain and replay, but a fixed window has a hard responsiveness
boundary and a mean remains sensitive to sustained outliers.

### 3. Median discharge windows

This plugin's current deterministic baseline records valid 15-minute windows,
uses the median draw from recent windows, and requires multiple sessions. It is
robust to isolated outliers and gives a stable “usual” workload. Its main
limitation is context blindness: power-saver and performance workloads are
combined, and older observations receive the same weight as newer ones inside
the 30-day window.

#### Current data usage

The history schema captures four values, but not every value is a predictor:

| Captured value       | Current use                                              | Not currently extracted                                              |
| -------------------- | -------------------------------------------------------- | -------------------------------------------------------------------- |
| Window epoch         | 30-day model cutoff and 180-day pruning                  | Recency weighting, time-of-day patterns, trend                       |
| Session ID           | Requires three distinct sessions                         | Per-session weighting or per-session model                           |
| Draw in mW           | Median expected draw; the model's sole learned predictor | Variability/confidence interval, trend, workload bands               |
| Full capacity in µWh | Recent median in `make status`                           | Runtime prediction; that uses the current live full-capacity reading |

Current stored energy is captured in tracker state and is the numerator of the
panel's remaining-runtime estimate. Current full usable capacity is the
numerator of the peak-runtime diagnostic. Continuity timestamps, battery
fingerprint, and previous energy samples validate or reset collection; they do
not tune expected draw.

Consequently, the system uses all history columns operationally, but it does not
use all of the information latent in them. In particular, a session with many
windows has more influence than a short session, capacity movement is not
modelled as a trend, and draw dispersion is not exposed as uncertainty.

The present schema also cannot support honest prediction-error training because
it does not record a ground-truth active time-to-threshold outcome. It does not
record power profile, exact accepted-window duration, or rejection reasons
either. Those omissions are privacy-friendly, but they limit regression and
model evaluation.

### 4. Exponential smoothing of estimates

KDE PowerDevil introduced an exponential moving average (EMA) over up to 64
remaining-time observations, with weight `0.05`, specifically to reduce the
impact of a short heavy load. It clears the history when AC state changes and
does not add zero estimates to history [5]. In pseudocode:

```text
smoothed = first_value
for value in bounded_history:
    smoothed = 0.95 * smoothed + 0.05 * value
```

Smoothing the final time estimate is straightforward, but it can hide a real
workload transition. Smoothing draw before dividing energy by draw is easier to
reason about physically.

### 5. Linear regression over energy and time

A regression model fits the observed discharge slope rather than trusting an
instantaneous kernel rate:

```text
energy_i = intercept + slope * elapsed_time_i
expected_draw = -slope
remaining_time = current_energy / expected_draw
```

Historical UPower code has used linear regression over a bounded history of
energy samples, requiring several valid points and retaining a previous rate
when a new fit is implausible [6]. This is still a one-variable physical model,
not general machine learning. Ordinary least squares is sensitive to spikes;
robust regression or strict session/window rejection is needed around it.

Battery Zen reports using exponentially weighted regression so recent samples
contribute more to charge/discharge-rate estimates [7]. A generic weighted fit
would minimize:

```text
sum(weight_i * (energy_i - (intercept + slope * time_i))^2)
```

This combines smoothness with adaptation, but introduces a decay parameter that
must be validated on held-out sessions.

### 6. Context-conditioned models

A later model could estimate draw separately by coarse, non-personal context,
for example power profile, charging state, or a small number of draw bands.
Academic workload-aware power models commonly add CPU use, brightness, or
application/workload features, but published results are device- and
workload-specific and should not be assumed to transfer to arbitrary laptops
[8][9]. Collecting application names would also violate this project's data
minimization goals.

## Candidate model families for offline comparison

These are evaluation candidates, not implementation decisions:

| Candidate                    | Inputs                                 | Strength                          | Main risk                      |
| ---------------------------- | -------------------------------------- | --------------------------------- | ------------------------------ |
| Current median               | Valid 15-minute draw windows           | Robust and explainable            | Slow/context-blind             |
| Rolling median               | Last N valid windows                   | Adapts without regression         | Abrupt window boundary         |
| Trimmed mean                 | Recent draws minus tails               | Uses more information than median | Trim fraction tuning           |
| EMA of draw                  | Current draw plus previous estimate    | Small state, gradual adaptation   | Lag and decay tuning           |
| OLS slope                    | Energy and elapsed time in one session | Physical, simple regression       | Outlier-sensitive              |
| Robust slope                 | Same as OLS with robust loss           | Better spike resistance           | More implementation complexity |
| Exponentially weighted slope | Recent energy/time samples             | Smooth but adaptive               | Weight tuning and startup bias |
| Profile-conditioned median   | Draw windows grouped by power profile  | Handles obvious modes             | Sparse data per group          |

## Accuracy evaluation before any model change

A model should be replayed against completed discharge sessions rather than
judged from how plausible one live number looks.

For each prediction timestamp:

1. Train only on observations available before that timestamp.
2. Predict time to a defined empty threshold.
3. Compare with actual active discharge time, excluding continuity gaps.
4. Report median absolute error, 90th-percentile absolute error, signed bias,
   and estimate volatility between adjacent polls.
5. Split by battery topology and power profile where enough data exists.

A candidate should beat the median baseline on held-out sessions without causing
visibly unstable estimates. Readiness and confidence should remain separate from
the numeric prediction.

## Constraints retained from this project

- No host identifiers, serials, application names, or personal data.
- No model should bridge suspend, clock reversal, charging, topology changes, or
  missing-energy intervals.
- Training and inference remain local and deterministic/replayable.
- A more complex model needs measurable held-out improvement, not only a better
  fit to its training windows.

## Sources and code references

1. UPower device property definitions:
   <https://upower.freedesktop.org/docs/Device.html>
2. Noctalia UPower fallback implementation (permalink):
   <https://github.com/noctalia-dev/noctalia-shell/blob/3c1ca3e6/src/dbus/upower/upower_service.cpp>
3. bar-rs battery implementation (permalink):
   <https://github.com/faervan/bar-rs/blob/46315971/src/modules/battery.rs>
4. BatteryScope runtime description and source:
   <https://github.com/ptcodes/BatteryScope>
5. KDE PowerDevil EMA commit, including weight and bounded history:
   <https://invent.kde.org/plasma/powerdevil/-/commit/b55f85ce464be8595df70c903b19534cbe36b7c3>
6. Historical UPower Linux supply implementation:
   <https://cgit.freedesktop.org/upower/tree/src/linux/up-device-supply.c?id=0e256ece04a98d3d202ed96>
7. Battery Zen analytics description and source:
   <https://github.com/Prajwal-Prathiksh/battery-zen>
8. Chromebook workload/power-prediction study:
   <https://mlforsystems.org/assets/papers/neurips2022/paper24.pdf>
9. Workload-aware mobile energy modelling example:
   <https://users.aalto.fi/~siekkine/pub/yu10greencom.pdf>

## Open research directions

Parked deliberately. Nothing here ships without a measurable held-out
improvement from `make backtest`, per the rule above.

### Per-battery calibration: is reported capacity honest?

The projection divides reported energy by a learned draw. It therefore trusts
`energy_full`, and on a worn cell that is exactly the number that stops being
true — a battery reporting 12.09 Wh may deliver noticeably less.

Schema v3 records `energy_now` and `energy_full` on every window, per battery,
so the delivered energy between two charge levels can be compared against what
the battery claimed to hold. The ratio is an effective-capacity factor,
anchored to the battery's identity so it survives a swap.

Open questions: how many windows are needed before the factor is stable;
whether it should be applied to `at full` only or to the live projection too;
and whether it drifts fast enough to need its own lookback.

### Discharge-curve non-linearity, and whether it worsens with wear

The projection is linear: `energy / draw`. Li-ion curves are flat across most
of the range and bend near empty, so the linear form may break at low charge —
and may break *earlier* on a degraded cell.

This was previously unanswerable because nothing recorded where in the
discharge a window sat. Schema v3 records `capacity_percent` and `voltage_now`
per window, so the question is now a query rather than a guess: split backtest
error by charge bucket, and split again by battery health.

Do not implement a correction before that split shows one is needed. If the
error is flat across buckets there is nothing here.

### Continuous backtesting — implemented

Scoring now runs continuously. The tracker rescores each battery against its
own accumulating evidence whenever it records a window, and writes the winning
estimator to that battery's row in `battery-state.tsv`; the view projects with whatever that battery
selected. `make backtest` renders the same scoring for a human and reports the
selection it would make, so the report and the running model cannot tell
different stories — both call `battery_model_score_draws()`.

The three requirements this needed were met as follows. Cost is kept off the
refresh path by scoring at window-append time, at most once every 15 minutes,
rather than on every panel read. The choice is recorded per battery with the
held-out error that earned it, and `make status` prints both. Flapping is
prevented by `BATTERY_MODEL_ESTIMATOR_MARGIN_PERCENT`: `median` keeps the job
unless a challenger beats it by a clear margin.

Still open: the margin and `BATTERY_MODEL_ESTIMATOR_MIN_SCORED` are chosen by
judgement, not measurement. Once real multi-week histories exist, check how
often the selection changes and whether the margin is doing useful work or
merely freezing an early accident.

`make export` writes the same history as CSV for exploring these questions in a
notebook before any of it is committed to shell.
