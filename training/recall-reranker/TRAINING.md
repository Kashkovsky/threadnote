# Training the Threadnote recall reranker

This runbook describes the complete development workflow for Threadnote's compact recall cross-encoder: prepare a
content-addressed base model, build and approve a partitioned dataset, train without network access, calibrate on the
validation split, export with the exact `llama.cpp` revision used by Threadnote, and prove that Python and Threadnote's
isolated native runtime agree.

This is development tooling. Python and `uv` are used only under `training/recall-reranker/`; neither is part of the
Threadnote CLI, MCP server, or standalone release. An exported model remains a candidate until every release gate in
this document has passed.

The reviewed base candidate is `answerdotai/ModernBERT-base`. The configuration and all commands below are tied to
`training/recall-reranker/configs/modernbert-base-v1.json`; substituting another model is a new architecture review,
not a local command-line choice.

## Trust zones

Keep the workflow in four distinct zones:

1. **Online preparation, with no approved dataset mounted or loaded.** Install locked dependencies and fetch the exact
   pinned base-model snapshot and converter checkout.
2. **Dataset preparation and human review.** Build source records, partitions, query groups, and labels. Generate the
   content-addressed validation receipt with the authoritative TypeScript validator.
3. **Offline training and export.** Disable Hugging Face, Transformers, Datasets, and `uv` network access before the
   Python process reads the approved dataset.
4. **Evaluation.** Compare Python and isolated Threadnote scores, run the frozen recall gate, and collect cold-load,
   latency, RSS, and size evidence. Evaluation data must never flow back into training.

Do not collapse these zones into one long network-enabled process. A pinned revision makes an upstream artifact
repeatable; it does not make arbitrary downloaded code an appropriate peer for sensitive opt-in data.

## End-to-end workflow

Use the same order for a smoke run and a real-corpus run:

1. With no approved dataset mounted or loaded, install the locked environment, prepare the pinned ModernBERT snapshot,
   prepare the exact `llama.cpp` checkout, and record their revisions.
2. Disable network access and verify the cached snapshot again. Training also performs this cache-only verification
   before it opens the dataset.
3. Build the dataset, review its source/license/privacy evidence and every label, partition it by provenance boundary,
   and create the content-bound TypeScript validation receipt.
4. Run Python validation and training offline in a new output directory.
5. Export the saved model with the pinned, clean converter checkout.
6. Compare Python scores with Threadnote's isolated native runtime, then run the frozen recall evaluator.
7. Collect platform performance evidence and promote only after every gate passes.

The checked smoke corpus exercises this sequence with `--allow-smoke`; it is never training data and can never justify
artifact promotion. A real corpus uses the same commands without `--allow-smoke` and must meet the source, size,
review, split, evaluation, and performance requirements below.

## Prerequisites

- A clean Threadnote checkout at a committed revision. A release candidate must not be trained from an uncommitted
  harness.
- Bun matching `package.json` (currently `1.3.14`) and the repository dependencies installed from the Bun lockfile.
- `uv`, Git, and Python `3.12.*`. The training project pins direct dependencies in `pyproject.toml` and transitive
  dependencies in `uv.lock`.
- Enough free storage for the Hugging Face snapshot, checkpoints, exported GGUF, a `llama.cpp` checkout, and retained
  evidence. Keep each candidate in a new run directory; never reuse an interrupted run directory.
- A compatible Threadnote `node-llama-cpp` runtime. The current target is `3.19.1`.
- The pinned base model is Apache-2.0 ModernBERT-base at an immutable snapshot. The harness uses its native
  `ModernBertForSequenceClassification` head, an 8,192-token architecture context, and a reviewed 1,024-token training
  limit; the configured document guard additionally truncates source text at 4,000 characters.
- For the optional Gemma teacher, the pinned `gemma-4-e4b-it-q4` model installed and verified by Threadnote. Its
  manifest requires at least 8 GiB RAM and the GGUF is approximately 4.59 GB.

From the repository root:

```sh
git status --short
git rev-parse HEAD
bun install --frozen-lockfile
uv sync --project training/recall-reranker --locked
uv run --project training/recall-reranker --locked python --version
```

