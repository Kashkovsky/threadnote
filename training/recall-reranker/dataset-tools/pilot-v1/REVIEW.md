# Reranker corpus proposal and AI audit

This directory is a **proposal**, not a reviewed training dataset. The checked-in
`DATASET_PREPARATION.md` requires a person to verify every candidate label and source-rights decision before
`reviewed`, `trainingApproved`, `redistributionApproved`, or `privacyReviewed` can become `true`. The proposal files
deliberately keep those flags `false`. No trainer input has been compiled from them.

## Fictional query groups

Run `bun scripts/training/build-recall-reranker-pilot.ts` to regenerate the owned synthetic proposal from
`seeds.json`. The immutable seed and resulting text hashes are in `counts.json` and `draft.proposed.json`.

| Measure                       | Current proposal |
| ----------------------------- | ---------------: |
| Whole fictional organizations |               22 |
| Query groups                  |              132 |
| Candidate judgments           |              792 |
| No-answer groups              |       44 (33.3%) |
| Train / validation / test     |    102 / 18 / 12 |

Two cards cover Bazel and Swift: `orchard-swiftbuild` has registered Swift toolchains, declared module inputs,
action-cache keys, and compiler plugins; `granite-bazel` has aspects, configuration transitions, action declarations,
and providers. They add twelve groups with realistic same-domain distractors. Candidate order is deterministic but
varies by group. Neutral titles remove the mechanical “Superseded” and “Other product” label cues, and answerable
slates also include wrong-product candidates. A near passage that effectively answered an offline-cursor query was
rewritten during the no-answer review.

The AI audit checked all generated groups for schema shape, exactly one direct positive in answerable groups, no
positives in no-answer groups, six candidates per group, distinct normalized queries, whole-organization split
isolation, document-text split isolation, no exact frozen recall-fixture text, and matches from Threadnote's secret
scrubber. The four focused Vitest cases cover those checks and a bounded permutation property. Every label remains a
proposal. Some stale passages still announce that they describe an older behavior; such text needs further review
before it represents a useful hard negative. The owned cards are short and share a slate pattern, so this is a
wiring and annotation pilot, not evidence of model quality.

## Pinned public-source pool

Run `python3 training/recall-reranker/dataset-tools/pilot-v1/build_acquisition_inventory.py` against the ignored,
exact-revision archives under `.artifacts/training/recall-reranker/sources/`. It verifies full archive hashes and
root license/notice hashes before writing provenance-only `public-source-inventory.jsonl`,
`techqa-row-inventory.jsonl`, `acquisition.json`, and `sources.proposed.json`. Raw third-party text is not committed.
Format `acquisition.json` with the repository's Prettier command after regenerating it.

| Source              | First-party files proposed for inspection | Current rights evidence                                             |
| ------------------- | ----------------------------------------: | ------------------------------------------------------------------- |
| Effect              |                                       475 | MIT root and package license hashes                                 |
| TypeScript          |                                       102 | Apache-2.0 license and notice hashes                                |
| Go                  |                                       483 | BSD-3-Clause root license hash                                      |
| Rust book           |                                       112 | MIT and Apache-2.0 license hashes                                   |
| Bazel               |                                     1,360 | Apache-2.0 root license hash                                        |
| `rules_swift`       |                                        86 | Apache-2.0 root license hash                                        |
| Swift compiler/docs |                                       540 | Apache-2.0 license hash, with runtime-library exception in the file |
| TechQA              |                         910 question rows | Publisher's Apache-2.0 dataset-card claim only                      |

The repository pool contains 3,158 file records. It excludes vendored, test, generated, oversized, and undecodable
files. A conservative key-like pattern excluded one Effect file pending private review. Two exact-content duplicate
pairs remain in the inventory for reviewer disposition; 29 selected files are shorter than 200 bytes. This inventory
is a source pool, **not 3,158 labeled query groups**. The top-level licenses are verified against exact archive
bytes, but file/subtree rights, embedded third-party text, privacy, and dataset/model redistribution require explicit
review before admission.

TechQA's pinned `train.json` has 610 answerable and 300 impossible rows. Its original TRAIN/DEV splits share 40
Technote filenames, and 29 normalized questions duplicate another question. Of the 610 answerable rows, 603 have a
normalized answer substring in the associated context and 601 have an exact answer substring; seven need special
investigation. TechQA context passages range from 318 to 178,392 characters, so raw contexts cannot simply become
reranker candidates. Its included IBM Technote rights and attribution remain unresolved. No TechQA text or query has
been used as a training proposal yet.

## What must happen before training

The first trainer gate requires at least 5,000 reviewed groups; the preparation plan recommends 10,000–20,000. The
132 fictional proposals are 2.6% of the minimum. Source acquisition gives enough vocabulary to start query writing
and retrieval-based negative mining, including Bazel/Swift cases, but it does not turn file counts into trustworthy
labels. Next, review source/subtree rights and privacy, extract coherent passages, generate queries with evidence,
mine candidate slates on eligible material, inspect every judgment (including negatives), group exact and near
duplicates before splitting, and compile only the approved records. Keep frozen recall and EnterpriseRAG evaluation
material out of all generation and mining.
