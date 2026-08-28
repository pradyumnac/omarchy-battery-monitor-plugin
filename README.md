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

Want the full picture? Read
[charging session experience](docs/charging-session-experience.md) for the
state machine behind every notification, the multi-battery rules, and the
state file the tracker writes.

## Install

```sh
git clone https://github.com/pradyumnac/omarchy-battery-monitor-plugin.git
cd omarchy-battery-monitor-plugin
make install
```

`make install` puts the widget in the bar itself — it rescans and enables the
plugin in the running Omarchy shell, replacing the built-in `omarchy.power`
widget, so no manual reload is needed. If the shell isn't running (no live
session), restart it once you're in one:

```sh
omarchy restart shell
```

Installation is repeatable and stays in your user account. `make install` runs
a preflight check first and refuses to install on a machine with no laptop
battery, or missing `upower` / `systemctl --user`. Run the check on its own,
any time, with:

```sh
make doctor
```

## Uninstall

```sh
make uninstall
```

This disables the widget in the running Omarchy shell (restoring the built-in
`omarchy.power` widget in its place), stops and removes the tracker service,
deletes the installed plugin and tracker files from
`~/.config/omarchy/plugins/doe.power`, and removes the session state. It
undoes `make install` completely, leaving your Omarchy config exactly as it
was before you installed.

## Requirements

- Omarchy with Quickshell
- A laptop battery (`make doctor` verifies this)
- UPower and `systemctl --user`
- A Nerd Font available to the Omarchy shell

## Repo map

| Path | What's there |
| --- | --- |
| `Panel.qml`, `Model.js`, `manifest.json` | The Omarchy bar widget |
| `service/` | The tracker, the monitor, and their systemd units — installed and run long-term |
| `scripts/` | `install`/`uninstall`/`preflight` — one-shot, run by `make` |
| `tests/` | Node test suite (`make test`) |
| `docs/` | [Charging session experience](docs/charging-session-experience.md): the state machine, rules, and state file |

## Contributing

Run `make check` before submitting a change. See
[CONTRIBUTING.md](CONTRIBUTING.md) for testing guidance and
[CONTRIBUTORS.md](CONTRIBUTORS.md) for project credits.

Runtime state stays under `~/.local/state/battery-session/` and is not tracked
by Git.

## License

MIT — see [LICENSE](LICENSE).
