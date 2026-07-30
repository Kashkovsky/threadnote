# ADR 017: Native code graph authority and snapshots

Status: accepted for implementation
Date: 2026-07-29

## Decision

Threadnote will implement code relationships as a local, disposable derived index under
`~/.threadnote/indexes/code-graph/`. Repository files, Git objects, and canonical Threadnote resources remain
authoritative. Graph storage does not participate in memory sharing and can always be deleted and rebuilt.

One local Git checkout (the resolved common Git directory) owns one SQLite graph database. Credential-free repository
identity remains part of every snapshot, while checkout-local storage prevents independent clones of the same remote
from garbage-collecting each other's active state. Linked worktrees reuse an immutable committed snapshot. Staged,
unstaged, deleted, renamed, and eligible untracked files are stored as worktree-scoped deltas with explicit deletion
markers; one worktree can never select another worktree's mutable overlay.

Committed inventory streams from Git tree and blob plumbing. Overlay inventory comes from Git status plus
boundary-checked worktree reads. Threadnote does not recursively walk a repository looking for source. Hidden
directories, ignored/generated/vendor/cache paths, oversized files, symbolic links, submodule contents, and unsupported
or binary files are rejected before parsing.

Parsed file facts are content-addressed and reusable. Uncached source is read, parsed, and committed to the disposable
parser cache in bounded batches; ordinary source text is released after each batch and is never retained until graph
activation. Package and TypeScript configuration is reduced to bounded resolution metadata before its source text is
released. Aggregate eligible source bytes are therefore not a repository admission limit. Safety remains enforced by
individual-file, eligible-file, retained-resolution-metadata, symbol, edge, lexical-term, command-output, and
per-command elapsed-time budgets. Completed parser-cache batches are reusable checkpoints after interruption.
Snapshot-dependent symbol resolution remains separate.
Deterministic graph snapshots are staged, revalidated, then promoted transactionally. Incomplete or failed builds never
replace the latest ready snapshot, and bounded reader leases keep selected snapshots alive without serializing queries
behind the writer lock. Dirty activation stages complete current rows in bounded batches and derives overrides and
deletions with indexed SQL joins, so a one-file edit does not issue one comparison query per symbol or edge. A short
process-aware registration lease plus maintenance intent prevents repair or purge from racing repository-root creation
without holding a reader marker while an index request waits for the repository lock. Vector generations are optional,
immutable, checksummed derived data associated with a ready snapshot only after verification; verified decoded
generations are held in a small process-local cache and vector failure leaves exact and lexical graph search available.
Vector projection is deterministically capped at 20,000 high-value symbols and is scale-gated with the pinned production
embedding model and a lexical-disjoint semantic positive control.

Every relationship records evidence and exactly one authority tier:

- `declared`: manifest or project-reference fact;
- `resolved`: compiler- or validated-index-resolved relationship;
- `syntactic`: AST relationship whose target is not semantically proven;
- `heuristic`: explicit convention with reduced authority;
- `model`: semantic association only.

Local AI cannot create `declared`, `resolved`, or `syntactic` edges. Unsupported language or resolution coverage is
reported rather than guessed. Bare identifiers are promoted to resolved relationships only when lexical binding and
module resolution prove the target; local shadowing remains syntactic evidence.

Normal users and agents do not run an indexing setup workflow. The first graph inspection builds a snapshot lazily.
Within MCP, `query` and `explain` prefer bounded latency and may briefly return the latest ready snapshot with explicit
stale metadata while the session watcher catches up; `path` and `impact` require a current snapshot. One-shot CLI graph
queries synchronously refresh stale snapshots because they have no persistent session scope. The first MCP graph
inspection starts one deduplicated, scoped watcher for that worktree; it is interrupted when the MCP process exits.
The optional foreground CLI watcher provides the same debounced incremental indexing and periodic reconciliation.
Memory/resource recall never invokes code-graph indexing or retrieval.

## Query contract

Graph retrieval uses exact/lexical and optional vector seeds followed by relation-aware bounded traversal. Every
operation has node, edge, depth, fan-out, elapsed-time, and output limits. Hub penalties keep ubiquitous utilities from
flooding results. Returned evidence includes repository, commit, dirty-overlay state, relative source path and line,
provenance, confidence, and freshness.

`recall_context` remains exclusively responsible for memories and seeded resources. A separate
`inspect_code_graph` MCP tool provides `query`, `explain`, `path`, and `impact` over current source; impact accepts
either an explicit symbol/path query or a Git base ref whose changed paths become the impact seeds. Agents may
explicitly call both tools and combine their evidence, but neither subsystem changes the other's no-answer or
freshness contract. CLI commands provide status, forced indexing, the same graph queries, foreground watch, explicit
export, purge, doctor, and repair.

## Evaluation contract

The reviewed `code-graph-v1` fixture and compact baselines are release inputs. Global and per-category quality,
no-answer behavior, authoritative false-edge rate, worktree/commit/repository isolation, interruption safety, and
existing recall-v2 metrics are cumulative gates. Performance budgets cover cold index, one-file incremental update,
hot query, dirty overlay, peak RSS, and disk at reviewed scale points.

Graphify is an external Phase 0 comparison only. Its output may be summarized in a checked baseline, but Threadnote
production, tests, install, update, repair, and release artifacts must not invoke or contain Graphify or Python.

## Consequences

- Worktrees share immutable facts without copying mutable graph directories.
- Git object identity, not checkout location or file timestamps, defines committed freshness.
- SQLite schema changes rebuild derived data rather than migrate canonical content.
- TypeScript/JavaScript and manifest support can ship honestly before full polyglot semantics.
- Exact/lexical graph retrieval remains deterministic when models are unavailable.
- A graph can be purged or disabled without changing memories, resources, Git repositories, or model files.
