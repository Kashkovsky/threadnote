# Offline organization pilot reports

`threadnote value pilot` produces one content-free report for one deployment and a maximum 28-day window. It consumes existing `ValueReportExportV1` bundles plus explicit operator-supplied observations. It does not contact a hosted service, collect telemetry, publish a report, or certify pilot success. Existing `threadnote value report` behavior is preserved.

```sh
threadnote value pilot --input pilot-input.json
threadnote value pilot --action export --input pilot-input.json
threadnote value pilot --action export --input pilot-input.json --apply
threadnote value pilot --action retention
threadnote value pilot --action retention --apply
threadnote value pilot --action reset
threadnote value pilot --action reset --apply --selection-digest <preview-selectionDigest>
```

Report and export preview print identical JSON without writing an export. Apply writes a private, content-addressed artifact in the existing `exports/value-reports` directory and prints a digest receipt without a path. Export is explicit and local; delivery to a design partner remains a separate operator action. Use a separate Threadnote home per deployment. Never combine tenants in one input or reuse actor mappings between windows.

## Versioned input

The closed `threadnote.value-pilot-input.v1` schema accepts only the fields below. Unknown properties fail at every level, including inside imported value reports. Files are bounded to 4 MiB, 100 actors, 100 local sources, 10,000 observations, and 10,000 evidence records. Invalid input errors do not echo values or paths.

```json
{
  "schema": "threadnote.value-pilot-input.v1",
  "version": 1,
  "windowStart": "2026-09-01",
  "elapsedDays": 7,
  "actors": 0,
  "evidenceCoverage": "unavailable",
  "sources": [],
  "observations": [],
  "evidence": []
}
```

`windowStart` is a real UTC calendar date. `elapsedDays` is 1–28 completed days, with an exclusive end. Reporting weeks are seven-day intervals from the start, not calendar weeks. Actor slots are integers from zero to `actors - 1`, assigned afresh inside this window to distinct humans or agent surfaces. They are not hashes, account IDs, or provider identities. Item slots are arbitrary integers from 0–10,000 identifying the same evidence episode inside the window. The producer owns the accuracy and temporary mapping of these slots. Threadnote cannot independently verify that two supplied slots are different real people or that operator attestations are true.

`sources` contains at most one `{ "actor": 0, "value": <ValueReportExportV1> }` per actor. Its period must exactly match the input window. Generate the source through the existing export command with inclusive/exclusive UTC dates, for example `threadnote value report export --from 2026-09-01 --to 2026-09-08` for a seven-day pilot starting September 1. These dates cannot be combined with `--period`; ordinary rolling exports keep their existing time-of-day behavior. Use non-overlapping local sources; do not copy one installation's report onto several actors. Only coarse counts of successful briefs, approved deltas, completed setup, and health openings/resolutions survive. Legacy counts are supporting context: successful brief does not establish source verification, approved delta does not establish reuse, and missing legacy instrumentation can contain zero.

Each observation has `actor`, `sample`, `metric`, and `state`. `state` is `observed`, `missing`, `pending`, `failed`, or `inapplicable`. Only `observed` has a nonnegative integer `value`. Missing means no measurement; pending means its opportunity remains open; failed means measurement could not be established; inapplicable means the metric does not apply. An observed negative outcome is **value zero**, not missing or failed. Omitted actors contribute missing coverage. Each actor/metric/sample tuple is unique. Milestone metrics require sample zero; rate metrics use distinct local opportunity ordinals.

| Metric                             | Observed value and denominator                                                           |
| ---------------------------------- | ---------------------------------------------------------------------------------------- |
| `setupCompletion`                  | 0 or 1 for the actor's initial setup                                                     |
| `setupMilliseconds`                | Elapsed setup time                                                                       |
| `firstCorrectEvidenceMilliseconds` | Elapsed task time to first independently checked correct evidence                        |
| `firstCorrectEvidenceTokens`       | Tokens spent reaching that first correct evidence                                        |
| `firstCorrectEvidenceTurns`        | Turns spent reaching that first correct evidence                                         |
| `freshnessCurrentRate`             | 1 when an evaluated evidence check establishes currentness; 0 otherwise                  |
| `staleDetectionRate`               | 1 when known-stale evidence is detected; denominator: audited stale cases                |
| `staleResolutionRate`              | 1 when a detected stale case is verified resolved; denominator: cases due for resolution |
| `falseCurrentRate`                 | 1 for a false-current claim; denominator: audited current claims                         |
| `recallWithoutEvidenceRate`        | 1 for a recall missing required evidence; denominator: audited recalls                   |
| `fallbackRate`                     | 1 when an eligible operation requires fallback; denominator: audited operations          |
| `setupFailureRate`                 | 1 for failed setup; denominator: setup attempts                                          |
| `conflictRate`                     | 1 for a conflict; denominator: write attempts                                            |
| `dataLossRate`                     | 1 for verified loss; denominator: integrity checks                                       |
| `silentPublicationRate`            | 1 for publication without required approval; denominator: audited publication attempts   |

