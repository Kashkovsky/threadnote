---
author: Denys Kashkovskyi
publishedAt: 2026-08-26T20:30:00Z
slug: memory-that-can-check-its-sources
summary: Threadnote 4.4 lets engineering memory cite exact code, distinguish moved links from stale claims, and abstain when current evidence is incomplete.
title: Memory that can check its sources
---

Engineering memory has an uncomfortable failure mode: the better written it is, the more convincing it can sound after
the code underneath it has changed.

“Retries preserve the original idempotency key” might be a useful durable decision today. Six months later, the file
may have moved, the implementation may have changed, or the entire retry path may have been deleted. A future agent
can still retrieve the sentence. Until now, Threadnote could attach broad commit provenance to a memory, but it could
not answer the sharper question: **does the particular code evidence behind this claim still exist?**

Threadnote 4.4 adds memory-to-code citations and stale-link warnings. A durable memory or handoff can cite a file or an
indexed symbol. Context Brief then checks that captured evidence against current, ready code-graph snapshots and
reports one of five outcomes: `exact`, `relocated`, `changed`, `deleted`, or `unknown`.

The important part is not the happy path. It is the distinction between a moved link and stale evidence—and the cases
where Threadnote deliberately refuses to guess.

## Capture a receipt, not a verdict

A citation starts with something the caller is allowed to know: a graph-indexed repository-relative path or a stable `cgs_`/`cgr_`
graph handle.

```sh
threadnote remember \
  --kind durable \
  --project payments \
  --topic retry-contract \
  --code-ref src/payments/retry.ts \
  --code-ref cgs_… \
  --text "Retries preserve the original idempotency key."
```

MCP clients use the same contract through `codeRefs` and an absolute `callerCwd`:

```json
{
  "kind": "durable",
  "project": "payments",
  "topic": "retry-contract",
  "callerCwd": "/workspace/payments",
  "codeRefs": ["src/payments/retry.ts", "cgs_…"],
  "text": "Retries preserve the original idempotency key."
}
```

Threadnote—not the caller—resolves those references against the exact-current ready graph. It captures repository and
snapshot identity, the containing file hash, and, for a symbol, the canonical source-fragment hash and indexed locator.
One missing, ambiguous, stale, or racing reference fails the write atomically. Capture never starts indexing behind the
user’s back.

What gets stored is an immutable statement about the past: these were the bytes observed at this location in this
snapshot. It does **not** store “fresh” or “stale.” Those are claims about a later observation and would become stale
themselves.

