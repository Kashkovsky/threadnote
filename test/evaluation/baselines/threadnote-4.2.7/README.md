# Threadnote 4.2.7 recall baseline

`recall-v2-lexical.json` is the active reviewed lexical quality baseline. It was captured before ranker changes from
clean commit `297cdb92bd164ed2ea58dd6c366c60c67aba97cf` with package version 4.2.7 and ranker `hybrid-v3`.
The legacy `openVikingVersion` compatibility field is `not-applicable` because this pipeline does not invoke
OpenViking.

The artifact records the exact identities of 193 reviewed contract defects. They remain visible improvement work: CI
allows fixes but rejects any newly introduced failure identity or count increase, and independently gates aggregate,
category, and safety non-inferiority. A strict run without a baseline requires zero defects.

`benchmarks/darwin-arm64-m1-max/` is the current same-host rank-performance reference. Its 200, 1k, and 10k captures
use 5 warmups and 25 samples; the directional 100k scale-boundary capture uses 1 warmup and 5 samples. All four were
captured with `--require-clean` from commit `6f090189249de0a95c24d3084946f1a94360653e` on an Apple M1 Max with 64 GiB
RAM, macOS 27.0, and Bun 1.3.14. That commit adds baseline tooling without changing the released `hybrid-v3` ranker,
so it is the clean pre-change performance reference. The quality artifact retains the exact released source commit
above because its deterministic results do not depend on benchmark-harness timing.

These measurements are hardware-bound observations, not universal latency limits. Compare a candidate on the same
hardware, runtime, fixture hashes, seed, warmups, and sample counts. The frozen Threadnote 3.0.3 files remain immutable
historical evidence.
