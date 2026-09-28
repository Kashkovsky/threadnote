# Threadnote 4.2.7 hybrid-v6 rank-performance candidate

These four artifacts compare the memory-recall implementation at clean commit
`02b8ff90c57962cc9745f0a52e10759fefcf3664` (`hybrid-v6`) with the reviewed clean `hybrid-v3` performance reference at
`6f090189249de0a95c24d3084946f1a94360653e`. Both runs used the same Apple M1 Max with 64 GiB RAM, macOS 27.0, Bun
1.3.14, fixture hashes, seed, query count, warmups, and samples.

| Documents | hybrid-v3 p95 | hybrid-v6 p95 | Ratio | hybrid-v3 RSS p95 | hybrid-v6 RSS p95 |
| --------: | ------------: | ------------: | ----: | ----------------: | ----------------: |
|       200 |     14.927 ms |     14.722 ms | 0.986 |        245.97 MiB |        252.41 MiB |
|     1,000 |     74.478 ms |     74.078 ms | 0.995 |        364.47 MiB |        286.33 MiB |
|    10,000 |    696.264 ms |    696.264 ms | 1.000 |        653.05 MiB |        494.78 MiB |
|   100,000 |  6,839.008 ms |  6,846.851 ms | 1.001 |      2,475.89 MiB |      2,115.08 MiB |

The candidate is latency-non-inferior on this matched host: the largest p95 change is +0.11% at 100k, while p95 RSS
falls materially at 1k, 10k, and 100k. These are same-host observations, not universal timing thresholds. The frozen
`hybrid-v3` files remain the pre-change base; these candidate artifacts do not replace them.