`git status --short` must be empty for a release training run. `uv run` commands in this runbook always use `--locked`;
the offline phase additionally uses `--offline`. Do not run `uv lock`, accept an automatic lock update, or install an
unrecorded package in the training environment.

Run the harness checks before spending time on a model:

```sh
uv run --project training/recall-reranker --locked \
  ruff check training/recall-reranker
uv run --project training/recall-reranker --locked \
  pytest training/recall-reranker/tests
bun --bun vitest run \
  test/unit/recall-reranker-training.test.ts \
  test/unit/recall-reranker-parity.test.ts \
  test/unit/effect-ai-isolated-runtime.test.ts
```

## Prepare and verify the pinned base snapshot

The current configuration is
`training/recall-reranker/configs/modernbert-base-v1.json`. It pins:

- Apache-2.0 `answerdotai/ModernBERT-base` at immutable revision
  `8949b909ec900327062f0ebf497f51aef5e6f0c8`;
- the exact six-file snapshot allowlist and aggregate SHA-256
  `ea751f494289bf014885cf135459708dc3da116ee551a1387d346205550eff88`;
- the training and runtime limits;
- `node-llama-cpp` `3.19.1`; and
- `llama.cpp` revision `571d0d540df04f25298d0e159e520d9fc62ed121` (`b10068`).

### Why ModernBERT replaced Jina

The initial `jinaai/jina-reranker-v1-turbo-en` experiment passed conversion and native loading, but failed the required
Python-versus-isolated-runtime score gate. On the deterministic validation fixture, 15 of 16 absolute-score comparisons
failed, maximum error was `0.24935`, and native probabilities collapsed into approximately `0.485..0.491`. The 22
meaningful pairwise orderings happened to survive, but ordering alone is insufficient for calibrated no-answer behavior
and stable score blending.

That result demonstrated that a successful GGUF conversion is not evidence that the bundled `llama.cpp` preserves a
model's trained sequence-classification semantics. ModernBERT was selected because pinned `llama.cpp` b10068 represents
the full `ModernBertForSequenceClassification` pooling and classification head natively. It still must pass the same
score and ordering parity gate; this architectural fit is not a waiver. Do not restore Jina without a reviewed runtime
change and fresh parity evidence.

The first command below is the only network-enabled base-model step. Run it **before** opening or mounting an approved
dataset. The snapshot helper downloads only the configured allowlist and rejects any byte mismatch.

```sh
TN_RERANKER_CONFIG=training/recall-reranker/configs/modernbert-base-v1.json

uv run --project training/recall-reranker --locked \
  threadnote-reranker prepare-base-model \
  --config "$TN_RERANKER_CONFIG" \
  --allow-network
```

Then disconnect the training environment from the network and prove that the same snapshot is present and valid using
cache-only resolution:

```sh
env HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 HF_DATASETS_OFFLINE=1 \
  uv run --project training/recall-reranker --locked --offline \
  threadnote-reranker prepare-base-model \
  --config "$TN_RERANKER_CONFIG"
```

`prepare-base-model` prints the reviewed model ID, revision, file count, and aggregate snapshot SHA only after all
configured files match. The trainer repeats the same cache-only verification before it loads dataset text, opens the
model from the verified local snapshot path, sets `local_files_only=True`, and sets `trust_remote_code=False`. Keep
`HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`, `HF_DATASETS_OFFLINE=1`, and `uv --offline` set for the training command.
Do not fall back to a network fetch after the dataset has been loaded.

If the snapshot digest differs, stop. Do not replace `snapshotSha256` with the newly observed value. First establish
whether the wrong revision, a partial cache entry, or an upstream artifact change caused the mismatch, then review any
intentional pin change as code.

## Data policy

The versioned contract lives in `scripts/training/recall-reranker-contract.ts`; the executable acquisition and review
playbook lives in `DATASET_PREPARATION.md`, with a shorter source policy in `DATA.md`. One JSONL row is a complete query
group rather than an independent pair, so answerability and the whole candidate slate remain available for
calibration.

### Allowed sources

