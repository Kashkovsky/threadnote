# Threadnote 4.0 model candidate results

These compact, checked-in summaries compare native `node-llama-cpp` pipelines with the immutable Threadnote 3.0.3
recall-v2 baseline. Full per-query artifacts and downloaded GGUF files remain untracked under `.artifacts/`.

Run date: 2026-07-27
Fixture SHA-256: `3967acf33893251f03126720ebf6fb55f6b6eed62f2c84f768963e9a352e9348`

| Pipeline                                 | Aggregate MRR | Recall@10 | Semantic-category MRR | No-answer recall | Gate      |
| ---------------------------------------- | ------------: | --------: | --------------------: | ---------------: | --------- |
| 3.0.3 lexical baseline                   |        0.8704 |    0.9156 |                0.2400 |           1.0000 | reference |
| BGE-small-en-v1.5 Q8                     |        0.9177 |    1.0000 |                0.6997 |           0.0000 | failed    |
| BGE-small-en-v1.5 Q8 + Jina reranker F16 |        0.9172 |    1.0000 |                0.6947 |           0.0000 | failed    |

The embedding candidate produces strong semantic uplift, but it turns every explicit no-answer query into an
answerable result. The tested reranker does not recover that safety regression and does not improve semantic ranking.
Both runs also emit tokenizer round-trip warnings from `node-llama-cpp`; the Jina model emits a pooling-type warning.

No embedding or reranker is selected as a 4.0 default from these results. Lexical recall remains the safe default until
a candidate passes every category and safety gate. Reproduce a candidate with:

```sh
npm run eval:recall:models -- \
  --embedding bge-small-en-v1.5-q8 \
  --reranker jina-reranker-v1-turbo-en-f16 \
  --home .artifacts/model-bakeoff-home \
  --fail-on-regression
```
