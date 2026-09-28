# Hosted Windows 10k query-tail calibration v2

Exact candidate `d828252e711e4cad1fef6961879ba382a41bdbed` failed the generated 10k-symbol Windows lexical
gate twice on workflow run `34310841512` after the 100-sample quantile correction. The linked attempt-2 job
`102350605034`, artifact `10090054843`, reported hot-query wall p50/p95 563.035/2,519.5922 ms over 100 samples
against the 1,200 ms p95 fuse. Process-CPU p50/p95 were 172/281 ms. The same artifact's one-file incremental index
was a single 24,240.1008 ms observation against the 15,000 ms cross-platform ceiling; activation wall was
19,887.2426 ms with a 14,774.7611 ms progress-heartbeat gap, while activation process CPU stayed 500 ms.

Attempt 1 on the same run, job `102337005480`, artifact `10088469240`, failed only the query fuse: wall p50/p95
493.6527/1,857.0263 ms, CPU p95 312 ms, and one-file index 3,945.1622 ms. Both attempts kept every correctness,
cold, materialization, analysis, RSS, and disk guard green. The development Windows replica governor on this SHA
passed. Linux and macOS 10k jobs passed. This is hosted wall delay, not added graph work.

The 100-sample policy already excludes four upper order statistics. Rank 96 still breached 1,200 ms on two
independent runners, so the pause is not a single excluded outlier. Raising the fuse uses the original 10% headroom
rule against the worse exact-candidate tail rather than relaxing p50, CPU, sample count, or non-Windows ceilings.

The retained attempt-2 archive digest is
`sha256:27bc8fbcf770ba760157f3ab6212e318f91acf1d1ea6242fa88802b0d9f90777`; the primary JSON payload digest is
`sha256:f91e16863ba367eaec0308a8278f00e20f37ea492fb9cb2ce8ef5bed5780b890`. Attempt 1 is bound as the immediately
prior observation. The JSON also keeps the original 25 v1 observations as scheduler context, not a homogeneous
sample.

For the normalized `github-hosted-windows-x64` runner class at exactly 10,000 lexical symbols, the prospective
policy is:

- wall p95 hard fuse: `ceil(2,519.5922 × 1.10 / 100) × 100 = 2,800 ms`;
- wall p50 companion: 750 ms;
- process-CPU p95 companion: 500 ms;
- measured samples: 100;
- additional tolerance: zero;
- one-file-index safety fuse: `15,000 × 2 = 30,000 ms`.

A replacement candidate must pass this 100-sample policy prospectively. Linux, macOS, local Windows, vector, and
other scale evidence retain their existing ceilings.
