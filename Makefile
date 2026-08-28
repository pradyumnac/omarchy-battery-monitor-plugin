# shellcheck disable=all
.PHONY: check test install uninstall reload status intelligence-status preflight doctor

PLUGIN_DIR ?= $(HOME)/.config/omarchy/plugins/doe.power
export PLUGIN_DIR

# Syntax and lint checks only. Run `make test` separately for the test suite.
check:
	bash -n service/battery-session-tracker service/battery-session-monitor service/power-supply.sh scripts/battery-session-preflight scripts/install-session-tracker scripts/uninstall-session-tracker scripts/battery-intelligence-status
	# Service executables exist only after `make install`; verify the static timer here.
	systemd-analyze verify service/battery-session-tracker.timer
	# shellcheck disable=SC1036,SC1088
	qmllint_bin=$$(command -v qmllint 2>/dev/null || command -v /usr/lib/qt6/bin/qmllint 2>/dev/null || true); \
	if [ -n "$$qmllint_bin" ]; then \
		"$$qmllint_bin" \
			--import disable \
			--unqualified disable \
			--required disable \
			--unresolved-type disable \
			--inheritance-cycle disable \
			--signal-handler-parameters disable \
			--incompatible-type disable \
			Panel.qml; \
	else \
		echo "qmllint not installed; skipping QML validation"; \
	fi
	node --check Model.js
	git diff --check

test:
	node --test tests/*.test.js

# Install the plugin and its user-level tracker, then reload the running
# Omarchy shell so it picks up the installed panel and tracker.
install:
	scripts/install-session-tracker
	@$(MAKE) --no-print-directory reload

# Undo `make install`: stop and remove the service, the installed plugin and
# tracker files, and the recorded session state, then reload the running
# Omarchy shell so the panel disappears. The machine is left as if the
# plugin had never been installed.
uninstall:
	scripts/uninstall-session-tracker
	@$(MAKE) --no-print-directory reload

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

# Show service health, recorded observations, and model learning progress.
intelligence-status:
	scripts/battery-intelligence-status

# Check this machine is ready to install, without installing anything.
preflight:
	scripts/battery-session-preflight

# Alias for `make preflight`.
doctor: preflight
