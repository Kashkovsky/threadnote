# Recall-reranker data plan

See [DATASET_PREPARATION.md](DATASET_PREPARATION.md) for the reviewed acquisition, licensing, connected-component
splitting, annotation, and import workflow.

The first useful target is 5,000-20,000 reviewed query groups, each with one or two graded positives and 4-12
candidate documents. Most negatives should come from Threadnote's real lexical/vector/hybrid shortlist rather than
random sampling.

## Preferred sources

1. **Threadnote-owned scenarios and documents.** Create separate fictional engineering organizations for train,
   calibration, and test. Cover decisions, runbooks, PR summaries, stale notes, contradictions, duplicates, wrong
   scope, identifiers, missing information, and handoffs. The MIT-licensed
   [EnterpriseRAG-Bench methodology](https://github.com/onyx-dot-app/EnterpriseRAG-Bench/blob/main/methodology.md)
   is useful inspiration, but its released benchmark corpus remains evaluation-only.
2. **Pinned permissive public repositories.** Start with reviewed snapshots of repositories such as
   [Effect](https://github.com/Effect-TS/effect) (MIT), [TypeScript](https://github.com/microsoft/TypeScript)
   (Apache-2.0), [Go](https://github.com/golang/go) (BSD-3-Clause),
   [The Rust Book](https://github.com/rust-lang/book) (MIT OR Apache-2.0), and
   [Kubernetes](https://github.com/kubernetes/kubernetes) (Apache-2.0). Preserve commit, repository-relative path,
   license-file hash, content hash, and transformation version. Exclude vendored or separately licensed subtrees.
3. **Technical support questions with true impossible cases.** NVIDIA's Apache-2.0
   [TechQA-RAG-Eval](https://huggingface.co/datasets/nvidia/TechQA-RAG-Eval) is a candidate anchor. Before use, pin a
   revision and checksum, group overlapping Technotes/product families/near-duplicates before splitting, and audit the
   applicable source-document rights.
4. **CodeSearchNet after row-level filtering only.** The
   [CodeSearchNet tooling](https://github.com/github/CodeSearchNet) is MIT, but corpus rows originate in repositories
   with different licenses. Accept only an explicit permissive SPDX allowlist, keep origin and notices, remove the
   query docstring from its candidate code, and reserve the human relevance judgments for evaluation.
5. **Explicit opt-in contributions.** A future exporter may capture a sanitized query, candidate slate, reviewed
   relevance, and consent reference. It remains off by default. Current Threadnote feedback contains fingerprints, not
   recoverable query text, and cannot be used.

## Labels and negatives

- Preserve relevance grades `0..3`; the training view maps them to `0..1` without discarding the original label.
- Mine sibling sections, semantic neighbors, lexical collisions, stale/superseded versions, wrong-project results,
  low-authority duplicates, and corrupted exact identifiers.
- Keep some ordinary/random negatives so the reranker does not overfit exclusively to difficult shortlists.
- Do not label an unjudged retrieved document negative automatically.
- Build no-answer groups from genuine impossible questions, reviewed constraint mutations, and answerable queries whose
  gold evidence is deliberately absent. Candidate sets should remain topically close; nonsense queries are not enough.

## Split and leakage rules

- Split by organization/repository/product/fictional company, never by individual pair.
- Keep every query paraphrase, document version, fork, duplicate, and entity timeline in one partition.
- Deduplicate exact content and near-duplicates before assigning partitions. Apply temporal cutoffs afterward.
- Mine no training negatives from any evaluation corpus.
- Keep Threadnote's checked-in recall fixtures and release baselines completely outside training and calibration.
- Record source URL, immutable revision, path/record ID, SPDX license, license hash, content hash, transformation
  revision, generator/teacher identity and terms, partition key, synthetic flag, and review state.

## Excluded without separate legal review

- [MS MARCO and ORCAS](https://microsoft.github.io/msmarco/Notice.html): their official notice limits use to
  non-commercial research and disclaims rights in underlying documents.
- Unfiltered public GitHub, unfiltered CodeSearchNet, arbitrary SWE-bench issues/PRs, or repositories without an
  explicit applicable license.
- Stack Exchange derivatives with version-dependent CC BY-SA attribution/share-alike obligations.
- Private memories, team shares, customer code, secrets, raw production logs, or telemetry gathered without explicit
  opt-in consent.
- Threadnote's own recall benchmark, CodeSearchNet human judgments, and other released benchmarks as training data.
- Synthetic labels as the sole source of final quality evidence.
