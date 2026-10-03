# GraphMem Continuation v1

GraphMem Continuation v1 is the preserved evidence bundle for the final study internally identified as
`threadnote-continuation-v19-final`. The study tests whether a fresh coding-agent session can continue multi-stage work
with fewer provider tokens when it receives a Threadnote-generated memory handoff and a code-graph query, compared with
a files-only session that receives no handoff.

The public name is intentionally shorter than the sealed study ID. The files retain the original IDs, nonces, hashes,
and candidate identity so the evidence chain is not rewritten for presentation.

## Headline result

Across five public-repository tasks, Threadnote completed 5/5 tasks and files-only completed 4/5. Failure-inclusive
lifecycle cost was 259,208 versus 753,916.5 provider tokens per deterministically verified completion: a 65.62%
reduction, with a repository-cluster bootstrap 95% interval of 50.80% to 81.56%.

The completion-rate difference was +20 percentage points, but its 95% interval was 0 to 60 points. It is reported as a
descriptive outcome, not evidence of completion superiority.

Read [the article](article.md) for the design, analysis, results, and limitations.

## Evidence layout

- `protocol/` contains the frozen corpus, exposure audit, preparation plans, qualified study inputs, candidate identity,
  final study record, and finalization runtime/receipt.
- `results/` contains the canonical outcome ledger, aggregate report, article-evidence projection, and finalization
  receipt.
- `evidence/tasks/` contains the exact small records for the five common Phase 1 sessions and ten Phase 2 attempts:
  task packets, selections, requests, responses, artifacts, terminal records, verification receipts, patches, and
  transcripts. The runner retained the historical directory name `pilot`; within this bundle those are the final
  confirmatory Phase 2 attempts, not exploratory pilot outcomes.
- `evidence/qualification/` contains the provider-free base qualification logs.
- `tools/` contains the task-input generator and held-out verifier used by the final study.
- `SHA256SUMS` authenticates every tracked file in this directory except the checksum file itself.

## What is deliberately not vendored

The original local study root was 4.1 GB and 61,310 files. Most of that volume was reconstructible execution machinery,
not experiment evidence: frozen binaries, source maps, Python and Go runtimes, dependency caches, cloned Git
repositories, virtual environments, prepared Threadnote homes, code-graph databases, and repeated adapter/tool binaries.
Several files exceeded GitHub's 100 MB object limit.

Those payloads are omitted. Their content identities, repository revisions, candidate commit, tool hash, adapter hash,
fixture hashes, environment-policy hashes, and lock identities remain in the sealed protocol and run records. The
evidentiary chain required to audit the design, inputs, assignments, provider usage, outputs, verification, and analysis
is preserved here without committing disposable caches or third-party build environments.

## Raw evidence and privacy

The article and aggregate report contain no raw prompts, transcripts, handoff bodies, or machine-local paths. This
evidence-only branch additionally preserves the exact final-run records, including raw prompts/transcripts and absolute
paths from the evaluation machine. A credential scan found no API keys, bearer tokens, GitHub tokens, AWS access keys,
private keys, or credential contents. Some configuration records refer to the path of the Codex authentication file;
the authentication file and its contents are not present.

Do not copy the raw evidence directory into release packages or user-facing documentation. It exists to preserve the
study, not as runtime input.

## Frozen identities

- Candidate source commit: `8da0eae878aaedc419319e32fd10fdcb5abccbb1`
- Candidate version: `5.1.0-beta.2`
- Candidate binary SHA-256: `75d731c3c1670b4be0b534fee8c6b3a298cba4a5d707aa8caa9dcfbd361e73c6`
- Adapter SHA-256: `a4292dd8dc900566223a25c77f8a0f4c415751a607e020441e72973c33dfe106`
- Study identity: `945b5466e0c2f86af7052916f2c29199dd7f913d01b94b427b39d285047a8046`
- Report identity: `4a491c64ea2af984d0b79f2001fdbcad903a95b0171d7eea0763bb067bf35c49`
- Finalization receipt identity: `caab6c601543d3d5cfa7769a19d417f47b37d9ecbe7b64b8e08244adcf9ffdb1`

These are embedded contract identities. Use `SHA256SUMS` for byte-level verification of the files on this branch.

## Verify the bundle

From this directory on macOS:

```sh
shasum -a 256 -c SHA256SUMS
```

On systems with GNU coreutils:

```sh
sha256sum -c SHA256SUMS
```

The report's primary claim can be checked directly in `results/continuation-report.json`; per-attempt lifecycle inputs
are in `results/continuation-outcomes.jsonl` and the matching task evidence directories.
