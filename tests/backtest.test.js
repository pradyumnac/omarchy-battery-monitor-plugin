const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { withFixture } = require("./support/fixture");

const backtest = path.join(__dirname, "..", "scripts", "battery-backtest.sh");

function writeHistory(dir, rows) {
  const file = path.join(dir, "discharge-history.tsv");
  fs.writeFileSync(
    file,
    ["# battery-discharge-history\tv1", ...rows].join("\n") + "\n",
  );
  return file;
}

function run(file, extraEnv = {}) {
  return spawnSync(backtest, [file], {
    env: { ...process.env, ...extraEnv },
    encoding: "utf8",
  });
}

describe("the backtest harness", () => {
  test("scores every estimator against held-out rows", () => {
    withFixture({ dir: "backtest" }, (f) => {
      // 40 windows alternating between a quiet and a heavy session.
      const rows = [];
      for (let session = 0; session < 5; session += 1) {
        const base = session % 2 === 1 ? 18000 : 7000;
        for (let window = 0; window < 8; window += 1) {
          const epoch = 1900000000 + (session * 8 + window) * 900;
          rows.push(`${epoch}\ts${session}\t${base + window * 100}\t50000000`);
        }
      }
      const result = run(writeHistory(f.dir, rows));

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /40 valid rows · 36 scored predictions/);
      for (const estimator of ["median", "recent", "ewma", "last"]) {
        assert.match(result.stdout, new RegExp(`\\b${estimator}\\b.*mW`));
      }
    });
  });

  test("never lets an estimator see the row it is predicting", () => {
    withFixture({ dir: "backtest-holdout" }, (f) => {
      // Every prior window is 10000; the final row is nothing like them. An
      // estimator that peeked at the row would score a zero error on it.
      const rows = Array.from(
        { length: 10 },
        (_, index) => `${1900000000 + index * 900}\ts0\t10000\t50000000`,
      );
      rows.push(`${1900000000 + 10 * 900}\ts0\t90000\t50000000`);
      const result = run(writeHistory(f.dir, rows));

      assert.equal(result.status, 0, result.stderr);
      // The last row contributes an 80000 mW error to every estimator, so no
      // estimator can report a mean error near zero.
      const means = [...result.stdout.matchAll(/^\s+\w+\s+\d+\s+(\d+) mW/gm)];
      assert.ok(means.length >= 3);
      for (const [, mean] of means) {
        assert.ok(Number(mean) > 1000, `suspiciously small error: ${mean}`);
      }
    });
  });

  test("refuses to report on history too short to hold anything out", () => {
    withFixture({ dir: "backtest-empty" }, (f) => {
      const result = run(
        writeHistory(f.dir, ["1900000000\ts0\t10000\t50000000"]),
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Not enough history/);
    });
  });

  test("refuses a history file whose schema it does not know", () => {
    withFixture({ dir: "backtest-schema" }, (f) => {
      const file = path.join(f.dir, "discharge-history.tsv");
      fs.writeFileSync(file, "# battery-discharge-history\tv99\n");
      const result = run(file);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Unsupported history format/);
    });
  });
});
