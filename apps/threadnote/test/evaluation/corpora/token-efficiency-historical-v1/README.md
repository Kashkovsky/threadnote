# Threadnote token-efficiency historical corpus v1

This reviewed corpus freezes six unedited historical GitHub task packets against six independent public repositories. Each task uses the first parent before the known fix as its held-out checkout. The known fix is retained only for corpus admission and hidden-verifier calibration; it is never exposed to the coding agent.

All tasks use the `historical-as-issued` variant. The corpus therefore makes no claim that synthetic exact-name, paraphrase, absent-answer, conflicting-records, or dirty-worktree conditions were materialized. Repository clusters are independent at the project level, so clustered confidence intervals do not treat multiple revisions of one project as independent evidence.

The prompt is GitHub's title, two LF bytes, and the unedited body with CRLF normalized to LF. The body is retained separately as manual context when context exists. Context sufficiency was independently reviewed from the title and body alone, without solutions or provider outcomes. The tasks cover `none`, `lacking`, `sufficient`, and `excessive`; strata remain descriptive.

One linked memory per task was authored by a source-only reviewer using a Git archive of the pre-fix tree without Git history, task prompt, network, or known fix. During local materialization, each exact body must become a managed Threadnote memory with its corpus citation finalized against the pinned base revision.

## Local materialization

Ignored local artifacts live under `.context/token-efficiency-corpus-v1`: clean checkouts, graph databases, managed memories, homes, credentials, binaries, and outcomes. The committed corpus contains no credentials or transcripts.

The preparer calibrates the hidden verifier with the pinned verifier environment:

```sh
.context/token-efficiency-corpus-v1/verifier-venv/bin/python \
  apps/threadnote/test/evaluation/corpora/token-efficiency-historical-v1/verifiers/verify.py \
  <h11|hpack|attrs|click|werkzeug|packaging> /absolute/path/to/checkout
```

Admission requires exit 1 at the pinned base and exit 0 at the known fix. Preparation emits a hash-closed `verification-plan.json` bound into the study, runtime, adapter configurations, requests, observations, outcome ledger, and report. After each candidate patch is captured, the adapter reruns the task verifier in a credential-free, network-denied Seatbelt sandbox. Exit 0 is a deterministic completion; the verifier's explicit exit-1 diagnostic is a task failure and keeps its token cost; timeout, output overflow, sandbox denial, artifact drift, or any malformed diagnostic is an infrastructure failure that aborts before the immutable outcome ledger advances.

The macOS verifier sandbox permits host file metadata plus read-only access to the pinned Python environment, candidate checkout, verifier runner, and required system runtime trees. It denies network access and restricts writes to a fresh per-run verifier directory. Receipts bind the verifier environment—including resolved symlink target bytes—interpreter, runner, sandbox executable, plan, candidate artifact, diagnostic, and task identity; the claim is therefore scoped to that sealed local runtime rather than cross-operating-system bitwise reproducibility.

The blinded rubric judge remains a secondary sensitivity measure. Publication gates require non-inferiority for both deterministic completion and the hybrid verifier-plus-judge completion rate, and the report exposes both verifier-pass/judge-fail and verifier-fail/judge-pass disagreement cells.

The experiment runs from the base; fix checkouts are used only during preparation calibration and are never mounted into the agent or judge environment.

## Delivery calibration and pilot invalidation

The initial September 2026 pilot is development evidence, not a token-savings result. Seven of its ten Threadnote calls failed because the proxy required the agent to reproduce the task prompt byte-for-byte. The old adapter checked call count, not successful delivery. It also classified declined commands as harmful actions and returned the context body twice (text plus structured content). Keep its v3 ledger and transcripts unchanged; do not resume that manifest, silently migrate its metrics, or pool those observations with a corrected run.

Proxy v2 binds the task internally to the immutable packet. Its public tool schema has no task argument. It returns one canonical JSON text body, preserving graph and memory evidence, plus private receipt metadata binding the body hash, frozen prompt hash, run nonce, runtime manifest, and prepared graph/memory identities. The adapter requires exactly one successful, non-error response and checks every receipt field against the sealed request and delivered text. A failed, absent, duplicate, or mismatched response aborts before judging or appending an outcome. Captured patches, provider usage, the agent checkpoint (`.jsonl.agent.jsonl`), and a failure transcript remain diagnostic evidence; they must be disclosed separately from completed study observations. Never treat an aborted infrastructure run as zero-cost or selectively retry it inside an already interpreted study.

Outcome schema v4 requires separate `safety.blockedActions` telemetry; token-efficiency report schema v3 displays it. Declined attempts still contribute their provider tokens but are not executed harm. Actual harmful actions, authorization leaks, false-current outcomes, invalidity, and task failures retain their existing gates. Old v3 outcomes are explicitly rejected by the new parser. Use the original revision when reproducing historical reports.

Before spending on a new study, calibrate exact formatted prompts and all three context arms against isolated copies of the frozen homes, verify delivery receipts through MCP and the adapter, and confirm useful graph/memory coverage. Passing delivery checks alone is not evidence that context helps. The unblinded six-task pilot is now development/calibration material; a confirmatory article claim needs a newly sealed, untouched evaluation corpus, declared accounting and thresholds, and a fresh manifest after harness and product changes are fixed.

`provenance.json` records identities, revisions, prompt sources, licensing, context assessments, and verifier selectors. `corpus.json` is the exact evaluator input. The local preparation plan is generated only after the final Threadnote 5.0.6 release commit, exact local binary, ready graph homes, managed memory IDs, known-fix checkouts, and the pinned verifier environment are known.
