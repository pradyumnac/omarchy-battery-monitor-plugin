// Unit tests for service/battery-model.sh.
//
// Everything else in this plugin is built on these rules, and until now they
// were only exercised indirectly through the tracker, the view and the status
// report. Two defects reached real hardware that way: a threshold-hold rule
// that matched a status string without checking the threshold, and a sampling
// window that recorded nothing while reporting success. Both are cheap to
// catch here and expensive to catch anywhere else.

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { withFixture } = require("./support/fixture");
const {
  modelEval,
  writeHistory,
  historyRow,
  windowsFor,
  writeEstimators,
  KEY_BAT0,
  KEY_BAT1,
  KEY_RETIRED,
  HISTORY_HEADER_V1,
  HISTORY_HEADER_V2,
} = require("./support/battery");

function evaluate(snippet) {
  return modelEval(snippet).trim();
}

describe("battery identity", () => {
  test("builds a key from what sysfs publishes about a cell", () => {
    // Given a battery's vendor, model and serial
    // When a key is built
    // Then it is NAME:VENDOR:MODEL:SERIAL
    assert.equal(
      evaluate('battery_model_battery_key BAT0 LGC 01AV420 1020'),
      "BAT0:LGC:01AV420:1020",
    );
  });

  test("trims the padding sysfs puts around a serial", () => {
    // Given a serial reported as " 1020", as this firmware does
    // When a key is built
    // Then the padding is not part of the identity
    assert.equal(
      evaluate('battery_model_battery_key BAT0 LGC 01AV420 " 1020 "'),
      "BAT0:LGC:01AV420:1020",
    );
  });

  test("neutralises characters that would corrupt the record", () => {
    // Given a vendor string containing the field and record separators
    // When a key is built
    // Then neither the key format nor the tab-separated history can be broken
    const key = evaluate(
      "battery_model_battery_key BAT0 'A:B,C' $'M\\tN' 1",
    );
    assert.equal(key, "BAT0:A_B_C:M N:1");
    assert.equal(key.split(":").length, 4);
    assert.ok(!key.includes("\t"));
  });

  test("orders a pack key so the same set always reads the same", () => {
    // Given the same two batteries presented in either order
    // When a pack key is built
    // Then both produce an identical key
    const forward = evaluate(
      `battery_model_pack_key ${KEY_BAT0} ${KEY_BAT1}`,
    );
    const reverse = evaluate(
      `battery_model_pack_key ${KEY_BAT1} ${KEY_BAT0}`,
    );
    assert.equal(forward, reverse);
    assert.equal(forward, `${KEY_BAT0},${KEY_BAT1}`);
  });

  test("reports an identity with no serial as weak", () => {
    // Given firmware that publishes no serial
    // When the pack key is checked
    // Then it is flagged, because two identical spares cannot be told apart
    assert.equal(
      evaluate(
        'battery_model_pack_key_is_weak "BAT0:LGC:01AV420:" && echo weak || echo strong',
      ),
      "weak",
    );
    assert.equal(
      evaluate(
        `battery_model_pack_key_is_weak "${KEY_BAT0}" && echo weak || echo strong`,
      ),
      "strong",
    );
  });
});

describe("charge-threshold holds", () => {
  test("claims a hold only once the battery reached its own cap", () => {
    // Given a battery parked at or above its configured stop threshold
    // When the hold rule is applied
    // Then it is a hold
    assert.equal(
      evaluate('battery_model_threshold_held "Not charging" 90 90 && echo held || echo idle'),
      "held",
    );
    assert.equal(
      evaluate('battery_model_threshold_held "Not charging" 95 90 && echo held || echo idle'),
      "held",
    );
  });

  test("does not claim a hold for a battery merely awaiting its turn", () => {
    // Given a battery reporting "Not charging" well below its cap, which is
    // what a second cell does while the first one charges
    // When the hold rule is applied
    // Then it is not a hold
    assert.equal(
      evaluate('battery_model_threshold_held "Not charging" 70 90 && echo held || echo idle'),
      "idle",
    );
  });

  test("does not claim a hold when no cap is configured", () => {
    // Given a battery with no charge-stop threshold set
    // When the hold rule is applied
    // Then it is not a hold, whatever its charge level
    assert.equal(
      evaluate('battery_model_threshold_held "Not charging" 100 0 && echo held || echo idle'),
      "idle",
    );
  });

  test("ignores any status other than the one sysfs uses for a hold", () => {
    // Given a discharging or charging battery
    // When the hold rule is applied
    // Then it is never a hold
    for (const status of ["Discharging", "Charging", "Full", ""]) {
      assert.equal(
        evaluate(
          `battery_model_threshold_held "${status}" 95 90 && echo held || echo idle`,
        ),
        "idle",
        `status ${status} must not read as a threshold hold`,
      );
    }
  });
});

