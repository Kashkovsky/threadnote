from __future__ import annotations

import importlib.metadata
import platform
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .calibration import fit_answerability_calibration
from .configuration import HarnessConfig
from .dataset import DatasetBundle, candidate_pairs, load_dataset, pair_rows
from .io import atomic_write_json, atomic_write_jsonl
from .metrics import evaluate_scores
from .model_snapshot import prepare_base_model_snapshot
from .parity import model_tree_sha256
from .provenance import file_sha256, git_source_state

MINIMUM_RELEASE_TRAIN_GROUPS = 5_000
MINIMUM_RELEASE_TRAIN_ANSWERABILITY_GROUPS = 500


def train(
    dataset_path: str | Path,
    config: HarnessConfig,
    output: str | Path,
    *,
    allow_smoke: bool,
    device: str | None = None,
) -> dict[str, Any]:
    # Resolve and verify the reviewed snapshot before any dataset text is loaded.
    # Training then remains offline and never executes remotely fetched code next
    # to a private or opt-in corpus.
    base_model_snapshot = prepare_base_model_snapshot(config, allow_network=False)
    dataset = load_dataset(dataset_path)
    if dataset.purpose == "evaluation_holdout":
        raise ValueError("Evaluation holdouts can never be used for training.")
    if dataset.purpose == "harness_smoke" and not allow_smoke:
        raise ValueError("Smoke data is not training data; pass --allow-smoke only to verify harness wiring.")

    try:
        import torch
        from datasets import Dataset
        from sentence_transformers.cross_encoder import (
            CrossEncoder,
            CrossEncoderTrainer,
            CrossEncoderTrainingArguments,
        )
        from sentence_transformers.cross_encoder.losses import BinaryCrossEntropyLoss
        from transformers import set_seed
    except ImportError as cause:
        raise RuntimeError("Training dependencies are not installed; run uv sync --locked for this project.") from cause

    root = Path(output).resolve()
    if root.exists() and any(root.iterdir()):
        raise ValueError(f"Training output directory must be new or empty: {root}")
    root.mkdir(parents=True, exist_ok=True)
    model_path = root / "model"
    checkpoints = root / "checkpoints"
    parameters = config.training
    source_state = git_source_state(config.source)
    selected_device = device or ("mps" if torch.backends.mps.is_available() else "cpu")
    set_seed(parameters.seed)
    torch.manual_seed(parameters.seed)

    train_rows = pair_rows(dataset, "train", config.runtime_target.document_character_limit)
    validation_rows = pair_rows(dataset, "validation", config.runtime_target.document_character_limit)
    positives = sum(row["label"] > 0 for row in train_rows)
    negatives = len(train_rows) - positives
    if positives == 0 or negatives == 0:
        raise ValueError("Training split requires positive and negative pairs.")

    model = CrossEncoder(
        str(base_model_snapshot),
        device=selected_device,
        local_files_only=True,
        max_length=parameters.max_length,
        num_labels=1,
        trust_remote_code=False,
        model_kwargs={"dtype": torch.float32},
    )
    loss = BinaryCrossEntropyLoss(model=model, pos_weight=torch.tensor(negatives / positives))
    arguments = CrossEncoderTrainingArguments(
        output_dir=str(checkpoints),
        data_seed=parameters.seed,
        dataloader_num_workers=0,
        dataloader_pin_memory=False,
        eval_strategy="epoch",
        gradient_accumulation_steps=parameters.gradient_accumulation_steps,
        learning_rate=parameters.learning_rate,
        logging_first_step=True,
        logging_steps=max(1, len(train_rows) // max(parameters.batch_size * 4, 1)),
        num_train_epochs=parameters.epochs,
        per_device_eval_batch_size=parameters.batch_size,
        per_device_train_batch_size=parameters.batch_size,
        report_to="none",
        save_strategy="epoch",
        save_total_limit=2,
        seed=parameters.seed,
        warmup_ratio=parameters.warmup_ratio,
        weight_decay=parameters.weight_decay,
    )
    trainer = CrossEncoderTrainer(
        model=model,
        args=arguments,
        train_dataset=Dataset.from_list(train_rows),
        eval_dataset=Dataset.from_list(validation_rows),
        loss=loss,
    )
    trainer.train()
    model.save_pretrained(str(model_path))

    validation_scores = score_split(
        model,
        dataset,
        "validation",
        config.runtime_target.document_character_limit,
        parameters.batch_size,
    )
    calibration = fit_answerability_calibration(validation_scores)
    test_scores = score_split(
        model,
        dataset,
        "test",
        config.runtime_target.document_character_limit,
        parameters.batch_size,
    )
    evaluation = evaluate_scores(test_scores, calibration)
    atomic_write_jsonl(root / "scores-validation.jsonl", validation_scores)
    atomic_write_jsonl(root / "scores-test.jsonl", test_scores)
    atomic_write_json(root / "calibration.json", calibration.to_json())
    atomic_write_json(root / "evaluation.json", evaluation)

    train_groups = dataset.groups_for_split("train")
    train_answerable = sum(group["answerability"] == "answerable" for group in train_groups)
    train_no_answer = len(train_groups) - train_answerable
    dataset_scale_eligible = (
        dataset.purpose == "training_candidate"
        and len(train_groups) >= MINIMUM_RELEASE_TRAIN_GROUPS
        and train_answerable >= MINIMUM_RELEASE_TRAIN_ANSWERABILITY_GROUPS
        and train_no_answer >= MINIMUM_RELEASE_TRAIN_ANSWERABILITY_GROUPS
    )
    manifest_path = dataset.root / "manifest.json"
    receipt_path = dataset.root / "validation-receipt.json"
    model_sha256 = model_tree_sha256(model_path)
    run = {
        "version": 2,
        "createdAt": datetime.now(UTC).isoformat(),
        "baseModel": {
            "id": config.base_model.id,
            "license": config.base_model.license,
            "revision": config.base_model.revision,
            "snapshotFiles": len(config.base_model.snapshot_files),
            "snapshotSha256": config.base_model.snapshot_sha256,
        },
        "configurationSha256": config.sha256,
        "dataset": {
            "groupFileSha256": dataset.manifest["groupFileSha256"],
            "groups": len(dataset.groups),
            "groupsSha256": dataset.groups_sha256,
            "manifestSha256": file_sha256(manifest_path),
            "name": dataset.manifest["name"],
            "purpose": dataset.purpose,
            "validationReceipt": {
                "manifestSha256": dataset.validation_receipt["manifestSha256"],
                "sha256": file_sha256(receipt_path),
                "validatorId": dataset.validation_receipt["validatorId"],
            },
        },
        "datasetScaleEligible": dataset_scale_eligible,
        "device": selected_device,
        "evaluation": evaluation,
        "evaluationArtifacts": {
            "calibrationSha256": file_sha256(root / "calibration.json"),
            "evaluationSha256": file_sha256(root / "evaluation.json"),
            "testScoresSha256": file_sha256(root / "scores-test.jsonl"),
            "validationScoresSha256": file_sha256(root / "scores-validation.jsonl"),
        },
        "libraries": _library_versions(),
        "modelDirectory": "model",
        "modelTreeSha256": model_sha256,
        "releaseEligible": False,
        "releaseBlockers": [
            *(
                []
                if dataset_scale_eligible
                else ["Training data has not met the minimum reviewed train-split scale and answerability balance."]
            ),
            *(
                ["Training source tree was dirty; use its content hash only for local smoke provenance."]
                if source_state.dirty
                else []
            ),
            "GGUF conversion and node-llama-cpp parity gates have not run.",
        ],
        "trainingCodeRevision": source_state.revision,
        "trainingSource": {
            "dirty": source_state.dirty,
            "fileCount": source_state.file_count,
            "sha256": source_state.content_sha256,
        },
    }
    atomic_write_json(root / "run.json", run)
    return run


def score_split(
    model: Any,
    dataset: DatasetBundle,
    split: str,
    document_character_limit: int,
    batch_size: int,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for group in dataset.groups_for_split(split):
        scores = model.predict(
            candidate_pairs(group, document_character_limit),
            batch_size=batch_size,
            convert_to_numpy=True,
            show_progress_bar=False,
        )
        flattened = scores.reshape(-1).tolist() if hasattr(scores, "reshape") else list(scores)
        if len(flattened) != len(group["candidates"]):
            raise RuntimeError(f"Model returned the wrong score count for {group['id']}.")
        rows.append(
            {
                "answerability": group["answerability"],
                "candidates": [
                    {
                        "id": candidate["id"],
                        "relevance": candidate["relevance"],
                        "score": float(score),
                    }
                    for candidate, score in zip(group["candidates"], flattened, strict=True)
                ],
                "groupId": group["id"],
                "split": split,
            }
        )
    return rows


def _library_versions() -> dict[str, str]:
    return {
        name: importlib.metadata.version(name)
        for name in ("accelerate", "datasets", "huggingface-hub", "sentence-transformers", "torch", "transformers")
    } | {"python": platform.python_version()}
