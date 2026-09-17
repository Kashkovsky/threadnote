# Threadnote 5 context workflows

Threadnote 5 is a source-verifiable context compiler for engineering work. Its core loop is deliberately small:

1. An agent starts with a bounded Context Brief and cited current-code evidence.
2. At task closeout, the session produces a reviewable Knowledge Delta.
3. A person approves, edits, defers, or rejects each proposed change.
4. Context health and Context Check make stale or conflicting knowledge visible before it misleads another task.
5. Verified procedures provide reviewed workflows alongside factual decisions.

This release track is local-first and provider-neutral. It does not create an organization account, require an
organization service, or add agent-brand switches. Organization productization and agent-surface setup/projection are
separate tracks.

## Closeout and Knowledge Delta

The existing MCP tools remain the compatibility surface: `review_session_context` creates a review and
`apply_memory_candidates` applies one explicit decision. Their structured results now include a bounded
`KnowledgeDeltaV1` projection. It contains at most three items and identifies the item type, source evidence,
comparison reason, confidence, proposed destination, recommendation, and exact mutation preview.

The local CLI exposes the same review state:

```sh
threadnote closeout preview --review-id <review-id>
threadnote closeout preview --review-id <review-id> --json
threadnote closeout apply \
  --review-id <review-id> \
  --revision <revision> \
  --candidate-id <candidate-id> \
  --action approve \
  --operation create \
  --approved
```

Preview is read-only. Apply is revision-checked and requires an explicit action; approving a write additionally
requires `--approved`. Use `--edited-text` to approve an edited proposal and `--replace-uri` when replacing an existing
memory. A Knowledge Delta is not an unconditional memory write: keep personal handoffs local, and publish shared
durable knowledge only through the existing reviewed Git share workflow.

## Context health

Inspect active records in one project with the read-only health command:

```sh
threadnote context health --project <project>
threadnote context health --project <project> --json
```

Agents using the full MCP toolset can request the same bounded report with `context_health`, passing the project and
an absolute `callerCwd`. The MCP adapter is read-only and does not prepare a graph or record a local value event.

The `ContextHealthReportV1` planner reports expired validity, overdue `review_after`, changed/missing/unknown code
citations, missing or inactive relation targets, exact duplicates, and contradictions or possible duplicates in pending
candidates. Severity, confidence, and repairability are separate fields. Findings are deterministic and bounded.

Health proposes reviewable repairs; it never silently archives, deletes, overwrites, or renews a record. Unknown code
coverage remains unknown rather than being presented as current. Shared records remain read-only until the user enters
the existing conflict or publish workflow.

## Context Check

Run the provider-neutral, read-only check for one project. `--base` is optional and selects the comparison base:

```sh
threadnote context check --project <name>
threadnote context check --project <name> --base <ref> --format json
threadnote context check --project <name> --base <ref> --format sarif
```

The versioned `ContextCheckReportV1` projection filters a health report to memories directly cited by changed tracked
or untracked paths. Deletions and renames include their source paths. The check does not claim transitive coverage of
callers, dependants, or other graph-related files. It has stable finding fingerprints and JSON/SARIF projections. Its
exit classes are:

| Exit | Meaning                                                   |
| ---: | --------------------------------------------------------- |
|  `0` | No actionable finding and complete evidence               |
|  `1` | An affected, actionable finding exists                    |
|  `2` | Invocation is invalid or required evidence is unavailable |

JSON contains categories, severities, repairability, and stable fingerprints; SARIF carries stable rule IDs, levels, and
fingerprints. Neither format contains memory bodies, source fragments, paths, queries, or repository identities. Do not
treat a partial or unavailable evidence result as a clean check.

See [Context CI](context-ci.md) for the provider-neutral job pattern and a minimal GitHub Actions example.

## Value report

The local value report is count-only and works independently of telemetry:

```sh
threadnote value report
threadnote value report --project <project> --period 14 --json
threadnote value report export --project <project> --period 14
threadnote value report export --project <project> --period 14 --apply
```

`ValueReportV1` summarizes a bounded period of Context Brief attempts, code-anchor coverage, estimated tokens,
follow-up operations, recall feedback, Knowledge Delta outcomes, health activity, and setup/reuse counters. Project
filtering affects local aggregation only; the project label is not emitted in the report. The report has `scope: local`.

A fresh successful `agents install <surface> --apply` contributes one setup completion. Installing a second distinct
supported surface also contributes one reuse count. Preview, failed, repair, remove, and idempotent reinstall
operations do not count, and the local value ledger stores no surface identifier.

No query text, memory text, source code, paths, repository names, stable user ID, or raw logs are part of this report.
Telemetry remains separately disabled by default and follows the consent contract in [Optional anonymous telemetry](telemetry.md).

`value report export` prints the exact closed `threadnote.value-report-export.v1` design-partner bundle by default and
writes nothing. `--apply` stores the same bounded field set as a private, content-addressed JSON file under
`$THREADNOTE_HOME/exports/value-reports/` and prints its local path. The bundle wraps only `ValueReportV1` aggregate
fields plus its export schema, type, and version; project filters affect selection but never appear in its content or
filename.

## Memory schema v5 maintenance metadata

Memory documents may now carry two optional maintenance fields:

```yaml
owner: platform-team
review_after: 2026-12-31
```

`owner` is an opaque person or team label, not an organization identity. `review_after` is an ISO calendar date. The
fields support health triage; they do not change authority, lifecycle, relation, or code-citation semantics. Existing
v4 memories remain readable and can be migrated deterministically to v5 without inventing either field. Review or
retire records explicitly; Threadnote does not silently renew stale knowledge.

## Verified procedures

Procedures remain versioned shared artifacts, not a new memory kind. A manifest records an artifact ID and semantic
version, SHA-256, compatible capability/surface IDs, owner and review date, dependencies, verification commands or
fixtures, and related durable memory IDs. A successful receipt binds verification to the exact manifest hash.

Verify an author-selected local manifest with a preview by default:

```sh
threadnote procedure verify <manifest> --json
threadnote procedure verify <manifest> --apply --artifact <file> \
  --fixture smoke=fixtures/smoke \
  --fixture integration=fixtures/integration
threadnote procedure verify <manifest> --apply --artifact <file> --dry-run
```

Execution requires both `--apply` and `--artifact <file>`. `--fixture id=path` may be repeated. `--preview` or
`--dry-run` overrides `--apply`, so those modes never execute commands or write. Verification is bounded and local;
downloaded or otherwise untrusted procedures are never executed automatically.

Inspect status without mutation:

```sh
threadnote procedure status <manifest> --artifact <file>
threadnote procedure status <manifest> --artifact <file> \
  --receipt <receipt.json> --surface <surface-id> --capability <capability-id> \
  --available-manifest <newer-manifest> --json
```

Status is read-only and reports `current`, `incompatible`, `locally-modified`, `unverified`, or `update-available`.
Update detection is explicit and local: pass a separately acquired manifest with `--available-manifest`; status never
downloads or executes it.
Procedure publication is intentionally absent until the source bytes are cryptographically bound to the verified
manifest and receipt. Use the existing reviewed artifact/share workflow only after that trust contract is available;
do not infer publication support from a successful local verification.

## Trust boundary

The canonical source remains local files and the user-configured Git share. Previews describe exact proposed bytes but
do not mutate canonical memory. Applies are guarded by optimistic revisions and content preconditions. Sharing keeps
the personal source until scrub, verification, commit, and push succeed; credentials, customer data, local paths, and
raw production logs must never be stored in memory or exported. These workflows do not replace repository review,
CODEOWNERS policy, or human judgment about whether a cited interpretation is correct.
