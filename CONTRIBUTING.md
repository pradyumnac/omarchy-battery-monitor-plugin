# Contributing

Thanks for helping improve T480 Omarchy Battery Monitor.

## Before opening a change

1. Search existing issues and explain the user problem.
2. Keep changes focused and portable across laptops; do not commit host paths, battery serials, logs, screenshots with personal data, or credentials.
3. Prefer user-level paths and services. Do not require root or modify `/usr/share/omarchy`.

## Local checks

```sh
make check
```

For UI changes, test on a laptop with one and two batteries when possible. Also check that the widget stays hidden on a desktop without laptop batteries.

## Pull requests

Include:

- What changed and why
- How it was tested
- Any Omarchy, Quickshell, UPower, or hardware assumptions

Keep commits small and use clear imperative commit messages.
