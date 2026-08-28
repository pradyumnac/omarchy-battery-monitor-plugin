# Agent essentials

- `Panel.qml`, `Model.js`, and `manifest.json` are the Omarchy plugin.
- `service/` contains the tracker, the monitor, and their systemd units.
- `scripts/` contains the one-shot install/uninstall/preflight scripts.
- Run `make check` before committing; use `make install` / `make uninstall`
  for installation and removal.
- Keep runtime state, host paths, credentials, serials, and personal data out
  of Git.
- Write files only below the current user's home directory, including tests
  and configurable install/state paths.
- Keep the plugin desktop-safe. Do not require root or edit
  `/usr/share/omarchy`.
