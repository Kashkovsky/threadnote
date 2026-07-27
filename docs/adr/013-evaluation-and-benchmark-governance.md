# ADR 013: Evaluation and benchmark governance

Status: accepted for 4.0
Date: 2026-07-27

## Decision

Threadnote uses a score-free, reviewed recall-v2 corpus as its quality contract. Quality is gated globally and by
category against frozen, fixture-hashed baselines. Safety metrics cannot regress. Built-artifact microbenchmarks use
Mitata; an explicit process runner captures end-to-end latency and resource measurements. Performance runs execute in
a separate scheduled platform workflow and remain informational until dedicated runner classes are available.

Checked-in artifacts are compact, deterministic baseline summaries. Full query runs, raw timing samples, model files,
and machine-specific measurements are retained as CI artifacts.

## Consequences

- A blended quality improvement cannot hide regressions in scope, lifecycle, no-answer, code, or multilingual recall.
- Fixture changes are deliberate baseline changes and require review.
- Shared CI detects gross failures but does not create noisy latency gates.
- Embedding and reranker candidates use the same artifact contract, making uplift directly comparable.
- The current 3.0.3 lexical baseline preserves known defects; it is not the 4.0 release target.

Operational instructions and metric definitions live in `test/evaluation/README.md`.
