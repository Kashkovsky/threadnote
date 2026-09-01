# Hosted Windows native query quantile calibration

The exact release candidate `1ce43969b08a772cb19e712eb71d7d34c38b7b66` failed the native Windows query
gate in workflow run `33460824382`, job `99710382411`, artifact `9783169868`. Its 25-sample hot-query wall
p50/p95/max were 752.8591/1,325.9255/1,488.6307 ms. The p50 exceeded the unchanged 750 ms guard by only 2.8591 ms
(0.381%), while p95 exceeded the unchanged 1,000 ms guard by 325.9255 ms. The existing 5% p95 wall allowance raises
the effective boundary only to 1,050 ms, which this observation still exceeded by 275.9255 ms. Process-CPU
p50/p95/max remained 218/296/298 ms against the independent unchanged 500 ms CPU-p95 guard.

This is not source-level regression evidence. The immediately preceding observation at
`a4969ac636e905ea4cb6f03529ff2a132c5d5eb5` has the exact same Git tree
`b4a5f22dbe90284d4ec6c7da7a216be4f1627ad3`; workflow run `33459952495`, job `99707838865`, artifact
`9782882422` passed with wall p50/p95/max 459.933/506.1142/523.1797 ms and CPU p95 234 ms. Across that observation
and the five preceding normalized hosted Windows native observations, wall p50 ranged 360.6885–523.9516 ms, wall p95
ranged 377.8–883.9018 ms, and CPU p95 ranged 218–266 ms. One of those controls retained a 4,640.2379 ms maximum yet
still had a 592.0333 ms p95, demonstrating how a single hosted pause can be present without defining the distribution.

The correction increases only the GitHub-hosted Windows x64 native query sample count from 25 to 100. Threadnote's
production percentile convention selects zero-based index `floor(sampleCount * 0.95)`: the second-highest observation
at 25 samples, excluding one upper-order value, and rank 96 at 100 samples, excluding four. A fifth slow query therefore
fails p95; sustained latency still fails the unchanged median, and computational regression still fails the unchanged
CPU guard. Linux, macOS, local Windows, every latency limit, and the existing 5% guarded Windows native p95 allowance
remain unchanged.

The same exact candidate also passed a separate 100-sample 10k fixture in job `99710382464`, artifact `9783228149`,
with wall p50/p95/max 374.4869/426.8328/495.2508 ms and CPU p95 281 ms. This supports the measurement method only: it
used a different generated fixture and runner, so it is not prospective native-gate evidence. The replacement release
candidate must pass the native 100-sample hosted Windows lane before admission.

The failed native archive digest is
`sha256:d7803cbe24e19bc38b18458be06d247f4685fca2a97f1cc4736118f7119b3c05`; its raw JSON digest is
`sha256:eb2a535dd1c60335202b52db7a6fc819c5612108809961c8cde7de92c45b7949`. The identical-tree control archive
digest is `sha256:8b61d95aed8c68cf5b45489df84cb9683d9bde1a9e003c8e629ac786fa91156a`; its raw JSON digest is
`sha256:eadde585d3be9103f6e2776d914d8abf64e4e0b1cc1b6de13c1c8e26a17fab4a`.
