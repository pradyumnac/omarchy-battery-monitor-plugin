import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Services.UPower
import qs.Commons
import qs.Ui
import "Model.js" as Model

Panel {
  id: root
  moduleName: "omarchy.power"
  ipcTarget: "omarchy.power"
  // manageIpc: false so this panel can own the single IpcHandler the target
  // permits — needed for the togglePercentage method below.
  manageIpc: false
  property var batteryInfo: ({})
  property var systemInfo: ({})
  property var batteryDetails: ({})
  property var chargeHistory: ({})
  property real uptimeSeconds: 0
  property real nowEpochSeconds: Date.now() / 1000
  readonly property string systemUptimeStr: Model.formatElapsed(root.uptimeSeconds)
  readonly property string sinceChargeStr: {
    var start = Number(root.chargeHistory.stateStartEpoch || 0)
    if (root.chargeHistory.state === "on-charge") {
      start = start || Number(root.chargeHistory.chargeStartEpoch || 0)
    }
    if (!(start > 0)) return "—"
    return Model.formatSessionDuration(root.nowEpochSeconds - start)
  }
  readonly property string lastChargeEndStr: root.chargeHistory.state === "on-charge"
    ? "—"
    : Model.formatHoursSince(root.chargeHistory.chargeEndEpoch, root.nowEpochSeconds)
  readonly property var laptopBatteries: Model.getLaptopBatteries(UPower.devices)
  // UPower can expose a display device on desktops too (for example AC power
  // or a UPS). Treat actual laptop batteries as the only reliable signal for
  // showing this battery-focused widget and its power-profile controls.
  readonly property bool hasLaptopBattery: root.laptopBatteries.length > 0
  readonly property real combinedEnergyCapacity: Model.totalEnergyCapacity(root.laptopBatteries)
  readonly property real combinedEnergy: Model.totalEnergy(root.laptopBatteries)
  readonly property real combinedChangeRate: {
    var rate = Model.totalChangeRate(root.laptopBatteries)
    if (rate > 0) return rate
    var r = parseFloat(root.batteryInfo.rate)
    return isNaN(r) ? 0 : r
  }
  readonly property string combinedCapacityStr: {
    if (combinedEnergyCapacity > 0) return Math.round(combinedEnergyCapacity) + "Wh"
    return root.batteryInfo.size || ""
  }
  readonly property string combinedRateStr: {
    if (combinedChangeRate > 0.05) return combinedChangeRate.toFixed(1) + "W"
    return root.batteryInfo.rate || "-"
  }
  // Time to empty/full computed from the combined pack, not whichever single
  // battery `omarchy-battery-status` happened to report on.
  readonly property string combinedTimeStr: {
    var label = Model.aggregateTimeLabel(root.combinedEnergy, root.combinedEnergyCapacity, root.combinedChangeRate, root.discharging)
    return label || root.batteryInfo.time || "—"
  }
  property var profiles: []
  property string activeProfile: ""
  property int profileIndex: 0
  property bool cursorActive: false
  readonly property bool showPercentage: setting("showPercentage", false) === true
  // With the percentage shown the button paints a text block wider than an
  // icon, so the open-panel mark takes the painted width instead of the
  // icon-sized fraction of the slot the fallback assumes.
  readonly property real openPanelIndicatorWidth: showPercentage && !button.vertical ? button.glyphPaintedWidth : 0
  readonly property bool batteryPresent: root.hasLaptopBattery

  function upowerStates() {
    return {
      Charging: UPowerDeviceState.Charging,
      Discharging: UPowerDeviceState.Discharging,
      FullyCharged: UPowerDeviceState.FullyCharged,
      PendingCharge: UPowerDeviceState.PendingCharge
    }
  }

  function selectProfileByDelta(delta) {
    profileIndex = Model.selectProfileIndex(profileIndex, delta, profiles)
  }

  function activateSelectedProfile() {
    if (profileIndex < 0 || profileIndex >= profiles.length) return
    setProfile(profiles[profileIndex])
  }

  function batteryIcon() {
    var device = UPower.displayDevice
    return Model.batteryIcon(device, root.batteryFraction, root.discharging, upowerStates())
  }

  function modeLabel() {
    var device = UPower.displayDevice
    return Model.modeLabel(device, root.batteryFraction, root.discharging, upowerStates())
  }

  function profileIcon(name) {
    return Model.profileIcon(name)
  }

  readonly property bool fullyCharged: {
    var device = UPower.displayDevice
    return device && device.isPresent && device.state === UPowerDeviceState.FullyCharged && !root.chargeThresholdActive
  }
  readonly property bool discharging: {
    var device = UPower.displayDevice
    return !!(device && device.isPresent && UPower.onBattery)
  }
  readonly property bool chargeThresholdActive: {
    var device = UPower.displayDevice
    return Model.chargeThresholdActive(device, root.batteryFraction, root.discharging, upowerStates())
  }
  readonly property bool batteryFull: fullyCharged || (!root.discharging && batteryFraction >= 1)
  readonly property bool batteryFlowIdle: batteryFull || chargeThresholdActive

  // 0..1 charge level across the whole pack (all physical batteries combined),
  // not just whichever one UPower happens to call the "display device". Used
  // by the bar icon, the hero percentage, and the progress bar.
  readonly property real batteryFraction: Model.aggregateFraction(root.laptopBatteries, UPower.displayDevice)

  readonly property bool charging: {
    var d = UPower.displayDevice
    return d && d.isPresent && !UPower.onBattery && !root.batteryFlowIdle
  }

  readonly property color batteryFillColor: {
    return root.bar ? root.bar.foreground : Color.foreground
  }

  // Cute agent-flavored phrases shown in the hero status line, rotated on a
  // timer so the panel feels alive when current is flowing (either direction).
  readonly property var chargingPhrases: [
    "Pumping power",
    "Injecting electrons",
    "Pouring juice",
    "Amassing watts",
    "Hoarding joules",
    "Sucking volts",
    "Topping reserves",
    "Soaking amps",
    "Inhaling kilowatts"
  ]
  readonly property var onBatteryPhrases: [
    "Slurping power",
    "Spending joules",
    "Draining watts",
    "Burning electrons",
    "Sipping juice",
    "Spending coulombs",
    "Bleeding amps",
    "Guzzling volts",
    "Munching reserves"
  ]
  property int phraseIndex: 0

  // Whichever list is "active" given the current power state.
  readonly property var activePhrases: {
    if (fullyCharged) return []
    if (charging) return chargingPhrases
    if (discharging) return onBatteryPhrases
    return []
  }
  readonly property bool rotatingPhrases: activePhrases.length > 0

  readonly property string heroStatusText: {
    if (fullyCharged) return "Fully charged"
    if (rotatingPhrases) return activePhrases[phraseIndex % activePhrases.length]
    return modeLabel()
  }

  function refresh() {
    if (!batteryPresent) return

    if (!batteryProc.running) batteryProc.running = true
    if (!profilesProc.running) profilesProc.running = true
    if (!uptimeProc.running) uptimeProc.running = true
    root.nowEpochSeconds = Date.now() / 1000
    if (!systemProc.running) systemProc.running = true
    if (!chargeHistoryProc.running) chargeHistoryProc.running = true
    if (!batDetailsProc.running) batDetailsProc.running = true
  }

  function updateKeyValue(raw, targetName) {
    var next = Model.parseKeyValue(raw)
    // Keep last known good data if a refresh briefly returns nothing — happens
    // around AC plug/unplug events. Avoids the section collapsing mid-transition.
    if (Object.keys(next).length === 0) return
    if (targetName === "battery") batteryInfo = next
    else systemInfo = next
  }

  function updateSessionState(raw) {
    var next = Model.parseKeyValue(raw)
    if (Object.keys(next).length === 0) return
    chargeHistory = {
      stateStartEpoch: Number(next.state_since || 0),
      chargeStartEpoch: Number(next.last_charge_start || 0),
      chargeEndEpoch: Number(next.last_charge_end || 0),
      state: next.previous_state || ""
    }
  }

  function updateProfiles(raw) {
    var parsed = Model.parseProfiles(raw, profileIndex)
    // Same guard as battery: preserve the last known profile list across
    // transient empty payloads so the buttons don't blink out.
    if (parsed.profiles.length === 0) return
    profiles = parsed.profiles
    activeProfile = parsed.activeProfile
    profileIndex = parsed.profileIndex
    if (opened && !cursorActive) {
      var idx = profiles.indexOf(activeProfile)
      if (idx >= 0) profileIndex = idx
    }
  }

  function setProfile(profile) {
    if (!profile || actionProc.running) return
    actionProc.command = ["omarchy-powerprofiles-set", root.discharging ? "battery" : "ac", profile]
    actionProc.running = true
  }

  function togglePercentage() {
    root.settings = Object.assign({}, root.settings, { showPercentage: !root.showPercentage })
    if (root.bar && root.bar.shell) root.bar.shell.updateEntryInline(root.moduleName, root.settings)
  }

  IpcHandler {
    target: "omarchy.power"

    function open() { root.open() }
    function close() { root.close() }
    function show() { root.open() }
    function hide() { root.close() }
    function toggle() { root.toggle() }
    function togglePercentage() { root.togglePercentage() }
  }

  onOpenedChanged: {
    if (opened) {
      if (!batteryPresent) {
        close()
        return
      }

      refresh()
      var idx = profiles.indexOf(activeProfile)
      profileIndex = idx >= 0 ? idx : 0
      cursorActive = false
    }
  }

  onBatteryPresentChanged: if (!batteryPresent) close()

  visible: batteryPresent
  implicitWidth: batteryPresent ? button.implicitWidth : 0
  implicitHeight: batteryPresent ? button.implicitHeight : 0

  Process {
    id: batteryProc
    command: ["omarchy-battery-status", "--shell"]
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: root.updateKeyValue(text, "battery") }
  }

  Process {
    id: profilesProc
    command: ["omarchy-powerprofiles-list", "--active-state"]
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: root.updateProfiles(text) }
  }

  Process {
    id: systemProc
    command: ["omarchy-system-stats"]
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: root.updateKeyValue(text, "system") }
  }

  Process {
    id: uptimeProc
    command: ["cat", "/proc/uptime"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.uptimeSeconds = Model.parseUptime(text)
    }
  }

  Process {
    id: chargeHistoryProc
    command: ["sh", "-c", "cat \"${XDG_STATE_HOME:-$HOME/.local/state}/battery-session/state\" 2>/dev/null"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.updateSessionState(text)
    }
  }

  Process {
    id: actionProc
    onExited: root.refresh()
  }

  Process {
    id: batDetailsProc
    command: ["sh", "-c", "for b in /sys/class/power_supply/BAT*; do [ -d \"$b\" ] && echo \"$(basename \"$b\")\t$(cat \"$b/cycle_count\" 2>/dev/null || echo '')\t$(cat \"$b/model_name\" 2>/dev/null || echo '')\t$(cat \"$b/manufacturer\" 2>/dev/null || echo '')\"; done"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var lines = String(text || "").split("\n")
        var map = {}
        for (var i = 0; i < lines.length; i++) {
          var parts = lines[i].split("\t")
          if (parts.length >= 2 && parts[0]) {
            map[parts[0]] = {
              cycles: parts[1] || "",
              model: parts[2] || "",
              vendor: parts[3] || ""
            }
          }
        }
        root.batteryDetails = map
      }
    }
  }

  Timer { interval: 5000; running: root.opened; repeat: true; onTriggered: root.refresh() }

  // Rotate the status phrase while the panel is open and we're in a
  // rotating state (charging or on battery). The text swap is wrapped in a
  // fade so the changeover reads as one organism rather than a hard cut.
  Timer {
    id: phraseTimer
    interval: 2800
    running: root.opened && root.rotatingPhrases
    repeat: true
    triggeredOnStart: false
    onTriggered: phraseSwap.restart()
  }

  SequentialAnimation {
    id: phraseSwap
    PropertyAnimation {
      target: heroStatus; property: "opacity"
      to: 0.0; duration: 180; easing.type: Easing.OutQuad
    }
    ScriptAction {
      script: {
        var n = root.activePhrases.length
        if (n > 0) root.phraseIndex = (root.phraseIndex + 1) % n
      }
    }
    PropertyAnimation {
      target: heroStatus; property: "opacity"
      to: 1.0; duration: 260; easing.type: Easing.InQuad
    }
  }

  // If we leave a rotating state mid-swap, halt the animation and snap back
  // to full opacity so "FULLY CHARGED" is legible immediately rather than
  // appearing dimmed.
  Connections {
    target: root
    function onRotatingPhrasesChanged() {
      if (!root.rotatingPhrases) {
        phraseSwap.stop()
        heroStatus.opacity = 1.0
      }
    }
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.showPercentage && !vertical
      ? Math.round(root.batteryFraction * 100) + "% " + root.batteryIcon()
      : root.batteryIcon()
    slotSize: Style.bar.iconSlot * (root.showPercentage && !vertical ? 2 : 1)
    tooltipText: ""
    onPressed: function(b) {
      if (!root.batteryPresent) return
      if (b === Qt.RightButton) root.togglePercentage()
      else root.toggle()
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened && root.batteryPresent
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(380))
    contentHeight: panel.fittedContentHeight(column.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onMoveRequested: function(dx, dy) {
        if (!root.cursorActive) { root.cursorActive = true; return }
        if (dx !== 0) root.selectProfileByDelta(dx)
        else if (dy !== 0) root.selectProfileByDelta(dy)
      }
      onActivateRequested: if (root.cursorActive) root.activateSelectedProfile()
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }

      Column {
        id: column
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        spacing: Style.space(14)

        // ---------- Hero: battery icon · title/status · percentage ----------
        Item {
          width: parent.width
          implicitHeight: Math.max(heroIcon.implicitHeight, heroLabels.implicitHeight, heroPercent.implicitHeight)

          Text {
            id: heroIcon
            text: root.batteryIcon()
            color: root.bar.foreground
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.display
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter

            Behavior on color { ColorAnimation { duration: 200 } }
          }

          Column {
            id: heroLabels
            anchors.left: heroIcon.right
            anchors.leftMargin: Style.space(14)
            anchors.right: heroPercent.left
            anchors.rightMargin: Style.space(10)
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(2)

            Text {
              text: "Battery"
              color: root.bar.foreground
              font.family: root.bar.fontFamily
              font.pixelSize: Style.font.title
              font.bold: true
              elide: Text.ElideRight
              width: parent.width
            }

            Text {
              id: heroStatus
              text: root.heroStatusText.toUpperCase()
              color: Qt.darker(root.bar.foreground, 1.4)
              font.family: root.bar.fontFamily
              font.pixelSize: Style.font.caption
              font.bold: true
              font.letterSpacing: 1.2
              elide: Text.ElideRight
              width: parent.width
            }
          }

          Text {
            id: heroPercent
            text: Math.round(root.batteryFraction * 100) + "%"
            color: root.bar.foreground
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.displayLarge
            font.bold: true
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter

            Behavior on color { ColorAnimation { duration: 200 } }
          }
        }

        // ---------- Battery progress bar ----------
        Item {
          width: parent.width
          implicitHeight: Style.space(8)

          Rectangle {
            id: barTrack
            anchors.fill: parent
            radius: height / 2
            color: Qt.rgba(root.bar.foreground.r, root.bar.foreground.g, root.bar.foreground.b, 0.12)
          }

          Rectangle {
            id: barFill
            anchors.left: barTrack.left
            anchors.verticalCenter: barTrack.verticalCenter
            height: barTrack.height
            radius: barTrack.radius
            color: root.batteryFillColor
            width: Math.max(barTrack.height, barTrack.width * root.batteryFraction)

            Behavior on width { NumberAnimation { duration: 320; easing.type: Easing.OutCubic } }
            Behavior on color { ColorAnimation { duration: 220 } }

            // Subtle pulse while charging — visible signal that energy is flowing in.
            SequentialAnimation on opacity {
              running: root.charging && !root.fullyCharged && root.opened
              loops: Animation.Infinite
              alwaysRunToEnd: true
              NumberAnimation { from: 1.0; to: 0.55; duration: 950; easing.type: Easing.InOutSine }
              NumberAnimation { from: 0.55; to: 1.0; duration: 950; easing.type: Easing.InOutSine }
            }
          }
        }

        // ---------- Stats ----------
        // Visibility is intentionally only gated by "we've ever loaded data" so
        // the section never collapses mid-transition. fullyCharged is *not* part
        // of the condition: UPower briefly reports FullyCharged on plug-in when
        // the battery sits above the charge-control start threshold, and we
        // refuse to flicker the whole panel for that ~1s window.
        // ---------- Stats (System-Wide) ----------
        Row {
          visible: root.batteryInfo.percentage !== undefined || root.laptopBatteries.length > 0
          width: parent.width
          spacing: Style.space(20)

          Column {
            width: (parent.width - parent.spacing) / 2
            spacing: Style.spacing.labelGap
            InfoPair {
              label: "▣ Cap."
              value: root.combinedCapacityStr
            }
            InfoPair {
              label: root.discharging ? "ϟ Draw" : (root.charging ? "ϟ Charge" : "ϟ Rate")
              value: root.batteryFlowIdle ? "-" : root.combinedRateStr
            }
          }

          Column {
            width: (parent.width - parent.spacing) / 2
            spacing: Style.spacing.labelGap
            InfoPair {
              label: root.chargeThresholdActive ? "⌁ Limit" : (root.discharging ? "◷ Left" : "◷ Full")
              value: root.chargeThresholdActive ? (root.batteryInfo.threshold || "-") : (root.batteryFlowIdle ? "-" : root.combinedTimeStr)
            }
            InfoPair {
              label: "● State"
              value: root.chargeThresholdActive ? "Holding" : (root.discharging ? "On battery" : (root.batteryFull ? "Full" : "Charging"))
            }
          }
        }

        // ---------- Session history ----------
        PanelSeparator {
          foreground: root.bar.foreground
          visible: root.uptimeSeconds > 0 || root.chargeHistory.chargeEndEpoch > 0
        }

        Row {
          visible: root.uptimeSeconds > 0 || root.chargeHistory.chargeEndEpoch > 0
          width: parent.width
          spacing: Style.space(20)

          Column {
            width: (parent.width - parent.spacing) / 2
            spacing: Style.spacing.labelGap
            InfoPair {
              label: "◷ Uptime"
              value: root.systemUptimeStr
            }
            InfoPair {
              label: root.discharging ? "󰂄 Battery" : (root.charging ? "󰂆 Charge" : "Session")
              value: root.sinceChargeStr
            }
          }

          Column {
            width: (parent.width - parent.spacing) / 2
            spacing: Style.spacing.labelGap
            InfoPair {
              label: "󰂅 Last"
              value: root.lastChargeEndStr
            }
          }
        }

        // ---------- Individual Physical Batteries (Read-Only) ----------
        PanelSeparator {
          foreground: root.bar.foreground
          visible: root.laptopBatteries.length > 0
        }

        Column {
          visible: root.laptopBatteries.length > 0
          width: parent.width
          spacing: Style.space(8)

          PanelSectionHeader {
            text: "PHYSICAL BATTERIES"
            foreground: root.bar.foreground
            fontFamily: root.bar.fontFamily
          }

          Repeater {
            model: root.laptopBatteries

            Rectangle {
              id: batCard
              required property var modelData
              required property int index

              readonly property var extra: root.batteryDetails[modelData.nativePath] || ({})
              readonly property string batLabel: {
                var name = modelData.nativePath || ("BAT" + index)
                if (name === "BAT0") return "BAT0 (Internal)"
                if (name === "BAT1") return "BAT1 (Removable)"
                return name
              }
              readonly property string vendorModel: {
                var v = extra.vendor || ""
                var m = extra.model || modelData.model || ""
                if (v && m) return v + " " + m
                return v || m
              }
              readonly property string stateIcon: Model.deviceStateIcon(modelData, root.upowerStates())
              readonly property string rateStr: modelData.changeRate > 0.05 ? " (" + modelData.changeRate.toFixed(1) + "W)" : ""
              readonly property string healthStr: {
                if (!modelData.healthSupported || modelData.healthPercentage <= 0) {
                  return modelData.energyCapacity > 0 ? "Supported" : "N/A"
                }
                var rawHealth = modelData.healthPercentage
                var val = rawHealth > 1 ? rawHealth : rawHealth * 100
                return Math.round(val) + "%"
              }
              readonly property string energyStr: (modelData.energy > 0 || modelData.energyCapacity > 0)
                ? modelData.energy.toFixed(1) + " / " + modelData.energyCapacity.toFixed(1) + " Wh"
                : ""

              width: parent.width
              implicitHeight: cardInner.implicitHeight + Style.space(14)
              radius: Style.cornerRadius > 0 ? Math.min(Style.cornerRadius, 6) : 4
              color: Qt.rgba(root.bar.foreground.r, root.bar.foreground.g, root.bar.foreground.b, 0.05)
              border.color: Qt.rgba(root.bar.foreground.r, root.bar.foreground.g, root.bar.foreground.b, 0.12)
              border.width: 1

              Column {
                id: cardInner
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.top: parent.top
                anchors.margins: Style.space(8)
                spacing: Style.space(4)

                // Row 1: Battery label + Vendor/Model · State Icon + Percentage
                Row {
                  width: parent.width

                  Row {
                    spacing: Style.space(6)
                    anchors.verticalCenter: parent.verticalCenter
                    Text {
                      text: batCard.batLabel
                      font.family: root.bar.fontFamily
                      font.pixelSize: Style.font.bodySmall
                      font.bold: true
                      color: root.bar.foreground
                    }
                    Text {
                      visible: batCard.vendorModel.length > 0
                      text: "· " + batCard.vendorModel
                      font.family: root.bar.fontFamily
                      font.pixelSize: Style.font.caption
                      color: Qt.darker(root.bar.foreground, 1.4)
                      anchors.verticalCenter: parent.verticalCenter
                    }
                  }

                  Item {
                    width: Math.max(0, parent.width - parent.children[0].implicitWidth - parent.children[2].implicitWidth)
                    height: 1
                  }

                  Row {
                    spacing: Style.space(5)
                    anchors.verticalCenter: parent.verticalCenter
                    Text {
                      text: Model.deviceBatteryIcon(batCard.modelData, root.upowerStates())
                      font.family: root.bar.fontFamily
                      font.pixelSize: Style.font.bodySmall
                      color: root.bar.foreground
                      anchors.verticalCenter: parent.verticalCenter
                    }
                    Text {
                      text: Math.round(batCard.modelData.percentage * 100) + "%"
                      font.family: root.bar.fontFamily
                      font.pixelSize: Style.font.bodySmall
                      font.bold: true
                      color: root.bar.foreground
                      anchors.verticalCenter: parent.verticalCenter
                    }
                  }
                }

                // Row 2: Health & Energy (left) · Cycle count (right)
                Row {
                  width: parent.width

                  Row {
                    spacing: Style.space(8)
                    anchors.verticalCenter: parent.verticalCenter
                    Text {
                      text: batCard.stateIcon
                      font.family: root.bar.fontFamily
                      font.pixelSize: Style.font.bodySmall
                      color: root.bar.foreground
                    }
                    Text {
                      text: "♥ " + batCard.healthStr
                      font.family: root.bar.fontFamily
                      font.pixelSize: Style.font.caption
                      color: Qt.darker(root.bar.foreground, 1.25)
                    }
                    Text {
                      visible: batCard.energyStr.length > 0
                      text: "· " + batCard.energyStr
                      font.family: root.bar.fontFamily
                      font.pixelSize: Style.font.caption
                      color: Qt.darker(root.bar.foreground, 1.35)
                    }
                  }

                  Item {
                    width: Math.max(0, parent.width - parent.children[0].implicitWidth - parent.children[2].implicitWidth)
                    height: 1
                  }

                  Text {
                    visible: !!(batCard.extra.cycles && batCard.extra.cycles !== "")
                    text: "↻ " + batCard.extra.cycles
                    font.family: root.bar.fontFamily
                    font.pixelSize: Style.font.caption
                    color: Qt.darker(root.bar.foreground, 1.35)
                    anchors.verticalCenter: parent.verticalCenter
                  }
                }
              }
            }
          }
        }

        // ---------- Power profile picker ----------
        PanelSeparator {
          foreground: root.bar.foreground
          visible: root.hasLaptopBattery
        }

        Column {
          visible: root.hasLaptopBattery
          width: parent.width
          spacing: Style.space(10)

          PanelSectionHeader {
            text: "POWER PROFILE"
            foreground: root.bar.foreground
            fontFamily: root.bar.fontFamily
          }

          Row {
            id: profileRow
            width: parent.width
            spacing: Style.space(6)

            readonly property real cellWidth: root.profiles.length > 0
              ? (width - spacing * (root.profiles.length - 1)) / root.profiles.length
              : 0

            Repeater {
              model: root.profiles
              Button {
                required property var modelData
                required property int index
                width: profileRow.cellWidth
                iconText: root.profileIcon(String(modelData))
                iconSize: Style.font.title
                text: String(modelData).charAt(0).toUpperCase() + String(modelData).slice(1)
                fontSize: Style.font.bodySmall
                foreground: root.bar.foreground
                fontFamily: root.bar.fontFamily
                horizontalPadding: Style.spacing.controlPaddingX
                verticalPadding: Style.spacing.controlPaddingY + Style.space(2)
                bordered: true
                active: root.activeProfile === modelData
                hasCursor: root.cursorActive && root.profileIndex === index
                onClicked: root.setProfile(modelData)
                onHovered: function(h) {
                  if (h) {
                    root.cursorActive = true
                    root.profileIndex = index
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  component InfoPair: Row {
    property string label: ""
    property string value: ""

    width: parent.width
    spacing: Style.space(8)

    InfoLabel { text: label }
    Item { width: Math.max(0, parent.width - parent.children[0].implicitWidth - parent.children[2].implicitWidth - parent.spacing * 2); height: 1 }
    InfoValue { text: value }
  }

  component InfoLabel: Text {
    color: root.bar.foreground
    opacity: 0.55
    font.family: root.bar.fontFamily
    font.pixelSize: Style.font.caption
  }

  component InfoValue: Text {
    color: root.bar.foreground
    font.family: root.bar.fontFamily
    font.pixelSize: Style.font.bodySmall
  }
}
