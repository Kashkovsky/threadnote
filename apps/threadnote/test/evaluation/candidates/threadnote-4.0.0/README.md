# Threadnote 4.0 model candidate results

These compact, checked-in summaries compare native `node-llama-cpp` pipelines with the immutable Threadnote 3.0.3
recall-v2 baseline. Full per-query artifacts and downloaded GGUF files remain untracked under `.artifacts/`.

Run date: 2026-07-27
Fixture SHA-256: `3967acf33893251f03126720ebf6fb55f6b6eed62f2c84f768963e9a352e9348`

| Pipeline                                 | Aggregate MRR | Recall@10 | Semantic-category MRR | No-answer recall | Gate      |
| ---------------------------------------- | ------------: | --------: | --------------------: | ---------------: | --------- |
| 3.0.3 lexical baseline                   |        0.8704 |    0.9156 |                0.2400 |           1.0000 | reference |
| BGE-small-en-v1.5 Q8                     |        0.9244 |    1.0000 |                0.6997 |           1.0000 | passed    |
| BGE-small-en-v1.5 Q8 + Jina reranker F16 |        0.9239 |    1.0000 |                0.6947 |           0.0000 | failed    |

The BGE embedding candidate now passes every category and safety gate after calibrating the semantic-only no-answer
boundary against the frozen fixture and preserving explicit graph paths when semantic seeds overlap them. It is the
Threadnote 4 core embedding model and is installed and selected automatically.

The tested Jina reranker still turns every explicit no-answer query into an answerable result and does not improve
semantic ranking, so it remains unselected. Reproduce the selected core pipeline with:

```sh
bun run eval:recall:models -- \
  --baseline test/evaluation/baselines/threadnote-3.0.3/recall-v2-lexical.json \
  --embedding bge-small-en-v1.5-q8 \
  --home .artifacts/model-bakeoff-home \
  --fail-on-regression
```

The explicit historical baseline is required to reproduce these 4.0 summaries; new model evaluations default to the
reviewed Threadnote 4.2.7 lexical baseline.

The checked-in `benchmarks/darwin-arm64-m1-max/recall-index-sqlite-10000.json` run records lexical schema v3 on the same
hardware class as the 3.0.3 indexed-recall baseline. Incremental-update p95 is 229.81 ms, source-validation p95 is
256.97 ms, hot-query p95 is 48.42 ms, exact-substring p95 is 3.56 ms, and exact-no-hit p95 is 3.22 ms. Every scenario
passes its release budget without rereading the canonical corpus for exact matching.

`recall-vector-storage-sqlite-v2.json` records the content-addressed paged vector store at 10k and 50k documents. At
50k, semantic query p95 is 195.38 ms, a one-document update reuses 49,999 vectors and grows the database by 4 KiB, and
initial construction peaks at 401.6 MB. The retired packed sidecar needed 3.35 s for a cold decode/search and peaked at
1.15 GB
during construction. The SQLite design intentionally accepts a slower initial build and 52.6% more derived disk space
for bounded memory, atomic availability, and fast incremental/cold-query behavior.

`code-graph-performance-audit-2026-07-30.json` preserves the matched 10k and 100k graph runs before and after the
set-based activation/resolution work. At 100k symbols, cold indexing falls from 133.36 s to 36.29 s and a one-file
incremental update falls from 127.70 s to 24.99 s.

`code-graph-intellij-query-2026-08-01.json` is development evidence from a dirty Threadnote worktree, not release
evidence. It records real CLI and MCP reads against a pinned public IntelliJ Community snapshot with 2.67 million
symbols and 7.34 million relationships. Indexed hot search plus adjacency falls from more than a minute to about 44
ms, the complete exact-current CLI query is 4.66 s, and Java, Kotlin, TypeScript, and Bazel/Starlark MCP queries remain
inside the 24 KiB structured response budget. The artifact reports Git freshness observation separately from SQLite
query time so neither number hides the other. Release claims must use a clean, harness-validated artifact instead.

The development-only [IntelliJ persisted analysis-summary benchmark](benchmarks/darwin-arm64-m1-max/code-graph-intellij-analysis-summary-2026-08-01.json)
uses the same public snapshot to preserve the whole-graph statistics comparison. It also records a dirty Threadnote
worktree and is not release evidence. The bounded legacy fallback took 48–53 s, while the compact persisted summary
answers the analysis portion in 6–7 ms; exact-current CLI runs take 3.91–3.99 s including Git observation and process
startup. Its one-time legacy backfill took approximately 20 s and added exactly 45,056 durable database bytes.

`embedding-backend-compatibility.json` records the Darwin arm64 BGE comparison used to preserve existing vector
generations when switching the built-in model to `gpuLayers=0`. Across 35 frozen recall/code-graph texts, the minimum
same-text cosine was 0.999879, the largest mixed-backend query/document score delta was 0.002503, and all 12 query
top-1 results agreed. The runtime policy therefore does not participate in the embedding-space recipe; model,
dimensions, normalization, and prompt changes still invalidate stored vectors.
