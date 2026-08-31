// battery_extract_windows(): raw observations -> windows + gaps.
//
// This is the single most important function ADR-0001 introduced, and the
// one with the least room for silent drift: the incremental path (one poll
// at a time) and `make reextract` (the whole file) call it identically, so
// whatever it gets wrong, it gets wrong everywhere at once.
//
// It also had zero coverage until this file: three real bugs shipped and
// were only caught by hand-testing against the actual awk implementation -
// a gap-triggered reset that ran after the row's own window arithmetic
// instead of before, letting `elapsed` span the gap; a fresh post-gap
// session inheriting the `eligible=0` flag from the gap that started it; and
// (in the caller, not here) a bash `read` target cleared on a failed read
// even when the loop body never ran. Every case below is chosen to make one
// of those regressions fail loudly if it comes back.

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const { withFixture } = require("./support/fixture");
const { modelLibrary, rawRow, rawPollRun, KEY_BAT0, KEY_BAT1 } = require("./support/battery");

// Runs battery_extract_windows() directly, feeding `rows` on stdin. Returns
// { windows, gaps, open } parsed into arrays/objects rather than raw text,
// since every test here cares about specific fields, not formatting.
function extract(rows, key = KEY_BAT1) {
  return withFixture({ dir: "extract" }, (f) => {
    const gapsFile = path.join(f.dir, "gaps.tsv");
    const openFile = path.join(f.dir, "open.tsv");
    const result = spawnSync(
      "bash",
      [
        "-c",
        `source ${JSON.stringify(modelLibrary)}; battery_extract_windows "$1" "$2" "$3"`,
        "_",
        key,
        gapsFile,
        openFile,
      ],
      { input: rows.join("\n") + "\n", encoding: "utf8" },
    );
    if (result.status !== 0) {
      throw new Error(`extract failed: ${result.stderr}`);
    }
    const windows = result.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [
          epoch,
          sessionEpoch,
          windowKey,
          drawMw,
          energyNow,
          energyFull,
          energyFullDesign,
          voltageNow,
          powerNow,
          capacity,
          cycleCount,
          eligible,
        ] = line.split("\t");
        return {
          epoch: Number(epoch),
          sessionEpoch: Number(sessionEpoch),
          key: windowKey,
          drawMw: Number(drawMw),
          energyNow: Number(energyNow),
          eligible: Number(eligible),
        };
      });
    const gaps = fs.existsSync(gapsFile)
      ? fs
          .readFileSync(gapsFile, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [key2, startEpoch, endEpoch, cause, acStart, acEnd, before, after, delta] =
              line.split("\t");
            return {
              key: key2,
              startEpoch: Number(startEpoch),
              endEpoch: Number(endEpoch),
              cause,
              acStart: Number(acStart),
              acEnd: Number(acEnd),
              delta: Number(delta),
            };
          })
      : [];
    const open = fs.existsSync(openFile)
      ? (() => {
          const [startEpoch, startEnergy, lastEpoch] = fs
            .readFileSync(openFile, "utf8")
            .trim()
            .split("\t");
          return {
            startEpoch: Number(startEpoch),
            startEnergy: Number(startEnergy),
            lastEpoch: Number(lastEpoch),
          };
        })()
      : null;
    return { windows, gaps, open };
  });
}

describe("a continuous discharge run", () => {
  test("completes a window once elapsed time and energy loss both qualify", () => {
    // Given a battery polled every 180s, losing energy steadily
    // When it crosses the 900s window boundary
    // Then one window is recorded with the right draw
    const rows = rawPollRun(KEY_BAT1, { count: 6, drawUwhPerPoll: 500000 });
    const { windows } = extract(rows);
    assert.equal(windows.length, 1);
    // 2.5 Wh over 900s.
    assert.equal(windows[0].drawMw, 10000);
    assert.equal(windows[0].eligible, 1);
  });

  test("keeps completing windows past the first, without starting a new session", () => {
    // Given a run long enough for several windows with no interruption
    // When windows are extracted
    // Then every window shares one session id, because a continuous run is
    // one session regardless of how many 15-minute windows it spans
    const rows = rawPollRun(KEY_BAT1, { count: 30, drawUwhPerPoll: 300000 });
    const { windows } = extract(rows);
    assert.ok(windows.length >= 2, `expected multiple windows, got ${windows.length}`);
    const sessions = new Set(windows.map((w) => w.sessionEpoch));
    assert.equal(sessions.size, 1);
  });

  test("reports the still-open window for the view to show progress on", () => {
    // Given a run that ends mid-window
    // When extraction finishes
    // Then the open file names that window's own start, not the last
    // completed window's
    const rows = rawPollRun(KEY_BAT1, { count: 3, drawUwhPerPoll: 300000 });
    const { windows, open } = extract(rows);
    assert.equal(windows.length, 0);
    assert.equal(open.startEpoch, 1900000000);
  });

  test("reports no open window once the battery stops discharging", () => {
    const rows = [
      ...rawPollRun(KEY_BAT1, { count: 3, drawUwhPerPoll: 300000 }),
      rawRow({ epoch: 1900000540, status: "Not charging", energyNow: 25000000 }),
    ];
    const { open } = extract(rows);
    assert.equal(open.startEpoch, 0);
  });
});

