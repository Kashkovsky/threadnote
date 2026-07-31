# ADR 017: Native code graph authority and snapshots

Status: accepted and implemented
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
directories, ignored/generated/vendor/cache paths, symbolic links, submodule contents, and unsupported or binary files
are rejected before parsing. Eligible tracked source is not rejected because of file or repository size.

Parsed file facts are content-addressed and reusable. Uncached source is read, parsed, and committed to the disposable
parser cache in bounded batches; ordinary source text is released after each batch and is never retained until graph
activation. Package and TypeScript configuration is reduced to compact resolution metadata before its source text is
released. File, byte, symbol, edge, lexical-term, and vector counts are not repository admission or coverage limits.
Fixed-size parser, SQLite, embedding, and output batches bound transient work without truncating the graph. Completed
parser-cache batches are reusable checkpoints after interruption. Snapshot-dependent symbol resolution remains
separate.
Deterministic graph snapshots are staged, revalidated, then promoted transactionally. Incomplete or failed builds never
replace the latest ready snapshot, and bounded reader leases keep selected snapshots alive without serializing queries
behind the writer lock. Dirty activation stages complete current rows in bounded batches and derives overrides and
deletions with indexed SQL joins, so a one-file edit does not issue one comparison query per symbol or edge. A short
process-aware registration lease plus maintenance intent prevents repair or purge from racing repository-root creation
without holding a reader marker while an index request waits for the repository lock. Vector generations are optional
derived data associated with a ready snapshot only after verification. A per-model SQLite database pages candidate
selection, fingerprint reuse, embedding writes, exact scans, and bounded top-k selection; a transaction switches each
worktree pointer only after the complete generation is ready. Vector failure leaves exact and lexical graph search
available. Vector projection includes every eligible high-value symbol and is processed in fixed-size embedding
batches. It is scale-gated with the pinned production embedding model and a lexical-disjoint semantic positive control.

Language support is provided through a generated first-party pack catalog. TypeScript/JavaScript preserves its pinned
compiler-backed extractor. Java, Kotlin, Swift, Bash, C, C++, C#, Dart, Elixir, Go, HCL/Terraform, Julia, Lua,
Objective-C, PHP, PowerShell, Python, Ruby, Rust, Scala, Solidity, Svelte, SystemVerilog/Verilog, Vue, and Zig use
bundled Tree-sitter WASM grammars whose source revision, ABI, version, checksum, and license are verified in source,
standalone packaging, and update validation. Apex, Fortran, and Razor use bounded deterministic text-structural packs
without an AST claim. Packs emit a language-neutral declaration/reference representation and advertise their actual
capabilities; structural coverage is not described as compiler semantics. Maven, Gradle, SwiftPM, Xcode, and existing
package metadata feed a static workspace model; repository build logic is never executed. Java and Kotlin share a JVM
resolution domain, while nested/integrated projects connect only through unique declared dependencies.

Deterministic packs also extract structured schema/configuration declarations and local document-corpus facts. PDFs,
OpenXML, OpenDocument, EPUB, plain-text documentation, notebooks, and text-based diagram formats contribute
extractable text and links. Images, audio, and video retain deterministic asset metadata; visual interpretation, OCR,
transcription, and video/frame analysis are outside this decision. Corpus inputs over 64 MiB remain metadata-only
assets; selected OpenXML, OpenDocument, and EPUB entries have 16 MiB per-entry and 64 MiB cumulative expansion
budgets. These per-artifact extraction budgets do not admit, reject, or truncate a repository graph. Marked rationale
comments and ADR/RFC references become derived rationale nodes with declared `documents` edges to their nearest source
owner.

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
Within MCP, `query`, exact `node`/`neighbors` drill-down, and `explain` prefer bounded latency and may briefly return the
latest ready snapshot with explicit stale metadata while the session watcher catches up. A cold build or stale strict `path`/`impact` operation gets only a
short foreground opportunity; if it is still running, MCP returns structured indexing phase and retry timing while the
deduplicated session refresh continues. One-shot CLI graph queries synchronously refresh stale snapshots because they
have no persistent session scope. Concurrent CLI writers report that another build is active and wait interruptibly;
dead owners are recovered, but repository scale is not converted into a fixed lock-wait failure. The first MCP graph
inspection starts one deduplicated, scoped watcher for that worktree; it is interrupted when the MCP process exits.
The optional foreground CLI watcher provides the same debounced incremental indexing and periodic reconciliation.
Memory/resource recall never invokes code-graph indexing or retrieval.

## Query contract

Graph retrieval uses exact/lexical and optional vector seeds followed by relation-aware bounded traversal. Scoped
inspection has node, edge, depth, fan-out, elapsed-time, and output limits. Hub penalties keep ubiquitous utilities
from flooding results. Returned evidence includes repository, commit, dirty-overlay state, relative source path and
line, provenance, confidence, and freshness.

Whole-graph analysis separately pages the selected SQLite snapshot to compute statistics, weakly connected
components, deterministic structural communities with stable drill-down IDs, bounded structural n-ary groups, hubs or
god nodes, surprising cross-community links, and confidence audits. It has no repository-size admission cap.
Elapsed-time and response-output budgets produce explicit partial-coverage metadata, and complete results suggest
focused follow-up questions. Manager invokes this analysis only on user request. Deterministic Markdown reports and
JSON, GraphML, HTML, and SVG exports are derived, source-sensitive views; streaming output limits do not alter or cap
the stored graph.

`recall_context` remains exclusively responsible for memories and seeded resources. The `inspect_code_graph` MCP tool
provides `query`, exact stable-ID `node` and directional `neighbors` drill-down, `explain`, `path`, and `impact` over
scoped current source; `path` accepts stable IDs as unambiguous endpoints, and impact accepts either an explicit
symbol/path query or a Git base ref whose changed paths become the impact seeds. The separate `analyze_code_graph` MCP
tool provides `stats`, `communities`, `community`, `groups`, `hubs`, `surprises`, `confidence`, and `full`
whole-repository views.
Agents may explicitly call all tools and combine their evidence, but no subsystem changes another's no-answer or
freshness contract. CLI commands provide status, forced indexing, the same inspections and analyses, deterministic
reports, foreground watch, explicit export, purge, doctor, and repair.

## Evaluation contract

The reviewed `code-graph-v1` TypeScript fixture and `code-graph-polyglot-v1` Java/Kotlin/Swift/TypeScript fixture and
compact baselines are release inputs. Global and per-category quality, no-answer behavior, authoritative false-edge
rate, worktree/commit/repository isolation, interruption safety, and existing recall-v2 metrics are cumulative gates.
Performance budgets cover cold index, one-file incremental update, hot query, dirty overlay, peak RSS, and disk at
reviewed scale points.

Graphify is an external Phase 0 comparison only. Its output may be summarized in a checked baseline, but Threadnote
production, tests, install, update, repair, and release artifacts must not invoke or contain Graphify or Python.

## Consequences

- Worktrees share immutable facts without copying mutable graph directories.
- Git object identity, not checkout location or file timestamps, defines committed freshness.
- SQLite schema changes rebuild derived data rather than migrate canonical content.
- TypeScript/JavaScript remains compiler-backed while 25 checksum-verified WASM packs and three bounded
  text-structural packs extend source coverage without external toolchains.
- Local document and media inventory is explicit about extractable text versus metadata-only coverage.
- Whole-graph analysis and portable exports page SQLite without imposing a graph admission cap.
- Exact/lexical graph retrieval remains deterministic when models are unavailable.
- A graph can be purged or disabled without changing memories, resources, Git repositories, or model files.
