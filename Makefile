.PHONY: check test install uninstall reload status doctor

PLUGIN_DIR ?= $(HOME)/.config/omarchy/plugins/doe.power
export PLUGIN_DIR

# Syntax and lint checks only. Run `make test` separately for the test suite.
check:
	bash -n tracker/battery-session-tracker tracker/battery-session-monitor tracker/power-supply.sh tracker/battery-session-preflight tracker/install-session-tracker tracker/uninstall-session-tracker
	# Service executables exist only after `make install`; verify the static timer here.
	systemd-analyze verify tracker/battery-session-tracker.timer
	qmllint_bin=$$(command -v qmllint 2>/dev/null || command -v /usr/lib/qt6/bin/qmllint 2>/dev/null || true); \
	if [ -n "$$qmllint_bin" ]; then "$$qmllint_bin" Panel.qml; else echo "qmllint not installed; skipping QML validation"; fi
	node --check Model.js
	git diff --check

test:
	node --test tests/*.test.js

# Install the plugin and its user-level tracker, then reload the running
# Omarchy shell so it picks up the installed panel and tracker.
install: check
	tracker/install-session-tracker
	$(MAKE) reload

# Undo `make install`: stop and remove the service, the installed plugin and
# tracker files, and the recorded session state, then reload the running
# Omarchy shell so the panel disappears. The machine is left as if the
# plugin had never been installed.
uninstall:
	tracker/uninstall-session-tracker
	$(MAKE) reload

# Ask the running Omarchy shell to rescan and reload plugins in place, so it
# picks up this plugin's changes without restarting the whole shell process.
# A no-op if the shell isn't reachable (e.g. no live Omarchy/Hyprland session).
reload:
	@if command -v omarchy-shell >/dev/null 2>&1; then \
		omarchy-shell -q shell rescanPlugins; \
	else \
		echo "omarchy-shell not found; rescan plugins manually to pick up changes."; \
	fi

status:
	systemctl --user status battery-session-tracker.timer --no-pager
	@cat "$${XDG_STATE_HOME:-$$HOME/.local/state}/battery-session/state" 2>/dev/null || true

# Check this machine is ready to install, without installing anything.
doctor:
	tracker/battery-session-preflight