describe("statistics and projection", () => {
  test("takes the middle value of an odd sample", () => {
    assert.equal(
      evaluate("values=(1 5 9); battery_model_median values"),
      "5",
    );
  });

  test("averages the two middle values of an even sample", () => {
    assert.equal(
      evaluate("values=(1 5 9 11); battery_model_median values"),
      "7",
    );
  });

  test("returns zero rather than failing on an empty sample", () => {
    // Given no evidence at all
    // When a statistic is asked for
    // Then it answers zero instead of erroring into a caller
    assert.equal(evaluate("values=(); battery_model_median values"), "0");
    assert.equal(evaluate("values=(); battery_model_mean values"), "0");
    assert.equal(evaluate("values=(); battery_model_percentile values 75"), "0");
  });

  test("reports a percentile that was actually measured", () => {
    // Given a sorted sample
    // When a percentile is taken
    // Then it is a real observation, never an interpolation between two
    const values = "values=(100 200 300 400)";
    assert.equal(evaluate(`${values}; battery_model_percentile values 25`), "100");
    assert.equal(evaluate(`${values}; battery_model_percentile values 75`), "300");
    assert.equal(evaluate(`${values}; battery_model_percentile values 100`), "400");
  });

  test("sorts numerically, not as text", () => {
    // Given values whose text order differs from their numeric order
    // When they are sorted
    // Then 9 does not sort after 10
    assert.equal(
      evaluate(
        "values=(10 9 100 2); battery_model_sort_numbers values; echo ${values[*]}",
      ),
      "2 9 10 100",
    );
  });

  test("converts stored energy and draw into seconds of runtime", () => {
    // Given 50 Wh at 10 W
    // When runtime is projected
    // Then it is five hours
    assert.equal(
      evaluate("battery_model_project_seconds 50000000 10000"),
      "18000",
    );
  });

  test("refuses to project from an impossible input", () => {
    // Given zero or negative energy, or a draw of zero
    // When runtime is projected
    // Then it answers zero rather than dividing by zero
    assert.equal(evaluate("battery_model_project_seconds 0 10000"), "0");
    assert.equal(evaluate("battery_model_project_seconds 50000000 0"), "0");
    assert.equal(evaluate("battery_model_project_seconds abc 10000"), "0");
  });
});

describe("discharge-window arithmetic", () => {
  test("turns energy consumed over time into an average draw", () => {
    // Given 2.5 Wh drawn over 15 minutes
    // When the window draw is computed
    // Then it is 10 W
    assert.equal(
      evaluate("battery_model_window_draw_mw 2500000 900"),
      "10000",
    );
  });

  test("refuses a window that consumed nothing or took no time", () => {
    assert.equal(
      evaluate("battery_model_window_draw_mw 0 900 || echo refused"),
      "refused",
    );
    assert.equal(
      evaluate("battery_model_window_draw_mw 2500000 0 || echo refused"),
      "refused",
    );
  });

  test("only accepts a window that ran long enough to be evidence", () => {
    assert.equal(
      evaluate("battery_model_window_complete 900 && echo yes || echo no"),
      "yes",
    );
    assert.equal(
      evaluate("battery_model_window_complete 899 && echo yes || echo no"),
      "no",
    );
  });

  test("rejects a draw no laptop battery could really produce", () => {
    // Given a draw far outside a plausible range, as a suspend or a counter
    // jump produces
    // When it is checked
    // Then it is rejected before it can become evidence
    assert.equal(
      evaluate("battery_model_draw_plausible 10000 && echo ok || echo no"),
      "ok",
    );
    assert.equal(
      evaluate("battery_model_draw_plausible 5 && echo ok || echo no"),
      "no",
    );
    assert.equal(
      evaluate("battery_model_draw_plausible 999999 && echo ok || echo no"),
      "no",
    );
  });
});

