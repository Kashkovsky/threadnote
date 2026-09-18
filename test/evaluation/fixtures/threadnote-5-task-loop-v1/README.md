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

Source-native adapter records are selected by a typed registry, not a capture label. Context Brief records reparse the
production request/result, accept only a requested 800–1,500 estimated-token cap, and permit shorter responses that stay
within it; first-plan correctness and citations need external authority. Dirty-worktree records require a parsed Context Check report plus repository, graph, and read-fence
boundaries. Guidance records reparse sources and preview/before/after/current receipts, and migration records bind both
runtime identities and protected-state digests. Missing external stale-precondition or migration-execution authority stays
unknown; a migration receipt by itself is never execution proof.
Each external authority entry is content-free, bound to one exact source record and candidate, and rejected when coverage
is missing, surplus, or mislabeled.

The seven candidate metrics are time and estimated tokens to the first cited correct plan, setup success,
wrong-memory rate, second-agent reuse, Knowledge Delta completion, and health resolution. The comparison policy is
separate: the exact 4.7.8 baseline contributes only the two Context Brief measurements and raw wrong-memory feedback
counts. The four workflows introduced for 5.0 are explicit `not-applicable` baseline lanes. Thresholds,
scenario-to-metric attribution, comparison applicability, and required outcome assertions are source-reviewed
constants; changing JSON alone cannot weaken them. Every measured candidate scenario requires at least ten eligible
trials for each attributed metric. In particular, activation setup requires at least 9 successes across 10 eligible
solo attempts. Smaller samples remain unknown even when their apparent value would pass a threshold.

Evidence contains only exact source versions and commits, executable hashes, bounded counts, categorical outcomes, and
deterministic receipt hashes. Every scenario transcript is chained, names its subsystem receipt digests, and records
matching pre/post runtime identity. A reviewed capture-manifest hash supplied outside the evidence file binds those
transcripts; the adapter label alone has no authority. Unknown, failed, missing, tampered, duplicate, runtime-drifting,
or scenario-mislabeled observations fail closed. A missing or untrusted 4.7.8 identity, executable, or ledger produces
an explicit unknown for comparable metrics, never an improvement. Metrics absent from 4.7.8 remain not applicable.

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
  --baseline-version 4.7.8 \
  --baseline-commit 80ca4acdb7347a4d00b0381f3757a5ac984d9fbf \
  --baseline-executable-sha256 <4.7.8-platform-executable-sha256> \
  --baseline-trial-ledger <baseline-trial-ledger.json> \
  --baseline-trial-ledger-sha256 <independently-reviewed-ledger-hash> \
  --evidence <content-free-evidence.json> \
  --output <scored-result.json>
```

The release gate uses only Threadnote 4.7.8 at commit
`80ca4acdb7347a4d00b0381f3757a5ac984d9fbf`. Provide that version and commit together with the independently verified
platform executable hash, comparison ledger, and independently reviewed ledger hash. All five inputs are required as
one trust boundary. Evidence and the ledger cannot nominate their own authority.

The command reads local files only. It never invokes an agent, product API, provider API, or network operation. A sealed
fixture replay can validate the evaluator but remains release status unknown; only
threadnote-5-local-task-loop-adapter-v1 evidence may claim release-candidate status.

## Remaining adapter seams

The independent contract, replay evaluator, and source-native local verifiers for structured closeout, ValueReport,
provider-neutral Git proposals, verified procedures, and existing context-health reports/repairs are complete. Private
source artifacts are bounded, tied to the exact candidate and scenario, and reduced to content-free verification hashes;
the verifier rejects copied transcript claims that it cannot independently rederive. Provider-call, proposal-approval,
and procedure-execution assertions additionally require the separately trusted authority manifest.

Activation trials now replay the production receipt chain and approval transitions, bind the final completed state to
transport-attested second-surface retrieval, and correlate the exact receipt with raw local value events. Health-maintenance
captures replay the shipped schedule plan and observed argv plus bounded personal/configured-team aggregate, while a separately supplied
record-bound authority proves zero writes/network activity and stable pre/post team snapshots. Unknown
aggregate outcomes remain valid evidence of the read-only boundary. The adapter never infers or synthesizes a passed assertion.