- Original, fictional Threadnote-owned engineering scenarios.
- Pinned snapshots of repositories or datasets whose applicable licenses explicitly permit the intended training and
  model distribution. Exclude vendored and separately licensed subtrees.
- Public technical-support material only after source-document rights, duplicates, products, and split boundaries have
  been reviewed.
- Explicitly opted-in, already-sanitized contributions with a durable consent reference and a reviewed redistribution
  decision.
- Deterministic teacher suggestions derived solely from an already approved source set, after independent human review.
  The teacher is a labeling assistant, not a new source of truth.

Each source record must identify its immutable revision, applicable license and URL, provenance, privacy basis,
training approval, and redistribution approval. Preserve stronger evidence—license-file hash, content hash,
transformation revision, generator or teacher identity and terms, and reviewer decision—in the ingestion record even
where the v1 manifest currently represents part of it as reviewed provenance text.

### Prohibited sources

- Private Threadnote memories, team shares, customer code, secrets, credentials, raw production logs, or unconsented
  telemetry.
- The frozen recall fixture, checked baselines, parity fixtures, or any other release evaluation material. Do not mine
  negatives from them and do not show them to a teacher model.
- Unfiltered public GitHub, CodeSearchNet, SWE-bench, Stack Exchange derivatives, or any corpus whose row-level rights
  have not been reviewed. “Public” is not a license.
- MS MARCO or ORCAS for a distributable commercial model under their current non-commercial research terms.
- An unjudged retrieval result labeled as a negative merely because it was not selected.
- Teacher-generated facts, invented citations, or synthetic labels as the sole evidence for final quality.
- Query fingerprints from Threadnote feedback. They do not contain recoverable, consented query text.

## Build an approved dataset and validation receipt

Start with the checked smoke corpus to verify wiring:

```sh
bun run train:reranker:data
bun run train:reranker:validate

uv run --project training/recall-reranker --locked --offline \
  threadnote-reranker validate \
  --dataset .artifacts/training/recall-reranker/datasets/smoke-v1
```

The builder creates `manifest.json` and `groups.jsonl`. The TypeScript validator creates
`validation-receipt.json`. The Python loader refuses to open a dataset without a receipt bound to:

- the exact manifest bytes;
- the exact JSONL file and canonical group hashes;
- the current validation-policy file;
- the current frozen recall-v2 identity; and
- the normalized forbidden-text set derived from that holdout.

For a real candidate, use `bun run train:reranker:prepare` with the reviewed draft and JSONL templates described in
`DATASET_PREPARATION.md`, or write a deterministic source-specific importer that feeds the same pure compiler. Do not
generate a receipt yourself. Every group must have a stable source, partition, split, query, answerability, and 2–32
candidates. Relevance is graded `0..3`; every candidate label must be reviewed. Relevant candidates cannot declare a
negative kind; grade-zero candidates must declare one of the contract's typed negative kinds.

Partition before producing pairs:

- Keep an organization, repository, product, fictional company, fork family, version lineage, and near-duplicate group
  in one split.
- Keep all paraphrases and candidate variants derived from the same source record in that partition.
- Use validation only for model selection and answerability calibration.
- Open the test split only for the final candidate evaluation. Never tune against its failures.

Validate a real dataset as follows:

```sh
TN_RERANKER_DATASET=.artifacts/training/recall-reranker/datasets/candidate-v1

bun run train:reranker:validate -- --dataset "$TN_RERANKER_DATASET"
uv run --project training/recall-reranker --locked --offline \
  threadnote-reranker validate --dataset "$TN_RERANKER_DATASET"
```

Any edit to `manifest.json`, `groups.jsonl`, or the validation policy invalidates the receipt. Rerun the TypeScript
validator after an intentional dataset edit. Never hand-edit `validation-receipt.json` and never weaken the policy to
make a corpus pass.

## Optional future/manual Gemma 4 teacher workflow

The installed Threadnote generation candidate `gemma-4-e4b-it-q4` can propose queries, relevance grades, negative
types, and no-answer cases for already approved documents. This is an optional future/manual labeling path, not the
shipped ranker and not a required training stage. The current training harness deliberately has no teacher-data CLI;
do not invent one in automation or documentation. Any future adapter must use Threadnote's selected local generation
model rather than a remote API and must preserve the review boundary below.

