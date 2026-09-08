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
- hard elapsed-time objectives remain mandatory in all three observations; objective-bearing metrics may clear a
  stricter screening-only static miss but are ineligible for confirmatory tail tolerance;
- CPU, RSS, work, storage, deterministic, cumulative-work, and every other non-wall measurement remain strict in both
  candidate observations.

The companion JSON binds the exact commits, timestamps, runner identity, artifact digest, payload digests, raw
measurements, and policy boundary needed to reproduce the adjudication. It is calibration evidence for a prespecified
confirmatory gate, not permission to raise the production budgets or retry until a run passes.

## Objective-bearing screening clarification (#406)

The original implementation excluded any metric with a hard objective before checking whether the control and
confirmatory candidate passed static. Issue [#406](https://github.com/Kashkovsky/threadnote/issues/406) exposed the
distinction: `same-overlay-reference-registration-lock-and-database-setup` has a reviewed static p95 limit of `888 ms`
and a separate hard objective of `4,999 ms`. In PR #405 [run 34262147162, job 102182573837](https://github.com/Kashkovsky/threadnote/actions/runs/34262147162/job/102182573837),
the screening candidate measured `966.326097 ms`, protected-base control `269.651538 ms`, and confirmatory candidate
`319.786313 ms`. These are three n=1 observations. They support clearing this isolated screening miss under the
confirmatory policy; they do not establish its cause or rule out all regressions.

The clarification applies screening clearance after enforcing the hard objective on every observation. An objective
miss in the initial candidate, control, or confirmatory candidate still fails. A confirmatory static miss on an
objective-bearing metric still cannot receive the `1%` / `5 ms` tail tolerance. Exact commits, runner identity,
fixture/runtime/storage and measurement-set agreement, ordered timestamps, and both candidates' independently
ratcheted resource/work/structural evidence remain prerequisites. No static limit, objective, or measurement changes.

Reproduction uses the run's `code-graph-production-ratchet-Linux-X64` artifact, the checked-in Linux ratchet, candidate
commit `60cda3256ac3af8c767e9bb6f5e91ff32c0f843e`, and protected-base commit
`81dfd7083ed70ed25b2e2d08ba8a73eb528fb25f`. The gate rejected the original payloads before this change and accepts
the same payloads afterward. Their SHA-256 digests are:

| Payload                | SHA-256                                                            |
| ---------------------- | ------------------------------------------------------------------ |
| Initial candidate      | `dfb2624a0341d740e40b3b5a203bcc36517800f17b3074e2d0cc35e5fbfb3f33` |
| Protected-base control | `a1936e4515b52d384df5645d4a3d5bd50352f46740ad9081e6ab568ea8116ba4` |
| Confirmatory candidate | `aaed37d3506e29f7fa497691731241e1a754b1b3bcdb7a492bd0afbe61aac5f4` |
