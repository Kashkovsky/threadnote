# Threadnote 4 architecture

Threadnote 4 is a self-contained executable with an embedded Bun runtime. Canonical storage, recall indexes, local
inference, sharing, migration, the manager, and MCP all run in the Threadnote process. A normal operation does not
start or contact a separately installed runtime, Python service, memory-platform server, database server, or
background daemon.

## Runtime contract

- Bun `1.3.14` is pinned for builds and embedded into every release executable; users do not install a runtime.
- Release compilation gates cover every base target supported by Bun: macOS arm64/x64, Linux arm64/x64 with glibc and
  musl, and Windows arm64/x64. Shipped local-AI archives are limited to the six targets with a compatible prebuilt
  `node-llama-cpp` payload.
- Bun bytecode compilation, minification, and linked source maps are enabled for standalone executables.
- Each CLI, MCP, or manager process owns one root Effect runtime and one root scope.
- MCP uses stdio. The manager starts a temporary loopback HTTP server only for the foreground manager session.
- `node-llama-cpp` is isolated behind one Threadnote adapter and may load only a compatible prebuilt binary.
  Threadnote does not silently compile llama.cpp or invoke Python.

```mermaid
flowchart TD
    Agents["Codex · Claude Code · Cursor · Copilot"] --> MCP["stdio MCP"]
    CLI["threadnote CLI"] --> Runtime["embedded Bun process<br/>one Effect runtime and scope"]
    MCP --> Runtime
    Manager["foreground manager session"] --> Runtime
    Runtime --> Store["ResourceStore<br/>canonical Markdown"]
    Runtime --> Recall["hybrid recall"]
    Runtime --> CodeGraph["native code graph"]
    Runtime --> Models["LocalModelRuntime<br/>node-llama-cpp"]
    Recall --> Lexical["SQLite lexical index"]
    Recall --> Vectors["packed vector generations"]
    Models --> Vectors
    CodeGraph --> GraphSqlite["per-repository SQLite snapshots"]
    CodeGraph --> GraphVectors["code-symbol vector generations"]
    Models --> GraphVectors
    Store --> Lexical
    Store --> Vectors
```

## Owned home and data authority

`~/.threadnote` is the only runtime-owned home.

| Path                                   | Purpose                                                                          | Authority               |
| -------------------------------------- | -------------------------------------------------------------------------------- | ----------------------- |
| `data/<account>/`                      | Canonical resources, personal memories, and ingested shared memories             | Authoritative           |
| `models/`                              | Verified, immutable GGUF model files and role selection                          | Re-downloadable state   |
| `indexes/lexical/active-v2.sqlite`     | Normalized document metadata, terms, postings, and corpus statistics             | Derived and disposable  |
| `indexes/vectors/<model>/`             | Checksummed active pointer plus immutable packed vector generations              | Derived and disposable  |
| `indexes/code-graph/repositories/`     | Git-snapshot-aware source symbols, relationships, lexical terms, and vectors     | Derived and disposable  |
| `share/`                               | Team configuration and isolated Git worktrees/gitdirs                            | Operational integration |
| `migration/`, `locks/`, `logs/`, `tmp` | Receipts, bounded cross-process coordination, diagnostics, and temporary staging | Operational state       |

Ordinary files and stable `threadnote://` identifiers remain authoritative. SQLite and vector formats may be replaced
or rebuilt without migrating canonical content.

## Recall pipeline

1. Share repositories auto-sync only when their worktrees are clean.
2. The SQLite index returns bounded lexical candidates and corpus statistics without loading a monolithic JSON cache.
3. The automatically installed BGE Small model embeds the query in process. Exact cosine search reads the active
   packed vector generation.
4. The hybrid ranker combines lexical, exact-term, field, semantic, scope, lifecycle, authority, time, graph, feedback,
   and—only when explicitly selected—reranker signals.
5. Confidence and no-answer gates prevent weak semantic-only matches from becoming answers.
6. Recall returns ranked pointers and compact explanations; the agent reads only selected `threadnote://` records.

The 36.7 MB BGE Small embedding model is core functionality. `threadnote install` and `threadnote repair` download,
verify, select, and preserve it automatically. Reranking and structured generation remain optional roles. If native
inference is temporarily unavailable, recall fails open to deterministic lexical results and doctor reports the
missing core capability.

## Native code graph

Code search is a separate concern from memory recall. `recall_context` answers what the team learned, decided, or
handed off from canonical memories and seeded resources. `inspect_code_graph` answers what current source defines,
calls, imports, extends, documents, or may affect. An agent can call both, but graph indexing never runs as a side
effect of recall and graph evidence cannot turn a memory no-answer into an answer.

