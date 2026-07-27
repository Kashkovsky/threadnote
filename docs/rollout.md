# 4.0 rollout

Release gates are cumulative:

1. Frozen 3.0.3 recall-v2 and M1 Max performance baselines remain immutable.
2. Unit, integration, type, lint, formatting, coverage, build, and package-content checks pass.
3. Global and per-category recall non-inferiority pass with no safety or contract regression.
4. Clean install and core recall pass on Linux, macOS, and Windows without an interpreter or daemon.
5. Migration fault-injection covers interruption, insufficient space, unsafe links, source mutation, unrelated target,
   idempotence, and preserved rollback source.
6. Model bake-off artifacts record exact revisions, hashes, hardware, latency, memory, and recall deltas.
7. Package scans prove no legacy executable, server config, interpreter bootstrap, or raw native-addon consumer ships.

Semantic and reranker defaults are selected only from checked-in reviewed bake-off summaries. Models remain an explicit
download even after selection; lexical recall is the zero-download default.

Rollback never deletes canonical data. Disable model selection or purge a derived index first. For a migration issue,
point the previous release at the preserved legacy home while the 4.0 target is investigated.
