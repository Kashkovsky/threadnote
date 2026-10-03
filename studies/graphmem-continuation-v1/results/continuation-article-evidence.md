# Matched continuation article evidence

- Report hash: 4a491c64ea2af984d0b79f2001fdbcad903a95b0171d7eea0763bb067bf35c49
- Study hash: 945b5466e0c2f86af7052916f2c29199dd7f913d01b94b427b39d285047a8046
- Workflow accounting: phase-one-plus-phase-two-per-attempt
- Exposure audit hash: 75c28f28bea0b5f041bc31ec17a82099e096fa7221046b411a83c3bc7378de86

## Claim decision

- Preloaded Threadnote continuation reduced failure-inclusive provider tokens per deterministically verified completion by 65.62% versus files-only while satisfying the preregistered token, completion, and safety gates on study threadnote-continuation-v19-final.

## Variant accounting

### files-bare

- Assigned / completed / failed / unavailable: 5 / 5 / 0 / 0
- Deterministically verified / hybrid verified: 4 / 4
- Failure-inclusive workflow tokens: 3,015,666
- Tokens per verified completion: 753,916.5
- Workflow milliseconds per verified completion: 285,375
- Missing provider / elapsed accounting: 0 / 0

### threadnote-preloaded-resume

- Assigned / completed / failed / unavailable: 5 / 5 / 0 / 0
- Deterministically verified / hybrid verified: 5 / 5
- Failure-inclusive workflow tokens: 1,296,040
- Tokens per verified completion: 259,208
- Workflow milliseconds per verified completion: 153,702
- Missing provider / elapsed accounting: 0 / 0

## Shared checkpoint accounting

- Raw shared Phase-1 provider tokens: 634,597
- Raw shared Phase-1 milliseconds: 391,659
- These raw shared totals are audit values; each variant result allocates the matched Phase-1 cost once per task as sealed by the workflow contract.

## Comparisons

### threadnote-preloaded-resume vs files-bare

- Status: passed
- Token reduction: 65.62%
- Token-reduction 95% interval: 50.80% to 81.56%
- Verified-completion delta: 20.00% percentage points
- Verified-completion 95% interval: 0.00% to 60.00%
- Full-lifecycle time reduction: 46.14%
- Time-reduction 95% interval: 25.25% to 73.38%

## Limitations

- Claims apply only to the frozen repositories, tasks, candidate, model configuration, and 2 continuation treatments.
- Each workflow observation includes the matched Phase 1 checkpoint cost plus its Phase 2 continuation cost; under the intent-to-treat estimand, a known failed provider attempt remains assigned as a non-completion and its retained provider usage stays in the numerator.
- A runtime-unavailable row is not treated as a failed task; it makes the corresponding completion intervals unavailable.
- Missing provider or elapsed accounting makes the corresponding efficiency estimate unavailable rather than treating the failure as cheap.
- Repository-cluster bootstrap intervals describe this held-out corpus and do not establish population validity beyond it.
- Attempt order was randomized but not position-balanced (files-bare: 1 at position 1, 4 at position 2; threadnote-preloaded-resume: 4 at position 1, 1 at position 2); order effects may influence the paired estimates.
- Manual handoff is an oracle-like control; preloaded Threadnote continuation is the primary comparison.
- Raw prompts, transcripts, local paths, and handoff contents remain outside this publishable report.

