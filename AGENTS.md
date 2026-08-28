# Agent essentials

- `Panel.qml`, `Model.js`, and `manifest.json` are the Omarchy plugin.
- `tracker/` contains the user-level session tracker and systemd timer.
- Run `make check` before committing; use `make install` for installation.
- Keep runtime state, host paths, credentials, serials, and personal data out of Git.
- Keep the plugin desktop-safe and avoid root requirements or edits to `/usr/share/omarchy`.
