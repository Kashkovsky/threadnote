# Threadnote token-efficiency historical corpus v1

This reviewed corpus freezes six unedited historical GitHub task packets against six independent public repositories. Each task uses the first parent before the known fix as its held-out checkout. The known fix is retained only for corpus admission and hidden-verifier calibration; it is never exposed to the coding agent.

All tasks use the `historical-as-issued` variant. The corpus therefore makes no claim that synthetic exact-name, paraphrase, absent-answer, conflicting-records, or dirty-worktree conditions were materialized. Repository clusters are independent at the project level, so clustered confidence intervals do not treat multiple revisions of one project as independent evidence.

The prompt is GitHub's title, two LF bytes, and the unedited body with CRLF normalized to LF. The body is retained separately as manual context when context exists. Context sufficiency was independently reviewed from the title and body alone, without solutions or provider outcomes. The tasks cover `none`, `lacking`, `sufficient`, and `excessive`; strata remain descriptive.

One linked memory per task was authored by a source-only reviewer using a Git archive of the pre-fix tree without Git history, task prompt, network, or known fix. During local materialization, each exact body must become a managed Threadnote memory with its corpus citation finalized against the pinned base revision.

## Local materialization

Ignored local artifacts live under `.context/token-efficiency-corpus-v1`: clean checkouts, graph databases, managed memories, homes, credentials, binaries, and outcomes. The committed corpus contains no credentials or transcripts.

Run a hidden verifier with the pinned verifier environment:

```sh
.context/token-efficiency-corpus-v1/verifier-venv/bin/python \
  apps/threadnote/test/evaluation/corpora/token-efficiency-historical-v1/verifiers/verify.py \
  <h11|hpack|attrs|click|werkzeug|packaging> /absolute/path/to/checkout
```

Admission requires exit 1 at the pinned base and exit 0 at the known fix. The experiment runs from the base; fix checkouts are never mounted into the agent or judge environment.

`provenance.json` records identities, revisions, prompt sources, licensing, context assessments, and verifier selectors. `corpus.json` is the exact evaluator input. The local preparation plan is generated only after the final Threadnote 5.0.6 release commit, exact local binary, ready graph homes, and managed memory IDs are known.
