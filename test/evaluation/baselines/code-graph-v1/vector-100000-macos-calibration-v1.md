# Hosted 100k vector cold-index calibration

The original 900-second budget predated the fixed-class hosted macOS ARM64 100k vector lane and had no retained
runner evidence. The first authoritative execution of that lane, workflow run `33438134814` at candidate
`4cf4c966cf272a3cb066db29750a415766ec5954`, completed the graph correctly but failed its sole cold-index observation:
1,194,863.914166 milliseconds against 900,000 milliseconds.

This is capacity evidence, not a retroactive passing release result. The failed candidate remains failed. The next
candidate must pass the recalibrated gate in one new authoritative workflow execution.

The observation ran on the required GitHub-hosted macOS ARM64 class with an Apple M1 virtual CPU, three reported CPU
math cores, two effective embedding contexts, no GPU layers, and the pinned `bge-small-en-v1.5-q8` model. Vector
generation consumed 1,120,743.251458 milliseconds of the 1,194,863.914166-millisecond cold index. The independent fresh
same-overlay rebuild took 1,257,493.159208 milliseconds and reproduced the expected structural digest. Incremental
indexing, materialization, semantic query, structural analysis, RSS, disk, external sampling, and parity guards all
passed their existing ceilings. The external process observer retained 4,156 cold, 152 incremental, and 4,352
same-overlay samples with zero failures; the incremental and independent same-overlay structural digests were equal.

A retained governed M1 Max context-sweep provides an independent capacity cross-check. Its two-context 10k median was
49,046.387666 milliseconds with eight CPU math cores (`4,4` threads) and 20,206 vector rows. Scaling by the exact
`202,006 / 20,206` vector-row ratio and by the `8 / 3` CPU-capacity ratio predicts 1,307,554.137300 milliseconds on the
hosted three-core runner. The observed 1,194,863.914166 milliseconds was 8.62% faster than that simple model, which
argues against lost parallelism. This is a capacity sanity check across fixed evidence, not a substitute for the
prospective release run.

The v1 calibration is a fixed-runner-class admission envelope, not a percentile estimate or a generic runtime
tolerance. It sets the prospective cold-index ceiling to 10% above the observed cold index, rounded up to the next
50,000 milliseconds:

```text
ceil((1,194,863.914166 * 1.10) / 50,000) * 50,000 = 1,350,000 ms
```

The resulting ceiling is 12.98% above the cold observation and 7.36% above the slower independent full rebuild. No
other performance or correctness budget changes. The 50-minute benchmark-step timeout also remains unchanged. The
privacy-safe JSON projection beside this file retains the exact provenance, runner capacity, governed observations,
and raw artifact digest without repository paths or source content; its unit test re-derives the ceiling and checks the
unchanged guards. One fresh candidate run must pass prospectively. A miss with otherwise healthy guards must stop the
release for controlled multi-run calibration or optimization; it must not trigger another automatic budget increase.