Verify the installed model before starting:

```sh
threadnote models list
threadnote models verify gemma-4-e4b-it-q4
threadnote models select generation gemma-4-e4b-it-q4
threadnote models runtime
```

Use one fixed prompt version, one fixed JSON Schema, `seed: 40000`, temperature zero (Threadnote structured generation
uses zero), a fixed maximum-token budget, and candidates sorted by stable ID. Record the following with each suggestion:

- teacher model ID, manifest revision and GGUF SHA-256;
- prompt version and SHA-256;
- JSON-Schema version and SHA-256;
- seed, maximum tokens, source IDs, and ordered candidate IDs;
- raw output SHA-256, generation timestamp, reviewer, and review disposition; and
- the Gemma terms applicable to the model and generated output.

A suitable fixed system prompt is:

```text
You are Threadnote dataset-labeling assistant v1. Use only the supplied approved evidence.
Return exactly one JSON value matching the supplied schema. Do not invent facts, paths,
identifiers, citations, policies, or candidates. Preserve candidate IDs exactly. A relevance
grade is a proposal, not approval. If the evidence cannot support an answer, choose no_answer.
Do not quote or reconstruct secrets or personal data. Give a short evidence-based rationale
for a human reviewer; never mark the record reviewed.
```

Use a closed schema such as:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "additionalProperties": false,
  "required": ["version", "query", "answerability", "candidates", "reviewNotes"],
  "properties": {
    "version": {"const": 1},
    "query": {"type": "string", "minLength": 1},
    "answerability": {"enum": ["answerable", "no_answer"]},
    "candidates": {
      "type": "array",
      "minItems": 2,
      "maxItems": 32,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["candidateId", "relevance", "negativeKind", "rationale"],
        "properties": {
          "candidateId": {"type": "string", "minLength": 1},
          "relevance": {"type": "integer", "minimum": 0, "maximum": 3},
          "negativeKind": {
            "type": ["string", "null"],
            "enum": [
              null,
              "adversarial",
              "cross_repository",
              "lexical_hard",
              "low_authority",
              "no_answer_distractor",
              "random",
              "semantic_hard",
              "stale",
              "wrong_scope",
              "wrong_version"
            ]
          },
          "rationale": {"type": "string", "minLength": 1, "maxLength": 500}
        }
      }
    },
    "reviewNotes": {"type": "string", "maxLength": 1000}
  }
}
```

Store teacher suggestions outside the approved dataset, for example as `teacher-suggestions.jsonl` in a private
staging area. A human reviewer must compare every proposed query and label with the original approved evidence,
correct or reject it, check answerability independently, and assign the final partition. Only the reviewed transform
may set `reviewed: true` and enter `groups.jsonl`. Never preserve a teacher rationale as factual provenance without
checking it, and never let teacher-generated data enter the frozen test set automatically.

## Train offline

Use a new directory for every attempt:

```sh
TN_RERANKER_DATASET=.artifacts/training/recall-reranker/datasets/candidate-v1
TN_RERANKER_RUN=.artifacts/training/recall-reranker/runs/candidate-v1
TN_RERANKER_CONFIG=training/recall-reranker/configs/modernbert-base-v1.json

env HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 HF_DATASETS_OFFLINE=1 \
  uv run --project training/recall-reranker --locked --offline \
  threadnote-reranker train \
  --dataset "$TN_RERANKER_DATASET" \
  --config "$TN_RERANKER_CONFIG" \
  --output "$TN_RERANKER_RUN"
