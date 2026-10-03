---
author: Denys Kashkovskyi
publishedAt: 2026-10-03T12:30:00Z
slug: graphmem-agent-continuation-study
summary: 'A controlled five-repository study found that Threadnote continuation used 65.62% fewer failure-inclusive provider tokens per verified completion than files-only continuation.'
title: 'GraphMem: Measuring Memory and Code Graphs in Agent Continuation'
---

## Abstract

Long-running coding work often crosses a session boundary. The second agent can rediscover the repository state from
files, or it can start with a compact account of what the previous session learned and a focused way to navigate the
code. We measured the cost of those two continuation strategies on five public-repository tasks.

The experiment compared a files-only continuation session with a Threadnote continuation session preloaded from the
first session's memory and required to execute one task-specific code-graph query. We counted the full matched workflow:
the shared first session plus the assigned continuation, including failed attempts, divided by deterministically
verified completions.

Threadnote used 1,296,040 lifecycle provider tokens and produced five verified completions. Files-only used 3,015,666
tokens and produced four. That is 259,208 versus 753,916.5 tokens per verified completion, a 65.62% reduction with a
repository-cluster bootstrap 95% interval of 50.80% to 81.56%. Lifecycle time per verified completion was 46.14% lower
(95% interval: 25.25% to 73.38%). The observed completion-rate difference was +20 percentage points, but its interval
included no difference (0 to 60 points), so this study does not establish completion superiority.

## Hypothesis

The primary hypothesis was narrow: for multi-session implementation work, preloaded Threadnote continuation would
reduce failure-inclusive provider tokens per deterministically verified completion relative to files-only continuation,
without violating the preregistered completion and safety gates.

This is not a test of whether any individual memory or graph query is useful in isolation. It tests a product workflow:
Threadnote captures the first session's evidence, prepares a compact continuation handoff, and makes a focused graph
query available to the next agent.

“GraphMem” is the article's shorthand for that bundled `threadnote-preloaded-resume` condition, not a separate product
name or a claim that memory and graph effects were independently identified.

## Experimental design

