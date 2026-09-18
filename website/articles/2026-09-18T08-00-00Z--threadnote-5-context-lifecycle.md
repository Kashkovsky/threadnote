---
author: Denys Kashkovskyi
publishedAt: 2026-09-18T08:00:00Z
slug: threadnote-5-context-lifecycle
summary: Threadnote 5.0.0 gives coding agents a source-verifiable context lifecycle across vendors—from a cited task brief to a reviewed Knowledge Delta, Git sharing, reuse, and ongoing health.
title: Threadnote 5.0.0 — Context that keeps up with the work
---

Coding agents are good at producing a change. They are much less reliable at inheriting the decisions behind the last
change, checking whether those decisions still match the code, and leaving something trustworthy for the engineer who
comes next.

That problem gets harder when a team uses more than one agent vendor. Each surface has its own chat history, rules, and
memory features. A decision that was obvious in one session can become invisible—or look current long after the source
has moved—in another.

Threadnote 5.0.0 turns that gap into one reviewable lifecycle:

> Coding agents start with the right decisions and current code evidence across vendors, and leave a reviewed knowledge
> delta for the next engineer.

This is not generic memory, a replacement code-search portal, or an internal developer portal. Threadnote compiles the
smallest useful evidence set for an engineering task, preserves provenance and uncertainty, and asks a person before a
suggestion becomes durable or shared.

## Start with a bounded, cited brief

A Context Brief brings together the pieces an agent needs to begin: relevant reviewed decisions, an active handoff,
current code-graph evidence, freshness checks, and compatible verified procedures. It stays inside a bounded token
budget and reports coverage gaps instead of hiding them.

After setup installs Threadnote's concise instructions and skills, the agent compiles this brief automatically at the
start of non-trivial work. Give it a normal engineering task; you do not need to name Context Brief in the prompt.

The distinction matters. Historical knowledge can explain _why_ a boundary exists. The current worktree shows _what_
exists now. Threadnote keeps those sources separate and carries their provenance into the same task view. Exact local
files remain authoritative, and missing or incomplete evidence stays `unknown` rather than becoming a confident clean
answer.

Setup is now a resumable journey rather than a pile of integration steps. Choose a surface from the public agent
catalog, preview the plan, and apply it to the current repository. Threadnote installs only the capabilities declared
for that surface, prepares the local project context, verifies the runtime, and finishes with a real source-backed
brief. The catalog remains the source of truth as support expands; the workflow is not built around a four-product
allowlist.

Setup already has a general repository-orientation task for that verification brief. Its optional `--task` flag only
customizes this one-time check; it is not needed for everyday agent work.

For teams that want to prove the whole loop, guided activation connects two catalog-supported surfaces, imports
selected guidance or ADRs into review, reaches the first cited brief, and later asks the second surface to retrieve the
approved decision. The journey is local, offline-capable, restartable, and explicit at every review or publication
boundary.

## Import guidance without silently canonizing it

Most repositories already contain useful instructions in agent-native files. Threadnote 5 can preview and import
selected project guidance into a private review, then project approved durable knowledge into another supported
surface’s native project instructions.

Import never means approval. Projection never means “overwrite the file.” Managed blocks carry provenance and hashes,
unmanaged bytes are preserved, shared physical targets have one owner receipt, and status reports missing, modified,
stale, conflicting, unsupported, or evidence-unavailable states. This lets a team reuse one reviewed decision without
maintaining divergent copies for every agent host.

## End the task with a Knowledge Delta

The most important change in Threadnote 5 happens at closeout.

Installed Threadnote guidance makes closeout part of the agent's normal lifecycle too. At meaningful closeout, the
agent writes the required private handoff and prepares the optional Knowledge Delta without waiting for a special
command. The person remains responsible for deciding whether any proposed durable knowledge is applied.

Instead of treating a transcript or session summary as knowledge, Threadnote forms a small Knowledge Delta. It can
contain decisions and rationale, constraints, verification performed, knowledge invalidated by the change, and
unresolved risks. Each proposal shows its evidence, comparison with current memory, confidence, destination, and exact
mutation preview.

A person can approve, edit, defer, or reject each item at the reviewed revision. The required handoff stays separate:
it captures current status, checks, blockers, and the next step, but it is not publishable team knowledge. That
separation keeps temporary branch mechanics from masquerading as a durable engineering contract.

