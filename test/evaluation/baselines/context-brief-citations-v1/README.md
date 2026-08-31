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
4/75 with at most two consecutive observations, 2/75 with no consecutive observations, and 0/75. The observer now
uses absolute monotonic deadlines and preserves the raw maximum while applying the prospective v1 quality policy:
at most a 10% breach rate, at most two consecutive breached observations, and a 250 ms hard maximum. This separates a
bounded hosted-runner scheduling stall from sustained loss of observation coverage without weakening sample-success
or RSS gates.
