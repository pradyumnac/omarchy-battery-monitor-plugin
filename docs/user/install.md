# Install and uninstall

## Requirements

- Omarchy with Quickshell
- A laptop battery (`make doctor` checks this)
- UPower and `systemctl --user`
- A Nerd Font available to the Omarchy shell

## Install

```sh
git clone https://github.com/pradyumnac/omarchy-battery-monitor-plugin.git
cd omarchy-battery-monitor-plugin
make install
```

`make install` replaces the built-in `omarchy.power` widget with this plugin
in the running Omarchy shell. No manual reload is needed.

If no shell session is running yet, start one:

```sh
omarchy restart shell
```

Installation is user-level and repeatable. It never touches
`/usr/share/omarchy` and never needs root.

## Preflight checks

`make install` runs a preflight check first. It refuses to install when:

- The machine has no laptop battery.
- `upower` or `systemctl --user` is missing.

Run the check on its own, any time:

```sh
make doctor
```

## Uninstall

```sh
make uninstall
```

This reverses `make install` completely:

- Restores the built-in `omarchy.power` widget.
- Stops and removes the tracker service.
- Deletes the plugin and tracker files from
  `~/.config/omarchy/plugins/doe.power`.
- Removes the session state.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `make install` stops with "no present battery" | `make doctor` found no laptop battery | Expected on desktops — the plugin only supports laptops |
| Widget doesn't appear after install | Shell wasn't running during install | Run `omarchy restart shell` |
| `make doctor` reports missing `upower` | UPower isn't installed | Install `upower` through your package manager |
| Notifications don't appear | `battery-session-monitor.service` isn't active | Run `systemctl --user status battery-session-monitor.service` |

See [notifications](notifications.md) for what each notification means.
