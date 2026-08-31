# SVG renderer for `make graph-charge` and `make graph-health`.
#
# Reads one battery's raw observation rows (ADR-0001 tier 1) on stdin, oldest
# first, and writes one SVG document on stdout. SVG rather than terminal
# character art for two reasons: it is the only form that gives exact control
# over the annotation rails under a shared time axis, and the same file opens
# in a browser or drops into a report. The driver rasterizes and displays it
# when the viewer is asked for; nothing here knows about terminals.
#
# Both metrics get the same treatment — same layout, same rails, same visual
# language — so the two charts can be read side by side without relearning
# anything. Only the series and the vertical axis differ.
#
# Rows may be 16 columns (raw format v0.1.0) or 18 (v0.2.0, which appended
# power_profile and load1), so every read of columns 17 and 18 is guarded: an
# older row did not lose those facts, it never recorded them, and the rails
# say so rather than drawing a zero.

function X(epoch) { return ML + (epoch - t0) * PW / tspan }
function Y(value) { return MT + (axis_hi - value) * PH / (axis_hi - axis_lo) }

function esc(s) {
  gsub(/&/, "\\&amp;", s); gsub(/</, "\\&lt;", s); gsub(/>/, "\\&gt;", s)
  return s
}

function text(x, y, fill, size, anchor, weight, body) {
  printf "<text x=\"%.1f\" y=\"%.1f\" fill=\"%s\" font-size=\"%s\" text-anchor=\"%s\" font-weight=\"%s\">%s</text>\n",
    x, y, fill, size, anchor, weight, esc(body)
}

function human_duration(seconds,   h, m) {
  if (seconds < 60) return int(seconds) "s"
  h = int(seconds / 3600); m = int((seconds % 3600) / 60)
  if (h == 0) return m "m"
  return h "h" sprintf("%02dm", m)
}

BEGIN {
  FS = "\t"

  W = 1240; H = 620
  # Keep the document size stable, but give the chart content more breathing
  # room at the edges.
  ML = 92; MR = 48; MT = 116; PH = 288
  PW = W - ML - MR

  y_axis      = MT + PH
  y_ticks     = y_axis + 20
  y_profile   = y_axis + 44
  y_load      = y_axis + 88
  y_rule      = y_axis + 130
  y_summary   = y_axis + 152

  # A label is only drawn when it clears the previous one. Event markers
  # cluster hard when transitions are close together, and a month-long health
  # chart can carry hundreds; the tick line is always drawn, the words only
  # when there is room for them.
  LABEL_GAP = 58
  MAX_EVENT_TICKS = 80

  if (theme == "light") {
    c_bg="#ffffff"; c_fg="#1b1f27"; c_muted="#6b7280"; c_grid="#e6e8ee"
    c_panel="#f1f2f6"; c_fill_op="0.14"
  } else {
    c_bg="#12141a"; c_fg="#e6e9ef"; c_muted="#767c8c"; c_grid="#242833"
    c_panel="#1b1e26"; c_fill_op="0.12"
  }
  c_discharge="#e0a34a"; c_charge="#5ec27a"; c_hold="#4aa3d8"
  c_health="#7f8cd4"; c_alert="#d9534f"

  n = 0
}

/^#/ { next }
NF < 16 { next }
{
  epoch = $1 + 0
  if (epoch < since || epoch > now + 86400) next
  n++
  e[n]        = epoch
  r_status[n] = $4
  r_full[n]   = $6 + 0
  r_design[n] = $7 + 0
  r_cap[n]    = $10 + 0
  r_cycle[n]  = $11 + 0
  r_ac[n]     = $13 + 0
  r_profile[n] = (NF >= 17) ? $17 : ""
  r_load[n]    = (NF >= 18) ? $18 + 0 : -1
  if (r_profile[n] != "" && r_profile[n] != "unknown") have_profile = 1
  if (r_load[n] >= 0) { have_load = 1; if (r_load[n] > load_max) load_max = r_load[n] }
}

