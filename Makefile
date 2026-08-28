.PHONY: check test install status doctor

PLUGIN_DIR ?= $(HOME)/.config/omarchy/plugins/doe.power
export PLUGIN_DIR

check: test
	bash -n tracker/battery-session-tracker tracker/battery-session-monitor tracker/power-supply.sh tracker/battery-session-preflight tracker/install-session-tracker
	# Service executables exist only after `make install`; verify the static timer here.
	systemd-analyze verify tracker/battery-session-tracker.timer
	if command -v qmllint >/dev/null 2>&1; then qmllint Panel.qml; else echo "qmllint not installed; skipping QML validation"; fi
	node --check Model.js
	git diff --check

test:
	node --test tests/*.test.js

# Install the plugin and its user-level tracker. This is the only supported
# installation entry point for standalone clones.
install: check
	tracker/install-session-tracker

status:
	systemctl --user status battery-session-tracker.timer --no-pager
	@cat "$${XDG_STATE_HOME:-$$HOME/.local/state}/battery-session/state" 2>/dev/null || true

# Check this machine is ready to install, without installing anything.
doctor:
	tracker/battery-session-preflight
