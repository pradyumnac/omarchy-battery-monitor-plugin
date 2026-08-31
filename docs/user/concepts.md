# How the battery model works

Audience: anyone who wants to know why the plugin answers the way it does.

This page explains the ideas. To act on them, read
[check battery and model health](status.md).

## Each battery has its own model

A battery's runtime depends on its own capacity, age, and discharge curve. If
the plugin mixed a worn cell's measurements with a healthy one, the result
would describe neither. So each battery keeps its own evidence, and a
projection for one battery never reads another battery's windows.

Two results follow:

- A battery swap does not corrupt the model. The new cell starts to gather its
  own evidence. The old cell's windows stay on file under `Not installed`, and
  never feed a projection.
- A rarely used battery learns slowly. It can stay at `learning` for a long
  time. This is expected.

## Why the pack figure is a sum

These batteries discharge one after another, not together. While one supplies
the system, the other sits idle. An idle battery records nothing for that
window, because a row of zeros would hide the real draw.

The pack figure adds the per-battery projections together. That sum is what
the pack actually gives you.

## Why identity is recorded

Each battery is identified by vendor, model, and serial. Capacity is not used
as identity, because capacity drifts with wear and recalibration. Two
different cells can also report the same capacity.

The serial is what separates two otherwise identical spare batteries. Without
it, the plugin cannot attribute evidence to the right cell.

This data stays in your own state directory. Nothing transmits it.

## Why the plugin learns before it answers

The plugin measures real discharge windows instead of trusting the number the
firmware reports. A window counts only when the battery discharged for the
full window length without interruption.

The model offers a rough, labelled answer after a few windows, and a full
answer after it meets the complete evidence gate. `make status` shows the
progress toward both.

Charging, suspend, a battery swap, missing energy readings, and an implausible
draw all stop a window from counting. They never delete evidence you already
have.

## Why some durations start with `>`

The tracker polls every few minutes. It cannot see what happened between two
polls.

When the tracker observed the plug or unplug itself, it shows an exact
duration. When it did not, it shows `> 5m`, which means **at least five
minutes**. The real session started earlier, but the tracker will not invent a
start time it never saw.

The `>` disappears after the next real plug or unplug.

## Why a restart is explained, not just reported

When the machine sleeps, reboots, or the tracker stops, the plugin records
what happened rather than only noticing that time passed. `make status` names
the cause: the machine was suspended, the machine was off, the tracker was not
running, or the clock changed.

The interrupted window stays on file. It never counts as evidence.

## Why the estimate has a range

`Range` shows a p25–p75 band. Half of that battery's recorded windows fall
inside it.

A heavier draw buys less time. The heavier quarter of the windows therefore
sets the **low** edge of the range.
