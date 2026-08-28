# Battery session behavior

The widget uses UPower for live battery display and the user-level tracker for
charge-session history. The tracker polls every 30 seconds, so history times
are approximate.

## Scenario reference

| Scenario | Tracker state | Widget behavior |
| --- | --- | --- |
| Charger connected | `on-charge` | Shows `Charging`, charge rate, and time to full when available. |
| Charger removed | `on-battery` | Shows `On battery`, draw rate, and time remaining when available. |
| Immediately after charger removal | Previous state may still be stored | Live UPower data changes first; `Last` updates after the next tracker poll. |
| Charging transition observed | `last_charge_start` is recorded | The `Charge` session duration uses the observed start time. |
| Charging ends | `last_charge_end` is recorded | `Last` shows elapsed time since charging ended. |
| First tracker run | `state_since=0` | Session duration displays `—` until a transition is observed. |
| Tracker gap over 90 seconds | Continuity is reset | The session duration displays `—` until a new transition is observed. |
| Two physical batteries | Both present laptop batteries are aggregated | Capacity, percentage, energy, and rate use the combined pack. Individual cards show each battery. |
| Charge threshold holds one battery | Battery can be `Not charging` while AC is online | Overall state remains charging or holding according to UPower and threshold data. |
| No laptop battery | No tracker state file is created | The battery widget remains hidden. |
| Mains supply is offline | No online `type=Mains` supply | The tracker records `on-battery`. |
| USB-C or alternate adapter | Supply must report `type=Mains` | Hardware verification is still required for each supported laptop. |
| Missing or malformed command output | Empty payload is ignored | The widget keeps the last valid displayed data where applicable. |

## State fields

The tracker stores state under:

```text
${XDG_STATE_HOME:-$HOME/.local/state}/battery-session/state
```

Important fields are:

- `previous_state`: `on-charge` or `on-battery`.
- `state_since`: start of the current observed state, or `0` when unknown.
- `last_charge_start`: last observed transition into charging.
- `last_charge_end`: last observed transition out of charging.
- `last_observed`: time of the last successful observation.

The tracker records observed transitions, not exact plug events. A transition
can be delayed by the polling interval.

## Testing

Automated tracker tests are in `tests/tracker.test.js`. They cover mains
supply detection, charger removal, charger connection, desktop behavior, and
observation gaps. The QML panel still requires runtime testing in Omarchy.
