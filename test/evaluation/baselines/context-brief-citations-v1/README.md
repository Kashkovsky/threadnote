# Context Brief citation scale calibration

The 4.6 release gate is calibrated from three independent, exact-candidate runs on the pinned GitHub-hosted
`macos-15` ARM64 runner class at commit `172c4d45e2cbc5dedb8f5fd088a8d5b93ca005d3`. Correctness, citation,
lease, no-cold-index, and RSS objectives remained healthy in all three runs.

The raw JSON observations came from hosted workflow run `33395986972`, attempts 1–3. Their SHA-256 digests are,
respectively, `f5fede4b95a93e364b4d144f73b835d7b9c78865af834a7df4ac98024c3b7f17`,
`8e7c8271dfd451cbd34f414ba60394577da0a6a860be1f947ca9766bbedbd6cc`, and
`781035bd16be8afc3fa1eb6818c6b4216b24b192bf9fed0b0038fff3e099d325`.

| Profile     | Validation p95 observations (ms) | Brief p95 observations (ms) | Reviewed validation / brief ceiling (ms) |
| ----------- | -------------------------------- | --------------------------- | ---------------------------------------- |
| local-100k  | 185.4 / 204.0 / 118.7            | 881.3 / 741.5 / 552.2       | 250 / 1,500                              |
| workset-50  | 649.0 / 831.3 / 570.4            | 2,009.2 / 2,920.4 / 1,534.2 | 950 / 3,250                              |
| workset-128 | 1,172.6 / 1,227.9 / 723.8        | 1,856.0 / 2,909.8 / 1,792.8 | 1,400 / 5,000                            |

For a ceiling that the three-run sample exceeded or left with less than the prospective margin, the reviewed value is
10% above the largest observation, rounded up to the next 50 ms. Existing ceilings with more headroom are retained;
this calibration does not tighten them from a small sample.

The same runs recorded maximum successful-sample gaps of 138, 172, and 100 ms. Their `>100 ms` breach patterns were
4/75 with at most two consecutive observations, 2/75 with no consecutive observations, and 0/75. The initial v1
quality policy therefore bounded the raw maximum at 250 ms while retaining a 10% breach-rate ceiling and at most two
consecutive breached observations.

A fourth independent run, `33438134814`, exercised exact candidate
`4cf4c966cf272a3cb066db29750a415766ec5954`. Its raw JSON has SHA-256
`fcd37f90826f35f01c6cd5b7ad605669e3c6f3f44c95671df02d0957b7ef91ca`. All product correctness, latency, RSS,
sample-success, and descendant-coverage gates passed, but one of 75 observations recorded an isolated 297 ms gap and
exceeded only the v1 250 ms ceiling. That observation still contained 64 successful samples and observed descendants;
the run had 3,194/3,194 successful samples, a 2/75 breach rate, and at most one consecutive breach. Across all four
runs, 8/300 observations breached 100 ms, with p50/p95/p99 gaps of 54/89/138 ms and a 297 ms maximum.

The prospective v2 policy applies the same calibration rule used above: 10% above 297 ms, rounded up to the next
50 ms, yields a 350 ms hard maximum. It keeps the 100 ms threshold, 10% breach-rate ceiling, two-consecutive ceiling,
zero-failure requirement, descendant coverage, and RSS budgets unchanged. This locks a bounded hosted-runner
scheduling-stall allowance before a new candidate run rather than accepting a retry of the failed candidate.
The privacy-safe canonical projection in `sample-gap-calibration-v2.json` retains all 300 ordered gaps and their
workflow, attempt, artifact, commit, timestamp, and raw-artifact-digest provenance. Its unit verifier independently
re-derives the documented aggregate and policy ceiling, so the calibration remains reviewable after hosted artifacts
expire.

The later `validation-quantile-calibration-v1.json` and matching rationale preserve the five-run evidence used to
increase release sampling from 25 to 100 without changing the reviewed latency ceilings. Its verifier re-derives the
pooled and latest-four-run quantiles and the four-versus-five upper-tail boundary.

`rss-observer-capacity-calibration-v1.json` and its rationale retain the first 100-sample prospective run that exposed
the old 256-observation protocol ceiling. The correction derives capacity from the three-profile, 100-sample release
contract, rejects oversized schedules before setup, and reports child failure immediately; it changes no evidence
budget and requires a fresh complete prospective artifact.
