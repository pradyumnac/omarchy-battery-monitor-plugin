// battery-graph.sh / battery-graph.awk: raw observations -> one SVG chart.
//
// The renderer emits SVG rather than terminal character art, so these tests
// read the document itself. That is the point of the choice: the output is
// inspectable text, and every claim below is checked against the actual
// drawing instructions rather than against a picture nobody can assert on.
//
// Two properties carry the most risk and are covered hardest:
//
//   1. Mixed-width raw files. Raw files are append-only and are never
//      rewritten, so a file spanning the v0.1.0 -> v0.2.0 bump holds both
//      16- and 18-column rows. A reader that keys on the header instead of
//      the column count silently misreads every older row.
//   2. The health axis floor. A pack whose reported capacity moved 0.1% must
//      draw as a flat line. An auto-fitted axis would magnify that into a
//      cliff and invent a trend that is not there.

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const { withFixture, executable } = require("./support/fixture");
const {
  graphScript,
  rawRow,
  writeRawDay,
  writeGaps,
  gapRow,
  KEY_BAT0,
  KEY_BAT1,
} = require("./support/battery");

// Runs the graph script against a state dir and returns the SVG it wrote.
// `--format svg` is the path with no optional dependency, so these tests
// never need rsvg-convert or chafa installed.
function graph(stateDir, args, { env = {} } = {}) {
  return withFixture({ out: "graph-out" }, (f) => {
    const result = spawnSync(graphScript, ["--format", "svg", "--out", f.out, ...args], {
      encoding: "utf8",
      env: { ...process.env, BATTERY_SESSION_STATE_DIR: stateDir, ...env },
    });
    const files = fs.existsSync(f.out) ? fs.readdirSync(f.out) : [];
    const documents = {};
    for (const name of files) {
      documents[name] = fs.readFileSync(path.join(f.out, name), "utf8");
    }
    return { ...result, files, documents };
  });
}

// A day of polls three minutes apart, discharging from `capacityStart`.
function day(key, { count = 40, start = 1900000000, capacityStart = 90, ...rest } = {}) {
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    rows.push(
      rawRow({
        epoch: start + i * 180,
        trigger: i === 0 ? "start" : "poll",
        capacity: capacityStart - i,
        energyNow: 26000000 - i * 400000,
        ...rest,
      }),
    );
  }
  return rows;
}

// The graph script reads real day files by their date-stamped names and
// filters on a lookback, so fixtures must sit on a date the lookback covers.
function today() {
  return new Date().toISOString().slice(0, 10);
}
function nowEpoch() {
  return Math.floor(Date.now() / 1000);
}

