#!/usr/bin/env bash
# The one list of files this plugin installs. Sourced by both
# install-session-tracker.sh and uninstall-session-tracker.sh so the two can
# never drift — before this list existed, uninstall removed an AGENTS.md that
# install never wrote.

# Plugin root: what the Omarchy shell loads.
plugin_root_files=(
  Panel.qml
  Model.js
  manifest.json
  README.md
  LICENSE
)

# Lifecycle scripts: run once, by hand or by make.
plugin_admin_files=(
  battery-session-preflight.sh
  install-session-tracker.sh
  uninstall-session-tracker.sh
  plugin-files.sh
)

# Services and libraries: the tracker, the monitor, their units, and the
# aggregated view every consumer reads.
plugin_service_files=(
  battery-session-tracker.sh
  battery-session-tracker.service
  battery-session-tracker.timer
  battery-session-monitor.sh
  battery-session-monitor.service
  power-supply.sh
  battery-model.sh
  battery-view.sh
)

# Everything above that must be executable once installed.
plugin_executables=(
  scripts/battery-session-preflight.sh
  scripts/install-session-tracker.sh
  scripts/uninstall-session-tracker.sh
  service/battery-session-tracker.sh
  service/battery-session-monitor.sh
  service/battery-view.sh
)