describe("energy that does not decrease", () => {
  test("restarts the window rather than completing on a rise", () => {
    // Given energy that rises mid-window, as a recalibration or a brief
    // charge would produce
    // When extraction runs
    // Then no window completes across the rise, and the next window starts
    // fresh from it
    const rows = [
      rawRow({ epoch: 1900000000, trigger: "start", energyNow: 20000000 }),
      rawRow({ epoch: 1900000180, energyNow: 19700000 }),
      rawRow({ epoch: 1900000360, energyNow: 20500000 }), // rises
      ...rawPollRun(KEY_BAT1, { count: 6, start: 1900000360, energyStart: 20500000, drawUwhPerPoll: 300000 }),
    ];
    const { windows } = extract(rows);
    for (const window of windows) {
      // No window's draw reflects the impossible negative-then-positive span.
      assert.ok(window.drawMw > 0 && window.drawMw < 20000);
    }
  });
});

describe("gap classification", () => {
  test("classifies a reboot as off: a different boot id", () => {
    // Given a large time gap paired with a new boot id
    // When extraction runs
    // Then the gap is classified "off", and no window spans it
    const rows = [
      rawRow({ epoch: 1900000000, trigger: "start", energyNow: 20000000, bootId: "boot-a" }),
      rawRow({ epoch: 1900010000, trigger: "start", energyNow: 19900000, bootId: "boot-b", suspendCount: 0 }),
    ];
    const { gaps, windows } = extract(rows);
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].cause, "off");
    assert.equal(windows.length, 0);
  });

  test("classifies a suspend as asleep: same boot id, suspend count increased", () => {
    // Given a large time gap with the same boot id but one more suspend cycle
    // When extraction runs
    // Then the gap is classified "asleep"
    const rows = [
      rawRow({ epoch: 1900000000, trigger: "start", energyNow: 20000000, bootId: "boot-a", suspendCount: 0 }),
      rawRow({ epoch: 1900021800, trigger: "resume", energyNow: 19950000, bootId: "boot-a", suspendCount: 1 }),
    ];
    const { gaps } = extract(rows);
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].cause, "asleep");
    assert.equal(gaps[0].delta, 50000);
  });

  test("classifies an unexplained gap as blind: same boot, no suspend", () => {
    // Given a large time gap with neither a reboot nor a suspend cycle
    // When extraction runs
    // Then the gap is classified "blind" — the machine was awake and the
    // service was simply not running
    const rows = [
      rawRow({ epoch: 1900000000, trigger: "start", energyNow: 20000000, bootId: "boot-a", suspendCount: 0 }),
      rawRow({ epoch: 1900001200, energyNow: 19900000, bootId: "boot-a", suspendCount: 0 }),
    ];
    const { gaps } = extract(rows);
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].cause, "blind");
  });

  test("tolerates ordinary clock jitter without recording a gap", () => {
    // Given a one-second backward step, the kind routine NTP correction
    // produces
    // When extraction runs
    // Then no gap is recorded
    const rows = [
      rawRow({ epoch: 1900000000, trigger: "start", energyNow: 20000000 }),
      rawRow({ epoch: 1900000179, energyNow: 19700000 }),
    ];
    const { gaps } = extract(rows);
    assert.equal(gaps.length, 0);
  });

  test("treats a real backward clock jump as a gap", () => {
    const rows = [
      rawRow({ epoch: 1900000000, trigger: "start", energyNow: 20000000 }),
      rawRow({ epoch: 1899999000, energyNow: 19900000 }),
    ];
    const { gaps } = extract(rows);
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].cause, "clock");
  });
});