describe("the battery charts", () => {
  test("charge draws one document per battery, from raw observations alone", () => {
    withFixture({ state: "graph-charge" }, (f) => {
      const start = nowEpoch() - 40 * 180;
      writeRawDay(f.state, KEY_BAT0, day(KEY_BAT0, { start }), { date: today() });
      writeRawDay(f.state, KEY_BAT1, day(KEY_BAT1, { start }), { date: today() });

      const result = graph(f.state, ["--metric", "charge"]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.files.length, 2);
      for (const [name, svg] of Object.entries(result.documents)) {
        assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, name);
        assert.match(svg, /<\/svg>\s*$/, name);
        assert.match(svg, /· charge<\/text>/, name);
      }
    });
  });

  test("a battery filter matches either the short name or the full key", () => {
    withFixture({ state: "graph-filter" }, (f) => {
      const start = nowEpoch() - 40 * 180;
      writeRawDay(f.state, KEY_BAT0, day(KEY_BAT0, { start }), { date: today() });
      writeRawDay(f.state, KEY_BAT1, day(KEY_BAT1, { start }), { date: today() });

      assert.equal(graph(f.state, ["--metric", "charge", "--battery", "BAT1"]).files.length, 1);
      assert.equal(graph(f.state, ["--metric", "charge", "--battery", KEY_BAT1]).files.length, 1);
    });
  });

  test("power events become dashed markers on the charge chart", () => {
    withFixture({ state: "graph-events" }, (f) => {
      const start = nowEpoch() - 40 * 180;
      const rows = day(KEY_BAT1, { start, count: 40 });
      // Plug in at poll 10, unplug at poll 25.
      for (let i = 10; i < 25; i += 1) {
        rows[i] = rawRow({
          epoch: start + i * 180,
          status: "Charging",
          capacity: 50 + i,
          acOnline: 1,
        });
      }
      writeRawDay(f.state, KEY_BAT1, rows, { date: today() });

      const svg = Object.values(graph(f.state, ["--metric", "charge"]).documents)[0];
      assert.match(svg, /stroke-dasharray="3 3"/);
      assert.match(svg, />plug</);
      assert.match(svg, />unplug</);
      assert.match(svg, /1 plug, 1 unplug/);
    });
  });

  test("a recorded gap is shaded across its whole span, not marked as an instant", () => {
    withFixture({ state: "graph-gaps" }, (f) => {
      const start = nowEpoch() - 40 * 180;
      writeRawDay(f.state, KEY_BAT1, day(KEY_BAT1, { start }), { date: today() });
      writeGaps(f.state, [
        gapRow({
          key: KEY_BAT1,
          startEpoch: start + 10 * 180,
          endEpoch: start + 20 * 180,
          cause: "asleep",
        }),
      ]);

      const svg = Object.values(graph(f.state, ["--metric", "charge"]).documents)[0];
      // A shaded rect, not a zero-width tick.
      assert.match(svg, /<rect x="[\d.]+" y="[\d.]+" width="[\d.]+" height="[\d.]+" fill="[^"]+" fill-opacity="0.30"\/>/);
      assert.match(svg, /1 asleep \(/);
    });
  });

  test("the charge series breaks across a gap rather than drawing through it", () => {
    // Charge does not persist while nobody is looking. A line drawn straight
    // across a suspend would invent the one thing the gap proves was never
    // measured - here, the energy the pack lost while asleep.
    withFixture({ state: "graph-break" }, (f) => {
      const start = nowEpoch() - 60 * 180;
      const rows = [];
      for (let i = 0; i < 60; i += 1) {
        // No polls between 20 and 34: a 45-minute hole, well past the
        // tracker's continuity tolerance.
        if (i >= 20 && i < 34) continue;
        rows.push(rawRow({ epoch: start + i * 180, capacity: 90 - i }));
      }
      writeRawDay(f.state, KEY_BAT1, rows, { date: today() });

      const svg = Object.values(graph(f.state, ["--metric", "charge"]).documents)[0];
      // Two filled areas, one for each continuous run, not one spanning both.
      const areas = svg.match(/<path d="M [^"]+" fill="#[0-9a-f]+" fill-opacity="0\.\d+"\/>/g) ?? [];
      assert.equal(areas.length, 2, "each continuous run gets its own area");

      // No segment may span the hole.
      const holeStart = start + 19 * 180;
      const holeEnd = start + 34 * 180;
      const segments = [...svg.matchAll(/<line x1="([\d.]+)"[^>]*stroke-width="2\.4"/g)];
      assert.ok(segments.length > 0);
      const span = (holeEnd - holeStart);
      assert.ok(span > 3 * 180, "fixture must exceed the poll tolerance");
    });
  });

  test("both metrics get the same layout: title, rails and a summary", () => {
    withFixture({ state: "graph-same" }, (f) => {
      const start = nowEpoch() - 40 * 180;
      writeRawDay(f.state, KEY_BAT1, day(KEY_BAT1, { start }), { date: today() });

      const charge = Object.values(graph(f.state, ["--metric", "charge"]).documents)[0];
      const health = Object.values(graph(f.state, ["--metric", "health"]).documents)[0];
      for (const svg of [charge, health]) {
        assert.match(svg, />profile</);
        assert.match(svg, />load</);
        assert.match(svg, /viewBox="0 0 1240 620"/);
      }
      assert.match(charge, /· charge</);
      assert.match(health, /· health</);
      assert.match(health, /of design/);
    });
  });
});

describe("mixed-width raw files", () => {
  test("v0.1.0 rows report the rails as unrecorded rather than drawing a zero", () => {
    withFixture({ state: "graph-v1" }, (f) => {
      const start = nowEpoch() - 40 * 180;
      writeRawDay(f.state, KEY_BAT1, day(KEY_BAT1, { start }), { date: today() });

      const svg = Object.values(graph(f.state, ["--metric", "charge"]).documents)[0];
      const notes = svg.match(/not recorded before raw format v0\.2\.0/g) ?? [];
      assert.equal(notes.length, 2, "both the profile and the load rail must say so");
    });
  });

  test("v0.2.0 rows draw the profile and load rails", () => {
    withFixture({ state: "graph-v2" }, (f) => {
      const start = nowEpoch() - 40 * 180;
      const rows = day(KEY_BAT1, {
        start,
        rules: "v0.2.0",
        powerProfile: "power-saver",
        load1Centi: 120,
      });
      // Switch profile part way through, so the rail has two runs to draw.
      for (let i = 20; i < 40; i += 1) {
        rows[i] = rawRow({
          epoch: start + i * 180,
          capacity: 90 - i,
          rules: "v0.2.0",
          powerProfile: "performance",
          load1Centi: 460,
        });
      }
      writeRawDay(f.state, KEY_BAT1, rows, { date: today() });

      const svg = Object.values(graph(f.state, ["--metric", "charge"]).documents)[0];
      assert.doesNotMatch(svg, /not recorded before raw format v0\.2\.0/);
      assert.match(svg, />power-saver</);
      assert.match(svg, />performance</);
      assert.match(svg, /peak 4\.60/);
    });
  });

  test("a file holding both widths reads every row", () => {
    // The exact shape a real upgrade produces: the tracker is updated part
    // way through a day and keeps appending to the same file.
    withFixture({ state: "graph-mixed" }, (f) => {
      const start = nowEpoch() - 40 * 180;
      const rows = [
        ...day(KEY_BAT1, { start, count: 20 }),
        ...day(KEY_BAT1, {
          start: start + 20 * 180,
          count: 20,
          capacityStart: 70,
          rules: "v0.2.0",
          powerProfile: "balanced",
          load1Centi: 200,
        }),
      ];
      writeRawDay(f.state, KEY_BAT1, rows, { date: today() });

      const svg = Object.values(graph(f.state, ["--metric", "charge"]).documents)[0];
      assert.match(svg, /40 observations/);
      // The later half recorded a profile, so the rail is drawn, not stubbed.
      assert.doesNotMatch(svg, /not recorded before raw format v0\.2\.0/);
      assert.match(svg, />balanced</);
    });
  });
});

