# Context Brief validation quantile calibration

The exact 4.6 candidate `568b0fefaa220c0f1497970fc43cf4fb05bd9806` failed one release-scale gate in
workflow run `33464018157`: workset-128 citation validation p95 was `1,439.192 ms` against the unchanged
`1,400 ms` ceiling. Every correctness, fan-out, receipt, lease, no-cold-build, RSS, and total-latency check passed;
the end-to-end brief p95 was `2,143.380/5,000 ms`.

This was the coarse tail of the 25-sample percentile estimator, not a changed implementation. The failed candidate
and its predecessor produced the same benchmark bundle and fixture digests, and the candidate changed only Windows
benchmark governance. Only two of its 25 workset-128 validation samples exceeded `1,400 ms`: `1,439.192` and
`1,523.320 ms`. Threadnote selects `sorted[floor(n * 0.95)]`, so at 25 samples the second-highest observation defines
p95.

The accompanying JSON retains all 125 ordered workset-128 observations from five independent runs of the same bundle
on the pinned GitHub-hosted macOS ARM64 class, along with workflow, job, artifact, commit, archive, and raw-JSON
provenance. Pooled p95 is `1,130.263 ms`; only two of 125 observations exceed the unchanged ceiling. The latest four
runs form a 100-observation projection whose p95 is `1,143.441 ms`.

The prospective correction therefore changes release evidence from 25 to exactly 100 samples with five warmups. It
does not change any latency threshold or correctness, work, RSS, identity, or provenance gate. At 100 samples, up to
four upper-tail observations are excluded; a fifth makes index 95 exceed the ceiling and fails. The replacement
candidate receives one preregistered hosted attempt—no retry-until-pass.
