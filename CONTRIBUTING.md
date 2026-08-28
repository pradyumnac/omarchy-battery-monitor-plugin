# Contributing

Thanks for helping improve T480 Omarchy Battery Monitor.

## Before opening a change

1. Check [docs/dev/requirements-spec.md](docs/dev/requirements-spec.md) for
   open backlog and explain the user problem. Issues aren't used for
   tracking — that file is the source of pending work.
2. Keep changes focused and portable across laptops.
3. Follow the constraints in [AGENTS.md](AGENTS.md) — user-level paths only,
   no root, no host-identifying data in Git.

## Local checks

```sh
make check
```

For UI changes, test on a laptop with one and two batteries when possible. Also check that the widget stays hidden on a desktop without laptop batteries.

If your change affects the panel layout or a notification's title/body, update the matching screenshot — see [docs/dev/screenshot-checklist.md](docs/dev/screenshot-checklist.md).

## Pull requests

Include:

- What changed and why
- How it was tested
- Any Omarchy, Quickshell, UPower, or hardware assumptions

Keep commits small and use clear imperative commit messages.
