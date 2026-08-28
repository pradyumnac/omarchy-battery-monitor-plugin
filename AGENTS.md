# Agent essentials

Authoritative source for repo layout and operating constraints. Other docs
(`README.md`, `CONTRIBUTING.md`) link here instead of restating these.

## Repo map

| Path | What's there |
| --- | --- |
| `Panel.qml`, `Model.js`, `manifest.json` | The Omarchy bar widget |
| `service/` | The tracker, the monitor, and their systemd units — installed and run long-term |
| `scripts/` | `install`/`uninstall`/`preflight` — one-shot, run by `make` |
| `tests/` | Node test suite (`make test`) |
| `docs/user/` | End-user docs: install, uninstall, notifications |
| `docs/dev/` | Contributor docs: architecture, state file, requirements spec |

## Constraints

- Keep runtime state, host paths, credentials, serials, and personal data out
  of Git.
- Write files only below the current user's home directory, including tests
  and configurable install/state paths.
- Keep the plugin desktop-safe. Do not require root or edit
  `/usr/share/omarchy`.

## Commands

- Run `make check` before committing.
- Use `make install` / `make uninstall` for installation and removal.
