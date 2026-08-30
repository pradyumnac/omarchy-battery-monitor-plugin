// `make export`: the history as CSV, for analysis outside this repo.
//
// The value of this path is that a notebook can read it without arguments and
// without parsing identity strings, so that is what these assert.

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { withFixture } = require("./support/fixture");
const {
  exportScript,
  writeHistory,
  windowsFor,
  historyRow,
  KEY_BAT1,
  HISTORY_HEADER_V2,
} = require("./support/battery");

function run(stateDir) {
  return spawnSync(
    exportScript,
    [path.join(stateDir, "discharge-history.tsv")],
    { env: { ...process.env }, encoding: "utf8" },
  );
}

// A deliberately small CSV reader: enough to prove the shape is standard,
// without pulling in a dependency.
function parseCsv(text) {
  const lines = text.trim().split("\n");
  const split = (line) => {
    const fields = [];
    let field = "";
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
      const character = line[index];
      if (quoted) {
        if (character === '"' && line[index + 1] === '"') {
          field += '"';
          index += 1;
        } else if (character === '"') {
          quoted = false;
        } else {
          field += character;
        }
      } else if (character === '"') {
        quoted = true;
      } else if (character === ",") {
        fields.push(field);
        field = "";
      } else {
        field += character;
      }
    }
    fields.push(field);
    return fields;
  };
  const header = split(lines[0]);
  return lines.slice(1).map((line) => {
    const fields = split(line);
    return Object.fromEntries(header.map((name, index) => [name, fields[index]]));
  });
}

describe("the CSV export", () => {
  test("splits identity into columns so no string parsing is needed", () => {
    // Given recorded windows
    // When they are exported
    // Then vendor, model and serial are their own columns, because a notebook
    // should be able to group by them directly
    withFixture({ state: "export" }, (f) => {
      writeHistory(f.state, windowsFor(KEY_BAT1, { count: 3, drawMw: 9000 }));
      const result = run(f.state);
      assert.equal(result.status, 0, result.stderr);

      const rows = parseCsv(result.stdout);
      assert.equal(rows.length, 3);
      assert.equal(rows[0].battery_name, "BAT1");
      assert.equal(rows[0].vendor, "SMP");
      assert.equal(rows[0].model, "01AV425");
      assert.equal(rows[0].serial, "783");
      assert.equal(rows[0].battery_key, KEY_BAT1);
    });
  });

  test("carries derived columns the raw history does not hold", () => {
    withFixture({ state: "export-derived" }, (f) => {
      writeHistory(f.state, [
        historyRow({
          epoch: 1900000000,
          key: KEY_BAT1,
          drawMw: 9000,
          energyNow: 13000000,
          energyFull: 26000000,
          energyFullDesign: 49500000,
        }),
      ]);
      const [row] = parseCsv(run(f.state).stdout);
      assert.equal(row.draw_w, "9");
      assert.equal(row.energy_now_wh, "13");
      assert.equal(row.energy_full_wh, "26");
      // 26 Wh of a 49.5 Wh design.
      assert.match(row.health_percent, /^52\.5/);
      assert.match(row.timestamp, /^\d{4}-\d{2}-\d{2}T/);
    });
  });

  test("quotes text fields so a comma in a model name cannot shift columns", () => {
    withFixture({ state: "export-quoting" }, (f) => {
      writeHistory(f.state, [
        historyRow({
          epoch: 1900000000,
          key: "BAT1:ACME:Pro, Max:9",
          drawMw: 9000,
          status: "Discharging",
        }),
      ]);
      const rows = parseCsv(run(f.state).stdout);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].vendor, "ACME");
      assert.equal(rows[0].model, "Pro, Max");
      assert.equal(rows[0].draw_mw, "9000");
    });
  });

  test("refuses a schema whose rows it cannot attribute", () => {
    withFixture({ state: "export-legacy" }, (f) => {
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

  test("refuses a schema it does not know", () => {
    withFixture({ state: "export-schema" }, (f) => {
      writeHistory(f.state, [], "# battery-discharge-history\tv99");
      const result = run(f.state);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Unsupported history format/);
    });
  });

  test("reports a missing history rather than emitting an empty file", () => {
    withFixture({ state: "export-missing" }, (f) => {
      const result = run(f.state);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /No discharge history/);
    });
  });
});