That split follows a useful provenance pattern. The [W3C PROV data model](https://www.w3.org/TR/prov-dm/) separates
entities from the activities that use and produce them. The [Software Heritage persistent identifier
specification](https://www.swhid.org/specification/v1.2/5.Core_identifiers/) similarly separates intrinsic content
identity from [qualified contextual information](https://www.swhid.org/specification/v1.2/6.Qualified_identifiers/).
Neither standard prescribes Threadnote’s format. Our design inference was to keep the captured code evidence immutable
and model each later validation as a disposable observation against one exact snapshot.

## One file can move without making a decision false

Paths are useful locators. They are poor identities.

Suppose `src/payments/retry.ts` becomes `src/checkout/retry-policy.ts` without changing the cited evidence. Calling the
memory stale would create noise. Silently rewriting its citation would erase provenance. Choosing the first similar
file would be worse.

Threadnote instead reports `relocated` only when there is one deterministic, unique match for the same captured
evidence. The memory remains fresh, but Context Brief adds a stale-link warning. The original citation stays untouched;
the returned validation receipt carries the observed location for review.

The five states have intentionally different consequences:

| Status      | Current observation                                                                   | Memory freshness  |
| ----------- | ------------------------------------------------------------------------------------- | ----------------- |
| `exact`     | The captured file bytes or symbol fragment remain at the original locator.            | Fresh             |
| `relocated` | One unique deterministic match preserves the evidence elsewhere.                      | Fresh, stale link |
| `changed`   | The locator or unique successor contains different cited evidence.                    | Stale             |
| `deleted`   | Complete current coverage finds neither the evidence nor one unique move.             | Stale             |
| `unknown`   | Evidence is unavailable, incomplete, ambiguous, invalid, unsupported, or over budget. | Unknown           |

For a memory with several citations, `changed` or `deleted` wins and makes it stale. Otherwise, any `unknown` makes the
aggregate unknown. Only an all-`exact`/`relocated` set is fresh.

This also fixes a coarse-freshness trap. A commit hash changes for many reasons unrelated to one remembered contract.
If the exact cited bytes survive in a later commit, precise current evidence can keep the memory fresh. For symbols,
Threadnote hashes the cited source fragment separately from the containing file, so an unrelated edit elsewhere in the
same file does not automatically invalidate the claim.

## Unknown is a safety result

Absence is surprisingly hard to prove.

A missing file in a stale graph is not deleted. Two copies of the same evidence are not one relocation. A cited
repository outside the active scope is not evidence about the repository that happens to be open. A graph that changes
during validation cannot authoritatively describe either side of the race.

Threadnote maps all of those cases to `unknown`. It never uses fuzzy similarity, an LLM, or “first match wins” to turn
ambiguity into confidence. `deleted` requires complete exact-current coverage. A stale, deferred, failed, missing, or
incomplete snapshot cannot produce an authoritative exact-or-deleted answer.

The work is bounded too. A memory can carry at most eight citations. One Context Brief validates at most 96 citations
across at most 32 cited repositories, with concurrency capped at four. It validates only memories already selected by
bounded recall, batches work by repository, and keeps the complete text-plus-structured response under the existing
1,500-estimated-token ceiling. Crossing a bound produces explicit unknown coverage; it does not trigger a scan or a
cold graph build.

This is an engineering choice, not a claim that uncertainty has disappeared. In a tool that helps agents decide what
to trust, a precise “I cannot establish this” is more useful than a fluent guess.

## Compatibility could not mean empty memory

The feature is additive. Existing v1 and other uncited memories remain in the same recall ranking after the upgrade.
Context Brief still returns them.

When one repository snapshot resolves and an old memory has a valid `sourceCommit`, Threadnote keeps the existing
coarse commit comparison. When that basis is not available, freshness is `unknown`. What does not happen is an empty
recall result merely because old records lack the new citation header.

New and rewritten memories use schema v4. Replacing cited prose without `codeRefs` or `--code-ref` deliberately clears
the old citations and reports the cleared count; evidence is never silently inherited by a different sentence.
Reviewed candidates retain the immutable receipts captured during review rather than recapturing them at approval
time.

There is one team-rollout boundary: upgrade every writer before publishing cited schema-v4 memory. An older writer does
not understand the repeated citation header and can discard it if it reformats the record.

Sharing remains conservative as well. A cited memory can be published only when its evidence came from clean committed
source and carries a portable remote repository identity. Dirty-worktree, local-only, or malformed citations block
publication. Threadnote will not strip provenance just to make the publish succeed.

## Context Brief carries the warning with the claim

The request did not get more complicated:

```sh
threadnote context brief \
  --task "Trace checkout retries and check the remembered contract" \
  --budget-tokens 1250 \
  --json
```

The response did get more honest. Context Brief v2 keeps freshness beside each selected durable decision or handoff and
can include its precise status, bounded per-citation receipts, and stale-link or stale-evidence issues. A projector
cannot keep the memory excerpt while quietly dropping its safety status. MCP content and plain CLI now carry
parseable `context-brief-agent-view` JSON for clients that hide structured
results, while JSON and MCP `structuredContent` retain the full bounded audit evidence.

Repository and Workset behavior follows the same rule: validate only an exact-current snapshot already available in
scope. Workset queries never fan out cold graph builds. If a member is missing or stale, prepare the Workset explicitly
and rerun—or accept the unknown result.

## Measure correctness offline; observe operation safely

Citation quality is not something anonymous telemetry can prove. We test it with labeled repository mutations:
unchanged evidence across later commits, unrelated edits in the same file, body changes, moves, renames, deletions,
path reuse, duplicated relocation candidates, dirty overlays, stale snapshots, incomplete Worksets, and
cross-worktree/repository collisions.

The safety properties matter more than a single aggregate score: changed or deleted evidence must never be fresh;
ambiguous relocation must abstain; incomplete absence must never become deleted; irrelevant same-file edits must
preserve an exact symbol fragment; and legacy memories must keep recall parity. Deterministic property tests vary order,
batching, and edit sequences so the validator cannot accidentally depend on lucky fixture layout.

Optional live telemetry has a narrower job: help diagnose latency, coverage, abstention, warning, and truncation trends.
It remains disabled by default. Schema v5 requires a fresh explicit opt-in and exports only closed operation classes,
phase timing, validation-result classes, and power-of-two buckets. It never exports the task, memory or citation
identity, memory text, path, symbol, repository or Workset identity, commit, snapshot, hash, exact private count, or raw
failure text. Failed and interrupted briefs do not emit result-derived citation classifications.

That versioned rollout is another design inference. [OpenTelemetry schemas](https://opentelemetry.io/docs/specs/otel/schemas/)
provide a way to describe telemetry transformations; Threadnote goes further for this surface by keeping earlier wire
contracts immutable and requiring renewed user consent before the v5 producer can send anything.

## The honest boundary

An exact citation proves that captured evidence persisted. It does not prove the prose is correct, complete, or still
the best engineering decision. A relocated result says a link moved, not that semantics stayed unchanged everywhere
around it. Unknown is not an invitation for the model to improvise.

That boundary is the feature.

Threadnote memory can now show its work, compare that work with current source, and tell an agent whether the evidence
survived, moved, changed, disappeared, or could not be checked safely. The repository remains authoritative. Memory is
more useful because it finally has a disciplined way to admit when the repository has moved on.
