# Hosted Windows 10k p95 sample calibration

The first prospective 25-sample validation of the hosted Windows 10k policy failed on exact candidate
`9126348fdce549b54036223f667efb24c4cfc123`: retained workflow run `33454986359`, job `99692956963`, artifact
`9781216114`. Outer wall p50/p95/max were 427.4689/1,776.0348/3,056.9098 ms, while process-CPU p50/p95 were only
219/298 ms. The independently timed exact-ready status-plus-query path stayed at 376.9342/431.6705/452.1237 ms
wall p50/p95/max and 235 ms CPU p95. The outer wall p95 was therefore 5.96 times CPU p95 and 4.11 times the
same-run exact-ready wall p95 without corresponding work or orchestration growth.

This is scheduler delay, but raising the 1,200 ms wall ceiling again would turn one unbounded hosted pause into the
definition of acceptable product latency. The threshold, 750 ms median companion, 500 ms CPU-p95 companion, and zero
additional tolerance therefore remain unchanged. The correction is statistical: the workflow now measures 100 real
queries. With 25 observations, Threadnote's production percentile convention selects the second-highest value and
excludes only one upper-order sample; with 100, it selects rank 96 and excludes four. A fifth wall breach fails, while
sustained latency still fails the median and actual work still fails the CPU guard. This is a bounded empirical p95,
not a trimmed or rewritten artifact; the benchmark continues to retain the raw summary unchanged.

The retained archive digest is
`sha256:f4e848cc1c54f7bdae556cd0150de91a5e91931b2dc2277b910fd89d87cea29b`; the primary JSON payload digest is
`sha256:1319ad4f10308a604470300c79e58113ed41793ea211cba22f94b1909b0751bc`. A replacement candidate must pass the
100-sample policy prospectively on the normalized `github-hosted-windows-x64` runner class. Linux and macOS use the
same 100-sample workflow observation but retain their tighter 1,000 ms scale ceiling.
