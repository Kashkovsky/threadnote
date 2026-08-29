# Memory-to-code citations

Threadnote 4.4 can bind a durable memory or handoff to exact file or symbol evidence from the current code graph. The
stored citation records what Threadnote observed at write time. A Context Brief later checks that immutable evidence
against an already-ready current graph and returns a disposable validation receipt.

Code citations are optional. Existing uncited memories remain recallable after upgrading.

## Capture citations

The CLI accepts repeatable `--code-ref` flags on `remember` and `handoff`. Run the command from the checkout whose
current graph should be used:

```sh
threadnote remember \
  --kind durable \
  --project payments \
  --topic retry-contract \
  --code-ref src/payments/retry.ts \
  --code-ref cgs_… \
  --text "Retries preserve the original idempotency key."

threadnote handoff \
  --project payments \
  --topic retry-rollout \
  --code-ref cgr_… \
  --task "Roll out the retry contract" \
  --tests "bun test payments" \
  --next-step "Review the remaining caller"
```

The MCP tools `remember_context` and `review_session_context` accept `codeRefs`. An absolute `callerCwd` is required
when references are present:

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

Pass that payload to `remember_context`. Supported references are:

- a safe repository-relative POSIX path present in the exact-current graph, which creates a file citation;
- a local `cgs_` graph handle, which normally creates a symbol citation;
- a repository-qualified `cgr_` handle, which selects its bound repository and symbol.

Callers supply locators, not hashes, status, snapshot data, or raw citation JSON. Threadnote resolves every reference
against an exact-current ready graph and derives the citation internally. Capture is deduplicated and atomic: if one
explicit reference is invalid, absent, ambiguous, non-current, or changes during capture, the memory is not written.

Path references are graph locators, not arbitrary tracked-file readers. A tracked file that is outside the graph
inventory cannot be cited by path; choose a path or stable handle that is present in the exact-current graph.

Capture never starts or refreshes indexing. Check the graph first and prepare it explicitly when needed:

```sh
threadnote graph status
threadnote graph index --no-vectors
```

When an MCP citation write reaches a missing, stale, or deferred graph admission state, it fails before changing memory
and returns a `memory-code-citation-write-recovery` receipt in `structuredContent`. The receipt keeps paths and graph
identities out of the response and reports `writeApplied: false` and `indexingStarted: false`. Caller-local references
use the command above from `callerCwd`; a `cgr_` reference routed through a named Workset returns an explicit
`threadnote workset prepare` action and the Workset name as a separate argument. Retry the same write only after the
selected preparation reports current ready evidence.

A newly written memory accepts at most eight citations. Each canonical citation line is limited to 8 KiB and total
citation metadata to 64 KiB.

## Capture and validation are different records

The citation persisted in schema-v4 memory is immutable capture-time evidence. It includes the repository identity,
source commit and snapshot, dirty state, extractor identity, repository-relative path, and file hash. A symbol citation
also includes its indexed locator, span, and a hash of the canonical source fragment. Threadnote derives a stable
`tncc_` identity from those fields.

Current status is deliberately not persisted in the memory. Each Context Brief computes a validation receipt for the
selected snapshot. The receipt may name the observed path and snapshot, but it is disposable and is recomputed for a
later brief. Finding a relocation never edits the original citation.

This distinction matters: a citation says which code evidence was captured. Even an `exact` receipt does not prove
that a natural-language memory is a correct interpretation of that code.

## Freshness states

Each citation receives one status:

| Status      | Meaning                                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------------------------- |
| `exact`     | The same file bytes or symbol fragment remain at the captured locator.                                         |
| `relocated` | One deterministic, unique match contains the same evidence at a different path, node, or span.                 |
| `changed`   | The captured locator or unique successor contains different cited evidence.                                    |
| `deleted`   | Complete exact-current coverage finds neither the original evidence nor one deterministic relocation.          |
| `unknown`   | Validation cannot make an authoritative claim because evidence is unavailable, ambiguous, invalid, or bounded. |

Memory freshness is aggregated conservatively:

1. Any `changed` or `deleted` citation makes the memory `stale`.
2. Otherwise, any `unknown` citation makes freshness `unknown`.
3. Otherwise, `exact` and `relocated` citations make the memory `fresh`.

`relocated` therefore means the evidence survived but its stored locator is stale. Context Brief returns a
`stale-link` issue while keeping the memory fresh. Review the current locator and recapture the citation when you next
replace the memory.

Precise current evidence supersedes commit-only freshness. A memory captured at an older commit can remain fresh when
its cited bytes are still exact or uniquely relocated. Conversely, Threadnote refuses to infer `exact` or `deleted`
from a missing, stale, deferred, failed, racing, incomplete, or ambiguous graph; those cases are `unknown`.

## Context Brief v3

Run a small repository-scoped code-anchored request:

```sh
threadnote context brief \
  --task "Trace checkout retries and check the remembered contract" \
  --code-ref src/checkout/retries.ts \
  --budget-tokens 1250 \
  --json
```

The equivalent MCP input is:

```json
{
  "task": "Trace checkout retries and check the remembered contract",
  "callerCwd": "/workspace/checkout-api",
  "codeRefs": ["src/checkout/retries.ts"],
  "budgetTokens": 1250
}
```

