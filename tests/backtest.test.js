// `make backtest`: the evidence gate for any model change.
//
// The scoring itself is unit tested in model-lib.test.js. What matters here is
// that the report reaches the same verdict the running model does, and that it
// refuses to report where it has nothing to say.

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { withFixture } = require("./support/fixture");
const {
  backtestScript,
  writeHistory,
  windowsFor,
  KEY_BAT0,
  KEY_BAT1,
  HISTORY_HEADER_V2,
} = require("./support/battery");

function run(stateDir, extraEnv = {}) {
  return spawnSync(
    backtestScript,
    [path.join(stateDir, "discharge-history.tsv")],
    { env: { ...process.env, ...extraEnv }, encoding: "utf8" },
  );
}

// A load that alternates between quiet and heavy blocks, so a recency
// estimator has something real to beat the median with.
function shiftingWindows(key, start) {
  return windowsFor(key, {
    count: 40,
    sessions: 5,
    start,
    drawMw: (index) => (Math.floor(index / 8) % 2 === 1 ? 18000 : 7000),
  });
}

describe("the backtest report", () => {
  test("scores every estimator separately for each battery", () => {
    // Given windows for two different batteries
    // When the report is produced
    // Then each battery gets its own scores, because an estimator suiting a
    // healthy cell need not suit a worn one
    withFixture({ state: "backtest" }, (f) => {
      writeHistory(f.state, [
        ...shiftingWindows(KEY_BAT1, 1900000000),
        ...shiftingWindows(KEY_BAT0, 1900100000),
      ]);
      const result = run(f.state);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /BAT1 · SMP · 01AV425 · 783/);
      assert.match(result.stdout, /BAT0 · LGC · 01AV420 · 1020/);
      for (const estimator of ["median", "recent", "ewma", "last"]) {
        assert.match(result.stdout, new RegExp(`\\b${estimator}\\b.*mW`));
      }
    });
  });

  test("reports the selection the tracker would actually make", () => {
    // The report and the running model must not tell different stories, so the
    // report states the choice as well as the scores.
    withFixture({ state: "backtest-selection" }, (f) => {
      writeHistory(f.state, shiftingWindows(KEY_BAT1, 1900000000));
      const result = run(f.state);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /selected: \w+/);
    });
  });

  test("never lets an estimator see the window it is predicting", () => {
    // Given a long steady run ending in one wildly different window
    // When the report is produced
    // Then no estimator reports a near-zero error, which it could only do by
    // having seen the window it was asked to predict
    withFixture({ state: "backtest-holdout" }, (f) => {
      const rows = windowsFor(KEY_BAT1, {
        count: 12,
        sessions: 1,
        drawMw: 10000,
        start: 1900000000,
      });
      rows.push(
        ...windowsFor(KEY_BAT1, {
          count: 1,
          drawMw: 90000,
          start: 1900009999,
        }),
      );
      writeHistory(f.state, rows);

      const result = run(f.state);
      assert.equal(result.status, 0, result.stderr);
      const means = [...result.stdout.matchAll(/^\s+\w+\s+\d+\s+(\d+) mW/gm)];
      assert.ok(means.length >= 3);
      for (const [, mean] of means) {
        assert.ok(Number(mean) > 500, `suspiciously small error: ${mean}`);
      }
    });
  });

  test("refuses history too short to hold anything out", () => {
    withFixture({ state: "backtest-short" }, (f) => {
      writeHistory(f.state, windowsFor(KEY_BAT1, { count: 1 }));
      const result = run(f.state);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /No battery has enough history/);
    });
  });

  test("refuses a schema it cannot score per battery", () => {
    // Given a pack-level history from an older schema
    // When the report is produced
    // Then it says so rather than scoring rows it cannot attribute
    withFixture({ state: "backtest-legacy" }, (f) => {
      writeHistory(
        f.state,
        ["1900000000\ts0\t9000\t26000000"],
        HISTORY_HEADER_V2,
      );
      const result = run(f.state);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /predates per-battery records/);
    });
  });

  test("refuses a schema it does not know at all", () => {
    withFixture({ state: "backtest-schema" }, (f) => {
      writeHistory(f.state, [], "# battery-discharge-history\tv99");
      const result = run(f.state);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Unsupported history format/);
    });
  });
});