Approved knowledge still does not cross into a team automatically. Small teams can preview and publish one selected
durable decision directly to their Git-backed share. Teams that require branch review can export a provider-neutral,
content-addressed proposal and materialize it as a deterministic local branch and commit. Threadnote does not switch
or dirty the current checkout, run Git hooks, push, or open a provider pull request. Normal Git policy and CODEOWNERS
remain in charge.

## Keep context healthy after it is shared

Useful context decays. Files move, implementation changes, ownership changes, and two reasonable records can begin to
contradict each other.

Memory schema v5 provides the compatibility foundation for maintenance: optional opaque ownership, review dates,
explicit validity, and safe lifecycle transitions. Existing v4 memory remains readable, and migration does not invent
an owner or review date.

Context health distinguishes current, changed, missing, unknown, overdue, expired, duplicate, contradictory, drifted,
and broken-relation states. Repairs are preview-first and preserve history. Personal lifecycle-safe repairs still need
explicit approval; shared, cited, guidance, ambiguous, and semantic changes stay review-only. Threadnote never silently
deletes durable knowledge or guesses which side of a contradiction is correct.

Teams can aggregate personal and selected local Git-team health without fetching or writing those repositories. A
provider-neutral schedule contract describes a read-only, network-disabled invocation for a local scheduler or CI, but
does not pretend that rendering a plan installed or ran a schedule.

## Put context checks beside code checks

`threadnote context check` brings the same lifecycle into CI. It compares a checkout with a Git base and reports five
bounded evidence lanes: directly cited changes, exact-current reverse graph impact, active conflicts, changed or
missing cited documentation, and advisories for important affected code that may need a new decision captured.

Text, JSON, and SARIF outputs are deterministic and content-free. The check does not prepare a graph, mutate memory,
push a branch, or contact a provider. Findings return one exit class; incomplete Git, graph, citation, or health
evidence returns another. Unavailable evidence can never pass as clean.

The checked-in GitHub Actions example is one adapter for that provider-neutral report. Hosted scheduling, organization
dashboards, identity, and automatic pull-request orchestration remain a separate deployment track. The local and
Git-team lifecycle does not depend on them.

## Reuse reviewed procedures, not mystery automation

Threadnote 5 also makes procedures first-class reviewed artifacts. A procedure declares stable identity and version,
ownership and review date, dependencies, compatible catalog surfaces and capabilities, task keywords, rollout policy,
and exact verification commands and fixtures.

Verification is preview-first. Nothing downloaded executes automatically. Apply runs only the reviewed local commands
with the current user’s permissions and emits a receipt only while the manifest, artifact, fixtures, and resulting
bytes remain exact. Publication has its own explicit preview and approval.

When a Context Brief considers procedures, it admits only a bounded, task-relevant, compatible, current, verified
dependency closure. The brief carries reviewed metadata and Git provenance—not procedure bodies or executable
commands.

## See whether the loop is actually helping

Threadnote now distinguishes context that merely looked useful from context that was actually applied to a plan or
change. `Useful`, `Wrong`, `Pin`, `Dismiss`, and `Applied` feedback appears in the normal recall workflow and Manager.

The local value report summarizes activation, time to first evidence, second-surface reuse, Knowledge Delta outcomes,
feedback, and health resolution. It is count-only and independent from optional telemetry. It excludes query text,
memory bodies, source code, paths, repository names, and stable user IDs. A design-partner export is redacted,
preview-first, and written only with explicit consent.

That measurement keeps the release honest. Threadnote should be judged by whether another engineer or agent can use a
reviewed, source-verifiable decision—not by how many memories or graph nodes it stores.

## Follow the complete journey

The new [Threadnote 5 journey](/docs/threadnote-5-journey/) walks from installation and catalog-driven setup through a
cited brief, reviewed closeout, Git sharing, second-surface reuse, health, and local value evidence. The
[context-lifecycle workflow docs](/docs/context-brief-workflow/) cover each stage in detail, and the stable
[3.x migration route](/docs/upgrade-from-3/) now explains how to move a legacy OpenViking home directly into
Threadnote 5 without deleting the rollback source.

Threadnote 5 is the same local-first project with a sharper job: keep engineering context trustworthy as work moves
between tasks, people, repositories, and agent vendors.
