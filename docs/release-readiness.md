# Local release-readiness evidence

The v5 release-readiness evaluator is an on-demand local procedure. It does not invoke an agent,
contact a provider, schedule work with an organization service, or enable CI enforcement.

## Capture and verify a candidate

Collect bounded content-free scenario transcripts from the shipped local task loop and provide the
source-native subsystem artifacts to the local verifier as short-lived private input. Every record
must name its scenario and exact candidate identity; its digest covers the candidate, scenario,
kind, and artifact. Every observation must bind the exact
`5.0.0-local.g<commit>` runtime before and after the scenario; a capture manifest hash is reviewed
outside the evidence file.

Assemble the independently reviewed observations into one bundle. The command emits only to its
already-open stdout descriptor; it never opens, replaces, renames, or cleans an output path. Retain
that stream in a supervisor-owned immutable store. For a local run, a fresh private directory keeps
the shell-owned file boundary inaccessible to other users while the command runs:

```sh
AUTHORITY_PRIVATE_DIR="$(mktemp -d)"
chmod 700 "$AUTHORITY_PRIVATE_DIR"

bun run assemble:threadnote-5-observer-authority -- \
  --assemble \
  --candidate candidate-runtime.json \
  --retained-records private-source-records.json \
  --reviews private-observer-reviews.json \
  > "$AUTHORITY_PRIVATE_DIR/reviewed-authority-bundle.json"
chmod 400 "$AUTHORITY_PRIVATE_DIR/reviewed-authority-bundle.json"

bun run assemble:threadnote-5-observer-authority -- \
  --verify \
  --candidate candidate-runtime.json \
  --retained-records private-source-records.json \
  --reviews private-observer-reviews.json \
  --bundle "$AUTHORITY_PRIVATE_DIR/reviewed-authority-bundle.json" \
  --manifest-sha256 <independently-reviewed-manifest-sha256> \
  --review-artifact-set-sha256 <independently-reviewed-review-set-sha256> \
  --binding-sha256 <independently-reviewed-binding-sha256> \
  > "$AUTHORITY_PRIVATE_DIR/reviewed-authority.json"
chmod 400 "$AUTHORITY_PRIVATE_DIR/reviewed-authority.json"
```

The verify step replays the retained records and private reviews, checks the single bundle against all
three independently supplied hashes, and emits the raw authority manifest expected by the capture
and evaluation commands below. A partial or altered bundle is not a valid authority artifact.

```sh
bun run capture:threadnote-5-release-readiness -- \
  --candidate candidate-runtime.json \
  --runtime-boundaries scenario-runtime-boundaries.json \
  --retained-subsystem-receipts private-source-records.json \
  --authority-manifest "$AUTHORITY_PRIVATE_DIR/reviewed-authority.json" \
  --authority-manifest-sha256 <independently-reviewed-64-hex-sha256> \
  --evidence-output candidate-evidence.json \
  --canonical-receipts-output retained-receipts.json

bun run verify:threadnote-5-release-readiness-receipts -- \
  --evidence candidate-evidence.json \
  --retained-subsystem-receipts retained-receipts.json \
  --authority-manifest "$AUTHORITY_PRIVATE_DIR/reviewed-authority.json" \
  --authority-manifest-sha256 <independently-reviewed-64-hex-sha256> \
  --output receipt-verification.json

bun run eval:threadnote-5-release-readiness -- \
  --candidate-commit <40-hex-commit> \
  --candidate-executable-sha256 <64-hex-sha256> \
  --capture-manifest-sha256 <independently-reviewed-64-hex-sha256> \
  --authority-manifest "$AUTHORITY_PRIVATE_DIR/reviewed-authority.json" \
  --authority-manifest-sha256 <independently-reviewed-64-hex-sha256> \
  --retained-subsystem-receipts retained-receipts.json \
  --evidence candidate-evidence.json
```

The capture command accepts exactly the 15 preregistered scenario boundaries and 24 source-native records. It replays
the same adapters as the verifier, derives the transcripts instead of accepting claimed outcomes, and writes records in
canonical order. Input order cannot change the evidence or manifest hashes. Missing, extra, duplicated, oversized,
mislabeled, under-sampled, cross-scenario, or pre/post runtime-drifting inputs stop capture without producing a passing
artifact. Review the printed capture-manifest hash independently before using it as evaluator authority.

The authority manifest is a separate content-free review boundary. Capture it from the supervising
execution/review surface, not from the proposal or procedure artifact being evaluated. It binds
candidate-review apply events, provider-call counts, procedure command exit receipts, and automatic
execution counts to exact source-record digests. Review its hash out of band before supplying it;
the manifest cannot nominate its own trust. Without this independently supplied authority,
provider-call, proposal-approval, and procedure-execution assertions remain unknown.

