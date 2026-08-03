# Threadnote 3.0.3 performance baseline

These compact artifacts preserve the pre-4.0 retrieval baseline. They are observations, not universal latency
thresholds.

The `darwin-arm64-m1-max` run used:

- Apple M1 Max with 64 GiB RAM;
- macOS/Darwin arm64;
- Node 22.22.0 and npm 10.9.4;
- source commit `43773b70c2c1bc01b68917365523a0a5257d00fc`;
- the checked-in Phase 0 harness in a dirty worktree, as recorded by every artifact.

`recall-rank-*.json` measures the deterministic hybrid ranker over complete candidate sets at 200, 1k, 10k, and 100k
documents. The 200/1k/10k points use 5 warmups and 25 samples. The 100k scale-boundary point uses 1 warmup and 5
samples, so its percentiles are directional.

`recall-index-10000.json` preserves the older production-shaped postings-index benchmark: hot query, cold decode,
source validation, and incremental update. The legacy runner did not record p99 or raw samples; that limitation is
part of the baseline.

Never compare latency across unlike hardware as a release gate. New platform classes get their own directory. Full raw
CI output stays in workflow artifacts; checked-in files retain only summaries and environment provenance.