```

On Apple Silicon, the trainer selects MPS when available. `--device cpu` is slower but is the preferred deterministic
diagnostic when investigating score drift. Do not use `--allow-smoke` for a candidate; that flag exists only to prove
that the tiny self-authored smoke corpus can traverse the whole harness.

The trainer uses pointwise relevance targets (`grade / 3`), binary cross-entropy, a positive weight derived from the
training split, deterministic seeds, and the pinned configuration. It emits:

- `model/` and `checkpoints/`;
- `scores-validation.jsonl` and `scores-test.jsonl`;
- `calibration.json` and `evaluation.json`; and
- `run.json` with dataset, dependency, configuration, and source provenance.

Treat a partial or failed output directory as contaminated. Keep it for diagnosis if useful, but choose a new output
directory for the next run. Do not export a checkpoint paired with an older `run.json`.

## Calibration and held-out metrics

Training automatically fits the answerability calibrator on validation scores and evaluates it on test scores. The
features are the top candidate score, top-score margin, and mean of the top three scores. The test split is not used to
select the threshold.

The standalone commands are useful for reproducing those steps:

```sh
env HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 HF_DATASETS_OFFLINE=1 \
  uv run --project training/recall-reranker --locked --offline \
  threadnote-reranker calibrate \
  --scores "$TN_RERANKER_RUN/scores-validation.jsonl" \
  --output "$TN_RERANKER_RUN/calibration-reproduced.json"

env HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 HF_DATASETS_OFFLINE=1 \
  uv run --project training/recall-reranker --locked --offline \
  threadnote-reranker evaluate \
  --scores "$TN_RERANKER_RUN/scores-test.jsonl" \
  --calibration "$TN_RERANKER_RUN/calibration-reproduced.json" \
  --split test \
  --output "$TN_RERANKER_RUN/evaluation-reproduced.json"
```

Compare the reproduced files with the originals and retain Recall@1/5/10, MRR, NDCG@5/10, no-answer precision,
recall, F1, accuracy, and confusion counts. Do not optimize only no-answer F1; false no-answer and false-answer costs
must be reviewed separately.

The Python calibration artifact is not currently consumed by the production TypeScript recall runtime. It remains a
research candidate until a versioned TypeScript decoder implements the same feature order, normalization, sigmoid,
threshold rule, and Python-versus-TypeScript parity tests. The existing native parity gate below validates reranker
scores, not the Python calibration decision.

## Export GGUF with the exact converter

Prepare the converter during the online, no-data phase. The checkout must be detached at the configured commit and
completely clean:

```sh
TN_LLAMA_CPP=.artifacts/training/recall-reranker/toolchains/llama.cpp-b10068

git clone --no-checkout https://github.com/ggml-org/llama.cpp.git "$TN_LLAMA_CPP"
git -C "$TN_LLAMA_CPP" fetch --depth 1 origin 571d0d540df04f25298d0e159e520d9fc62ed121
git -C "$TN_LLAMA_CPP" checkout --detach FETCH_HEAD
git -C "$TN_LLAMA_CPP" rev-parse HEAD
git -C "$TN_LLAMA_CPP" status --short
```

The revision must match exactly and the final status command must print nothing. Export rejects a different or dirty
checkout. It verifies the saved one-label `ModernBertForSequenceClassification` architecture and uses the converter's
native ModernBERT sequence-classification path without rewriting the model configuration or tensors. It supports only
reviewed output types (currently `f16`), checks the GGUF header, and records artifact and converter hashes.

```sh
TN_RERANKER_GGUF="$TN_RERANKER_RUN/threadnote-reranker.f16.gguf"

uv run --project training/recall-reranker --locked --offline \
  threadnote-reranker export \
  --run "$TN_RERANKER_RUN" \
  --config "$TN_RERANKER_CONFIG" \
  --llama-cpp "$TN_LLAMA_CPP" \
  --output "$TN_RERANKER_GGUF"
```

Export creates:

- the GGUF;
- `${TN_RERANKER_GGUF}.manifest.json`, the conversion/provenance record; and
- `${TN_RERANKER_GGUF}.model.json`, the normal Threadnote local-model manifest.

Conversion deliberately leaves `releaseEligible: false`.

### Full smoke wiring check

After the snapshot, smoke dataset, and converter checkout are prepared, the following exercises training, export, and
native parity end to end. Choose a new run directory on every attempt:

```sh
TN_RERANKER_DATASET=.artifacts/training/recall-reranker/datasets/smoke-v1
TN_RERANKER_RUN=.artifacts/training/recall-reranker/runs/smoke-modernbert-v1
TN_RERANKER_CONFIG=training/recall-reranker/configs/modernbert-base-v1.json
TN_RERANKER_GGUF="$TN_RERANKER_RUN/threadnote-reranker.f16.gguf"

env HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 HF_DATASETS_OFFLINE=1 \
  uv run --project training/recall-reranker --locked --offline \
  threadnote-reranker train \
  --dataset "$TN_RERANKER_DATASET" \
  --config "$TN_RERANKER_CONFIG" \
  --output "$TN_RERANKER_RUN" \
  --allow-smoke

uv run --project training/recall-reranker --locked --offline \
  threadnote-reranker export \
  --run "$TN_RERANKER_RUN" \
  --config "$TN_RERANKER_CONFIG" \
  --llama-cpp "$TN_LLAMA_CPP" \
  --output "$TN_RERANKER_GGUF"

env HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 HF_DATASETS_OFFLINE=1 \
  uv run --project training/recall-reranker --locked --offline \
  python -m threadnote_reranker_training.parity \
  --run "$TN_RERANKER_RUN" \
  --dataset "$TN_RERANKER_DATASET" \
  --config "$TN_RERANKER_CONFIG" \
  --output "$TN_RERANKER_RUN/python-parity.json" \
  --maximum-groups 8

bun run train:reranker:parity -- \
  --fixture "$TN_RERANKER_RUN/python-parity.json" \
  --manifest "${TN_RERANKER_GGUF}.model.json" \
  --model "$TN_RERANKER_GGUF" \
  --output "$TN_RERANKER_RUN/native-parity.json"
```

This check must pass exact artifact bindings and native parity, but its tiny self-authored labels cannot establish recall
quality, calibration quality, performance, or release readiness. Run the real-corpus flow without `--allow-smoke` and
apply every remaining gate.

## Generate Python parity evidence

Generate a deterministic, answerability-stratified sample from the validation split with the saved Python model:

```sh
TN_PARITY_FIXTURE="$TN_RERANKER_RUN/python-parity.json"

env HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 HF_DATASETS_OFFLINE=1 \
  uv run --project training/recall-reranker --locked --offline \
  python -m threadnote_reranker_training.parity \
  --run "$TN_RERANKER_RUN" \
  --dataset "$TN_RERANKER_DATASET" \
  --config "$TN_RERANKER_CONFIG" \
  --output "$TN_PARITY_FIXTURE" \
  --maximum-groups 8
```

The parity fixture contains exact validation queries and documents. It inherits the dataset's sensitivity and must not
be published merely because it is an evaluation artifact. The generator binds the fixture to the dataset, run JSON,
model-tree hash, configuration, source revision, and Python library versions.

Replay those exact pairs through Threadnote's supervised isolated inference worker:

```sh
bun run train:reranker:parity -- \
  --fixture "$TN_PARITY_FIXTURE" \
  --manifest "${TN_RERANKER_GGUF}.model.json" \
  --model "$TN_RERANKER_GGUF" \
  --output "$TN_RERANKER_RUN/native-parity.json"
```

The current default gates are maximum absolute score error `0.02` and minimum Python ordering gap `0.01`. The gate
checks every absolute error and every sufficiently separated within-group ordering. A failed comparison is a failed
artifact. Do not relax thresholds to make one candidate pass; a threshold change needs a reviewed rationale, a
versioned policy, and retained before/after evidence.

Threadnote supplies the exact ModernBERT pair template `[CLS]{{query}}[SEP]{{document}}[SEP]` when it creates the
native ranking context. The generic node-llama-cpp fallback inserts both EOS and SEP between pair members; for this
tokenizer they are the same token, which duplicates the separator and changes scores. A runtime regression test keeps
the explicit template in place. The completed smoke run measured maximum absolute error `0.00142`, mean error
`0.00050`, and zero failures across 16 meaningful ordering comparisons. These numbers prove toolchain parity only;
they are not a model-quality result.

## Run the frozen recall evaluation

Run the candidate through the same frozen recall-v2 fixture and non-inferiority gate used by Threadnote model
evaluation. This command verifies the GGUF size and SHA-256, parses the production model manifest, and invokes the
isolated `LocalModelRuntime.rerank` path:

```sh
bun run eval:recall:models -- \
  --reranker-manifest "${TN_RERANKER_GGUF}.model.json" \
  --reranker-path "$TN_RERANKER_GGUF" \
  --output "$TN_RERANKER_RUN/recall-v2.json" \
  --summary-output "$TN_RERANKER_RUN/recall-v2-summary.json" \
  --fail-on-regression