The verification output retains only content-free receipt-set hashes and scenario states; it never
includes source paths or private artifact bodies. Delete or otherwise handle the private input under
the repository's normal local-data policy after producing and reviewing that output.

The local adapter registry independently parses and rederives shipped structured-closeout, ValueReport,
proposal, procedure, health, Context Brief, Context Check, guidance, and migration artifacts. It rejects duplicate, extra, oversized, stale-candidate,
or unreferenced records and compares derived assertions and measurements exactly with the sealed
transcript. Proposal approval and procedure execution are checked against the independently trusted
authority manifest rather than proposal/receipt labels. Activation, Context Brief, and ValueReport records are joined by
the exact first-brief receipt or second-surface proof, and each counted feedback event is bound to that exact scenario
trial. Offline activation and ValueReport trials both require separately hash-bound zero-network observations. Scheduled
health captures replay the production schedule plan and aggregate from bounded personal/team sources, then require a
record-bound authority entry proving zero writes/network activity and stable pre/post HEAD, index, and worktree digests
for every selected configured team. Unknown aggregate results remain valid read-only outcomes. Missing source-native
records or external authority leave only their dependent scenarios and metrics unknown;
tampered or mismatched evidence is a quality failure.

Context Brief captures strictly reparse the production request/result, require a requested cap from 800–1,500 estimated
tokens, and verify that the measured response stays at or below that cap, including valid shorter responses.
They cannot infer first-plan correctness or citations without a separately hash-bound external authority entry. Context Check captures require a
parsed report plus repository, graph, and read-fence evidence before proving dirty evidence is non-current and its outcome
unknown and an authority entry bound to the receipt. Guidance captures replay bounded source and before/after bytes through
the production projection functions; stale-precondition rejection requires external authority. Migration captures bind
4.7.x and 5.0 runtime identities and protected-state digests, but a HomeMigrationReceipt alone cannot prove execution
and remains unknown without execution authority. Authority entries have exact record coverage: surplus or mislabeled
entries are rejected.

The matrix requires exact five-field closeout output (decisions and rationale, constraints,
verification, invalidations, unresolved risks), current compatible verified procedures that never
auto-execute, activation receipt reuse in ValueReport, provider-neutral Git proposals, and local
read-only scheduling plus configured Git-team read-only health aggregation. Organization-hosted
scheduling is outside this procedure. Measured lanes retain the ten-eligible-sample minimum.

## Compare with the last 4.x release

The baseline is fixed to Threadnote 4.7.8 at commit
`80ca4acdb7347a4d00b0381f3757a5ac984d9fbf`. Capture its evidence in a separate local artifact, then independently
record the executable hash for the exact platform binary that produced it:

```sh
bun run capture:threadnote-5-baseline-ledger -- \
  --evidence baseline-evidence.json \
  --output baseline-trial-ledger.json

bun run eval:threadnote-5-release-readiness -- \
  --candidate-commit <5.0-commit> \
  --candidate-executable-sha256 <5.0-executable-sha256> \
  --capture-manifest-sha256 <reviewed-manifest-sha256> \
  --authority-manifest "$AUTHORITY_PRIVATE_DIR/reviewed-authority.json" \
  --authority-manifest-sha256 <independently-reviewed-64-hex-sha256> \
  --baseline-version 4.7.8 \
  --baseline-commit 80ca4acdb7347a4d00b0381f3757a5ac984d9fbf \
  --baseline-executable-sha256 <4.7.8-platform-executable-sha256> \
  --baseline-trial-ledger baseline-trial-ledger.json \
  --baseline-trial-ledger-sha256 <independently-reviewed-ledger-hash> \
  --retained-subsystem-receipts retained-receipts.json \
  --evidence candidate-evidence.json
```

Do not treat the baseline artifact as its own authority. Version, commit, executable hash, ledger, and the ledger hash
reviewed outside that ledger are one mandatory trust boundary; omitting or mismatching any part keeps the comparison
unknown and cannot admit a release.

Only measurements that both releases genuinely share are compared: time and estimated tokens to the first cited correct
Context Brief plan, plus the raw eligible/wrong feedback counts used to calculate wrong-memory rate. Setup success,
second-agent reuse, Knowledge Delta completion, and health resolution were introduced for the 5.0 workflow. Their
4.7.8 values and deltas are therefore reported as `not-applicable`, never as zero, passed, improved, regressed, or
unknown. Candidate evidence and thresholds remain independent release gates, so a candidate failure still fails the
release even when a baseline comparison is unavailable or not applicable.

For a downgrade, run the same fixture after restoring 4.7.8; retain a safe-refusal result instead of forcing a
destructive downgrade.