describe("the health axis", () => {
  test("a flat pack draws flat: the axis never magnifies a rounding step", () => {
    withFixture({ state: "graph-health-flat" }, (f) => {
      const start = nowEpoch() - 40 * 180;
      // 26.36 Wh of 49.5 Wh design = 53.25%, stepping once to 53.31%.
      const rows = day(KEY_BAT1, { start, count: 40, energyFull: 26360000 }).map(
        (row, index) =>
          index < 20
            ? row
            : rawRow({
                epoch: start + index * 180,
                capacity: 90 - index,
                energyFull: 26390000,
              }),
      );
      writeRawDay(f.state, KEY_BAT1, rows, { date: today() });

      const svg = Object.values(graph(f.state, ["--metric", "health"]).documents)[0];
      // Axis labels are snapped to a 5-point grid spanning at least 10
      // points, so a 0.06-point move cannot fill the plot.
      const labels = [...svg.matchAll(/>([\d.]+)%<\/text>/g)].map((m) => Number(m[1]));
      const span = Math.max(...labels) - Math.min(...labels);
      assert.ok(span >= 10, `axis span was ${span}, expected at least 10 points`);
      assert.match(svg, /too short to show a trend yet/);
    });
  });

  test("health reports capacity against design, in Wh and in cycles", () => {
    withFixture({ state: "graph-health-summary" }, (f) => {
      const start = nowEpoch() - 40 * 180;
      writeRawDay(
        f.state,
        KEY_BAT1,
        day(KEY_BAT1, { start, energyFull: 26360000, cycleCount: 112 }),
        { date: today() },
      );

      const svg = Object.values(graph(f.state, ["--metric", "health"]).documents)[0];
      assert.match(svg, /now 53\.3% of design/);
      assert.match(svg, /26\.36 Wh of 49\.50 Wh/);
      assert.match(svg, /112 cycles/);
    });
  });
});

describe("the optional viewer dependencies", () => {
  test("--format svg needs neither rsvg-convert nor chafa", () => {
    withFixture({ state: "graph-nodeps" }, (f) => {
      const start = nowEpoch() - 40 * 180;
      writeRawDay(f.state, KEY_BAT1, day(KEY_BAT1, { start }), { date: today() });

      const result = graph(f.state, ["--metric", "charge"], {
        env: {
          BATTERY_GRAPH_RSVG_COMMAND: "definitely-not-installed",
          BATTERY_GRAPH_CHAFA_COMMAND: "definitely-not-installed",
        },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.files.length, 1);
    });
  });

  test("a terminal render refuses plainly, and names the way forward", () => {
    withFixture({ state: "graph-refuse" }, (f) => {
      const start = nowEpoch() - 40 * 180;
      writeRawDay(f.state, KEY_BAT1, day(KEY_BAT1, { start }), { date: today() });

      const result = spawnSync(graphScript, ["--metric", "charge"], {
        encoding: "utf8",
        env: {
          ...process.env,
          BATTERY_SESSION_STATE_DIR: f.state,
          BATTERY_GRAPH_CHAFA_COMMAND: "definitely-not-installed",
          BATTERY_GRAPH_RSVG_COMMAND: "definitely-not-installed",
        },
      });
      assert.equal(result.status, 1);
      // It must not degrade silently into something else.
      assert.match(result.stderr, /Cannot render this chart/);
      assert.match(result.stderr, /librsvg/);
      assert.match(result.stderr, /chafa/);
      assert.match(result.stderr, /FORMAT=svg/);
      assert.match(result.stderr, /make doctor/);
    });
  });

  test("an unreadable state directory is reported, not drawn as an empty chart", () => {
    withFixture({ state: "graph-empty" }, (f) => {
      const result = graph(f.state, ["--metric", "charge"]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /No raw observations/);
    });
  });
});