The graph inventory reads committed files through bounded Git tree/blob plumbing and overlays eligible staged,
unstaged, deleted, renamed, and untracked worktree files after containment and ignore checks. Uncached source is parsed
into the SQLite-backed content-addressed fact cache in bounded batches, and ordinary source text is released before the
next batch. Package and TypeScript configuration is retained only as compact resolution metadata. Repository admission
and graph coverage are not capped by file bytes, file count, resolution metadata, symbols, edges, lexical terms, or
vectors. Fixed-size parser and SQLite batches bound transient work without truncating the stored graph, and completed
parser batches are reusable after interruption. TypeScript/JavaScript, package manifests, Go
manifests, and Markdown have built-in extractors. Every edge identifies its evidence and authority as declared,
resolved, syntactic, heuristic, or model-derived; semantic similarity is never promoted to an authoritative source edge.

Each local Git checkout owns a SQLite graph under
`~/.threadnote/indexes/code-graph/repositories/<checkout-id>/`. Linked worktrees share an immutable commit snapshot;
dirty overlays store only changed facts and deletion markers, while active pointers remain worktree-scoped. Independent
clones of the same remote have separate operational stores. Builds stage, revalidate, and promote transactionally;
dirty activation stages complete current rows in bounded batches and compares them with the immutable base through
indexed SQL joins instead of issuing per-symbol or per-edge comparison queries. One scoped SQLite connection serves all
store calls in a logical query or export. Concurrent readers pin snapshots with bounded leases instead of taking the
writer lock. Repository registration uses a short process-aware maintenance lease and a writer-intent marker so repair
and purge cannot remove a graph being created, without serializing extraction or model work across repositories. Vectors
use immutable checksummed generations, a bounded decoded-generation cache, and fixed-size embedding batches over every
eligible high-value symbol; missing models fail open to indexed SQLite lexical postings.

One Git checkout is one graph scope, including monorepos. Nested package manifests assign symbols to the deepest
containing package, and the most specific matching TypeScript project supplies path aliases. These scopes disambiguate
resolution; they are not graph partitions. A nested app can resolve declared dependencies and imports into the outer
workspace while retaining isolated aliases for its own modules. Unique package names may resolve across `apps/`,
`libs/`, or deeper nested workspaces; duplicate package names remain unresolved rather than creating false edges.
Nested Git repositories and submodules keep separate graph identities and are not traversed from the parent checkout.
`threadnote graph status|index|query|explain|path|impact|watch|export|purge` provides the operator surface. Doctor reports
graph integrity and incomplete builds; repair discards only corrupt derived databases, abandoned snapshots, and
temporary vector files.

The first query builds a graph lazily. Within MCP, later `query` and `explain` calls may return a ready stale snapshot
immediately and disclose that freshness explicitly while the session watcher catches up; `path` and `impact` wait for
a current snapshot. One-shot CLI graph queries synchronously refresh stale snapshots because their application scope
ends with the command. The first MCP graph inspection starts one scoped watcher per worktree for that MCP session.
`graph watch` exposes the same watcher as a foreground CLI command. Both watcher modes subscribe to worktree filesystem
events, ignore hidden-directory noise, debounce bursts, and perform a full Git reconciliation every five minutes to
recover missed events.

## Writes and sharing

Canonical writes validate URI segments and containment, reject escaping links, coordinate writers with bounded
heartbeat locks, and commit same-directory temporary files by atomic rename. Replacement uses compare-and-swap where
the lifecycle contract requires it.

Team sharing is explicit. `share publish` scrubs the candidate, writes and verifies the shared copy, commits and pushes
the team Git worktree, and only then removes the personal source. Personal handoffs and preferences are not
publishable. Recall and read auto-sync clean incoming team changes before searching.

## Migration boundary

Legacy 3.x storage is input to a one-time, non-destructive migration, not a runtime dependency. Migration inventories,
stages, hashes, validates, and promotes canonical content into `~/.threadnote`, then writes a matching receipt. Repair
uses the actual legacy-home and receipt state, so a completed migration is not advertised again even if post-update
prompt bookkeeping is absent. The legacy source remains untouched as a rollback source.

## Effect boundaries

Effect provides capability services, scopes, typed failures, interruption, concurrency, and test substitution. Domain
modules depend on Threadnote-owned ports. Raw filesystem, process, HTTP, digest, SQLite, and native-addon access stays
inside adapters, and tests replace those services with Layers instead of starting hidden local servers.
