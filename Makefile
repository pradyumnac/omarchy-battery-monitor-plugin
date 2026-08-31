# shellcheck disable=all
.PHONY: check test install uninstall uninstall-purge-data reload restart-shell status view backtest export reextract benchmark preflight doctor

PLUGIN_DIR ?= $(HOME)/.config/omarchy/plugins/doe.power
export PLUGIN_DIR

# Syntax and lint checks only. Run `make test` separately for the test suite.
check:
	bash -n service/battery-session-tracker.sh service/battery-session-monitor.sh service/power-supply.sh service/battery-model.sh service/battery-view.sh scripts/battery-session-preflight.sh scripts/install-session-tracker.sh scripts/uninstall-session-tracker.sh scripts/plugin-files.sh scripts/battery-intelligence-status.sh scripts/battery-backtest.sh scripts/battery-export.sh scripts/battery-reextract.sh
	# Service executables exist only after `make install`; verify the static timer here.
	systemd-analyze verify service/battery-session-tracker.timer
	# The flags below are Qt6-only, so prefer the Qt6 binary explicitly —
	# `qmllint` on PATH may resolve to a Qt5 build that rejects them.
	# shellcheck disable=SC1036,SC1088
	qmllint_bin=$$(command -v /usr/lib/qt6/bin/qmllint 2>/dev/null || command -v qmllint 2>/dev/null || true); \
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

# Show concise service health, current battery facts, and model readiness.
# Output is TTY-aware; NO_COLOR disables ANSI styling.
status:
	@BATTERY_STATUS_VERBOSE="$${VERBOSE:-0}" scripts/battery-intelligence-status.sh

# Print the aggregated view: the exact JSON document Panel.qml reads. This is
# the seam — anything the panel or a future widget shows has to appear here.
view:
	@service/battery-view.sh

# Score the runtime model against the recorded windows. No model change ships
# without a measurable improvement here; see docs/research/. `make backtest
# WINDOWS=path/to/windows.tsv` scores a file other than the live one.
backtest:
	@scripts/battery-backtest.sh $(WINDOWS)

# Bundle every tier of collected data (raw, windows, gaps, battery-state) into
# one zip in ~/Downloads, for analysis in a notebook. `make export DEST=dir`
# writes elsewhere.
export:
	@scripts/battery-export.sh $(DEST)

# Rebuild windows.tsv, gaps.tsv, and battery-state.tsv from raw observations
# and diff against the live files (ADR-0001). The tracker derives these
# incrementally with the same extraction function; a clean diff is the
# standing proof the two paths agree. `make reextract FORCE=1` replaces the
# live files with the freshly regenerated ones.
reextract:
	@scripts/battery-reextract.sh $(if $(FORCE),--force,)

# Measure what this plugin costs the battery it monitors: CPU time charged to
# each unit, and the exact number of processes one tracker poll forks.
benchmark:
	@printf 'Accumulated CPU time per unit\n'
	@for unit in battery-session-tracker.service battery-session-monitor.service; do \
		printf '  %-40s %s\n' "$$unit" \
			"$$(systemctl --user show -p CPUUsageNSec --value $$unit 2>/dev/null || echo 'n/a')"; \
	done
	@printf '\nProcesses forked by one tracker poll\n'
	@if command -v strace >/dev/null 2>&1; then \
		strace -f -c -e trace=execve service/battery-session-tracker.sh --once 2>&1 \
			| tail -n 3; \
	else \
		echo "  strace not installed; install it for an exact per-run fork count"; \
	fi
	@printf '\nProcesses forked by one view read\n'
	@if command -v strace >/dev/null 2>&1; then \
		strace -f -c -e trace=execve service/battery-view.sh 2>&1 >/dev/null | tail -n 3; \
	else \
		echo "  strace not installed"; \
	fi

# Check this machine is ready to install, without installing anything.
preflight:
	scripts/battery-session-preflight.sh

# Alias for `make preflight`.
doctor: preflight