For a prepared Workset, omit `codeRefs` in this milestone:

```sh
threadnote workset prepare checkout
threadnote context brief \
  --task "Trace checkout retries across services" \
  --workset checkout \
  --mode trace \
  --json
```

After an agent discovers code, repeat `--code-ref` up to eight times with repository-relative files or `cgs_` symbols.
The MCP `codeRefs` input accepts one string or an array with the same eight-occurrence limit. Context Brief retrieves
memories whose immutable citations explicitly link to those anchors alongside the ordinary task-text recall lane. It
does not infer semantic links from nearby code; unsupported `cgr_` or Workset anchors remain explicit coverage gaps.
Requests with nonempty `codeRefs` emit Context Brief v3; task-only requests retain the v2 output contract.
The v3 projection summarizes direct-link coverage as `coverage.memory.codeAnchors` with `requested`, `resolved`,
`matchedMemories`, and `complete`. A directly selected memory carries `selectionBasis: "code-citation"` and may expose
bounded `codeRelations` entries with only the anchor ordinal, citation ID, file-or-symbol kind, and validation status.
Coverage describes explicit citations in the authorized indexed corpus, not semantic completeness; raw selectors,
repository IDs, paths, hashes, commits, and snapshots stay private.

Inverse citation lookup has an independent bounded selector scan. When that scan cannot exhaust a selector prefix and
the corresponding result lane remains unfilled, Context Brief adds `code-anchor-recall-truncated` to `gaps`. This is an
abstention receipt: deeper eligible links may have been omitted, so it is not evidence that no cited memory exists. A
true no-memory result requires resolved anchor coverage and no truncation gap. If
`code-anchor-recall-no-active-memory` appears alongside `code-anchor-recall-truncated`, it means no active match was
found in the examined candidates; the truncation still governs any conclusion about the unexamined prefix.
`coverage.memory.codeAnchors.complete` describes anchor resolution, so always inspect `gaps` separately for recall
completeness.

Context Brief retrieves bounded graph and memory evidence first, then validates citations for the selected
memories. Returned durable decisions and handoffs keep `freshness` beside the memory excerpt and may include
`preciseStatus`, `citationReceipts`, and related entries in `stalenessAndConflicts`. Use JSON or MCP
`structuredContent` to consume those fields; the plain CLI/MCP text remains a terse receipt.

Validation reads only already-ready exact-current repository snapshots. A Workset brief checks citations only in its
configured member paths and does not fan out cold builds. Missing or stale members remain explicit unknown coverage;
run `threadnote workset prepare <name>` yourself when current evidence is required.

The hard bounds are:

- 24 selected memory candidates;
- eight citations per memory;
- 96 citation validations per brief;
- 32 cited repositories;
- validation concurrency of four;
- 1,250 estimated output tokens by default and 1,500 maximum.

Work beyond a bound becomes an explicit `unknown` receipt or output omission, never a repository-wide scan or a
silent freshness claim.

## Existing v1 and uncited memories

Threadnote does not require a citation migration. Schema-v1, schema-v2, schema-v3, and unversioned memories continue
through the normal recall ranking and can appear in Context Brief. They do not receive fabricated precise receipts.

When an uncited memory has a valid `sourceCommit` and exactly one repository snapshot resolves, Context Brief retains
the existing coarse commit comparison. Otherwise its freshness is `unknown`. The memory is still returned; an upgrade
does not turn legacy recall into an empty result.

New and rewritten records use schema v4. Upgrade every writer that may replace a shared cited memory before publishing
schema-v4 citations: an older writer does not understand the repeated `code_citation` header and may drop it while
reformatting the record.

## Replacement and candidate review

Citation evidence is bound to the prose that was reviewed:

- replacement with `codeRefs` or `--code-ref` captures new evidence;
- replacement without code references clears old citations and reports `clearedCodeCitations` or a CLI message;
- citations are never silently inherited across edited prose;
- `review_session_context` captures optional `codeRefs` at review time;
- an approved candidate keeps those reviewed immutable citations rather than recapturing them during approval.

Read the old memory and current source before replacing a stale claim. Threadnote does not automatically repair a
relocated link or rewrite natural-language memory.

## Sharing restrictions

Code citations are preserved across a supported sharing boundary; Threadnote never silently strips them. A cited
memory is publishable only when all citations:

- were captured from clean committed source;
- use a portable remote repository identity; and
- contain valid canonical metadata.

Dirty-worktree, local-only, or malformed citations block publishing. Commit the cited source and recapture before
sharing. The ordinary content scrubber, preview, confirmation, and active-durable-only rules still apply. See
[Team sharing](share.md).

## Optional telemetry

Anonymous telemetry remains disabled by default and requires explicit consent for schema v5. A successful Context
Brief may report only closed local/workset scope, phase timings, validation coverage/result classes, a closed unknown
reason, output truncation, and power-of-two count buckets. It never exports memory text or identity, citation IDs,
tasks, paths, symbols, repository or Workset identity, commits, snapshots, hashes, exact private counts, or raw errors.
Failed and interrupted briefs do not emit result-derived citation classifications.

Telemetry can diagnose latency, coverage, abstention, and warning trends; it cannot prove citation correctness or the
absence of stale memory. See [Optional anonymous telemetry](telemetry.md).