Rates never infer a clean result from a missing observation. The report includes observed/missing/pending/failed/inapplicable buckets and marks mixed coverage. Rate denominators contain only observed opportunities. A zero rate does not assert unobserved operations were safe.

## Evidence and cross-actor reuse

Evidence records have only `actor`, `item`, `minute`, and `kind`. Minute is an integer offset inside the window. Kinds are `verified-brief`, `approved-delta`, `verified-reuse`, and `full-loop`. Each actor/item/kind may appear once; use a new item for a new episode. These records attest to actual checked outcomes, never merely tool invocation. The producer must not invent records to satisfy a gate.

- First source-verified brief requires a `verified-brief` event for that actor.
- Seven-day reuse requires a later `verified-reuse` of the same item by a different actor, at most 10,080 minutes after the originating verified brief. A still-open seven-day opportunity is pending. Multiple originating actors are evaluated independently.
- Approved-delta reuse requires the originating actor's verified brief and approval, followed by another actor's verified reuse of that item.
- A weekly full loop requires the actor's verified brief or verified reuse and approved delta before its full-loop completion for that item. Cross-actor full loop additionally requires another actor's earlier verified brief before the reuse. Retention intersects those actors across adjacent weeks and across all four weeks, within this window only.

`evidenceCoverage` is `complete`, `partial`, or `unavailable`. Complete is an explicit producer assertion that all evidence opportunities in the window were covered. Only complete coverage permits an absence to become observed zero. Partial evidence can prove positives but leaves absent outcomes missing; adjacent-week retention is unavailable. Unavailable requires an empty evidence array. Unfinished weeks remain pending. No cross-window correlation or retention claim is made.

## Privacy, retention, and deletion

The output never includes actor/item/sample slots, local exports, event records, content, paths, repository names, queries, raw logs, stable user IDs, or provider-specific fields. Counts use `0`, `1-2`, `3-4`, `5-9`, `10-24`, `25-49`, `50-99`, and `100+`. Rates and medians need at least three observed actors; otherwise they are suppressed. Rates are coarse ranges; medians are zero/low/medium/high. Time thresholds are 60 seconds and ten minutes, token thresholds 1,000 and 10,000, turn thresholds three and ten. These buckets reduce disclosure; they are not differential privacy or a guarantee against outside knowledge. Avoid publishing overlapping custom windows that permit subtraction attacks.

The report digest covers only the sanitized report, never input records or correlation material. It is a content digest, not a signature or deployment identifier. There is no persistent actor map. Retention permits at most 100 managed exports, each eligible for 28 days after its observation period ends. Export apply prunes expired artifacts before writing; explicit retention also prunes them. Abandoned artifact-specific staging directories are included in cleanup. Writers and cleanup share one storage lock, so cleanup cannot remove an active writer’s staging. General value-report retention also removes abandoned staging. There is no background deletion timer, so files may remain on disk while the tool is idle. Expired and future-dated reports cannot be newly exported. Preview remains available for historical analysis.

Reset preview and apply identify the selected managed pilot artifacts by a deterministic selection digest and count. Apply requires `--selection-digest` from the preview and rejects any changed selection before deleting anything. Reset removes those artifacts only and reports zero stored correlation records. Existing `value report delete --exports --apply` also removes pilot exports; local feedback/events require their existing explicit selections. Caller-owned input files, temporary mappings, downloaded copies, and backups are outside this scope and must be deleted by their owners. Nothing silently claims remote or backup erasure.

Synthetic tests verify contracts, privacy boundaries, ordering, idempotence, and cleanup. They do not establish setup success, real second-user reuse, four-week retention, zero production incidents, buyer value, willingness to pay, or pilot completion. Every report keeps `pilotSuccess: "not-assessed"`.
