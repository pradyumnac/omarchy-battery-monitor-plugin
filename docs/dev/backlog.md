# Backlog

Audience: contributors who pick up pending work.

This file is the only record of pending work. GitHub issue tracking was
retired, because issue bookkeeping cost more contributor time than a project
of this size justifies. Closed issues carry a comment that points here.

## Open

| Case | Question | Notes |
| --- | --- | --- |
| Mains change entirely inside a gap | Can a plug and unplug that both happen during one suspend be recovered? | The gap is classified, but the moment of a hidden transition inside it is not. See [architecture](architecture.md#open-edge-cases) |
| Last battery removed at runtime | Does the panel degrade to hidden if the battery never returns? | Preflight already refuses on zero-battery machines. This is the runtime case |
| Real-hardware verification | Confirm settle time and notification text on laptops other than the T480 | Was issue #4 |
| Health and discharge graphs | Add `make` targets that plot battery health and discharge over a chosen duration | Deferred in [ADR-0001](../adr/0001-raw-observation-tier.md), now that the raw tier exists to draw from |

## Archived issues

| Issue | Was about | Where it lives now |
| --- | --- | --- |
| #2 | Slice 2: summarize a completed charging session | Covered by the suite. See [testing](testing.md) |
| #3 | Slice 3: harden transition notifications | Covered by the suite. See [testing](testing.md) |
| #4 | Verify charging notifications on supported hardware | [Open](#open), "Real-hardware verification" |
