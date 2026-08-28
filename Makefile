# shellcheck disable=all
.PHONY: check test install uninstall uninstall-purge-data reload restart-shell status preflight doctor

PLUGIN_DIR ?= $(HOME)/.config/omarchy/plugins/doe.power
export PLUGIN_DIR

# Syntax and lint checks only. Run `make test` separately for the test suite.
check:
	bash -n service/battery-session-tracker.sh service/battery-session-monitor.sh service/power-supply.sh scripts/battery-session-preflight.sh scripts/install-session-tracker.sh scripts/uninstall-session-tracker.sh scripts/battery-intelligence-status.sh
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

# Install the plugin and its user-level tracker, then restart the running
# Omarchy shell so no stale QML or JavaScript component survives the update.
install:
	scripts/install-session-tracker.sh
	@$(MAKE) --no-print-directory restart-shell

# Undo `make install`: stop and remove the service and installed plugin files,
# retain recorded session/intelligence data for a later reinstall, then reload
# the running Omarchy shell so the panel disappears.
uninstall:
	scripts/uninstall-session-tracker.sh --keep-data
	@$(MAKE) --no-print-directory restart-shell

# Perform a complete uninstall, including all recorded session state,
# discharge history, and intelligence metrics.
uninstall-purge-data:
	scripts/uninstall-session-tracker.sh
	@$(MAKE) --no-print-directory restart-shell

# Ask the running Omarchy shell to rescan and reload plugins in place, so it
# picks up this plugin's changes without restarting the whole shell process.
# A no-op if the shell isn't reachable (e.g. no live Omarchy/Hyprland session).
reload:
	@if command -v omarchy-shell >/dev/null 2>&1; then \
		omarchy-shell -q shell rescanPlugins; \
	else \
		echo "omarchy-shell not found; rescan plugins manually to pick up changes."; \
	fi

# Lifecycle operations require a fresh QML engine: plugin rescans are
# asynchronous and can retain stale components across a rapid remove/reinstall.
restart-shell:
	@if command -v omarchy >/dev/null 2>&1; then \
		omarchy restart shell; \
	else \
		echo "omarchy not found; restart the shell manually to apply lifecycle changes."; \
	fi

# Show service health, raw tracker state, and intelligence progress in one
# TTY-aware, color-coded report. NO_COLOR disables ANSI styling.
status:
	@color=0; color_mode="$${BATTERY_STATUS_COLOR:-auto}"; \
	if [ -z "$${NO_COLOR:-}" ]; then \
		case "$$color_mode" in \
			always) color=1 ;; \
			never) color=0 ;; \
			auto) [ -t 1 ] && color=1 ;; \
			*) printf 'Invalid BATTERY_STATUS_COLOR: %s (expected auto, always, or never)\n' "$$color_mode" >&2; exit 2 ;; \
		esac; \
	fi; \
	if [ "$$color" -eq 1 ]; then \
		bold=$$(printf '\033[1m'); cyan=$$(printf '\033[36m'); \
		blue=$$(printf '\033[34m'); yellow=$$(printf '\033[33m'); \
		reset=$$(printf '\033[0m'); \
		export SYSTEMD_COLORS=1 BATTERY_STATUS_COLOR=always; \
	else \
		bold=; cyan=; blue=; yellow=; reset=; \
		export SYSTEMD_COLORS=0 BATTERY_STATUS_COLOR=never; \
	fi; \
	section() { \
		printf '\n%b%s%b\n%b%s%b\n' "$$bold$$cyan" "$$1" "$$reset" \
			"$$blue" '────────────────────────────────────────' "$$reset"; \
	}; \
	section 'SERVICE STATUS'; \
	systemctl --user status battery-session-tracker.timer \
		battery-session-monitor.service --no-pager || true; \
	section 'TRACKER STATE'; \
	state_file="$${XDG_STATE_HOME:-$$HOME/.local/state}/battery-session/state"; \
	if [ -f "$$state_file" ]; then \
		awk -F= -v cyan="$$cyan" -v reset="$$reset" '{ \
			separator = index($$0, "="); \
			if (separator > 0) \
				printf "  %s%s%s = %s\n", cyan, substr($$0, 1, separator - 1), reset, substr($$0, separator + 1); \
			else print "  " $$0; \
		}' "$$state_file"; \
	else \
		printf '  %bWaiting for first tracker poll%b\n' "$$yellow" "$$reset"; \
	fi; \
	section 'BATTERY INTELLIGENCE'; \
	scripts/battery-intelligence-status.sh

# Check this machine is ready to install, without installing anything.
preflight:
	scripts/battery-session-preflight.sh

# Alias for `make preflight`.
doctor: preflight
