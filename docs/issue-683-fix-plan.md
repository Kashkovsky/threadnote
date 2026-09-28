# Issue #683: bounded graph analysis and refresh recovery

Status: investigation and implementation contract for `fix/issue-683-analysis-readiness`. Current validation results are recorded in the pull request and task handoff.

Applies to: local whole-graph analysis, MCP graph request deadlines, scoped refresh demand, and capacity-failure reporting.
Invariant: an accepted ready snapshot can yield bounded analysis or a precise actionable state; stale evidence must never be represented as current or selected from the wrong project.
Avoid: increasing timeouts as the primary fix, bypassing snapshot leases, removing capacity protection, or treating transport success as successful analysis.
Verify: held-writer, no-ready, equivalent-scope, cancellation, and capacity-pressure regressions through the actual registered MCP handler and global CLI.

## Evidence and scope

Reviewed the [issue](https://github.com/Kashkovsky/threadnote/issues/683) and its one existing [retest comment](https://github.com/Kashkovsky/threadnote/issues/683#issuecomment-5866604311), retrieved on 2026-09-28. The comment distinguishes two projects: one has usable stale evidence and CLI analysis works; the other has no project-ready snapshot and refresh encounters capacity pressure. It also reports competing indexers, repeated supersession errors, and inspection responses arriving after a 30-second client deadline.

Implementation references below use current fetched `main`, commit `37eacfac12069b797e7529e1ab3b59a59f9d0b9c`, which includes monorepo migration #684. At investigation time, the supplied worktree was at `bdc474984f4ec19acaf215a6011bea259526d3ce`, before that migration. Implementation starts from the fetched main commit above. Threadnote graph queries and code-linked context briefs used the worktree's existing graph; current-main claims were then verified directly with `git show`. Old `src/code_graph/*` memory anchors are provenance for the earlier layout, not proof of current-main content.

The initial investigation did not rerun the reporter's large repository, change runtime code, run product tests, or reinstall the binary. Reported production timings are issue evidence, not new measurements. The latest comment's workload and disk observations do not by themselves prove the reservation calculation is incorrect.

## Confirmed findings

1. **MCP analysis lacks the CLI freshness choice.** The registered schema has no freshness input. Resolution starts watcher work, requests refresh for stale state, and declines analysis while the selected snapshot remains stale. Default strictness is intentional; its failure mode and inability to opt into stale analysis are the problem. See [MCP registration and selection](https://github.com/Kashkovsky/threadnote/blob/37eacfac12069b797e7529e1ab3b59a59f9d0b9c/apps/threadnote/src/mcp/server/code_graph.ts#L673).

2. **Summary backfill is only one writer dependency.** `analyzeCodeGraphWithLease` acquires a lease, runs `ensureAnalysisSummary`, then opens a read-only session. Summary maintenance, lease acquisition, and lease release all use the writer gate. Its default wait is infinite. The analysis's internal duration clock begins after acquisition/backfill, so it excludes their cost. See [analysis entry point](https://github.com/Kashkovsky/threadnote/blob/37eacfac12069b797e7529e1ab3b59a59f9d0b9c/packages/graph/src/analysis.ts#L436), [backfill](https://github.com/Kashkovsky/threadnote/blob/37eacfac12069b797e7529e1ab3b59a59f9d0b9c/packages/graph/src/store/service/data.ts#L503), [acquisition](https://github.com/Kashkovsky/threadnote/blob/37eacfac12069b797e7529e1ab3b59a59f9d0b9c/packages/graph/src/store/service/lifecycle.ts#L305), [release](https://github.com/Kashkovsky/threadnote/blob/37eacfac12069b797e7529e1ab3b59a59f9d0b9c/packages/graph/src/store/service/maintenance.ts#L237), and [lock defaults](https://github.com/Kashkovsky/threadnote/blob/37eacfac12069b797e7529e1ab3b59a59f9d0b9c/packages/graph/src/store/session.ts#L236).

3. **There is a cleanup gap to cover.** Lease release is attached only to the read-session effect, after backfill. Interruption during backfill therefore has no enclosing release finalizer in this function. A gated release inside a finalizer can also prolong timeout completion. These are source-level risks requiring deterministic regression tests; this investigation did not measure leaked production leases.

4. **Cold `ready` is not a read-only policy today.** The CLI policy deliberately refreshes if there is no ready snapshot. Only `allow-stale` refuses to start indexing. The CLI analysis timeout currently surrounds refresh, excluding initial status/attachment and subsequent analysis. Thus a cold `ready` request consuming its budget is partly existing policy, not evidence that SQLite could have served that project. See [policy](https://github.com/Kashkovsky/threadnote/blob/37eacfac12069b797e7529e1ab3b59a59f9d0b9c/packages/graph/src/cli/freshness.ts#L14) and [CLI resolver](https://github.com/Kashkovsky/threadnote/blob/37eacfac12069b797e7529e1ab3b59a59f9d0b9c/packages/graph/src/analysis/cli.ts#L96).

5. **The deadline mismatch is explicit.** Analysis has a 30-second outer envelope and an independent 25-second compute budget; inspection has a 55-second envelope. Existing tests intentionally allow inspection to exceed 25 seconds. A 30-second client cannot rely on those server settings. Scope discovery, refresh, cleanup, serialization, and synchronous database calls all need accounting. See [constants](https://github.com/Kashkovsky/threadnote/blob/37eacfac12069b797e7529e1ab3b59a59f9d0b9c/apps/threadnote/src/mcp/server/code_graph.ts#L96) and [existing test](https://github.com/Kashkovsky/threadnote/blob/37eacfac12069b797e7529e1ab3b59a59f9d0b9c/apps/threadnote/test/unit/mcp-code-graph-analysis-handler.test.ts#L181).

6. **Capacity has two different decision layers.** A whole-build heuristic uses cached-fact bytes, estimates durable storage plus journals and temporary storage, and doubles headroom for concurrency. `build.ts` turns a shortfall into a hard error for direct-persistent materialization, even though the planning helper's comment calls it warning-only. Separately, measured per-operation reservations protect bounded writes. The 22 GB database size is not the heuristic's direct input. Distinguish these layers before changing either. See [estimate and plan](https://github.com/Kashkovsky/threadnote/blob/37eacfac12069b797e7529e1ab3b59a59f9d0b9c/packages/graph/src/indexer/materialization.ts#L1024) and [hard rejection](https://github.com/Kashkovsky/threadnote/blob/37eacfac12069b797e7529e1ab3b59a59f9d0b9c/packages/graph/src/indexer/build.ts#L1272).

7. **Duplicate-refresh causality is still a hypothesis.** Watcher instance keys use worktree plus configured project URI, while durable demand uses checkout/worktree/scope identity and a build request key. Equivalent explicit-project and nested-cwd calls must resolve identically. The observed child commands are a strong regression case, but supersession errors also cover authority/path/token changes; their name or five-second duration alone does not prove one cause. See [watcher target](https://github.com/Kashkovsky/threadnote/blob/37eacfac12069b797e7529e1ab3b59a59f9d0b9c/packages/graph/src/watcher.ts#L599), [watcher key](https://github.com/Kashkovsky/threadnote/blob/37eacfac12069b797e7529e1ab3b59a59f9d0b9c/packages/graph/src/watcher.ts#L1477), and [demand identity](https://github.com/Kashkovsky/threadnote/blob/37eacfac12069b797e7529e1ab3b59a59f9d0b9c/packages/graph/src/refresh/demand.ts#L39).

## Implementation findings

The linked-worktree regression confirmed one scope-routing defect: root plus explicit project selected the configured project, while nested plus inferred project incorrectly treated sibling scopes as ambiguous. Verifying each candidate's checkout/repository identity before reapplying configured graph roots relative to the caller's actual worktree fixes that divergence and excludes nested independent repositories. Durable-demand tests preserve equivalent-request coalescing and backoff without changing the scheduler. Other causes of the reporter's supersession sequence remain unproven.

The capacity correction leaves the heuristic formulas unchanged and makes their direct-persistent shortfall advisory. A synthetic fixture with 4 GiB of cached facts estimates 68,753,031,168 bytes for the whole build, while its next bounded 32 MiB / 512,000-row operation requires 429,916,160 bytes with 10 GiB available. Measured transaction reservations remain authoritative and fail closed. Typed failure evidence survives persisted build status, the isolated parent, and a newly started watcher. This validation uses synthetic metadata rather than filling a developer filesystem or reproducing the reporter's full repository.

## Intended behavior

Add MCP `freshness: current | ready | allow-stale`, defaulting to `current`. Share the policy and selected-snapshot contract with the CLI; keep transport-specific scheduling separate.

| Situation                                      | `current`                                                                                | `ready`                                                                    | `allow-stale`                                                        |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Compatible current snapshot                    | Analyze within remaining budget                                                          | Analyze                                                                    | Analyze                                                              |
| Compatible stale snapshot for selected project | Request/attach one refresh; bounded wait; never return it as current                     | Analyze the selected ready snapshot immediately                            | Analyze the selected ready snapshot; start no refresh                |
| No selected-project ready snapshot             | Request/attach one refresh; return actionable pending/failure state if still unavailable | Preserve cold-refresh permission, but return bounded pending/failure state | Return `unavailable` / `no-ready-snapshot`; start no indexer         |
| Snapshot lease cannot be acquired promptly     | Return `deferred` with writer-contention reason                                          | Same; do not bypass the lease                                              | Same                                                                 |
| Known refresh failure                          | Report typed cause and recovery                                                          | Analyze existing usable snapshot if present; otherwise report cause        | Report absence and any already-known failure without initiating work |

All responses must disclose policy, evidence freshness, selected project/snapshot/commit/dirty identity where available, and semantic outcome. Keep analysis coverage separate from freshness and from historical project coverage. `projectCoverage: complete` cannot stand in for a ready pointer. Explicit stale analysis is a new opt-in exception to the earlier strict-analysis contract; it does not change path, impact, or citation authority and does not borrow another project's full-repository graph.

## Implementation sequence

### 1. Capture failing contracts before changing behavior

Extend the existing registered-handler harness and graph service tests. Add cases for a stale-ready snapshot with a held writer, both present and missing summaries, cold selected scope despite historical coverage, refresh failure, and cancellation at each lease phase. Use `Deferred` barriers rather than timing sleeps.

Record stage durations and semantic outcomes for status, scope resolution, ready selection, demand registration, writer wait, lease acquire/release, summary read, analysis, and serialization. Reuse existing telemetry stages where possible. Public evidence must contain only bounded counts, opaque identities, typed reasons, and timings.

### 2. Remove opportunistic summary writes from foreground analysis

In `packages/graph/src/analysis.ts`, read the persisted summary when available and otherwise use the existing paged aggregate fallback. Preserve row/time limits and truthful partial coverage. Keep summary generation at index activation or explicit maintenance; do not replace the synchronous write with one new background task per read.

Bracket acquisition, use, and release with an interruption-safe Effect resource scope. Pass explicit finite writer wait options for acquisition and release. A busy lease gate returns a typed deferred outcome promptly; it never authorizes unleased reads. Keep maintenance/pruning invariants intact. Failed bounded release must have explicit deferred-cleanup/expiry behavior and an observable receipt, rather than silently becoming an indefinite finalizer. Exercise interruption after acquisition but before opening the session.

### 3. Use one end-to-end budget and an enforceable worker boundary

Create one absolute deadline at request entry, before graph status or watcher setup. Pass remaining time to every stage; never restart a full budget after refresh. For ordinary MCP requests, propose a 25-second total server target to leave margin below the reported 30-second client deadline. Reserve time inside that total for cancellation, cleanup, and serialization. Cap initial refresh observation at five seconds or the smaller remaining allowance.

Move potentially blocking analysis/status work behind a bounded isolated worker, following the existing graph isolated-read process lifecycle. An outer Effect timeout alone cannot reliably preempt synchronous native SQLite work. The parent owns wall-clock cancellation and child reaping; the worker owns scoped leases. Preserve ownership fencing and recovery if the process must be terminated.

Resolve the existing 55-second inspection compatibility contract explicitly: use the short default for clients with no larger known budget, and allow a validated explicit longer request budget when supported. Test both paths and update the existing long-inspection regression instead of silently deleting its intent. For CLI analysis/report, make the advertised read timeout cover the entire read operation; retain explicit longer CLI budgets for deliberate offline analysis and document the corrected boundary.

### 4. Add freshness and structured recovery to MCP/CLI

Put reusable policy/resolution behavior in `packages/graph`; keep MCP and CLI composition in `apps/threadnote`. Touch the analysis CLI resolver, application graph commands, MCP handler/schema, and analysis render/projection contracts.

Select the project before scheduling. For ready evidence, avoid attaching or refreshing current evidence ahead of an accepted read. `allow-stale` must not start a watcher/indexer indirectly. Preserve current-mode final identity/freshness checks if the worktree changes during analysis. Represent a failure discovered during refresh immediately; represent an in-progress cold refresh as pending with a stable continuation and retry advice, not as successful groups or a generic unexplained timeout.

Prefer additive fields and existing typed outcomes; version a response only when necessary. Preserve default compact text versus explicit `dual` behavior, deterministic token bounds, and enough metadata in compact output to understand stale/partial/deferred results. Update tool help, shipped graph guidance, and troubleshooting examples together.

### 5. Prove and repair scope-equivalent refresh coalescing

Build a small fixture with two configured sibling projects. Compare root plus explicit project, nested cwd plus inferred project, and two MCP processes. Capture resolved repository/worktree/scope/build keys, child launch count, and terminal semantic result.

Equivalent routes must attach to one compatible active demand; different sibling scopes must remain separate. Carry the selected project through every status, watcher, isolated worker, child CLI, and recovery call. Correct whichever boundary demonstrably loses or changes it. Do not invent a second scheduler: preserve the existing one-active/one-latest demand model, owner fencing, safe publication boundary, and convergence after edits stop.

Treat ordinary supersession as a bounded scheduling outcome where appropriate, while retaining real authority/permission errors. Repeated polling must not reset backoff, replace an identical target, or spawn another equivalent child. A known capacity pause must remain visible and avoid an automatic tight retry loop.

### 6. Diagnose and fix cold-snapshot capacity recovery

First make the rejection explain itself: selected scope, decision layer, estimate basis, required/available bytes by filesystem, active reservations, model version, retryability, and safe recovery. Distinguish whole-build heuristic rejection from a transaction reservation failure. Surface the last relevant failure in graph status and analysis responses even when no ready snapshot exists.

Use a synthetic large fact-metadata fixture to reproduce the arithmetic without copying a customer repository or allocating a giant database. Check scope inventory size, cached/final fact bytes, shared-versus-separate filesystem accounting, existing reservations, doubled concurrency allowance, and incremental/reused rows. Compare the projected whole-build envelope to measured bounded write demand.

If the heuristic rejects work that the measured reservation model can safely execute, replace that unconditional rejection with a staged/resumable admission decision supported by evidence. If the demand is genuinely too large, retain refusal and provide recovery that can change the outcome. Never simply lower amplification factors, ignore free-space checks, delete the graph database, or disable reservation fencing. Correct the warning-only documentation discrepancy whichever policy is chosen.

This capacity behavior is a separate deliverable from stale-ready analysis. Do not claim the cold-project case is fixed merely because the MCP freshness option works.

## Test and acceptance matrix

| Layer                 | Required checks                                                                                                                                                                                    |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Analysis service      | Present/missing summary, held writer before acquisition, writer becoming busy before release, interruption at each phase, paged fallback parity and bounded coverage                               |
| Registered MCP        | All three policies across current/stale/absent snapshots; groups actually returned when possible; typed contention/failure otherwise; compact and dual metadata parity                             |
| CLI resolver          | `allow-stale` performs no refresh; cold `ready` preserves bounded refresh; known failure returns before budget exhaustion; total wall deadline includes discovery and cleanup                      |
| Cross-process fixture | Equivalent project routes coalesce; sibling projects do not; no repeated child storm; latest desired target becomes ready after quiescence                                                         |
| Capacity              | Heuristic versus reservation failures distinguished; shared/separate volume accounting; repeated reads preserve last failure without retry storms; resumable recovery retains valid ready evidence |
| Actual MCP transport  | A simulated 30-second client receives an actionable response before disconnect; cancellation terminates owned read workers and leaves no indefinite finalizer                                      |

Extend `packages/graph/test/unit/code-graph.analysis.test.ts`, analysis/store/summary properties, refresh-demand properties, and disk-capacity/materialization-storage properties. Extend `apps/threadnote/test/unit/mcp-code-graph-analysis-handler.test.ts`, `code-graph.commands-analysis.test.ts`, watcher and refresh-demand I/O tests, plus focused transport/process integration coverage. Put new package-only tests in the graph package, even where older application tests have not yet moved.

Meaningful bounded Fast-check properties: policy truth-table correctness; stale evidence never becoming current; identity isolation; identical-request coalescing and latest-target convergence; persisted-summary versus paged-fallback equivalence; every acquired lease is released or explicitly left to bounded recovery; capacity admission monotonicity as available bytes increase. Use independent invariants/models rather than copies of production helpers.

Use `@effect/vitest` for Effect programs, narrow layers, `Deferred`/`TestClock`, and Effect cleanup. Consult `@repos/effect/` before implementation. Use live time only for actual process/SQLite-lock/deadline tests, with bounded wall-clock assertions. No test was added or executed during the initial planning task; implementation adds the regressions described above.

Acceptance requires: ordinary MCP total work fits the proposed 25-second target under controlled contention and completes before the 30-second client deadline; cold and failed reads say why evidence is unavailable; accepted stale analysis preserves exact snapshot identity; no cross-project fallback or duplicate equivalent builds; real insufficient-capacity cases remain protected. A small test fixture must demonstrate analysis data, not only a transport-success envelope. Representative large-snapshot runs must report actual latency and partial coverage without assuming the issue's earlier timings will reproduce.

## Delivery and completion

Implement in three reviewable changes: (1) analysis resource lifetime, deadlines, freshness, and recovery; (2) proven scope/demand coalescing fixes; (3) capacity diagnostics and any evidence-backed admission correction. The first change may ship independently, but #683's retest scenarios remain open until the other observed failure modes are resolved or explicitly tracked with verified boundaries.

Follow current-main `docs/monorepo.md`: regenerate build declarations with `bun run bazel:generate`, run `bun run check:repo`, run the narrowest affected Bazel targets and focused tests, and inspect `bun run bazel:affected`. Run relevant lint/typechecks. Leave the complete selected suite and platform matrix to PR CI; investigate failures before merge.

For each runtime delivery, commit the intended changes and make the worktree clean, then use the contributor install skill to install exact HEAD globally. Respect active-worktree ownership; obtain release from the owning agent before takeover. Terminate superseded Threadnote processes through the supported installer option. Smoke the global CLI with stale-ready, cold-project, contention, and capacity fixtures, then verify the MCP behavior through its transport. Record exact source/runtime versions, semantic outcomes, latency, remaining limitations, and focused/CI checks in the handoff.

Store this plan privately under stable topic `issue-683-analysis-readiness-fix-plan` and update the existing `analyze-code-graph-queued-investigation` handoff. The initial request authorized remembering the plan privately. The follow-up explicitly authorizes implementation, global validation, and opening a pull request. Shared memory publication remains separate.
