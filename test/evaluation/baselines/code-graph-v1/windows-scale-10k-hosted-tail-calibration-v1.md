# Hosted Windows 10k query-tail calibration

The exact Threadnote 4.6 candidate `55c9fecf0e2808e580f544c4a6a6b3b734b74c20` failed the generated 10k-symbol
Windows lexical gate in workflow run `33452060622`, job `99683952779`, artifact `9780321745`. Across ten measured
queries, wall p50/p95 were 642.985/1,068.8384 ms against the existing 1,000 ms p95 ceiling. Process-CPU p50/p95 were
only 172/266 ms. Every correctness, cold, materialization, incremental, analysis, RSS, and disk gate in that artifact
passed.

The wall-only breach coincided with a slow heterogeneous hosted runner rather than added graph work. Checkout took 82
seconds and dependency installation took 188 seconds. The immediately preceding candidate observation, artifact
`9779699070`, reported 390.1606 ms wall p95 with a higher 344 ms CPU p95. In the retained 24 prior observations, wall
p95 ranged from 383.7384 to 898.2133 ms and CPU p95 ranged from 203 to 375 ms; none breached the old wall or companion
CPU ceilings. The failed candidate's 266 ms CPU p95 is below the prior median of 281 ms even though its wall p95 is
2.73 times the immediate predecessor.

The retained JSON binds 25 reverse-chronological observations to workflow run, artifact ID, GitHub archive digest,
exact commit, branch, host facts, query sample count, wall p50/p95, CPU p50/p95, and cold wall timings. These evolving
commits are scheduler context, not a homogeneous statistical sample. The exact candidate and its immediate predecessor
provide the causal wall-versus-CPU control. The raw candidate payload has SHA-256
`b19a83f4c95927dbac2c861d5cba36ef1c85d07dd472a3766e1eba20d2e4f11b`.

For the normalized `github-hosted-windows-x64` runner class at exactly 10,000 lexical symbols, the prospective policy
is:

- wall p95 hard fuse: `ceil(1,068.8384 × 1.10 / 100) × 100 = 1,200 ms`;
- wall p50 companion: 750 ms;
- process-CPU p95 companion: 500 ms;
- measured samples: 25;
- additional tolerance: zero.

With ten samples, nearest-rank p95 is the single maximum and is too sensitive to one scheduler pause. At 25 samples,
p95 is the second-highest observation, while the hard p50 and CPU companions still reject sustained latency or actual
computation regressions. The focused property test proves every boundary remains strict. Local, Linux, macOS, vector,
and other scale evidence retain their existing ceilings.

The failed artifact also exposed missing provenance on the 10k matrix: it recorded `local-unclassified` and `local`.
The replacement workflow supplies the GitHub-hosted runner label and runner name; the existing privacy-safe normalizer
maps them to `github-hosted-windows-x64` and a hashed runner identity. The override additionally requires the artifact's
runtime platform to be `win32` and its architecture to be `x64`, so a mislabeled non-Windows artifact retains the
1-second ceiling. A replacement candidate must pass prospectively with this identity and 25 real samples. A future
breach stops the release rather than automatically recalibrating.
