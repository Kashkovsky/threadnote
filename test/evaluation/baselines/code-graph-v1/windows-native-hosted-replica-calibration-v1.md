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
- twice each resolved Windows wall ceiling for cold index (`30,000 ms`), cold materialization (`16,000 ms`), one-file
  index (`20,000 ms`), one-file materialization (`8,000 ms`), and whole-graph analysis (`4,000 ms`); and
- `400 ms` for whole-graph-analysis process-CPU p95, a strict computational companion with roughly 50% headroom over
  the prospective set's observed `266 ms` maximum, rounded to `100 ms`.

The wall multipliers cover hosted scheduler/storage state without weakening computational or resource guards. A severe
single-runner breach still fails closed, while a systematic ordinary regression fails at least two replicas.

The accompanying privacy-safe JSON preserves exact workflow, job, artifact, source-tree, runner, digest, environment,
and measurement provenance. Each replacement release candidate receives exactly one preregistered three-runner set.