Each task had two phases, sealed in the
[task-level evidence](https://github.com/threadnote/threadnote/tree/2b9ede3e031790f9798517504027870dacbc0f74/studies/graphmem-continuation-v1/evidence/tasks)
and continuation plans.

1. A common Phase 1 agent added a regression and diagnosed the defect. Its sealed checkpoint included the repository
   state, measured provider usage, the verified invariant, the unresolved gap, source citations, and a graph question.
2. Two fresh Phase 2 sessions continued independently from that same checkpoint. Each task contributed exactly one
   files-only attempt and one Threadnote attempt. There were no retries.

The two treatment arms were:

- **Files-only (`files-bare`)**: the agent received the task and checkpoint repository files, but no handoff or
  Threadnote tool.
- **GraphMem (`threadnote-preloaded-resume`)**: Threadnote preloaded a compact, product-generated continuation handoff
  before the first agent response. The agent also executed exactly one task-specific code-graph query derived from the
  Phase 1 diagnosis. No manually written context was supplied.

The experiment used OpenAI `gpt-5.6-luna` with one sealed parameter configuration in all ten Phase 2 attempts. The
Threadnote candidate was `5.1.0-beta.2` at source commit
`8da0eae878aaedc419319e32fd10fdcb5abccbb1`; its executable SHA-256 was
`75d731c3c1670b4be0b534fee8c6b3a298cba4a5d707aa8caa9dcfbd361e73c6`.

These treatment and model fields are recorded in every preserved request. For example, the
[Click GraphMem request](https://github.com/threadnote/threadnote/blob/2b9ede3e031790f9798517504027870dacbc0f74/studies/graphmem-continuation-v1/evidence/tasks/click/pilot/runs/run_a51f7c019b6a96e15ba1ea3a078f805c/request.json)
contains the automatic handoff URI, required graph query, null manual handoff, model identity, parameter hash, and tool
identity. The rationale for excluding an unstandardized manual-context arm is preserved in the
[experiment protocol](https://github.com/threadnote/threadnote/blob/2b9ede3e031790f9798517504027870dacbc0f74/studies/graphmem-continuation-v1/protocol/no-manual-context.json).

Assignment order was randomized but not position-balanced: Threadnote ran first in four task pairs and files-only ran
first in one. The analysis discloses this imbalance because order effects could influence paired estimates.

## Task corpus

The corpus covered five defects in mature public repositories and two implementation languages.

| Repository          | Task                                                      | Language |
| ------------------- | --------------------------------------------------------- | -------- |
| `pallets/click`     | Preserve abbreviations while generating short help        | Python   |
| `pytest-dev/pluggy` | Unregister every hook implementation owned by one plugin  | Python   |
| `go-chi/chi`        | Preserve real handlers during route-tree enumeration      | Go       |
| `gin-gonic/gin`     | Reset radix-tree backtracking state across method lookups | Go       |
| `labstack/echo`     | Avoid mutating caller-owned RFC 9457 problem values       | Go       |

Every task had a task-specific held-out verifier. The exact source revisions, checkpoint revisions, repository fixture
hashes, prompts, plans, and verifier contracts are preserved in the
[frozen verification plan](https://github.com/threadnote/threadnote/blob/2b9ede3e031790f9798517504027870dacbc0f74/studies/graphmem-continuation-v1/protocol/prepared-study/verification-plan.json)
and task evidence.

## What counted as completion

An agent saying it was finished did not count. Completion required the generated patch to pass deterministic
verification against both the visible continuation contract and the held-out task contract. The files-only Pluggy
attempt reached a terminal runner state but failed the held-out verifier, so it remained assigned, contributed all of
its tokens and time, and contributed no completion.

This distinction is central to the metric. A failed attempt that spends fewer tokens is not a cheaper completed task.
Conversely, a treatment that spends tokens but turns a failure into a verified completion can improve tokens per
completion even when raw attempt cost alone is ambiguous.

## Lifecycle accounting

The primary endpoint was:

> Total provider tokens for the common Phase 1 checkpoints plus all assigned Phase 2 attempts, divided by the number of
> deterministically verified completions.

The common Phase 1 sessions cost 634,597 provider tokens across the five tasks. That same measured cost was charged to
each arm. Phase 2 then used 661,443 tokens for GraphMem and 2,381,069 for files-only, producing lifecycle totals of
1,296,040 and 3,015,666 respectively.

This intent-to-treat accounting keeps known failures in the numerator and does not let a missing or broken runtime look
cheap. The final run had no unavailable rows and no missing token or elapsed-time accounting.

## Statistical method

The study used the repository task as the cluster and ran 10,000 cluster-bootstrap draws with a frozen random seed.
Intervals are percentile 95% intervals over this five-cluster corpus. They quantify uncertainty within this benchmark;
they do not establish population validity for software-engineering tasks in general.

The preregistered token gate required at least a 5% reduction. Completion had a five-percentage-point non-inferiority
margin. Harmful actions and authorization leaks had to remain at zero. The false-current gate permitted up to 1,000
events; both arms recorded three, so the safety-gate result should not be read as zero false-current assessments.

## Results

| Arm        | Assigned | Verified | Lifecycle provider tokens | Tokens per verified completion | Lifecycle ms per verified completion |
| ---------- | -------: | -------: | ------------------------: | -----------------------------: | -----------------------------------: |
| Files-only |        5 |        4 |                 3,015,666 |                      753,916.5 |                              285,375 |
| GraphMem   |        5 |        5 |                 1,296,040 |                        259,208 |                              153,702 |

The primary comparison was a **65.62% reduction in provider tokens per verified completion**. The 95% interval was
50.80% to 81.56%, entirely above the preregistered 5% threshold.

Lifecycle time per verified completion was **46.14% lower**, with a 95% interval of 25.25% to 73.38%.

GraphMem completed 5/5 tasks and files-only completed 4/5. The difference was +20 percentage points, with a 95%
interval of 0 to 60 points. We therefore report the completion counts but do not claim that GraphMem has a superior
completion rate.

### Results by repository

The token effect was not driven by one repository. GraphMem used fewer lifecycle tokens in all five pairs.

| Repository | Files-only lifecycle tokens | Files verified | GraphMem lifecycle tokens | GraphMem verified |
| ---------- | --------------------------: | :------------: | ------------------------: | :---------------: |
| Click      |                     560,404 |      Yes       |                   209,818 |        Yes        |
| Pluggy     |                     621,988 |       No       |                   319,182 |        Yes        |
| Chi        |                     526,224 |      Yes       |                   201,392 |        Yes        |
| Gin        |                     657,529 |      Yes       |                   390,933 |        Yes        |
| Echo       |                     649,521 |      Yes       |                   174,715 |        Yes        |

Both arms recorded zero harmful actions and zero authorization leaks. GraphMem recorded four blocked actions across the
five outcomes, compared with twenty for files-only. Those counts are descriptive; they were not an independently
randomized mechanism test.

## What the experiment says about mechanism

The result supports the tested bundle, not a decomposition of it. GraphMem combined a compact continuation memory with
a focused code-graph action. There was no memory-only or graph-only arm in this final study, and the manual-context arm
was deliberately excluded because the amount and quality of human-supplied context cannot be standardized objectively.

The lower blocked-action count and lower token use are consistent with the intended mechanism: the second session
spent less effort reconstructing what Phase 1 had already established. But the design cannot determine how much of the
effect came from memory, from graph navigation, from their interaction, or from another feature of the continuation
workflow. That requires a separately preregistered component ablation.

## Limitations

The study has five clusters. Its confidence intervals are therefore sensitive to each task, and they apply to this
corpus rather than to all repositories or agents.

The five task identities had been used in earlier evaluator and product iterations. The final experiment used fresh
nonces, fresh sessions, a frozen candidate, no pooled historical outcomes, and no task-specific product tuning after
freeze, but prior benchmark exposure limits the claim that the corpus was strictly unseen. Those facts were reviewed
before the final provider outcomes and are preserved in the
[exposure audit](https://github.com/threadnote/threadnote/blob/2b9ede3e031790f9798517504027870dacbc0f74/studies/graphmem-continuation-v1/protocol/exposure-audit.json).

Order was randomized but not balanced. GraphMem ran first in four of five pairs. A larger replication should balance
position within repository clusters.

The experiment compared two bundled treatments with one model and one parameter configuration. It does not establish a
completion-rate advantage, isolate memory from graph effects, or show that the result generalizes to other models,
languages, task sizes, or repository states.

Finally, deterministic verification is only as good as the task contracts. This study hardened those contracts with
provider-free qualification, accepted-fix compatibility checks, and held-out verification, but no finite verifier can
prove the absence of every semantic defect.

## Reproducibility

The preserved study is `threadnote-continuation-v19-final`, published as
[GraphMem Continuation v1](https://github.com/threadnote/threadnote/tree/2b9ede3e031790f9798517504027870dacbc0f74/studies/graphmem-continuation-v1).

- Study identity: `945b5466e0c2f86af7052916f2c29199dd7f913d01b94b427b39d285047a8046`
- Report identity: `4a491c64ea2af984d0b79f2001fdbcad903a95b0171d7eea0763bb067bf35c49`
- Finalization receipt identity: `caab6c601543d3d5cfa7769a19d417f47b37d9ecbe7b64b8e08244adcf9ffdb1`
- Corpus hash: `704d46b7386561807d9393403daadad4675c5e9f61a180506b6afa3af9ca7046`

The canonical aggregate result is in the
[continuation report](https://github.com/threadnote/threadnote/blob/2b9ede3e031790f9798517504027870dacbc0f74/studies/graphmem-continuation-v1/results/continuation-report.json),
with per-attempt accounting in the
[continuation outcomes](https://github.com/threadnote/threadnote/blob/2b9ede3e031790f9798517504027870dacbc0f74/studies/graphmem-continuation-v1/results/continuation-outcomes.jsonl).
The frozen design and task identities are in the
[final study protocol](https://github.com/threadnote/threadnote/blob/2b9ede3e031790f9798517504027870dacbc0f74/studies/graphmem-continuation-v1/protocol/final-study/continuation-study.json).
Raw final-run records are retained under `evidence/tasks/`, and every preserved file is covered by `SHA256SUMS`.

## Conclusion

On this five-task benchmark, preloaded Threadnote continuation reduced failure-inclusive lifecycle provider tokens per
deterministically verified completion by 65.62% relative to files-only continuation. The cluster-bootstrap interval
remained positive, and observed lifecycle time was also lower. The completion-rate interval included no difference, and
the design cannot attribute the effect to memory or graph context independently.

The practical result is still meaningful: preserving verified work across a session boundary can make successful
continuation substantially less expensive. The next question is not whether this exact five-task result should be rerun
until it changes, but whether a larger, position-balanced replication and component ablation reproduce it.
