// `make export`: every tier of collected data as one zip archive (ADR-0001).
//
// The script writes a file to disk rather than a stream to stdout, so these
// tests unzip the result and read its members - there is no CSV-on-stdout
// contract left to assert against.

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { withFixture } = require("./support/fixture");
const {
  exportScript,
  writeWindows,
  writeGaps,
  writeBatteryState,
  writeRawDay,
  windowsForBattery,
  gapRow,
  batteryStateRow,
  rawPollRun,
  KEY_BAT1,
} = require("./support/battery");

function run(stateDir, destDir, extraEnv = {}) {
  return spawnSync(exportScript, [destDir], {
    env: { ...process.env, BATTERY_SESSION_STATE_DIR: stateDir, ...extraEnv },
    encoding: "utf8",
  });
}

// Unzips the archive named in `result.stdout` ("Wrote <path>") into a fresh
// directory and returns that directory, so a test can read members with
// plain fs calls rather than parsing zip listings.
function unzipResult(result, workDir) {
  const match = result.stdout.match(/Wrote (.+\.zip)/);
  assert.ok(match, `export did not report a written archive: ${result.stdout}${result.stderr}`);
  const archivePath = match[1].trim();
  const out = path.join(workDir, "unzipped");
  fs.mkdirSync(out);
  const unzip = spawnSync("unzip", ["-q", archivePath, "-d", out]);
  assert.equal(unzip.status, 0, `unzip failed: ${unzip.stderr}`);
  return { archivePath, dir: out };
}

describe("the export archive", () => {
  test("names the archive with host, user, and a UTC timestamp", () => {
    withFixture({ state: "export-name", dest: "export-name-dest" }, (f) => {
      writeWindows(f.state, windowsForBattery(KEY_BAT1, { count: 3 }));
      const result = run(f.state, f.dest);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /battery-export-.+-.+-\d{8}T\d{6}Z\.zip/);
    });
  });

  test("bundles windows, gaps, and battery-state as separate files", () => {
    // No joined table: a notebook joins on its own terms, so each tier stays
    // its own file inside the archive.
    withFixture({ state: "export-tiers", dest: "export-tiers-dest" }, (f) => {
      writeWindows(f.state, windowsForBattery(KEY_BAT1, { count: 3 }));
      writeGaps(f.state, [gapRow({ key: KEY_BAT1, startEpoch: 100, endEpoch: 200 })]);
      writeBatteryState(f.state, [batteryStateRow({ key: KEY_BAT1 })]);

      const result = run(f.state, f.dest);
      assert.equal(result.status, 0, result.stderr);
      const { dir } = unzipResult(result, f.dest);

      assert.ok(fs.existsSync(path.join(dir, "windows.csv")));
      assert.ok(fs.existsSync(path.join(dir, "gaps.csv")));
      assert.ok(fs.existsSync(path.join(dir, "battery-state.tsv")));
      assert.ok(fs.existsSync(path.join(dir, "manifest.json")));
    });
  });

  test("includes raw observations as one CSV per battery per day", () => {
    withFixture({ state: "export-raw", dest: "export-raw-dest" }, (f) => {
      writeRawDay(f.state, KEY_BAT1, rawPollRun(KEY_BAT1, { count: 6 }), {
        date: "2026-03-01",
      });
      writeWindows(f.state, windowsForBattery(KEY_BAT1, { count: 3 }));

      const result = run(f.state, f.dest);
      assert.equal(result.status, 0, result.stderr);
      const { dir } = unzipResult(result, f.dest);

      const rawCsv = path.join(dir, "raw", "BAT1:SMP:01AV425:783", "2026-03-01.csv");
      assert.ok(fs.existsSync(rawCsv), `expected ${rawCsv}`);
      const lines = fs.readFileSync(rawCsv, "utf8").trim().split("\n");
      assert.equal(lines[0], [
        "timestamp", "epoch", "trigger", "rules", "status", "energy_now_uwh",
        "energy_full_uwh", "energy_full_design_uwh", "voltage_now_uv",
        "power_now_uw", "capacity_percent", "cycle_count",
        "end_threshold_percent", "ac_online", "boot_id", "suspend_count",
        "uptime_seconds",
      ].join(","));
      assert.equal(lines.length, 7); // header + 6 polls
    });
  });

  test("splits windows.csv identity into its own columns", () => {
    withFixture({ state: "export-identity", dest: "export-identity-dest" }, (f) => {
      writeWindows(f.state, windowsForBattery(KEY_BAT1, { count: 3, drawMw: 9000 }));
      const result = run(f.state, f.dest);
      const { dir } = unzipResult(result, f.dest);
      const rows = fs
        .readFileSync(path.join(dir, "windows.csv"), "utf8")
        .trim()
        .split("\n");
      const header = rows[0].split(",");
      assert.ok(header.includes("vendor"));
      assert.ok(header.includes("model"));
      assert.ok(header.includes("serial"));
      const first = rows[1].split(",");
      assert.equal(first[header.indexOf("vendor")], '"SMP"');
      assert.equal(first[header.indexOf("draw_mw")], "9000");
    });
  });

  test("records the format and rules versions in the manifest", () => {
    withFixture({ state: "export-manifest", dest: "export-manifest-dest" }, (f) => {
      writeWindows(f.state, windowsForBattery(KEY_BAT1, { count: 3 }));
      const result = run(f.state, f.dest);
      const { dir } = unzipResult(result, f.dest);
      const manifest = JSON.parse(
        fs.readFileSync(path.join(dir, "manifest.json"), "utf8"),
      );
      assert.equal(manifest.windows_format, "v0.1.0");
      assert.equal(manifest.raw_format, "v0.1.0");
      assert.ok(manifest.generated_at_utc);
      assert.ok(manifest.host);
      assert.ok(manifest.user);
    });
  });

  test("exports every tier present, with no option to narrow it", () => {
    // The destination directory is the only argument the script accepts -
    // there is no flag to select a subset.
    withFixture({ state: "export-all", dest: "export-all-dest" }, (f) => {
      writeWindows(f.state, windowsForBattery(KEY_BAT1, { count: 12 }));
      writeGaps(f.state, [gapRow({ key: KEY_BAT1, startEpoch: 100, endEpoch: 200 })]);
      writeRawDay(f.state, KEY_BAT1, rawPollRun(KEY_BAT1, { count: 4 }));
      const result = run(f.state, f.dest);
      assert.equal(result.status, 0, result.stderr);
      const { dir } = unzipResult(result, f.dest);
      assert.ok(fs.existsSync(path.join(dir, "windows.csv")));
      assert.ok(fs.existsSync(path.join(dir, "gaps.csv")));
      assert.ok(fs.existsSync(path.join(dir, "raw")));
    });
  });

  test("refuses to write into a destination it cannot create", () => {
    withFixture({ state: "export-baddest" }, (f) => {
      writeWindows(f.state, windowsForBattery(KEY_BAT1, { count: 3 }));
      // A file, not a directory, so mkdir -p on it must fail.
      const blocked = path.join(f.state, "blocked-dest");
      fs.writeFileSync(blocked, "not a directory\n");
      const result = run(f.state, path.join(blocked, "nested"));
      assert.notEqual(result.status, 0);
    });
  });

  test("reports nothing to export when the state directory is empty", () => {
    withFixture({ state: "export-empty", dest: "export-empty-dest" }, (f) => {
      const result = run(f.state, f.dest);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /No exportable data/);
    });
  });
});
