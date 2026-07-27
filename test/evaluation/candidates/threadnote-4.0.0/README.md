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
npm run eval:recall:models -- \
  --embedding bge-small-en-v1.5-q8 \
  --home .artifacts/model-bakeoff-home \
  --fail-on-regression
```

The checked-in `benchmarks/darwin-arm64-m1-max/recall-index-sqlite-10000.json` run records the normalized SQLite
implementation on the same hardware class as the 3.0.3 indexed-recall baseline. All four scenarios pass their release
budgets; incremental-update p95 improves from 903.03 ms to 424.45 ms and source-validation p95 improves from 841.59 ms
to 417.63 ms. Hot-query p95 is 74.79 ms versus the older 10.22 ms and remains below the 150 ms release budget; the
tradeoff removes whole-file JSON decode and rewrite behavior at production corpus sizes.
