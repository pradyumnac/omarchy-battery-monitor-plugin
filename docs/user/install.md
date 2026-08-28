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
and restarts the Omarchy shell so a fresh QML engine loads the installed code.
No manual reload is needed.

Inspect the complete runtime report with:

```sh
make status
```

It prints separated, color-coded sections for service health, raw tracker
state, active-window progress, and the local history used for the `≈ Usual`
runtime estimate. `Usual readiness` shows both requirements as progress —
`X/12 windows` and `Y/3 sessions` — so learning is visible before the estimate
is ready. ANSI colors are automatic on a terminal; use
`NO_COLOR=1 make status` for plain output or
`BATTERY_STATUS_COLOR=always make status` to preserve colors through a pipe.
Runtime data is kept in
`~/.local/state/battery-session/` and never sent over the network.

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

To remove the plugin but retain all locally collected data for a later
reinstall:

```sh
make uninstall
```

This command:

- Restores the built-in `omarchy.power` widget and restarts the Omarchy shell.
- Stops and removes the tracker service.
- Deletes the plugin and tracker files from
  `~/.config/omarchy/plugins/doe.power`.
- Keeps the complete `~/.local/state/battery-session/` directory, including
  current session state, discharge history, and learned intelligence metrics.

To remove the plugin **and permanently purge all collected data**:

```sh
make uninstall-purge-data
```

The purge target removes the entire battery-session state directory and also
restarts the Omarchy shell. Reinstalling after a normal `make uninstall`
resumes with the retained history; reinstalling after
`make uninstall-purge-data` starts learning from scratch.

All three lifecycle targets use a full shell restart rather than an in-process
plugin rescan. Plugin rescans remain useful during development, but their
asynchronous component reload can retain stale QML or JavaScript during a
rapid uninstall/reinstall.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `make install` stops with "no present battery" | `make doctor` found no laptop battery | Expected on desktops — the plugin only supports laptops |
| Widget doesn't appear after install | Shell wasn't running during install | Run `omarchy restart shell` |
| `make doctor` reports missing `upower` | UPower isn't installed | Install `upower` through your package manager |
| Notifications don't appear | `battery-session-monitor.service` isn't active | Run `make status` and inspect **SERVICE STATUS** |

See [notifications](notifications.md) for what each notification means.