describe("reading the history", () => {
  function withHistory(rows, callback, header) {
    return withFixture({ state: "model-history" }, (f) => {
      writeHistory(f.state, rows, header);
      return callback(path.join(f.state, "discharge-history.tsv"), f.state);
    });
  }

  test("recognises each schema it can read, and refuses the rest", () => {
    withHistory([], (file) => {
      assert.equal(evaluate(`battery_model_history_format ${file}`), "3");
    });
    withHistory([], (file) => {
      assert.equal(evaluate(`battery_model_history_format ${file}`), "2");
    }, HISTORY_HEADER_V2);
    withHistory([], (file) => {
      assert.equal(evaluate(`battery_model_history_format ${file}`), "1");
    }, HISTORY_HEADER_V1);
    withHistory([], (file) => {
      assert.equal(evaluate(`battery_model_history_format ${file}`), "0");
    }, "# battery-discharge-history\tv99");
    assert.equal(evaluate("battery_model_history_format /nonexistent"), "0");
  });

  test("keeps one battery's evidence entirely separate from another's", () => {
    // Given windows for two different batteries in the same file
    // When one battery is selected
    // Then only its own windows are visible, because a projection for a cell
    // must never be built from a different cell's measurements
    withHistory(
      [
        ...windowsFor(KEY_BAT1, { count: 6, drawMw: 9000, start: 19990000 }),
        ...windowsFor(KEY_BAT0, { count: 4, drawMw: 3000, start: 19991000 }),
      ],
      (file) => {
        const out = evaluate(`
          battery_model_load_history ${file} 20000000
          battery_model_select_battery ${KEY_BAT1}
          echo "bat1 $battery_model_window_count $(battery_model_median battery_model_draws)"
          battery_model_select_battery ${KEY_BAT0}
          echo "bat0 $battery_model_window_count $(battery_model_median battery_model_draws)"
        `);
        assert.match(out, /bat1 6 9000/);
        assert.match(out, /bat0 4 3000/);
      },
    );
  });

  test("reports a battery it has never seen as having no evidence", () => {
    // Given a history with no windows for the requested battery
    // When it is selected
    // Then the working set is empty rather than carrying the previous
    // selection's numbers
    withHistory(windowsFor(KEY_BAT1, { count: 6 }), (file) => {
      const out = evaluate(`
        battery_model_load_history ${file} 20000000
        battery_model_select_battery ${KEY_BAT1}
        battery_model_select_battery ${KEY_RETIRED}
        echo "windows=$battery_model_window_count sessions=$battery_model_session_count draws=\${#battery_model_draws[@]}"
      `);
      assert.match(out, /windows=0 sessions=0 draws=0/);
    });
  });

  test("counts distinct discharge sessions, not rows", () => {
    withHistory(
      windowsFor(KEY_BAT1, { count: 12, sessions: 3 }),
      (file) => {
        const out = evaluate(`
          battery_model_load_history ${file} 20000000
          battery_model_select_battery ${KEY_BAT1}
          echo "windows=$battery_model_window_count sessions=$battery_model_session_count"
        `);
        assert.match(out, /windows=12 sessions=3/);
      },
    );
  });

  test("ignores rows outside the lookback and rows from the future", () => {
    // Given evidence that is too old, current, and impossibly new
    // When the history is read
    // Then only the current evidence is modelled, and the rest is counted
    withHistory(
      [
        historyRow({ epoch: 1000, key: KEY_BAT1, drawMw: 50000 }),
        ...windowsFor(KEY_BAT1, { count: 5, drawMw: 9000, start: 19990000 }),
        historyRow({ epoch: 20000100, key: KEY_BAT1, drawMw: 50000 }),
      ],
      (file) => {
        const out = evaluate(`
          battery_model_load_history ${file} 20000000
          battery_model_select_battery ${KEY_BAT1}
          echo "total=$battery_model_total_rows future=$battery_model_future_rows windows=$battery_model_window_count draw=$(battery_model_median battery_model_draws)"
        `);
        assert.match(out, /total=7 future=1 windows=5 draw=9000/);
      },
    );
  });

  test("counts pack-level rows from older schemas as unusable", () => {
    // Given a history written before evidence was recorded per battery
    // When it is read
    // Then those rows are reported but never attributed to a cell
    withHistory(
      ["19990000\ts0\t9000\t26000000", "19990001\ts0\t9100\t26000000"],
      (file) => {
        const out = evaluate(`
          battery_model_load_history ${file} 20000000
          echo "legacy=$battery_model_legacy_rows keys=\${#battery_model_keys[@]}"
        `);
        assert.match(out, /legacy=2 keys=0/);
      },
      HISTORY_HEADER_V2,
    );
  });

  test("treats an unreadable schema as having no model at all", () => {
    withHistory(
      [],
      (file) => {
        const out = evaluate(`
          battery_model_load_history ${file} 20000000
          echo "state=$battery_model_state confidence=$(battery_model_confidence)"
        `);
        assert.match(out, /state=unsupported confidence=unavailable/);
      },
      "# battery-discharge-history\tv99",
    );
  });
});

