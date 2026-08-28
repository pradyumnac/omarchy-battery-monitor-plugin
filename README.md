# Omarchy Battery Monitor Plugin

> One clear power view for every battery in your Omarchy laptop.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Omarchy](https://img.shields.io/badge/Omarchy-compatible-7f5af0)](https://omarchy.org/)

![Omarchy Battery Monitor Plugin](screenshots/power-panel.png)

Built for dual-battery ThinkPads and other UPower laptops. See the combined
picture at a glance, then inspect each physical battery when you need detail.

## Highlights

- Combined charge, capacity, power rate, and time estimate
- Per-battery health, energy, cycles, percentage, and state
- Charging and on-battery session timing
- Built-in power-profile controls
- User-level installation with no root service
- Hidden automatically on desktops without laptop batteries

Want the details? Read the
[charging session experience](docs/charging-session-experience.md) for power
transitions, timing, multi-battery behavior, and the notification UX plan.

## Install

```sh
git clone https://github.com/pradyumnac/omarchy-battery-monitor-plugin.git
cd omarchy-battery-monitor-plugin
make install
```

Reload the Omarchy shell:

```sh
omarchy-shell shell rescanPlugins
omarchy restart shell
```

Installation is repeatable and stays in your user account.

## Requirements

- Omarchy with Quickshell
- UPower and `systemctl --user`
- A Nerd Font available to the Omarchy shell

## Contributing

Run `make check` before submitting a change. See
[CONTRIBUTING.md](CONTRIBUTING.md) for testing guidance and
[CONTRIBUTORS.md](CONTRIBUTORS.md) for project credits.

Runtime state stays under `~/.local/state/battery-session/` and is not tracked
by Git.

## License

MIT — see [LICENSE](LICENSE).
