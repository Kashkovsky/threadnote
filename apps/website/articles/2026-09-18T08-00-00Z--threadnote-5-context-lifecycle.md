---
author: Denys Kashkovskyi
publishedAt: 2026-09-18T08:00:00Z
slug: threadnote-5-context-lifecycle
summary: 'Threadnote 5 gives coding agents a trustworthy context lifecycle: a focused, cited start; reviewed learning at closeout; and maintenance that keeps knowledge connected to the code.'
title: Threadnote 5.0.0 — Context that keeps up with the work
---

Coding agents can make a change quickly. The harder part is starting the next task with the decisions that still
matter, checking them against the code that exists today, and leaving something better than a chat summary behind.

Threadnote 5 turns that into one lifecycle:

> Start with the useful context and current source evidence, then review the lessons worth carrying forward.

It works across supported coding-agent environments without treating vendor chat history as a source of truth. The
repository and current worktree still decide what the code does. Threadnote makes the relevant history, current-source
connections, and uncertainty available at the right time—and leaves the decision to preserve or share knowledge with
you.

## Begin a task with a Context Brief

A **Context Brief** is the small, cited starting packet for a real task. It can combine reviewed decisions, unfinished
work, compatible verified procedures, and current code evidence. Just as importantly, it shows when evidence is old,
incomplete, or unavailable.

After connecting an agent, give it a normal engineering task. The concise Threadnote guidance installed for that agent
automatically prepares a brief for meaningful work; you do not have to request it in every prompt. The agent can use
the brief to orient itself, then verify consequential claims in the files and worktree it is changing.

Setup is designed around that first useful moment rather than a collection of configuration steps. It connects a
selected agent, prepares the repository, checks the installation, and finishes by producing a real brief. The journey
is resumable and preview-first, and it does not publish anything just because setup ran.

For a large monorepo, start by defining a **graph scope** for the app or library roots that matter to a project.
Threadnote follows their declared dependencies and leaves unrelated packages out of that project graph. The scope can
be previewed before indexing, carries coverage information into graph answers, and remains available across compatible
linked worktrees without mixing dirty local changes. It is a durable, reviewable boundary—not a personal ignore file
that must be copied into every worktree.

A **Workset** solves a different problem: it deliberately groups prepared projects or repositories for one
cross-project investigation. Scopes focus one monorepo graph; worksets compose evidence across selected projects.

## End with a Knowledge Delta, not a transcript

At meaningful closeout, Threadnote guidance asks the agent to record a private handoff for the next person continuing
the task. When the task produces reusable knowledge, it also prepares a **Knowledge Delta**: a concise proposal for
changing the context available to future work.

A good delta identifies the decision and rationale, the constraints that must hold, what was verified, knowledge that
is no longer valid, and unresolved risks. It is deliberately a small review artifact rather than a copy of the
conversation.

You can approve, edit, defer, or reject each proposed item. Nothing is silently written as durable knowledge. A private
handoff remains private task state; an approved durable decision remains private until you choose to share it. Teams
that want normal code-review controls can materialize a proposal for their existing Git and CODEOWNERS workflow.

That boundary is central to Threadnote 5: agents discover and propose context, while people decide what becomes a
lasting engineering record.

## Reuse knowledge without copying it everywhere

Repositories often already have useful instructions and ADRs. Threadnote can bring selected guidance into review before
it becomes reusable knowledge. Once a decision is approved, it can be projected into another supported agent’s native
project guidance while preserving the text and policy the repository already owns.

This means one reviewed decision can support several agent environments without maintaining drifting copies. Related
memories can also be connected explicitly, so a later reader can follow a decision to its constraints, replacement, or
supporting record without receiving an unbounded bundle of notes.

Threadnote 5 also makes **verified procedures** first-class context. A procedure is a reviewed, versioned workflow with
compatibility and verification evidence. It is not an instruction that Threadnote downloads and runs automatically.
Only procedures that are relevant, compatible, current, and verified can accompany a Context Brief.

## Keep context healthy as the code changes

Saved knowledge is useful only while it remains connected to reality. Threadnote 5 adds optional ownership, review
dates, and expiry dates to support that maintenance work. Existing memories remain readable, and upgrading does not
invent an owner or a deadline for them.

Context health identifies code citations that changed or disappeared, records that are overdue or expired, conflicting
or duplicate knowledge, broken memory connections, and drift in projected guidance. It proposes repair, replacement,
supersession, or retirement for review. It never silently rewrites a record, deletes it, or decides which side of a
contradiction is right.

The same lifecycle can be checked next to code changes, making it easier to notice when a decision or document should
be revisited instead of discovering the mismatch months later.

## Measure whether the loop helps

Threadnote distinguishes context that merely looked relevant from context that actually helped. Mark recalled material
useful, wrong, pinned, dismissed, or applied when it informed a plan or change. A local value report then summarizes
reuse, closeout, and health outcomes without collecting source code, memory bodies, queries, paths, repository names,
or raw logs.

The point is not to maximize the number of stored notes. It is to make the next engineer or agent more effective with a
reviewed, source-aware decision.

## Follow the journey

Start with [How Threadnote helps on a real task](/docs/threadnote-5-journey/), then see the
[Context Brief workflow](/docs/context-brief-workflow/), [Knowledge Delta review](/docs/knowledge-delta/), and
[monorepo graph scopes](/docs/graph-monorepos/). Existing Threadnote 4 users can follow
[Upgrade from Threadnote 4](/docs/upgrade-from-4/); the separate [3.x migration guide](/docs/upgrade-from-3/) remains
for legacy OpenViking installations.

Threadnote 5 has one job: help context keep up with the work, from the first brief to the next task.
