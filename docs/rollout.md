# Recall and 4.0 rollout gates

Release gates are cumulative:

1. Frozen 3.0.3 recall-v2 and M1 Max performance artifacts remain immutable historical evidence; the active lexical
   quality gate is the reviewed clean-commit Threadnote 4.2.7 baseline.
2. Unit, integration, type, lint, formatting, coverage, build, and package-content checks pass.
3. Global and per-category recall non-inferiority pass with no safety regression, no new reviewed contract-failure
   identity, and no increase in the current failure count.
4. Clean install and core recall pass on Linux, macOS, and Windows without an interpreter or daemon.
5. Migration fault-injection covers interruption, insufficient space, unsafe links, source mutation, unrelated target,
   idempotence, and preserved rollback source.
6. Model bake-off artifacts record exact revisions, hashes, hardware, latency, memory, and recall deltas.
7. Package scans prove no legacy executable, server config, interpreter bootstrap, or raw native-addon consumer ships.

Embedding and reranker defaults are selected only from checked-in reviewed bake-off summaries. The measured 36.7 MB
BGE Small model is installed and selected automatically because semantic recall is core functionality. Additional
embedding candidates, rerankers, and generation models remain explicit choices. Lexical recall is the deterministic
fail-open path when native inference is temporarily unavailable.

Rollback never deletes canonical data. Disable model selection or purge a derived index first. For a migration issue,
point the previous release at the preserved legacy home while the 4.0 target is investigated.
