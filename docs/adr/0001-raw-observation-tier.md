# 0001 — Raw-observation tier, single extractor, and per-battery gap tracking

Audience: contributors who change the tracker's write path or its data files.

## Status

accepted

## Implemented

done

## Context

The tracker recorded only completed 15-minute discharge windows, computed
in-flight and appended to `discharge-history.tsv`. Every raw poll, and every
plug/unplug/threshold/handover transition, was thrown away the moment it was
read. Two failures exposed the cost of this directly:

- The laptop suspended for 11h 39m overnight (00:18–11:57). No raw signal
  survived to explain the gap: `make status` could only report a generic
  `polling-gap` reset, and the resumed session's `state_since` was recorded
  as an *exact* timestamp — more confidence than the code had any right to
  claim about the interval it knew least about.
- Window extraction, the threshold-hold rule, and battery-identity handling
  had each existed in more than one implementation at different points this
  session, and each time the copies drifted and shipped a bug to real
  hardware. Any redesign that keeps two writers of the same derived fact
  repeats that failure mode.

Requirements agreed with the user across a dedicated design review (not
retained verbatim here, distilled into the decision below):

- Never delete or edit tracked data. Retention becomes a read-time policy,
  not a write-time deletion.
- Discarding a window means marking it ineligible for modelling, never
  removing it.
- Capture only observations that add value — every poll (the heartbeat that
  proves the service was alive), plus state *transitions* (plug, unplug,
  charge complete, threshold hold, sequential handover, topology change,
  resume, service start). Not every UPower event: a 15-second sample showed
  six `battery_BAT1` events firing inside one millisecond with no state
  change behind them.
- One extraction implementation, callable both incrementally (per poll, on a
  bounded tail) and in batch (`make reextract`, on the whole history), so
  the two paths cannot disagree.
- Battery identity anchors data to the cell that produced it (established in
  prior work this session); this ADR extends that anchor to raw storage and
  drops the file-content privacy rule that anchor already superseded.
- No new locking mechanism. Concurrent writers were flagged as a latent
  risk; the fix is disjoint write ownership, not a lock bolted onto shared
  state.

## Decision

Store battery data in three tiers, all inside the existing state directory.