describe("the evidence gate", () => {
  test("holds the full gate until both counts are met", () => {
    const gate = (windows, sessions) =>
      evaluate(`
        battery_model_window_count=${windows}
        battery_model_session_count=${sessions}
        battery_model_confidence
      `);
    // Enough windows but too few sessions is still not ready: one long session
    // is weaker evidence than the same count spread across several.
    assert.equal(gate(12, 3), "ready");
    assert.equal(gate(12, 2), "provisional");
    assert.equal(gate(4, 1), "provisional");
    assert.equal(gate(3, 1), "learning");
    assert.equal(gate(0, 0), "learning");
  });
});

describe("estimator scoring", () => {
  const steady = "for i in $(seq 1 30); do echo 10000; done";
  const shifting =
    "for b in 5000 20000 5000 20000; do for i in $(seq 1 8); do echo $b; done; done";

  test("never lets an estimator see the window it is predicting", () => {
    // Given a run of identical windows ending in one wildly different value
    // When the estimators are scored
    // Then every one carries that error, proving none of them peeked
    const out = evaluate(
      `{ for i in $(seq 1 12); do echo 10000; done; echo 90000; } | battery_model_score_draws`,
    );
    const rows = out.split("\n").filter(Boolean).map((line) => line.split("\t"));
    assert.ok(rows.length >= 3);
    for (const [name, , mean] of rows) {
      assert.ok(
        Number(mean) > 1000,
        `${name} reported a suspiciously small error (${mean} mW)`,
      );
    }
  });

  test("keeps the incumbent when nothing measurably beats it", () => {
    // Given a steady load where every estimator is equally right
    // When a selection is made
    // Then the default keeps the job
    assert.match(evaluate(`${steady} | battery_model_best_estimator`), /^median\t/);
  });

  test("switches when a challenger is clearly better", () => {
    // Given a load that shifts in blocks, where a recency estimator wins
    // When a selection is made
    // Then the incumbent is replaced
    const selection = evaluate(`${shifting} | battery_model_best_estimator`);
    assert.doesNotMatch(selection, /^median\t/);
    const [, scored, mean] = selection.split("\t");
    assert.ok(Number(scored) > 0);
    assert.ok(Number(mean) > 0);
  });

  test("does not switch on noise alone", () => {
    // Given a load that only jitters around one level
    // When a selection is made
    // Then the incumbent holds, because a projection that changes shape between
    // refreshes is harder to trust than one that is a little worse
    // Uncorrelated jitter around one level. A deterministic sawtooth would
    // not do: "last" predicts that perfectly and would deserve to win.
    const noisy = "printf '%s\\n' 9700 9880 9550 10260 10000 10000 9700 9550 9550 9550 10000 10130 9880 10410 10410 9550 9700 10130 10130 9880 9880 10410 9700 10410 9550 9880 9700 9550 10410 10260 10410 9880 10410 9880 9700 9700 9880 9880 10260 10410";
    assert.match(evaluate(`${noisy} | battery_model_best_estimator`), /^median\t/);
  });

  test("refuses to select on too little evidence", () => {
    // Given fewer scored predictions than the minimum
    // When a selection is made
    // Then the default is kept regardless of what the scores say
    const brief = "for b in 5000 20000 5000; do echo $b; done";
    assert.match(evaluate(`${brief} | battery_model_best_estimator`), /^median\t/);
  });

  test("computes the draw each estimator would project with", () => {
    const setup = `
      battery_model_draws_ordered=(5000 5000 20000 20000)
      battery_model_draws=(5000 5000 20000 20000)
      battery_model_recent_draws=(20000 20000)
    `.trim();
    assert.equal(evaluate(`${setup}; battery_model_estimator_draw median`), "12500");
    assert.equal(evaluate(`${setup}; battery_model_estimator_draw recent`), "20000");
    assert.equal(evaluate(`${setup}; battery_model_estimator_draw last`), "20000");
    // The weighted average trails the newest values without reaching them, so
    // it sits inside the observed range and is not simply the last reading.
    const ewma = Number(evaluate(`${setup}; battery_model_estimator_draw ewma`));
    assert.ok(ewma > 5000 && ewma < 20000, `ewma outside observed range: ${ewma}`);
    assert.notEqual(ewma, 20000, "ewma must lag, not track, the newest window");
  });

  test("falls back to the default for an estimator it does not know", () => {
    assert.equal(
      evaluate(`
        battery_model_draws_ordered=(1000 2000 3000)
        battery_model_draws=(1000 2000 3000)
        battery_model_estimator_draw not-an-estimator
      `),
      "2000",
    );
  });
});

