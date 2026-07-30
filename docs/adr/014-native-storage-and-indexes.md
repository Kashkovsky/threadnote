# ADR 014: Native canonical storage and derived indexes

Status: accepted for 4.0
Date: 2026-07-27

## Decision

Threadnote owns canonical resource bytes under `~/.threadnote/data/` and preserves stable `threadnote://`
identifiers. The implementation is an Effect `ResourceStore` service over ordinary files. It validates portable
segments and containment, rejects escaping links, serializes writers with heartbeat locks, supports compare-and-swap,
and commits same-directory temporary files with atomic rename.

Lexical and vector indexes are derived, disposable data under `~/.threadnote/indexes/`. The lexical index is normalized
SQLite, accessed through the exact-version `@effect/sql-sqlite-bun` adapter over Bun's built-in `bun:sqlite`. It
stores canonical-document metadata once, postings by integer document ID, and document frequency by term. Queries read
only postings and statistics for their terms; refreshes transactionally update only changed documents and affected
terms. WAL, bounded cross-process locks, generation invalidation, and rebuild-on-corruption keep the database
recoverable without making it canonical.

Vectors use normalized `Float32` blobs in a paged SQLite database. Each blob is content-addressed by the embedding
model hash, dimensions, document prompt prefix, normalization recipe, and chunk fingerprint, so generations never copy
unchanged payloads. Lightweight chunk mappings update transactionally only after every required value is present;
failed embedding leaves the active mapping untouched, and interrupted values are reusable on retry. Queries join and
scan bounded row pages directly without decoding or caching the corpus as JavaScript arrays. No SQLite vector
extension is used: exact vector scan remains simpler and meets the checked-in 10k and measured 50k budgets. A future
approximate index may replace only the derived vector-search service.

## Options evaluated

| Option                                                        | Strengths                                                                                   | Decision                                                                                                                                                                                                         |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Effect SQLite lexical + content-addressed `Float32` rows      | Incremental disk-backed postings and paged vectors; no database server or extra addon       | Chosen. SQLite replaces whole-file lexical and vector decoding while transactions preserve active-index availability.                                                                                            |
| SQLite + [`sqlite-vec`](https://alexgarcia.xyz/sqlite-vec/)   | Familiar transactions and SQL metadata joins; Node and precompiled extension packages exist | Not selected. `sqlite-vec` is pre-v1 and currently uses brute-force vector search, so it adds an extension/binary matrix without changing the 4.0 vector scaling class.                                          |
| [`libSQL`](https://docs.turso.tech/libsql)                    | Production SQLite fork with a native vector type and DiskANN available for larger sets      | Not selected. A second native database runtime and schema migration surface are unnecessary while paged exact scan meets the measured budget. It remains the strongest embedded candidate if scale requires ANN. |
| [`LanceDB`](https://docs.lancedb.com/quickstart)              | In-process TypeScript client, columnar storage, mature vector-oriented query path           | Not selected. Its database and native columnar runtime are substantially broader than Threadnote's disposable index need; adopting it would not simplify canonical storage.                                      |
| [`PGlite`](https://github.com/electric-sql/pglite) + pgvector | Dependency-only WASM Postgres, rich SQL, pgvector support                                   | Not selected. A WASM Postgres engine, Postgres data-directory upgrades, and single-connection execution are excessive for local derived indexes.                                                                 |
| External vector service                                       | Independent scaling and mature ANN implementations                                          | Rejected. It reintroduces a daemon, port, lifecycle, and availability dependency—the exact class of failure 4.0 removes.                                                                                         |

The decision is benchmark-reversible. Re-evaluate the derived index implementation when the checked-in 10k budget
fails on a supported platform, a real corpus crosses the 100k boundary, exact scan becomes a material part of recall
latency, or multi-process index updates cannot meet their reliability budget. The replacement must still leave
canonical Markdown and `threadnote://` identifiers untouched.

## Consequences

- Canonical content is inspectable, recoverable, and independent of an index implementation.
- Clean install has no database server or SQLite extension/native addon beyond the embedded Bun runtime.
- Multi-process safety and crash consistency are explicit Threadnote contracts.
- Index format changes can rebuild without migrating canonical data.