**Tier 1 — raw** (`raw/<sanitized-battery-key>/<YYYY-MM-DD>.tsv`, one
directory per battery, one file per local day, format-versioned `v0.1.0`).
Append-only, never edited or pruned. One row per poll, denormalized (each
row repeats machine-level facts — `ac_online`, `boot_id`, `suspend_count`,
`uptime_s` — rather than joining to a separate system file, so a single
battery's file is independently readable). A `trigger` column
(`poll | plug | unplug | status | resume | start`) distinguishes a routine
poll from a captured transition; both shapes share one schema. A poll row is
written unconditionally, every poll — it is the liveness proof, not
overhead. A transition row is written only when a tracked value actually
changes (AC-online flip, or a battery's own status string changes),
filtering out same-instant duplicate UPower events. Every row also carries a
`rules` column: the semver of the *recording* rules in force when it was
written (window length, draw formula, plausibility bounds, poll interval) —
distinct from the file's `format` version, which describes how to *parse*
the row. Interpretation rules (lookback, evidence gate, retention,
estimator margin) are not stamped anywhere, because they are re-applied
freely to old data at read time.

Battery directory names are the existing sanitized identity key
(`vendor:model:serial`) with only filesystem-illegal characters (`/`, NUL)
replaced by `-`; the existing whitespace trim on serials is kept. No
additional obfuscation — this is a continuation of the identity-anchoring
decision already in force, not a new privacy boundary.

**Tier 2 — derived, unrotated** (`windows.tsv`, `gaps.tsv`, format `v0.1.0`).
Regenerable from tier 1 by the single extraction function, called
incrementally after every poll (over a bounded tail: enough rows to cover
one window plus gap detection) and in batch by `make reextract`. Gaps are
derived, not separately observed: any two consecutive raw rows fully
determine what happened between them, using `boot_id` and `suspend_count`
deltas to classify the interval as `off` (shutdown/reboot/hibernate — not
drawing power), `asleep` (suspend — drawing power, service cannot run), or
`blind` (machine awake, service dead for no known reason). A window
interrupted by a gap is written and flagged ineligible for modelling rather
than discarded; only `off`/`asleep`/`blind` interruptions are excluded from
modelling, not deleted.

**Tier 3 — summary** (`battery-state.tsv`, format `v0.1.0`). One row per
battery, rewritten on each extraction: the open sampling window's start and
energy baseline, the last reset reason, and the currently selected
estimator with its held-out error. Fully derivable from tiers 1–2. This is
what the view reads on its 5-second refresh path — never raw, never
tier 2 — so panel latency is unaffected by raw file size.

`make reextract` regenerates tiers 2–3 to temporary files and diffs against
the live ones by default; `--force` replaces. A clean diff is the standing
proof that the incremental and batch paths agree.

**Concurrency**: no locking is introduced. The timer-driven poll owns raw
appends and tiers 2–3; the event-driven run (fired by the monitor on a real
power transition) owns session state only (`previous_state`, `state_since`,
`last_charge_*`, `charge_start_levels`). The two runs no longer write a
shared mutable target. Raw appends from either run are safe unlocked because
single-line `O_APPEND` writes under 4096 bytes are atomic. Routing the
monitor through `systemctl start` instead of invoking the tracker directly
was tested and rejected: three concurrent `systemctl start` calls on the
tracker's oneshot unit produced one actual run — systemd merges pending
starts, which would silently drop a power-event notification.

**Legacy generation superseded by name, not by version bump.** The prior
files (`discharge-history.tsv`, `estimators.tsv`, arbitrary internal
`v1`–`v3` markers) are superseded by differently-named files
(`windows.tsv`, `battery-state.tsv`) rather than a new version of the same
filename, so a reader can never misparse one generation as the other. Data
format versions from this point forward are semver, starting at `v0.1.0`
for every new file, independent of the legacy internal version numbers.

The existing state directory's legacy files have no raw observations behind
them and cannot be regenerated. They were archived by hand to
`~/Downloads/battery-archive-<host>-<user>-<UTC-timestamp>-legacy.zip` with
a self-describing `ARCHIVE-README.txt`, and the live state directory is
wiped for a clean start as the final implementation step — not migrated,
not partially carried forward.

## Consequences

- Raw storage grows without bound by design: ~130 KB/day for two batteries,
  ~47 MB/year, permanent. On this machine that is 235 MB over five years
  against 829 GB free. `make export` (existing) already produces
  unbounded output on the same principle; this extends it upstream.
- Per-poll writes go from one (the state file, rewritten whole) to three
  (state, raw, and tier 2/3 on change) — a 3x increase in write count, all
  small and unsynced, batched by ordinary page-cache writeback.
- The state file loses `window_start_epoch`, `window_start_energy_uwh`,
  `window_start_energies`, and `last_sample_energy_uwh`. That state becomes
  derivable from raw via `battery-state.tsv` rather than carried directly,
  which is what makes the state file disposable rather than precious: it
  can be lost and reconstructed from raw for everything except session
  bookkeeping.
- `make status`'s `Sampling` line moves from one pack-level line to a
  per-battery fact, displayed inside each battery's block; when every
  battery reports the same reason the display collapses to one line, but
  the underlying data is always stored per battery in tier 3 and raw, so no
  captured fact is lost by the collapse — only redundant repetition of an
  identical line is suppressed.
- `zip` becomes a hard preflight requirement, for `make export`'s existing
  archive step.
- This is the third rewrite of the tracker's write path in one review
  session. The mitigation is a rewritten, failing test suite landing before
  the implementation, and `make reextract`'s diff-by-default acting as a
  standing self-test rather than a one-time check.
- Deferred, not decided against: `make` targets for battery health and
  discharge graphs over a requested duration and interval, once tier 1
  exists to draw them from.

## Alternatives considered

- **Keep in-flight computation, treat raw as a pure audit log nothing
  reads** — cheaper to build, but tier 2 stops being genuinely derived, and
  a recording-rule change can never be re-applied to history. Rejected: it
  keeps the two-writer drift risk this ADR exists to remove.
- **`flock` around the read-modify-write steps** — fixes the latent
  concurrency race without a design change. Rejected in favor of disjoint
  write ownership, which removes the shared target instead of managing
  contention over it; a lock was judged a code smell papering over the
  actual problem.
- **Route the monitor's tracker invocation through `systemctl start`** —
  would have let systemd's unit lifecycle replace ad hoc subprocess calls.
  Rejected after testing: concurrent starts merge, and a power event fired
  during a merge window would be lost. Verified empirically, not assumed.
- **Normalize machine-level facts into a separate `raw/system/` file** —
  saves ~34 KB/day of duplicated `boot_id` strings via a join. Rejected:
  the saving is negligible at this data volume, and it would make a single
  battery's raw file unreadable in isolation, which was the point of
  denormalizing.
- **Hash battery identity for directory names** — never collides, but the
  user is expected to read these directories by hand; a hashed tree would
  make that impractical for no benefit once the content-privacy rule for
  identity data was already dropped in prior work.
- **Discard an entire session on any interruption** — simpler, but destroys
  valid windows recorded before the interruption; on hardware that
  discharges batteries sequentially, this could keep a battery from ever
  reaching the evidence gate. Rejected in favor of marking only the
  interrupted window ineligible.
- **Migrate legacy rows forward under the new schema** — rejected because
  they carry no raw observations and no recording-rules stamp; presenting
  them as equivalent to raw-derived data would misstate their provenance.
  Archived instead, and the tracker starts clean.

## Changelog

None.
