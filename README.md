# Omarchy Battery Monitor Plugin

> One clear power view for every battery in your Omarchy laptop.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Omarchy](https://img.shields.io/badge/Omarchy-compatible-7f5af0)](https://omarchy.org/)

![Omarchy Battery Monitor Plugin](screenshots/power-panel.png)

Built for dual-battery ThinkPads and other UPower laptops. See the combined
picture at a glance, then inspect each physical battery when you need detail.

## Highlights

- Combined charge, capacity, power rate, and time estimate in the bar
- Per-battery health, energy, cycles, percentage, and state in the panel
- A `Plugged` notification when the charger connects, and an `Unplugged`
  notification with the session summary when it disconnects
- Charging and on-battery session timing
- Built-in power-profile controls
- User-level installation with no root service
- Hidden automatically on desktops with no laptop battery, and refused at
  install time on the same hardware

### Per-battery detail

![Panel detail: BAT0 and BAT1 side by side](screenshots/panel-detail.png)

> Screenshot pending — see
> [screenshot checklist](docs/dev/screenshot-checklist.md).

### Session notifications

<table>
<tr><td>

![Plugged notification](screenshots/notify-plugged.png)

> Pending

</td><td>

![Unplugged notification](screenshots/notify-unplugged.png)

> Pending

</td></tr>
</table>

## Install

```sh
git clone https://github.com/pradyumnac/omarchy-battery-monitor-plugin.git
cd omarchy-battery-monitor-plugin
make install
```

Full install, uninstall, and troubleshooting steps:
[docs/user/install.md](docs/user/install.md).

## Learn more

| Doc | For |
| --- | --- |
| [docs/user/install.md](docs/user/install.md) | Install, uninstall, troubleshooting |
| [docs/user/notifications.md](docs/user/notifications.md) | What the panel and each notification mean |
| [docs/dev/architecture.md](docs/dev/architecture.md) | The tracker/monitor state machine, for contributors |
| [docs/dev/state-file-reference.md](docs/dev/state-file-reference.md) | State file field reference |
| [docs/dev/requirements-spec.md](docs/dev/requirements-spec.md) | Test coverage, manual QA checklist, backlog |

## Contributing

See [AGENTS.md](AGENTS.md) for the repo map and operating constraints,
[CONTRIBUTING.md](CONTRIBUTING.md) for the contribution process, and
[CONTRIBUTORS.md](CONTRIBUTORS.md) for project credits.

## License

MIT — see [LICENSE](LICENSE).
