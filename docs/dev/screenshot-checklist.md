# Screenshot checklist

Tracks the screenshots the docs reference, where each one is used, and
whether it's current. Update this table whenever `Panel.qml` or a
notification body changes shape — a stale screenshot is worse than none.

| State | Used in | File | Status |
| --- | --- | --- | --- |
| Bar + panel, combined view | `README.md` hero | `screenshots/power-panel.png` | Current |
| Per-battery panel detail (BAT0 + BAT1 side by side) | `docs/user/notifications.md` | `screenshots/panel-detail.png` | Pending |
| `Plugged` notification | `docs/user/notifications.md` | `screenshots/notify-plugged.png` | Pending |
| `Plugged` with charge-threshold block | `docs/user/notifications.md` | `screenshots/notify-threshold.png` | Pending |
| `Unplugged` notification | `docs/user/notifications.md` | `screenshots/notify-unplugged.png` | Pending |

## Capture steps

1. Connect the charger with BAT0 and BAT1 present. Capture the panel detail
   view before the charger settles.
2. Wait for the `Plugged` notification. Capture it.
3. If a battery holds at its charge threshold, capture that variant of
   `Plugged` separately.
4. Disconnect the charger. Capture the `Unplugged` notification.
5. Crop to the UI element only. Remove hostnames, serial numbers, and any
   personal notification content.
6. Save under `screenshots/` using the file names in the table above, then
   flip **Status** to `Current` and mark the file as tracked in Git.

## When to recapture

- Panel layout or field set changes → `panel-detail.png`, hero.
- Notification title or body format changes → the matching `notify-*.png`.
- A new laptop model becomes the reference machine → hero, panel detail.
