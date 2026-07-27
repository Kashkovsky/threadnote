# ADR 014: Native canonical storage and derived indexes

Status: accepted for 4.0
Date: 2026-07-27

## Decision

Threadnote owns canonical resource bytes under `~/.threadnote/data/viking/` and preserves stable `viking://`
identifiers. The implementation is an Effect `ResourceStore` service over ordinary files. It validates portable
segments and containment, rejects escaping links, serializes writers with heartbeat locks, supports compare-and-swap,
and commits same-directory temporary files with atomic rename.

Lexical and vector indexes are derived, disposable generations under `~/.threadnote/indexes/`. Vector sidecars use
packed normalized `Float32` data, immutable model/chunker metadata, per-entry fingerprints, and a checksummed active
pointer. Rebuilds reuse unchanged chunks, checkpoint batches, resume compatible staging, and activate only a complete
generation.

SQLite and a vector extension are not canonical dependencies. They add native distribution and migration surfaces
without improving the append/read/replace workload enough to justify them. The packed exact-scan index is simpler and
measured for the current bounded corpus. A future approximate index may replace only the derived search service.

## Options evaluated

| Option                                                        | Strengths                                                                                                         | Why it is not the 4.0 default                                                                                                                                                                                                 |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Threadnote files + packed `Float32` sidecar                   | No extra runtime, canonical Markdown stays inspectable, exact results, trivial rebuild and atomic generation swap | Chosen. At 384 dimensions, 10,000 vectors occupy about 15.4 MB before metadata, inside the measured exact-scan budget.                                                                                                        |
| SQLite + [`sqlite-vec`](https://alexgarcia.xyz/sqlite-vec/)   | Familiar transactions and SQL metadata joins; Node and precompiled extension packages exist                       | `sqlite-vec` is pre-v1 and currently uses brute-force vector search, so it adds an extension/SQLite binary matrix without changing the 4.0 scaling class.                                                                     |
| [`libSQL`](https://docs.turso.tech/libsql)                    | Production SQLite fork with a native vector type and DiskANN available for larger sets                            | A second native database runtime and schema migration surface are unnecessary while exact scan meets the 10k budget. It remains the strongest embedded candidate if measured scale or concurrent updates outgrow the sidecar. |
| [`LanceDB`](https://docs.lancedb.com/quickstart)              | In-process TypeScript client, columnar storage, mature vector-oriented query path                                 | Its database and native columnar runtime are substantially broader than Threadnote's disposable index need; adopting it would not simplify canonical storage.                                                                 |
| [`PGlite`](https://github.com/electric-sql/pglite) + pgvector | Dependency-only WASM Postgres, rich SQL, pgvector support                                                         | A WASM Postgres engine, Postgres data-directory upgrades, and single-connection execution are excessive for one local derived index.                                                                                          |
| External vector service                                       | Independent scaling and mature ANN implementations                                                                | Reintroduces a daemon, port, lifecycle, and availability dependency—the exact class of failure 4.0 removes.                                                                                                                   |

The decision is benchmark-reversible. Re-evaluate the derived index implementation when the checked-in 10k budget
fails on a supported platform, a real corpus crosses the 100k boundary, exact scan becomes a material part of recall
latency, or multi-process index updates cannot meet their reliability budget. The replacement must still leave
canonical Markdown and `viking://` identifiers untouched.

## Consequences

- Canonical content is inspectable, recoverable, and independent of an index implementation.
- Clean install has no database server or extra native addon.
- Multi-process safety and crash consistency are explicit Threadnote contracts.
- Index format changes can rebuild without migrating canonical data.