describe("windows that span an interruption", () => {
  test("does not let elapsed time span the gap itself", () => {
    // Given a window that was only 540s (3 polls) into its 900s target when
    // an 11-hour suspend gap hit
    // When extraction runs
    // Then no window is falsely completed using elapsed time that spans the
    // gap — the pre-gap partial progress is abandoned, not stitched together
    // with post-gap polls into one bogus window
    const rows = [
      ...rawPollRun(KEY_BAT1, { count: 3, drawUwhPerPoll: 300000, bootId: "boot-a", suspendCount: 0 }),
      rawRow({
        epoch: 1900000540 + 39600,
        trigger: "resume",
        energyNow: 19100000,
        bootId: "boot-a",
        suspendCount: 1,
      }),
    ];
    const { windows, gaps } = extract(rows);
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].cause, "asleep");
    for (const window of windows) {
      // A bogus elapsed-across-the-gap window would report a near-zero draw
      // (huge elapsed, small energy delta) or fail the plausibility bound
      // entirely. Neither should appear.
      assert.ok(window.drawMw >= 100 && window.drawMw <= 120000);
    }
  });

  test("starts a fresh, eligible session immediately after a gap", () => {
    // Given a gap followed by a full clean window
    // When extraction runs
    // Then that window is eligible=1 and carries a new session id — it must
    // not inherit the eligible=0 the gap itself was flagged with
    const rows = [
      rawRow({ epoch: 1900000000, trigger: "start", energyNow: 20000000, bootId: "boot-a", suspendCount: 0 }),
      rawRow({
        epoch: 1900041800,
        trigger: "resume",
        energyNow: 19950000,
        bootId: "boot-a",
        suspendCount: 1,
      }),
      ...rawPollRun(KEY_BAT1, {
        count: 6,
        start: 1900041800,
        energyStart: 19950000,
        drawUwhPerPoll: 300000,
        bootId: "boot-a",
        suspendCount: 1,
      }).slice(1),
    ];
    const { windows, gaps } = extract(rows);
    assert.equal(gaps.length, 1);
    assert.ok(windows.length >= 1);
    assert.equal(windows[0].eligible, 1, "the post-gap window must not inherit eligible=0");
    assert.equal(
      windows[0].sessionEpoch,
      1900041800,
      "the session id must be the resume row, not the pre-gap start",
    );
  });

  test("never lets a window spanning a gap complete at all, rather than completing it as ineligible", () => {
    // A gap always resets have_start on the row where it is detected, before
    // that row's own discharge processing runs (the ordering fix). That row
    // then always takes the fresh-session branch, which also resets
    // eligible back to 1 in the same step - so a window that started before
    // a gap is abandoned outright, never completed and flagged unusable.
    // This is a stronger guarantee than "mark it ineligible": the value
    // simply never exists to be misread. The `eligible` column consequently
    // reads 1 on every window this function actually emits; a future
    // extraction rule that lets a partial pre-gap window survive would need
    // to reintroduce eligible=0 deliberately, and this test would need to
    // change with it.
    const rows = [
      rawRow({ epoch: 1900000000, trigger: "start", energyNow: 20000000, bootId: "boot-a", suspendCount: 0 }),
      rawRow({ epoch: 1900000700, energyNow: 19700000, bootId: "boot-a", suspendCount: 0 }),
      // A gap just over the poll tolerance, but short enough the window
      // would have reached 900s of elapsed time on the far side if the two
      // spans were wrongly stitched together.
      rawRow({ epoch: 1900001300, energyNow: 19400000, bootId: "boot-a", suspendCount: 0 }),
    ];
    const { windows, gaps } = extract(rows);
    assert.ok(gaps.length >= 1);
    for (const window of windows) {
      assert.equal(window.eligible, 1);
    }
  });
});

describe("malformed and short input", () => {
  test("ignores a row with too few columns rather than crashing", () => {
    const { windows, gaps } = extract(["1900000000\tstart\tonly-a-few-fields"]);
    assert.equal(windows.length, 0);
    assert.equal(gaps.length, 0);
  });

  test("produces nothing from an empty input", () => {
    const { windows, gaps, open } = extract([]);
    assert.equal(windows.length, 0);
    assert.equal(gaps.length, 0);
    assert.equal(open.startEpoch, 0);
  });

  test("rejects a draw outside plausible bounds for a laptop battery", () => {
    // A jump far too large to be real (a counter glitch or a battery swap
    // mid-window) must not produce a window at all.
    const rows = [
      rawRow({ epoch: 1900000000, trigger: "start", energyNow: 40000000 }),
      rawRow({ epoch: 1900000900, energyNow: 1000000 }), // implausible draw
    ];
    const { windows } = extract(rows);
    assert.equal(windows.length, 0);
  });
});

describe("battery isolation", () => {
  test("only ever reports windows for the requested key", () => {
    // The extractor is called once per battery on a raw file already scoped
    // to that battery's own directory, so it has no way to see another
    // battery's rows - this asserts the output never claims a different key.
    const rows = rawPollRun(KEY_BAT0, { count: 6, drawUwhPerPoll: 300000 });
    const { windows } = extract(rows, KEY_BAT0);
    for (const window of windows) {
      assert.equal(window.key, KEY_BAT0);
    }
  });
});
