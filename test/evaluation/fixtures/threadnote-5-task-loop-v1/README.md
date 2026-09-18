# Threadnote 5 release-readiness contract

This fixture preregisters the deterministic, offline evidence contract for the local 5.0 task loop. The evaluator
requires one content-free receipt for each bounded scenario:

- solo use and first cited correct plan;
- two-agent reuse through a second surface;
- Git-shared retrieval;
- offline/no-network operation;
- dirty-worktree fail-closed behavior;
- interrupted/resumed operation without duplicate effects;
- upgrade readability and readable-or-safe-refusal downgrade behavior;
- reviewed, provider-neutral Git proposal generation; and
- health issue detection and resolution.

The same executable matrix retains the earlier static gates for structured closeout, stale citations, contradiction
triage, projection drift, and Context Brief/Knowledge Delta output budgets; those contracts were expanded, not replaced.

The seven metrics are time and estimated tokens to the first cited correct plan, setup success, wrong-memory rate,
second-agent reuse, Knowledge Delta completion, and health resolution. Thresholds, scenario-to-metric attribution, and
required outcome assertions are source-reviewed constants; changing JSON alone cannot weaken them. Every measured
scenario requires at least ten eligible trials for each attributed metric. In particular, activation setup requires at
least 9 successes across 10 eligible solo attempts. Smaller samples remain unknown even when their apparent value would
pass a threshold.

Evidence contains only exact source versions and commits, executable hashes, bounded counts, categorical outcomes, and
deterministic receipt hashes. Every scenario transcript is chained, names its subsystem receipt digests, and records
matching pre/post runtime identity. A reviewed capture-manifest hash supplied outside the evidence file binds those
transcripts; the adapter label alone has no authority. Unknown, failed, missing, tampered, duplicate, runtime-drifting,
or scenario-mislabeled observations fail closed. A missing or untrusted 4.7.x identity produces an explicit unknown
comparison, never an improvement.

## Run the evaluator

```sh
bun run eval:threadnote-5-release-readiness -- \
  --candidate-commit <exact-40-character-sha> \
  --candidate-executable-sha256 <64-lowercase-hex> \
  --capture-manifest-sha256 <independently-reviewed-64-lowercase-hex> \
  --evidence <content-free-evidence.json> \
  --output <scored-result.json>
```

To enable 4.7.x comparisons, also provide the independently verified baseline identity as
`--baseline-version <4.7.x>`, `--baseline-commit <exact-40-character-sha>`, and
`--baseline-executable-sha256 <64-lowercase-hex>`. All three are required together. Evidence cannot nominate its own
trusted baseline.

The command reads local files only. It never invokes an agent, product API, provider API, or network operation. A sealed
fixture replay can validate the evaluator but remains release status unknown; only
threadnote-5-local-task-loop-adapter-v1 evidence may claim release-candidate status.

## Remaining adapter seam

The independent contract and replay evaluator are complete. The production adapter must translate the final shipped
activation, structured closeout, health, value, and proposal receipts into this schema while binding the exact installed
5.0.0-local.g<commit> executable. The current evaluator replays a reviewed manifest, derives assertions and metrics from
its bounded content-free transcripts, and verifies transcript chaining plus subsystem digests and pre/post identity. The
remaining production adapter verifier must resolve each subsystem digest against the corresponding real receipt rather
than trust the adapter label. The adapter must not infer or synthesize a passed assertion. Until those APIs land and both
sides of that seam are implemented, release evidence cannot pass.