```

Keep this fixture evaluation-only. A failure may justify changing the model, training data, or training procedure, but
the failed fixture examples must not be copied into training or used to mine negatives. Make a bounded hypothesis,
change the training process using training/validation evidence, and run the test gate again only when a new candidate
is ready.

The frozen recall gate and score parity do not replace production-runtime measurements. Before release, retain cold
load time, warm and cold rerank latency, throughput for realistic shortlist sizes, peak RSS, artifact size, interruption
behavior, and lexical-only fallback behavior on each supported release platform. There is not yet one checked-in
command that promotes an artifact after all of these gates; release approval remains an explicit reviewed decision.

## Artifact promotion criteria

The export manifest intentionally says `releaseEligible: false`; conversion cannot promote itself. Promotion is a
separate reviewed source change that adds the candidate to Threadnote's signed model catalog only after all of the
following evidence refers to the same content-addressed run:

- approved dataset provenance, privacy, license, consent, redistribution, and partition review;
- the authoritative TypeScript receipt and independent Python validation;
- held-out ranking and no-answer metrics selected without test-set tuning;
- Python-versus-isolated-native absolute-score and ordering parity at the checked thresholds;
- frozen recall-v2 non-inferiority with no-answer behavior reviewed explicitly;
- cold load, warm/cold latency, throughput, peak RSS, model size, interruption, and lexical fallback evidence on every
  supported release platform;
- immutable training source, dependency lock, base snapshot, `llama.cpp` converter, model tree, GGUF, manifest, and
  result hashes; and
- reviewed base-model, dataset, derivative-model, notice, and distribution terms.

A promotion review must fail closed if evidence is absent, hash bindings disagree, a runtime/backend was not tested,
or privacy-safe aggregate results are insufficient to explain a regression. Never hand-edit the generated candidate
manifest to set release eligibility.

## Inspect and retain provenance

At minimum, inspect the following before proposing a model:

```sh
git status --short
git rev-parse HEAD
shasum -a 256 \
  "$TN_RERANKER_DATASET/manifest.json" \
  "$TN_RERANKER_DATASET/groups.jsonl" \
  "$TN_RERANKER_DATASET/validation-receipt.json" \
  "$TN_RERANKER_RUN/run.json" \
  "$TN_RERANKER_RUN/calibration.json" \
  "$TN_RERANKER_RUN/evaluation.json" \
  "$TN_PARITY_FIXTURE" \
  "$TN_RERANKER_RUN/native-parity.json" \
  "$TN_RERANKER_GGUF" \
  "${TN_RERANKER_GGUF}.manifest.json" \
  "${TN_RERANKER_GGUF}.model.json" \
  "$TN_RERANKER_RUN/recall-v2-summary.json"
