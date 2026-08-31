# Omarchy Battery Monitor Plugin

> One clear power view for every battery in your Omarchy laptop.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Omarchy](https://img.shields.io/badge/Omarchy-compatible-7f5af0)](https://omarchy.org/)

![Omarchy Battery Monitor Plugin](screenshots/panel-detail.png)

Built for dual-battery ThinkPads and other UPower laptops. See the combined
picture at a glance, then inspect each physical battery when you need detail.

## Highlights

- Combined charge, capacity, power rate, and time estimate in the bar
- Per-battery health, energy, cycles, percentage, and state in the panel
- A runtime model learned per battery, from that battery's own discharge
  windows — a worn cell and a healthy one are never averaged together
- Estimators scored continuously against each battery's held-out evidence, so
  the one in use is the one currently measuring best for that cell
- A `Plugged` notification when the charger connects, and an `Unplugged`
  notification with the session summary when it disconnects
- Charging and on-battery session timing
- Built-in power-profile controls
- User-level installation with no root service
- Hidden automatically on desktops with no laptop battery, and refused at
  install time on the same hardware

## Install

```sh
git clone https://github.com/pradyumnac/omarchy-battery-monitor-plugin.git
cd omarchy-battery-monitor-plugin
make install
```

Full install, uninstall, and troubleshooting steps:
[docs/user/install.md](docs/user/install.md).

## Status

```sh
make status
```

This concise lifecycle report shows service health, then a block per battery —
its identity, its charge and health, and what its own evidence says about it —
followed by the pack summary, model freshness, and actionable warnings. While
learning, each battery shows capped `X/12 windows` and `Y/3 sessions` progress.
Use `make status VERBOSE=1` only for collection diagnostics. See
[check battery and model health](docs/user/status.md) for examples and recovery
steps.

## Other commands

| Command | What it does |
| --- | --- |
| `make view` | Print the aggregated view: the exact JSON document the panel reads |
| `make backtest` | Score each battery's candidate estimators against its own held-out windows |
| `make export` | Bundle raw observations, windows, gaps, and battery state into one zip, for analysis in a notebook |
| `make reextract` | Rebuild windows/gaps/battery-state from raw and diff against the live files (`FORCE=1` to replace them) |
| `make benchmark` | Measure what this plugin costs the battery it monitors |
| `make doctor` | Check this machine can run the tracker, without installing anything |

## Learn more

| Doc | For |
| --- | --- |
| [docs/user/install.md](docs/user/install.md) | Install, uninstall, troubleshooting |
| [docs/user/notifications.md](docs/user/notifications.md) | What the panel and each notification mean |
| [docs/user/status.md](docs/user/status.md) | How to check battery/model health and respond to warnings |
| [docs/dev/architecture.md](docs/dev/architecture.md) | Why the tracker, model, and monitor work this way |
| [docs/dev/status-output-reference.md](docs/dev/status-output-reference.md) | Status fields and lifecycle-state contract |
| [docs/dev/view-reference.md](docs/dev/view-reference.md) | The aggregated view: the contract every consumer reads |
| [docs/dev/state-file-reference.md](docs/dev/state-file-reference.md) | Persisted state, history schema, and selected estimators |
| [docs/research/battery-runtime-modelling.md](docs/research/battery-runtime-modelling.md) | Why the model is what it is, and the open questions |
| [docs/dev/requirements-spec.md](docs/dev/requirements-spec.md) | Test coverage, manual QA checklist, backlog |

## Repo map

| Path | What's there |
| --- | --- |
| `Panel.qml`, `Model.js`, `manifest.json` | The Omarchy bar widget |
| `service/` | The tracker, the monitor, the model rules, the aggregated view, and their systemd units — installed and run long-term |
| `scripts/` | `install`/`uninstall`/`preflight`, plus `status`/`backtest`/`export`/`reextract` — one-shot, run by `make` |
| `tests/` | Node test suite (`make test`) |
| `docs/user/` | Goal-oriented user guides and user-facing explanations |
| `docs/dev/` | Contributor explanations, reference, and verification specs |
| `docs/research/` | Background research, not implementation decisions |

## Constraints

- Keep runtime state, host paths, credentials, and personal data out of Git.
  Battery identity — vendor, model, serial — *is* recorded in the user's own
  state directory, because evidence has to be anchored to the cell that
  produced it; it is never committed and never transmitted.
- Write files only below the current user's home directory, including tests
  and configurable install/state paths.
- Keep the plugin desktop-safe. Do not require root or edit
  `/usr/share/omarchy`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution process
(includes `make check` / `make install` / `make uninstall`).

## License

MIT — see [LICENSE](LICENSE).
