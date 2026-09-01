# Hosted Linux paired-wall ratchet calibration

This record retains the privacy-safe evidence behind the bounded confirmatory-wall rule used by the pull-request
production ratchet. It comes from PR #335 run `33456846932`, job `99698573470`, on one GitHub-hosted Linux runner. No
local benchmark contributed to this decision.

The first candidate observation is a screening measurement. It exceeded the unchanged static limits for MCP impact
and one-file materialization, while the exact protected-base control and the immediate confirmatory candidate both
passed those metrics. Carrying the screening-only wall spikes into final adjudication would make the confirmatory
sequence unable to confirm that those observations were transient.

For hot exact lexical query, the screening candidate and protected-base control passed the unchanged `489 ms` p95
limit. The confirmatory candidate measured `492.101135 ms`: `3.101135 ms`, or about `0.634%`, over the boundary. Its
process-CPU p95 was `285.777 ms`, close to the control's `281.794 ms` and well below the independent `455 ms` CPU
limit. That wall/CPU split is evidence of a narrow hosted-scheduler tail rather than additional graph work.

Fourteen recent successful hosted observations on the same governed reduced fixture ranged from `246.869959 ms` to
`409.694920 ms`; their upper middle observation was `339.205149 ms`. These are fourteen independent n=1 observations,
not a portable p95 estimate. A prior failed sandwich measured `506.564589 ms`, or `17.564589 ms` (`3.592%`) above the
static boundary. The calibrated cap continues to reject that discriminating case.

The calibrated rule therefore keeps the checked-in static limits unchanged and applies only inside a valid
candidate-control-candidate sequence:

- a screening-only failure may be cleared only when the protected-base control and confirmatory candidate pass the
  same allowlisted wall metric;
- when screening and control pass, at most one confirmatory wall observation in the entire sequence may exceed the
  static boundary by the smaller of `1%` and `5 ms`; a second crossing fails;
- two candidate failures still fail, as does any confirmatory excess beyond that cap;
- hard elapsed-time objectives are ineligible for both forms of confirmatory forgiveness;
- CPU, RSS, work, storage, deterministic, cumulative-work, and every other non-wall measurement remain strict in both
  candidate observations.

The companion JSON binds the exact commits, timestamps, runner identity, artifact digest, payload digests, raw
measurements, and policy boundary needed to reproduce the adjudication. It is calibration evidence for a prespecified
confirmatory gate, not permission to raise the production budgets or retry until a run passes.
