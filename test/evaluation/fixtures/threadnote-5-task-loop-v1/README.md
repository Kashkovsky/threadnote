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
- reviewed, provider-neutral Git proposal generation;
- verified, compatible procedures that never auto-execute; and
- health issue detection, read-only local scheduling, and configured Git-team aggregation.

The same executable matrix requires exact five-field structured closeout output and retains the earlier static gates for stale citations, contradiction
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

Proposal/provider-call and procedure-execution claims additionally require a separate content-free authority manifest
from the supervising review/execution surface. Its independently supplied hash binds exact apply-audit digests,
provider-call counts, command exit receipts, and automatic-execution counts to source-record digests. The proposal or
procedure artifact cannot self-authorize this manifest.

## Run the evaluator

```sh
bun run eval:threadnote-5-release-readiness -- \
  --candidate-commit <exact-40-character-sha> \
  --candidate-executable-sha256 <64-lowercase-hex> \
  --capture-manifest-sha256 <independently-reviewed-64-lowercase-hex> \
  --authority-manifest <reviewed-content-free-authority.json> \
  --authority-manifest-sha256 <independently-reviewed-64-lowercase-hex> \
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

## Remaining adapter seams

The independent contract, replay evaluator, and source-native local verifiers for structured closeout, ValueReport,
provider-neutral Git proposals, verified procedures, and existing context-health reports/repairs are complete. Private
source artifacts are bounded, tied to the exact candidate and scenario, and reduced to content-free verification hashes;
the verifier rejects copied transcript claims that it cannot independently rederive. Provider-call, proposal-approval,
and procedure-execution assertions additionally require the separately trusted authority manifest.

Activation/second-surface linkage and scheduled/team health aggregation remain explicit pending seams until their final
production receipt APIs land. Their dependent scenarios and metrics therefore stay unknown and cannot admit a release.
The adapter must never infer or synthesize a passed assertion.
