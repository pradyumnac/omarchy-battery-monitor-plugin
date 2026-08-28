# What the panel and notifications tell you

![Panel detail: BAT0 and BAT1 side by side](../../screenshots/panel-detail.png)

The bar shows one combined percentage. Open the panel for per-battery
health, energy, cycles, and state. A notification fires only when the
charger connects or disconnects — the panel's own numbers refresh every 30
seconds on their own, so a shown duration can lag the real state by up to
30 seconds. Notifications never lag.

## Charger connected: `Plugged`

![Panel while charging, with the power-profile picker](../../screenshots/panel-detail-charging.png)

```text
Plugged
BAT0 · 22%
```

One row per battery that's actively charging, with its percentage. Two
charging batteries get two rows.

A battery held at its charge threshold doesn't show as charging — the panel
shows `Holding` and the configured limit, so you know why it isn't charging
instead of having to guess:

![Panel with batteries held at their charge threshold](../../screenshots/panel-detail-threshold.png)

The same condition is also called out in the connection notification:

![Plugged notification with one battery charging and one at its charge threshold](../../screenshots/notify-threshold.png)

```text
Plugged
⚠ Charge threshold:
BAT0 · 95%
```

The notification never repeats numbers the panel already shows — no
aggregate pack level, charge rate, or time-to-full.

## Charger disconnected: `Unplugged`

![Unplugged notification](../../screenshots/notify-unplugged.png)

```text
Unplugged
Charged for ~18m
BAT0: 12% → 22%
BAT1: 80% → 80%
```

The first line is the approximate session duration. Each battery gets one
start-to-end row. A battery that didn't move (already at its threshold)
still gets a row — equal start and end values already say "no change."

## Rules that apply to every notification

- One short title, one scannable fact per row.
- Only present laptop batteries appear — never a UPS or the AC adapter.
- Batteries are named `BAT0`, `BAT1`, and so on — never a serial number.
- An unknown value is omitted, never shown as a misleading zero.
- The same power state never sends a notification twice.
- A plug shorter than the battery's settle time sends only `Unplugged` —
  a connection that stops before any battery starts charging isn't an
  event worth reporting.

## Battery added or removed mid-session

| Case | On connect | On disconnect |
| --- | --- | --- |
| Battery present for the whole session | Shown with its percentage | Start → end row |
| Battery removed mid-session | Shown at connect | Row reads `removed`, with its last known level |
| Battery added mid-session | Not in the connect snapshot | Row reads `added`, with its level |
| No laptop battery | No notification | Panel stays hidden |

## Panel session duration

The panel distinguishes an observed transition from a session that was
already underway when tracking became reliable:

| Display | Meaning |
| --- | --- |
| `5m` | The tracker observed the plug or unplug transition five minutes ago |
| `> 5m` | **At least five minutes**; the actual session started earlier, but its transition time is unknown |

The `>` form appears when the tracker first starts while already plugged or
unplugged, resumes the same state after a polling gap over 90 seconds or a
clock reversal, or recovers an older state file with no session timestamp. It
disappears after the next real plug or unplug transition.

For the mechanics behind this — the state machine, timing, and state file —
see [architecture](../dev/architecture.md).