describe("the estimator store", () => {
  test("uses each battery's recorded selection", () => {
    withFixture({ state: "estimator-store" }, (f) => {
      writeEstimators(f.state, [
        { key: KEY_BAT1, estimator: "recent", meanError: 420 },
      ]);
      const out = evaluate(`
        battery_model_load_estimators ${path.join(f.state, "estimators.tsv")}
        echo "chosen=$(battery_model_estimator_for ${KEY_BAT1}) error=\${battery_model_estimator_error[${KEY_BAT1}]}"
      `);
      assert.match(out, /chosen=recent error=420/);
    });
  });

  test("falls back to the default for a battery never scored", () => {
    withFixture({ state: "estimator-missing" }, (f) => {
      writeEstimators(f.state, [{ key: KEY_BAT1, estimator: "recent" }]);
      assert.equal(
        evaluate(`
          battery_model_load_estimators ${path.join(f.state, "estimators.tsv")}
          battery_model_estimator_for ${KEY_BAT0}
        `),
        "median",
      );
    });
  });

  test("ignores a store it does not recognise instead of trusting it", () => {
    // Given a store with an unknown header, or none at all
    // When selections are loaded
    // Then every battery falls back to the default, because deleting or
    // corrupting this file must cost nothing but a rescore
    withFixture({ state: "estimator-corrupt" }, (f) => {
      writeEstimators(
        f.state,
        [{ key: KEY_BAT1, estimator: "recent" }],
        "# battery-estimators\tv99",
      );
      assert.equal(
        evaluate(`
          battery_model_load_estimators ${path.join(f.state, "estimators.tsv")}
          battery_model_estimator_for ${KEY_BAT1}
        `),
        "median",
      );
      assert.equal(
        evaluate("battery_model_load_estimators /nonexistent; battery_model_estimator_for x"),
        "median",
      );
    });
  });
});
