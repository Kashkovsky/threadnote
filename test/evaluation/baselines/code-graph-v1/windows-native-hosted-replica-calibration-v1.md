# Hosted Windows native replica calibration

Two independent 100-sample GitHub-hosted Windows runs measured the exact same source tree
`e1fc4934be4abf21711f1c15d3a72eaa9fda7d01`, fixture, AMD CPU model, Windows build, memory class, and Bun runtime.
One runner recorded wall p50/p95/max `454.4315/525.8618/906.2541 ms`; the other recorded
`393.7612/1,673.8084/2,184.2209 ms`. Their process-CPU p95 values were `281` and `282 ms`.

The wall p95 changed by `1,147.9466 ms` (`3.183x`) while process CPU changed by `1 ms`, and the runner with the slower
tail had the faster median. One hundred queries on one hosted VM therefore characterize query variation within that
runner, not variation across hosted runner states.

The prospective gate makes the hosted runner the experimental unit: three fixed independent replicas, 100 samples and
five warmups each, with no adaptive rerun. Every replica must pass all existing non-wall budgets, the unchanged
`750 ms` wall median and `500 ms` CPU-p95 companions, exact work/parity checks, and a `1,900 ms` wall-p95 safety fuse.
The fuse is 10% above the first verified 100-sample scheduler tail, rounded upward to 100 ms. At least two replicas must
also pass the unchanged ordinary `1,000 ms` p95 plus guarded 5% boundary (`1,050 ms`). Equivalently, the median of the
three runner-level p95 values must pass. A severe single-runner breach fails closed; systematic latency fails at least
two replicas.

The accompanying privacy-safe JSON preserves exact workflow, job, artifact, source-tree, runner, digest, environment,
and measurement provenance. The replacement release candidate receives exactly one preregistered three-runner set.
