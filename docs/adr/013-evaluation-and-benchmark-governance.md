# ADR 013: Evaluation and benchmark governance

Status: accepted for 4.0
Date: 2026-07-27

## Decision

Threadnote uses a score-free, reviewed recall-v2 corpus as its quality contract. Quality is gated globally and by
category against frozen, fixture-hashed baselines. Safety metrics cannot regress. Built-artifact microbenchmarks use
Mitata; an explicit process runner captures end-to-end latency and resource measurements. Performance runs execute in
a separate platform workflow. Pull requests keep bounded 10k/100k regression gates; scheduled and manually dispatched
runs share one production-large workflow with the Threadnote 4 beta/RC/final release gate on a pinned Linux runner class.
Shared-runner timings remain same-runner evidence rather than portable percentile claims.

Checked-in artifacts are compact, deterministic baseline summaries. Full query runs, raw timing samples, model files,
and machine-specific measurements are retained as CI artifacts.

The production-large artifact separates inventory/extraction from graph materialization, reference resolution,
activation, and one-file reindexing. It retains aggregate row counts, phase duration, CPU, boundary/observed RSS, and
SQLite storage without repository paths or source content. Each reviewed file, symbol, edge, and lexical-term shape
must reach at least 90% of its declared target. Index wall-time and process boundaries cover only the `indexer.index()`
call; sampler startup/readiness, overlay application/restoration, and post-index work remain outside them. Activation
additionally retains completed-stage duration and row counts for validation, copying, commit, checkpoint, and
completion in both cold and one-file builds, with an
observed-stage control so disconnected progress cannot silently become all-zero evidence. Materialization has an
independent regression budget in bounded PR scale runs. SQLite TEMP allocated-page high-water is retained separately
from the external sampler. The sampler unions linked files in its isolated temporary root with open regular scratch
files held by the recursive benchmark process tree, deduplicated by device and inode, so immediately unlinked SQLite
`etilqs_*` files are still observed without retaining paths. Linux uses `/proc` file descriptors and macOS uses a
bounded `lsof` projection. Aggregate inspection attempts, successes, and failures are retained, and production/external
evidence fails if any scheduled inspection is lost after startup. The result remains sampled high-water rather than an
exact total between successful observations. The heavy-tail suite is parser, extraction, cache,
interruption/resume, and determinism coverage; its comparatively small graph is not evidence for production-scale
materialization.

An external soak is an explicit local/manual mode, never a network action in CI. The operator supplies an already
cloned, clean checkout, an exact tracked regular file for the scoped one-file overlay, and one or more structured query
controls. A validation-only preflight checks commit/tree identity, semantic-overlay support, parser-worker settings,
privacy-safe allowlisted environment overrides, and filesystem headroom, then releases its prospective homes so the
real run can reuse those fresh paths. The real run repeats and enforces the capacity check even if preflight was
omitted. Explicit homes are atomically reserved and retention is armed only after that preflight succeeds. Large runs
may retain two explicit fresh homes for forensics; otherwise the scoped homes are removed. Linux and macOS are the
audited external-evidence platforms; others fail before indexing. The harness records the external commit plus
aggregate telemetry, never its path, remote URL, filenames, queries, graph results, source content, or raw path-valued
environment metadata. The artifact and both homes must remain outside the measured checkout.

The one-file overlay adds a harmless language-aware import/dependency while preserving the symbol lookup surface. Its
source must be valid UTF-8. Compare-before-write guards protect both application and restoration, and the original
bytes—including BOM and line endings—are restored after normal success or cooperative failure. A newer concurrent edit
is never overwritten. Uncatchable termination can still leave the overlay in place, so the documented operating model
uses a disposable clean clone for destructive-scale evidence. The observed materialization mode must be
`incremental-overlay`; a full fallback is rejected.

The overlay must change the cold effective-state digest. The resulting incremental state must equal an independently
indexed full graph of that same overlay across files, symbols, terms, lookup keys, edges, workspace attribution,
re-export provenance, and analysis aggregates. Cold, incremental, and same-overlay reference phases each retain a
distinct non-overlapping sampler, progress, temporary-storage, and lifecycle checkpoint. Structured expected
path/language controls must resolve in all three graphs. A six-operation MCP matrix (`query`, `node`, `neighbors`,
`explain`, `impact`, and `path`) retains only latency, size, and aggregate result counts, and enforces the tool timeout
and compact response budgets. Git checks explicitly include config-hidden untracked/submodule changes in both the
external checkout and the actual Threadnote source checkout. All validation, budget, parity, and final cleanliness
checks complete before the canonical artifact is written. Results are comparable only against the same external
commit and sanitized runner class.

## Consequences

- A blended quality improvement cannot hide regressions in scope, lifecycle, no-answer, code, or multilingual recall.
- Fixture changes are deliberate baseline changes and require review.
- Shared CI detects gross failures but does not create noisy latency gates.
- Every published Threadnote 4 beta, RC, and final release has a successful 90-day production-large artifact tied to
  its exact commit; a failed benchmark or missing artifact blocks immutable publication, and normal pull requests do
  not pay that multi-hour cost.
- Embedding and reranker candidates use the same artifact contract, making uplift directly comparable.
- The current 3.0.3 lexical baseline preserves known defects; it is not the 4.0 release target.

Operational instructions and metric definitions live in `test/evaluation/README.md`.
