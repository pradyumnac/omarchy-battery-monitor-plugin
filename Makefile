.PHONY: check install status

PLUGIN_DIR ?= $(HOME)/.config/omarchy/plugins/doe.power
export PLUGIN_DIR

check:
	bash -n tracker/battery-session-tracker tracker/install-session-tracker
	# The service executable exists only after `make install`; verify the timer here.
	systemd-analyze verify tracker/battery-session-tracker.timer
	node --check Model.js
	git diff --check

# Install the plugin and its user-level tracker. This is the only supported
# installation entry point for standalone clones.
install: check
	tracker/install-session-tracker

status:
	systemctl --user status battery-session-tracker.timer --no-pager
	@cat "$${XDG_STATE_HOME:-$$HOME/.local/state}/battery-session/state" 2>/dev/null || true