END {
  if (n < 2) exit 0

  t0 = e[1]; t1 = e[n]; tspan = t1 - t0
  if (tspan < 1) tspan = 1

  split(key, id, ":")

  # --- Series and vertical axis -------------------------------------------
  for (i = 1; i <= n; i++) {
    if (metric == "charge") {
      v[i] = r_cap[i]
    } else {
      v[i] = (r_design[i] > 0) ? r_full[i] * 100.0 / r_design[i] : 0
    }
  }
  if (metric == "charge") {
    axis_lo = 0; axis_hi = 100
  } else {
    lo = 1e9; hi = -1e9
    for (i = 1; i <= n; i++) {
      if (v[i] <= 0) continue
      if (v[i] < lo) lo = v[i]
      if (v[i] > hi) hi = v[i]
    }
    if (hi < lo) { lo = 0; hi = 100 }
    # Snap to a 5-point grid with a 10-point floor on the span. A pack whose
    # reported capacity moved 0.1% must look like a flat line, because it is
    # one; an auto-fitted axis would magnify that into a cliff.
    axis_lo = int((lo - 2) / 5) * 5
    axis_hi = int((hi + 2) / 5) * 5 + 5
    if (axis_lo < 0) axis_lo = 0
    if (axis_hi > 100) axis_hi = 100
    if (axis_hi - axis_lo < 10) {
      axis_hi = axis_lo + 10
      if (axis_hi > 100) { axis_hi = 100; axis_lo = 90 }
    }
  }

  # --- Document -----------------------------------------------------------
  printf "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"%d\" height=\"%d\" viewBox=\"0 0 %d %d\" font-family=\"Inter, DejaVu Sans, Helvetica, sans-serif\">\n", W, H, W, H
  printf "<rect width=\"%d\" height=\"%d\" rx=\"10\" fill=\"%s\"/>\n", W, H, c_bg

  title = (metric == "charge") ? "charge" : "health"
  text(ML, 38, c_fg, 22, "start", 600, id[1] " · " title)
  text(ML, 60, c_muted, 13, "start", 400,
    id[2] " " id[3] "   ·   " strftime("%b %d %H:%M", t0) " → " strftime("%b %d %H:%M", t1) \
    "   ·   " human_duration(t1 - t0) ", " n " observations")

  # --- Grid and vertical labels -------------------------------------------
  gstep = (axis_hi - axis_lo) / 4
  for (g = axis_lo; g <= axis_hi + 0.001; g += gstep) {
    printf "<line x1=\"%.1f\" y1=\"%.1f\" x2=\"%.1f\" y2=\"%.1f\" stroke=\"%s\" stroke-width=\"1\"/>\n",
      ML, Y(g), ML + PW, Y(g), c_grid
    text(ML - 12, Y(g) + 4, c_muted, 12, "end", 400, sprintf("%.4g%%", g))
  }

  # --- Series -------------------------------------------------------------
  if (metric == "charge") {
    # The series breaks wherever two samples sit further apart than the
    # tracker's own continuity tolerance. Charge does not persist while
    # nobody is looking, and a line drawn straight across a suspend would
    # invent the one thing the gap proves was never measured. Each
    # continuous run gets its own filled area and its own segments.
    run_start = 1
    for (i = 2; i <= n + 1; i++) {
      if (i <= n && e[i] - e[i-1] <= max_gap) continue
      run_end = i - 1
      area = sprintf("M %.1f %.1f", X(e[run_start]), Y(v[run_start]))
      for (j = run_start + 1; j <= run_end; j++)
        area = area sprintf(" L %.1f %.1f", X(e[j]), Y(v[j]))
      if (run_end > run_start)
        printf "<path d=\"%s L %.1f %.1f L %.1f %.1f Z\" fill=\"%s\" fill-opacity=\"%s\"/>\n",
          area, X(e[run_end]), Y(axis_lo), X(e[run_start]), Y(axis_lo), c_discharge, c_fill_op
      for (j = run_start + 1; j <= run_end; j++) {
        st = r_status[j]
        seg = (st == "Charging") ? c_charge : (st == "Discharging") ? c_discharge : c_hold
        printf "<line x1=\"%.1f\" y1=\"%.1f\" x2=\"%.1f\" y2=\"%.1f\" stroke=\"%s\" stroke-width=\"2.4\" stroke-linecap=\"round\"/>\n",
          X(e[j-1]), Y(v[j-1]), X(e[j]), Y(v[j]), seg
      }
      run_start = i
    }
  } else {
    # Health is a step: firmware moves reported capacity in recalibration
    # jumps, and between two readings the last one is still the truth.
    step = sprintf("M %.1f %.1f", X(e[1]), Y(v[1]))
    for (i = 2; i <= n; i++)
      step = step sprintf(" L %.1f %.1f L %.1f %.1f", X(e[i]), Y(v[i-1]), X(e[i]), Y(v[i]))
    printf "<path d=\"%s L %.1f %.1f L %.1f %.1f Z\" fill=\"%s\" fill-opacity=\"%s\" stroke=\"none\"/>\n",
      step, X(e[n]), Y(axis_lo), X(e[1]), Y(axis_lo), c_health, c_fill_op
    printf "<path d=\"%s\" fill=\"none\" stroke=\"%s\" stroke-width=\"2.4\" stroke-linejoin=\"round\"/>\n",
      step, c_health
  }

  # --- Power events -------------------------------------------------------
  n_ev = 0
  for (i = 2; i <= n; i++) {
    if (r_ac[i] == r_ac[i-1]) continue
    n_ev++
    ev_epoch[n_ev] = e[i]
    ev_label[n_ev] = (r_ac[i] == 1) ? "plug" : "unplug"
    ev_tone[n_ev]  = (r_ac[i] == 1) ? c_charge : c_discharge
    if (r_ac[i] == 1) count_plug++; else count_unplug++
  }
  while ((getline line < gaps_file) > 0) {
    if (line ~ /^#/) continue
    split(line, gap_row, "\t")
    if (gap_row[1] != key) continue
    gs = gap_row[2] + 0; ge = gap_row[3] + 0
    if (ge < t0 || gs > t1) continue
    gap_total[gap_row[4]]++; gap_seconds[gap_row[4]] += ge - gs
    # A gap is a span, not an instant: shade what was not observed.
    gx1 = X(gs < t0 ? t0 : gs); gx2 = X(ge > t1 ? t1 : ge)
    if (gx2 - gx1 < 1.5) gx2 = gx1 + 1.5
    printf "<rect x=\"%.1f\" y=\"%.1f\" width=\"%.1f\" height=\"%.1f\" fill=\"%s\" fill-opacity=\"0.30\"/>\n",
      gx1, MT, gx2 - gx1, PH, c_muted
    n_ev++
    ev_epoch[n_ev] = gs
    ev_label[n_ev] = gap_row[4]
    ev_tone[n_ev]  = (gap_row[4] == "off") ? c_alert : c_hold
  }
  close(gaps_file)

  if (n_ev > 0 && n_ev <= MAX_EVENT_TICKS) {
    last_label_x = -1e9
    for (i = 1; i <= n_ev; i++) {
      x = X(ev_epoch[i])
      printf "<line x1=\"%.1f\" y1=\"%d\" x2=\"%.1f\" y2=\"%.1f\" stroke=\"%s\" stroke-width=\"1\" stroke-dasharray=\"3 3\" opacity=\"0.7\"/>\n",
        x, MT, x, y_axis, ev_tone[i]
      printf "<circle cx=\"%.1f\" cy=\"%d\" r=\"3\" fill=\"%s\"/>\n", x, MT, ev_tone[i]
      if (x - last_label_x >= LABEL_GAP) {
        text(x, MT - 11, ev_tone[i], 10.5, "middle", 500, ev_label[i])
        last_label_x = x
      }
    }
  } else if (n_ev > MAX_EVENT_TICKS) {
    text(ML + PW, MT - 11, c_muted, 10.5, "end", 400,
      n_ev " power events — too dense to mark individually")
  }

  # --- Time axis ----------------------------------------------------------
  printf "<line x1=\"%d\" y1=\"%.1f\" x2=\"%.1f\" y2=\"%.1f\" stroke=\"%s\"/>\n",
    ML, y_axis, ML + PW, y_axis, c_muted
  tfmt = (tspan <= 172800) ? "%H:%M" : (tspan <= 2592000) ? "%b %d" : "%b %d"
  for (k = 0; k <= 5; k++) {
    tt = t0 + tspan * k / 5
    text(X(tt), y_ticks, c_muted, 11, (k == 0) ? "start" : (k == 5) ? "end" : "middle", 400,
      strftime(tfmt, tt))
  }

  # --- Rails --------------------------------------------------------------
  text(ML - 12, y_profile + 13, c_muted, 11, "end", 400, "profile")
  if (have_profile) {
    run = 1
    for (i = 2; i <= n + 1; i++) {
      if (i <= n && r_profile[i] == r_profile[run]) continue
      px1 = X(e[run]); px2 = X(e[(i > n) ? n : i])
      pname = r_profile[run]
      pc = (pname == "performance") ? c_alert : (pname == "balanced") ? c_hold : c_charge
      if (pname == "" || pname == "unknown") pc = c_panel
      printf "<rect x=\"%.1f\" y=\"%.1f\" width=\"%.1f\" height=\"18\" rx=\"3\" fill=\"%s\" fill-opacity=\"0.55\"/>\n",
        px1, y_profile, (px2 - px1 < 1) ? 1 : px2 - px1, pc
      if (px2 - px1 > 66) text((px1 + px2) / 2, y_profile + 13, c_fg, 10, "middle", 400, pname)
      run = i
    }
  } else {
    printf "<rect x=\"%d\" y=\"%.1f\" width=\"%d\" height=\"18\" rx=\"3\" fill=\"%s\"/>\n", ML, y_profile, PW, c_panel
    text(ML + PW / 2, y_profile + 13, c_muted, 10, "middle", 400, "not recorded before raw format v0.2.0")
  }

  text(ML - 12, y_load + 22, c_muted, 11, "end", 400, "load")
  if (have_load && load_max > 0) {
    lp = sprintf("M %.1f %.1f", X(e[1]), y_load + 30)
    for (i = 1; i <= n; i++)
      if (r_load[i] >= 0) lp = lp sprintf(" L %.1f %.1f", X(e[i]), y_load + 30 - (r_load[i] * 28.0 / load_max))
    printf "<path d=\"%s L %.1f %.1f Z\" fill=\"%s\" fill-opacity=\"0.35\" stroke=\"%s\" stroke-width=\"1.2\"/>\n",
      lp, X(e[n]), y_load + 30, c_hold, c_hold
    text(ML + PW, y_load - 2, c_muted, 10, "end", 400, sprintf("peak %.2f", load_max / 100.0))
  } else {
    printf "<rect x=\"%d\" y=\"%.1f\" width=\"%d\" height=\"18\" rx=\"3\" fill=\"%s\"/>\n", ML, y_load + 6, PW, c_panel
    text(ML + PW / 2, y_load + 19, c_muted, 10, "middle", 400, "not recorded before raw format v0.2.0")
  }

  # --- Summary ------------------------------------------------------------
  printf "<line x1=\"%d\" y1=\"%.1f\" x2=\"%.1f\" y2=\"%.1f\" stroke=\"%s\"/>\n",
    ML, y_rule, ML + PW, y_rule, c_grid

  if (metric == "charge") {
    cap_lo = 101; cap_hi = -1; on_batt = 0; on_ac = 0
    for (i = 1; i <= n; i++) {
      if (r_cap[i] < cap_lo) cap_lo = r_cap[i]
      if (r_cap[i] > cap_hi) cap_hi = r_cap[i]
      if (i > 1) {
        d = e[i] - e[i-1]
        if (d > 0 && d < 1800) { if (r_ac[i] == 1) on_ac += d; else on_batt += d }
      }
    }
    text(ML, y_summary, c_fg, 13, "start", 500,
      sprintf("now %d%%   ·   range %d%%–%d%%   ·   on battery %s   ·   plugged %s",
        r_cap[n], cap_lo, cap_hi, human_duration(on_batt), human_duration(on_ac)))
    detail = sprintf("%d plug, %d unplug", count_plug + 0, count_unplug + 0)
    for (cause in gap_total)
      detail = detail sprintf(", %d %s (%s)", gap_total[cause], cause, human_duration(gap_seconds[cause]))
    text(ML, y_summary + 20, c_muted, 12, "start", 400, detail)
  } else {
    health_now = v[n]
    text(ML, y_summary, c_fg, 13, "start", 500,
      sprintf("now %.1f%% of design   ·   %.2f Wh of %.2f Wh   ·   %d cycles",
        health_now, r_full[n] / 1000000.0, r_design[n] / 1000000.0, r_cycle[n]))
    span_days = (t1 - t0) / 86400.0
    detail = sprintf("%+.2f points and %+d cycles over %.1f days",
      health_now - v[1], r_cycle[n] - r_cycle[1], span_days)
    if (span_days < 14)
      detail = detail "  ·  health moves in firmware recalibration steps over weeks; too short to show a trend yet"
    text(ML, y_summary + 20, c_muted, 12, "start", 400, detail)
  }

  printf "</svg>\n"
}
