import QtQuick
import Quickshell.Io
import Quickshell.Services.UPower
import qs.Commons
import qs.Ui
import "Model.js" as Model

Panel {
  id: root
  moduleName: "omarchy.power"
  ipcTarget: "omarchy.power"
  // manageIpc: false so this panel can own the target's single IpcHandler.
  manageIpc: false
  // The aggregated view: one document from service/battery-view.sh that
  // supplies every panel field UPower does not push live over D-Bus. Nothing
  // in this file reads the tracker state file, sysfs, or a helper command's
  // output directly — if a field is missing, add it to the view.
  property var view: Model.emptyView()
  property real nowEpochSeconds: Date.now() / 1000
  readonly property string systemUptimeStr: Model.formatElapsed(root.view.uptimeSeconds)
  readonly property string usualRuntimeStr: Model.formatRuntimeEstimate(root.view.remainingSeconds)
  readonly property bool usualRuntimeAvailable: usualRuntimeStr !== ""
  readonly property string sinceChargeStr: {
    var start = Number(root.view.stateSinceEpoch || 0)
    if (root.view.powerState === "on-charge") {
      start = start || Number(root.view.chargeStartEpoch || 0)
    }
    if (!(start > 0)) return "—"
    return Model.formatSessionDuration(
      root.nowEpochSeconds - start,
      root.view.stateSinceAtLeast
    )
  }
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
    return root.view.drawMw / 1000
  }
  readonly property string combinedCapacityStr: {
    if (combinedEnergyCapacity > 0) return Math.round(combinedEnergyCapacity) + "Wh"
    return Model.formatWattHours(root.view.energyCapacityUwh)
  }
  readonly property string combinedRateStr: {
    if (combinedChangeRate > 0.05) return combinedChangeRate.toFixed(1) + "W"
    return Model.formatWatts(root.view.drawMw) || "-"
  }
  // Time to empty/full computed from the combined pack, not whichever single
  // battery `omarchy-battery-status` happened to report on.
  readonly property string combinedTimeStr: {
    var label = Model.aggregateTimeLabel(root.combinedEnergy, root.combinedEnergyCapacity, root.combinedChangeRate, root.discharging)
    return label || Model.formatRuntimeEstimate(root.view.liveTimeSeconds) || "—"
  }
  readonly property var profiles: root.view.profiles
  readonly property string activeProfile: root.view.activeProfile
  property int profileIndex: 0
  property bool cursorActive: false
  // The bar always shows the combined percentage. Use the painted text width
  // for the open-panel mark on a horizontal bar.
  readonly property real openPanelIndicatorWidth: !button.vertical ? button.glyphPaintedWidth : 0
  readonly property bool batteryPresent: root.hasLaptopBattery

  function upowerStates() {
    return {
      Charging: UPowerDeviceState.Charging,
      Discharging: UPowerDeviceState.Discharging,
      Empty: UPowerDeviceState.Empty,
      FullyCharged: UPowerDeviceState.FullyCharged,
      PendingCharge: UPowerDeviceState.PendingCharge,
      PendingDischarge: UPowerDeviceState.PendingDischarge,
      Unknown: UPowerDeviceState.Unknown
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
    return Model.batteryIcon(device, root.batteryFraction, root.discharging, upowerStates(), root.view)
  }

  function modeLabel() {
    var device = UPower.displayDevice
    return Model.modeLabel(device, root.batteryFraction, root.discharging, upowerStates(), root.view)
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
    return Model.chargeThresholdActive(device, root.batteryFraction, root.discharging, upowerStates(), root.view)
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

  // Maps Model.deviceStateSeverity() onto colors. The neutral and critical
  // steps follow the Omarchy theme; the palette exposes no low/held/full
  // equivalents, so those three keep literal colors.
  function severityColor(severity) {
    if (severity === "critical") return Color.urgent
    if (severity === "low") return "#eab308"
    if (severity === "held") return "#f97316"
    if (severity === "full") return "#22c55e"
    return root.batteryFillColor
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
    root.nowEpochSeconds = Date.now() / 1000
    if (!viewProc.running) viewProc.running = true
  }

  function updateView(raw) {
    var next = Model.parseView(raw)
    // Keep the last known good view when a refresh returns nothing parseable —
    // it happens around AC plug/unplug events, and the panel must not collapse
    // mid-transition.
    if (!next) return
    root.view = next
    root.profileIndex = Model.clampIndex(root.profileIndex, next.profiles.length)
    if (opened && !cursorActive) {
      var idx = next.profiles.indexOf(next.activeProfile)
      if (idx >= 0) root.profileIndex = idx
    }
  }

  function setProfile(profile) {
    if (!profile || actionProc.running) return
    actionProc.command = ["omarchy-powerprofiles-set", root.discharging ? "battery" : "ac", profile]
    actionProc.running = true
  }

  IpcHandler {
    target: "omarchy.power"

    function open() { root.open() }
    function close() { root.close() }
    function show() { root.open() }
    function hide() { root.close() }
    function toggle() { root.toggle() }
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

  // The plugin's own directory, wherever it was installed to.
  readonly property string viewCommand: decodeURIComponent(
    Qt.resolvedUrl("service/battery-view.sh").toString().replace(/^file:\/\//, ""))

  Process {
    id: viewProc
    command: [root.viewCommand]
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: root.updateView(text) }
  }

  Process {
    id: actionProc
    onExited: root.refresh()
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
    text: vertical
      ? root.batteryIcon()
      : Math.round(root.batteryFraction * 100) + "% " + root.batteryIcon()
    slotSize: Style.bar.iconSlot * (vertical ? 1 : 2)
    tooltipText: ""
    onPressed: function() {
      if (root.batteryPresent) root.toggle()
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
          visible: root.view.available || root.laptopBatteries.length > 0
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
              value: root.chargeThresholdActive ? (Model.formatPercent(root.view.chargeLimitPercent) || "-") : (root.batteryFlowIdle ? "-" : root.combinedTimeStr)
            }
            InfoPair {
              label: root.usualRuntimeAvailable ? "≈ Usual" : "● State"
              value: root.usualRuntimeAvailable
                ? root.usualRuntimeStr
                : (root.chargeThresholdActive ? "Holding" : (root.discharging ? "On battery" : (root.batteryFull ? "Full" : "Charging")))
            }
          }
        }

        // ---------- Session history ----------
        PanelSeparator {
          foreground: root.bar.foreground
          visible: root.uptimeSeconds > 0 || root.sinceChargeStr !== "—"
        }

        Row {
          visible: root.uptimeSeconds > 0 || root.sinceChargeStr !== "—"
          width: parent.width
          spacing: Style.space(20)

          Column {
            width: (parent.width - parent.spacing) / 2
            InfoPair {
              label: "◷ Uptime"
              value: root.systemUptimeStr
            }
          }

          Column {
            width: (parent.width - parent.spacing) / 2
            InfoPair {
              label: root.discharging ? "󰂄 Unplugged" : (root.charging ? "󰂆 Plugged" : "Session")
              value: root.sinceChargeStr
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

              readonly property var extra: root.view.batteries[modelData.nativePath] || ({})
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
              readonly property color stateIconColor: root.severityColor(
                Model.deviceStateSeverity(modelData, extra, root.upowerStates()))
              readonly property string rateStr: modelData.changeRate > 0.05 ? " (" + modelData.changeRate.toFixed(1) + "W)" : ""
              readonly property string healthStr: {
                if (!modelData.healthSupported || modelData.healthPercentage <= 0) {
                  return modelData.energyCapacity > 0 ? "Supported" : "N/A"
                }
                var rawHealth = modelData.healthPercentage
                var val = rawHealth > 1 ? rawHealth : rawHealth * 100
                return Math.round(val) + "%"
              }
              // This battery's own runtime model, built only from its own
              // windows. Named `projection` in the view so it cannot collide
              // with `model`, which is the cell's model name.
              readonly property var projection: extra.projection || ({})
              readonly property string projectionStr: Model.batteryProjectionLabel(
                batCard.projection, root.view.requiredWindows)
              readonly property string projectionDrawStr: Model.batteryDrawLabel(batCard.projection)
              readonly property bool projectionProvisional: batCard.projection.state === "provisional"
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
                      color: batCard.stateIconColor
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

                // Row 3: what this battery's own evidence says about it.
                // Each cell is modelled separately, so this number belongs to
                // this card and not to the pack figure above.
                Row {
                  width: parent.width
                  visible: batCard.projectionStr.length > 0

                  Text {
                    text: "◷ " + batCard.projectionStr
                    font.family: root.bar.fontFamily
                    font.pixelSize: Style.font.caption
                    color: batCard.projectionProvisional
                      ? Qt.darker(root.bar.foreground, 1.5)
                      : Qt.darker(root.bar.foreground, 1.25)
                    anchors.verticalCenter: parent.verticalCenter
                  }

                  Item {
                    width: Math.max(0, parent.width - parent.children[0].implicitWidth - parent.children[2].implicitWidth)
                    height: 1
                  }

                  Text {
                    visible: batCard.projectionDrawStr.length > 0
                    text: batCard.projectionDrawStr
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