```

Review, rather than merely archive:

- source licenses, approvals, consent references, revisions, and transformation provenance;
- split counts, answerability balance, relevance/negative-type distributions, and budget hits;
- the validation receipt's manifest, policy, group, forbidden-text, and holdout bindings;
- base-model ID, revision, snapshot hash, training configuration hash, dependency versions, and source commit;
- calibration and held-out metrics, including confusion counts;
- model-tree, GGUF, converter-source, local-model-manifest, parity-fixture, and parity-result hashes; and
- frozen recall gate result plus platform performance and reliability evidence.

Do not publish a validation/parity fixture or raw teacher output from an opt-in dataset. Release evidence can contain
hashes, aggregate metrics, model metadata, and reviewed privacy-safe diagnostics without exposing source text.

## Troubleshooting

### `Dataset requires the TypeScript validation receipt`

Run `bun run train:reranker:validate -- --dataset <directory>`. If validation fails, repair the dataset; do not create
the receipt by hand. The receipt must be regenerated after every manifest or JSONL change.

### Validation policy or frozen-holdout mismatch

The checked policy no longer matches the generated recall-v2 fixture. Stop and review the source change. A frozen
fixture must not change silently; use a versioned replacement and reviewed baseline migration.

### Base snapshot missing while offline

Do not reconnect after approved data is loaded. Unmount or close the dataset, return to the online preparation zone,
run the pinned snapshot preparation command, then repeat the cache-only verification before reopening the data.

### Base snapshot digest mismatch

Do not update the expected hash reflexively. Confirm the repository ID, immutable revision, configured allowlist, and
cache contents. Treat an intentional upstream-byte change as a new reviewed base snapshot and configuration revision.

### Wrong Transformers API or missing `accelerate`

The process is not using the checked lock environment. Run `uv sync --project training/recall-reranker --locked` and
then `uv run ... --locked`. Do not solve the error with an ad hoc `pip install`.

### MPS failure or unexplained score drift

Repeat the smallest smoke or parity run with `--device cpu`. Keep the original artifacts, record both devices and
library versions, and do not compare files that came from different model-tree hashes.

### Output directory already contains an earlier run

Choose a new run ID and directory. The harness writes checkpoints, weights, scores, and metadata at different stages;
reusing an interrupted directory can mix generations.

### Export rejects the converter checkout

Confirm the exact commit and an empty `git status --short`. Do not patch the converter in place. Any converter change
needs a reviewed revision, content hash, conversion test, and fresh parity evidence.

### Export reports an unsupported ModernBERT architecture or head

The exporter accepts only the reviewed one-label `ModernBertForSequenceClassification` layout and does not rewrite its
configuration or tensors. Stop instead of weakening the check. Inspect the saved model configuration and compare it
with the pinned base snapshot. Any new layout requires a versioned architecture review, converter tests, and fresh
Python-versus-native parity evidence.

### Native parity fails

Confirm that the parity fixture, run JSON, model tree, local-model manifest, GGUF, and configuration hashes all refer to
the same run. Confirm `nodeLlamaCpp` is `3.19.1` and rerun on CPU to separate backend drift from conversion drift. Keep
the failed evidence. Do not normalize away the error or raise thresholds without review.

### Frozen recall non-inferiority fails

The model is not a release candidate. Inspect aggregate categories and failure codes without copying holdout examples
into training. Preserve lexical-only fallback and return to approved training/validation evidence.

## Release checklist

- [ ] Training harness source is committed; `git status --short` is empty.
- [ ] Bun and Python dependencies match checked lockfiles; every `uv` command used `--locked`.
- [ ] The pinned base snapshot passed online preparation and offline cache-only verification before data was loaded.
- [ ] Any teacher used the pinned local Gemma manifest, fixed prompt/schema/seed, and no network.
- [ ] Every teacher suggestion and every positive or negative label received independent human review.
- [ ] Every source has reviewed privacy, license, training, redistribution, revision, and provenance evidence.
- [ ] Repository/company/product/fork/version/near-duplicate partitions do not cross splits.
- [ ] The current TypeScript validator produced an unedited receipt bound to the exact dataset and frozen holdout.
- [ ] Training ran offline in a fresh directory; `run.json`, scores, calibration, evaluation, and model files are intact.
- [ ] Validation selected calibration/model choices; test data was opened only for the final candidate evaluation.
- [ ] Calibration metrics and false-answer/no-answer tradeoffs passed reviewed thresholds.
- [ ] The exact clean `llama.cpp` revision produced the GGUF and converter provenance record.
- [ ] Python-versus-isolated-Threadnote score and ordering parity passed without relaxed thresholds.
- [ ] Frozen recall-v2 non-inferiority passed with `--fail-on-regression`.
- [ ] Cold-load, latency, throughput, RSS, size, interruption, and fallback evidence passed on supported platforms.
- [ ] All retained hashes bind the same dataset, source revision, run, model tree, converter, GGUF, manifests, and gates.
- [ ] Sensitive validation/parity text and teacher outputs remain private; public evidence contains only reviewed safe data.
- [ ] The final model license, notices, distribution terms, model card, signed hashes, rollback, and lexical fallback have
      been reviewed.
- [ ] No artifact is marked or advertised release-ready solely because training or GGUF conversion completed.
