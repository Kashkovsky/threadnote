# Threadnote recall-reranker training harness

This directory contains development-only tooling for Threadnote's first task-specific model: a compact cross-encoder
that reranks recall candidates and fits validation-only no-answer calibration. Python and `uv` are confined to this
training workspace. They are not packaged in the Threadnote CLI, MCP server, or standalone release; shipped inference
continues to use the isolated `node-llama-cpp` runtime.

The reviewed base is Apache-2.0
[`answerdotai/ModernBERT-base`](https://huggingface.co/answerdotai/ModernBERT-base), pinned to an immutable snapshot and
content hash in `configs/modernbert-base-v1.json`. The earlier Jina experiment was rejected because its converted
classification head did not preserve Python scores in the shipped runtime. ModernBERT is still only a candidate until
the trained artifact passes native score parity, frozen recall, no-answer, latency, memory, cold-load, and size gates.

Start with:

- [TRAINING.md](TRAINING.md) — exact setup, training, GGUF export, parity, evaluation, promotion, and troubleshooting
  commands.
- [DATASET_PREPARATION.md](DATASET_PREPARATION.md) — source acquisition, licensing, safe split construction, hard
  negatives, no-answer cases, human review, optional local Gemma proposals, and the reviewed-input compiler.
- [DATA.md](DATA.md) — concise source policy and exclusions.

## Safety and reproducibility boundary

- The recall-v2 fixture is a frozen evaluation holdout. The TypeScript validator rejects normalized query or document
  overlap and binds its current identity into a content-addressed validation receipt.
- Never train on private memories, team shares, customer or employer code, secrets, raw logs, or unconsented
  telemetry. Public data still needs an applicable training and redistribution license.
- Partition related repositories, products, source documents, versions, forks, and near duplicates before assigning
  train, validation, and test splits.
- Every candidate label, including every negative, must be explicitly human-reviewed. A local Gemma model may propose
  rows from already approved evidence, but it cannot set `reviewed: true` or create evaluation gold.
- `harness_smoke` data verifies wiring only. It requires `--allow-smoke` and always produces a non-release artifact.
- Real training requires a clean committed source tree, a content-verified base snapshot, a new output directory, and
  the locked environment. A dataset below the reviewed scale floor remains non-release.

## Quick smoke check

From the repository root:

```sh
uv sync --project training/recall-reranker --locked

uv run --project training/recall-reranker --locked \
  threadnote-reranker prepare-base-model \
  --config training/recall-reranker/configs/modernbert-base-v1.json \
  --allow-network

bun run train:reranker:data
bun run train:reranker:validate

env HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 HF_DATASETS_OFFLINE=1 \
  uv run --project training/recall-reranker --locked --offline \
  threadnote-reranker validate \
  --dataset .artifacts/training/recall-reranker/datasets/smoke-v1

env HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 HF_DATASETS_OFFLINE=1 \
  uv run --project training/recall-reranker --locked --offline \
  threadnote-reranker train \
  --dataset .artifacts/training/recall-reranker/datasets/smoke-v1 \
  --config training/recall-reranker/configs/modernbert-base-v1.json \
  --output .artifacts/training/recall-reranker/runs/smoke-modernbert-v1 \
  --allow-smoke
```

Use a new run directory for every attempt. The complete runbook continues through pinned `llama.cpp` preparation,
GGUF export, Python/native parity, and frozen evaluation.

## Prepare a real reviewed dataset

Copy the fictional examples under `dataset-tools/` to a private staging area and replace every source and group with
reviewed material:

```sh
bun run train:reranker:prepare -- \
  --draft /path/to/reviewed-draft.json \
  --groups /path/to/reviewed-groups.jsonl \
  --output .artifacts/training/recall-reranker/datasets/candidate-v1

bun run train:reranker:validate -- \
  --dataset .artifacts/training/recall-reranker/datasets/candidate-v1

uv run --project training/recall-reranker --locked --offline \
  threadnote-reranker validate \
  --dataset .artifacts/training/recall-reranker/datasets/candidate-v1
```

The preparation command cannot grant source approvals, mark labels reviewed, or issue a validation receipt. It
compiles already reviewed inputs, injects the current frozen-holdout reservation, and runs the same privacy,
provenance, leakage, duplicate, and split checks. The separate TypeScript validator is the only receipt issuer.

## Dataset artifact contract

Each compiled dataset directory contains:

- `manifest.json`: source/license/privacy approvals, immutable revisions, split strategy, holdout reservations,
  checksums, semantic hash, and counts;
- `groups.jsonl`: complete query candidate sets with answerability, graded relevance, typed negative kinds, provenance,
  and review state; and
- `validation-receipt.json`: content-bound proof that the authoritative TypeScript validator checked the exact
  manifest and JSONL against the current policy and frozen holdout.

Any edit to the manifest, group file, validation policy, or reserved holdout invalidates the receipt. The Python
loader repeats integrity, privacy, source, split, and label checks before importing training dependencies, and the
trainer reopens the dataset from disk after verifying the pinned model snapshot offline.

## Verified smoke result

The checked setup has completed a real ModernBERT smoke fine-tune, F16 GGUF conversion with pinned `llama.cpp`
`571d0d540df04f25298d0e159e520d9fc62ed121`, and replay through Threadnote's isolated native runtime. The explicit
ModernBERT pair template avoids a duplicate separator produced by the generic node-llama-cpp fallback. On the
deterministic 16-pair fixture, maximum Python/native score error was `0.00142`, mean error was `0.00050`, and all 16
meaningful ordering comparisons passed. This proves the toolchain wiring; it says nothing about real model quality.
