# Not published to the AUR. This file exists as the authoritative, machine-
# readable dependency list for the plugin — `depends` below is what a fresh
# Arch install actually needs, and scripts/battery-session-preflight.sh checks
# the same set at install time.
#
# Packaging this properly is deferred: the plugin installs user-level systemd
# units and a per-user state directory, which a system package cannot own
# cleanly. `make install` from a git checkout stays the supported path.

pkgname=omarchy-battery-monitor-plugin
pkgver=1.0.0
pkgrel=1
pkgdesc="A compact battery and power-session monitor for Omarchy laptops"
arch=('any')
url="https://github.com/pradyumnac/omarchy-battery-monitor-plugin"
license=('MIT')

depends=(
  'bash>=4.3'       # namerefs and associative arrays
  'gawk'            # every model computation; mawk works too
  'coreutils'       # sort, tail, cat, mv, realpath, id
  'systemd'         # user timer and services
  'upower'          # power-event monitor and the panel's live D-Bus data
  'omarchy'         # the shell that hosts the panel and the power profiles
  'zip'             # make export's archive step
)

optdepends=(
  'libnotify: desktop notifications on plug and unplug'
  # make graph-charge / graph-health render SVG with awk alone. These two
  # only turn that SVG into a picture in the terminal; FORMAT=svg needs
  # neither, so neither belongs in depends.
  'librsvg: rasterize a chart for make graph-charge / graph-health'
  'chafa: show a chart in the terminal for make graph-charge / graph-health'
)

makedepends=()

checkdepends=(
  'nodejs'          # `make test` only; never on the runtime path
  'qt6-declarative' # `make check` runs qmllint
)
