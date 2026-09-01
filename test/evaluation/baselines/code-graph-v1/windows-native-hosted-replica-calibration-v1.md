# Hosted Windows native replica calibration

Two independent 100-sample GitHub-hosted Windows runs measured the exact same source tree
`e1fc4934be4abf21711f1c15d3a72eaa9fda7d01`, fixture, AMD CPU model, Windows build, memory class, and Bun runtime.
One runner recorded wall p50/p95/max `454.4315/525.8618/906.2541 ms`; the other recorded
`393.7612/1,673.8084/2,184.2209 ms`. Their process-CPU p95 values were `281` and `282 ms`.

The wall p95 changed by `1,147.9466 ms` (`3.183x`) while process CPU changed by `1 ms`, and the runner with the slower
tail had the faster median. One hundred queries on one hosted VM therefore characterize query variation within that
runner, not variation across hosted runner states.

The first prospective three-runner set, workflow `33466815457` at exact commit
`9d037a04c5f23da0a356d2578d0e0d6af5144a4d` (tree `f36871a2d43c5e3081338eb2f008ea43bfda66ef`),
confirmed the runner-level model but exposed an incomplete safety projection. Replicas 1 and 3 passed the ordinary hot
wall gate at `377.0996` and `538.5316 ms`. Replica 2 recorded a `1,762.7741 ms` hot p95 with only `219 ms` process CPU,
then a `3,605.5271 ms` whole-graph-analysis wall p95 with only `125 ms` process CPU. The other replicas' analysis wall
p95 values were `200.6048` and `118.495 ms`; the maximum analysis process-CPU p95 across all three was `266 ms`.
Replica 2 therefore exhibited scheduler-sensitive wall delay across more than the hot-query phase, while resource and
computational companions stayed bounded. The exact artifacts, digests, runner identities, environments, and all
governed wall/CPU measurements are retained in the JSON calibration.

The corrected gate keeps the hosted runner as the experimental unit: three fixed independent replicas, 100 samples and
five warmups each, with no adaptive rerun. At least two replicas must pass the entire ordinary performance budget. All
three must pass exact correctness/work/parity checks, unchanged RSS and disk limits, the unchanged `750 ms` hot-query
wall median and `500 ms` hot-query process-CPU p95, and these fail-closed scheduler safety fuses:

- `1,900 ms` for hot-query wall p95, still 10% above the first verified 100-sample scheduler tail rounded upward to
  `100 ms`;
- twice each resolved Windows enclosing wall ceiling for cold index (`30,000 ms`) and one-file index (`20,000 ms`),
  with each nested materialization bound by its enclosing ceiling and by `nested <= enclosing`, plus twice the resolved
  whole-graph analysis ceiling (`4,000 ms`); and
- `3,000 ms` and `200 ms` single-observation process-CPU maxima for cold and one-file materialization respectively,
  each derived as 50% headroom over the retained candidate-C maximum (`1,703 ms` and `94 ms`) rounded upward to a
  reviewable `1,000 ms` or `100 ms` quantum; and
- `400 ms` for whole-graph-analysis process-CPU p95, a strict computational companion with roughly 50% headroom over
  the prospective set's observed `266 ms` maximum, rounded to `100 ms`.

The wall multipliers cover hosted scheduler/storage state without weakening computational or resource guards. A severe
single-runner breach still fails closed, while a systematic ordinary regression fails at least two replicas.

Candidate C supplied a second prospective set: workflow `33476389393` at exact commit
`15fcbfc820fc6e0c3ff4d40ede3466a0449670ad` (tree `729f7cb0ee3ff6550b969f9136cdad928a3ac0ee`).
Replicas 2 and 3 completed cold materialization in `1,724.5823` and `1,692.2245 ms`. Replica 1 recorded
`17,315.2415 ms`, above the former standalone `16,000 ms` materialization safety fuse, while its enclosing cold index
remained inside the existing `30,000 ms` safety fuse at `27,864.6616 ms`. Cold-materialization process CPU was
`1,516/1,703/1,453 ms` across replicas 1–3, and one-file-materialization process CPU was `46/63/94 ms`; all six
measurements used milliseconds with exactly one sample. The nested outlier consumed only `1,516 ms` of process CPU
(`11.422x` wall/CPU), and its maximum progress-heartbeat gap was `13,080.6681 ms`. In the same job, an independent
fresh rebuild of the same overlay completed materialization in `1,662.5275 ms` and the full index in `5,981.3059 ms`.
All correctness, work, parity, RSS, disk, incremental, query, and analysis guards passed. This is a single hosted
scheduler/storage stall inside a still-bounded enclosing phase, not evidence for a graph regression or a new
standalone `17.3 s` materialization limit.

The corrected safety projection therefore models the timer hierarchy explicitly. Cold and one-file index retain their
existing `30,000 ms` and `20,000 ms` aggregate safety ceilings. Their nested materialization observations use the same
enclosing ceiling during three-replica safety adjudication, and a fail-closed invariant requires every nested maximum
to be less than or equal to its enclosing maximum. Independent `3,000 ms` cold-materialization and `200 ms` one-file
materialization process-CPU ceilings apply to every replica, so scheduler wall-clock relief cannot conceal additional
computation. The ordinary per-replica budgets remain unchanged at `15,000/8,000 ms` for cold index/materialization and
`10,000/4,000 ms` for one-file index/materialization, so at least two replicas must still demonstrate normal end-to-end
and subphase performance. Any aggregate overrun, impossible nested timing, process-CPU overrun, second ordinary outlier,
or independent product/resource breach still fails the release.

The accompanying privacy-safe JSON preserves exact workflow, job, artifact, source-tree, runner, digest, environment,
and measurement provenance, including the failed candidate-C aggregate result and all three raw replica digests. Each
replacement release candidate receives exactly one preregistered three-runner set.
