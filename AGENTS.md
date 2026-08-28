# Agent essentials

- `Panel.qml`, `Model.js`, and `manifest.json` are the Omarchy plugin.
- `tracker/` contains the user-level session tracker and systemd timer.
- Run `make check` before committing; use `make install` for installation.
- Keep runtime state, host paths, credentials, serials, and personal data out
  of Git.
- Write files only below the current user's home directory, including tests
  and configurable install/state paths.
- Keep the plugin desktop-safe. Do not require root or edit
  `/usr/share/omarchy`.
