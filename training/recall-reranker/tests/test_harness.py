from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from threadnote_reranker_training.calibration import (
    answerability_probability,
    fit_answerability_calibration,
    parse_calibration,
)
from threadnote_reranker_training.configuration import load_config
from threadnote_reranker_training.dataset import load_dataset, normalize_text
from threadnote_reranker_training.export import stage_model_for_conversion, validate_export_run
from threadnote_reranker_training.io import canonical_groups_sha256, sha256_bytes
from threadnote_reranker_training.metrics import evaluate_scores
from threadnote_reranker_training.parity import model_tree_sha256
from threadnote_reranker_training.provenance import file_sha256
from threadnote_reranker_training.trainer import train


def test_loads_partitioned_dataset_and_rejects_checksum_tampering(tmp_path: Path) -> None:
    root = _write_dataset(tmp_path)
    dataset = load_dataset(root)

    assert len(dataset.groups) == 6
    assert dataset.purpose == "harness_smoke"
    assert len(dataset.groups_for_split("validation")) == 2

    group_file = root / "groups.jsonl"
    group_file.write_text(group_file.read_text(encoding="utf-8") + "\n", encoding="utf-8")
    with pytest.raises(ValueError, match="checksum"):
        load_dataset(root)


def test_rejects_cross_split_document_leakage(tmp_path: Path) -> None:
    root = _write_dataset(tmp_path)
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    groups = _read_groups(root)
    groups[-1]["candidates"][0]["text"] = groups[0]["candidates"][0]["text"]
    _rewrite(root, manifest, groups)

    with pytest.raises(ValueError, match="document leaks"):
        load_dataset(root)


def test_requires_content_bound_typescript_validation_receipt(tmp_path: Path) -> None:
    root = _write_dataset(tmp_path)
    (root / "validation-receipt.json").unlink()
    with pytest.raises(ValueError, match="TypeScript validation receipt"):
        load_dataset(root)

    root = _write_dataset(tmp_path)
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    manifest["description"] = "Changed after validation."
    (root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    with pytest.raises(ValueError, match="exact manifest content"):
        load_dataset(root)


def test_train_reopens_dataset_instead_of_trusting_an_in_memory_bundle(tmp_path: Path) -> None:
    root = _write_dataset(tmp_path)
    load_dataset(root)
    (root / "validation-receipt.json").unlink()
    config = load_config(Path(__file__).parents[1] / "configs" / "modernbert-base-v1.json")

    with pytest.raises(ValueError, match="TypeScript validation receipt"):
        train(root, config, tmp_path / "run", allow_smoke=True, device="cpu")


def test_rejects_unreviewed_negative_labels(tmp_path: Path) -> None:
    root = _write_dataset(tmp_path)
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    groups = _read_groups(root)
    groups[0]["candidates"][1]["reviewed"] = False
    _rewrite(root, manifest, groups)

    with pytest.raises(ValueError, match="unreviewed"):
        load_dataset(root)


def test_matches_shared_non_ascii_canonicalization_vectors() -> None:
    fixture = json.loads(
        (Path(__file__).parents[1] / "fixtures" / "canonicalization-v1.json").read_text(encoding="utf-8")
    )

    assert [normalize_text(vector["input"]) for vector in fixture["normalization"]] == [
        vector["output"] for vector in fixture["normalization"]
    ]
    assert [
        group["id"] for group in sorted(fixture["canonicalGroups"], key=lambda group: group["id"].encode("utf-8"))
    ] == fixture["sortedIds"]
    assert canonical_groups_sha256(fixture["canonicalGroups"]) == fixture["groupsSha256"]


def test_fits_no_answer_calibration_and_evaluates_rankings() -> None:
    rows = _score_rows("validation")
    calibration = fit_answerability_calibration(rows, iterations=2_000)
    parsed = parse_calibration(calibration.to_json())
    answerable = rows[0]
    no_answer = rows[1]

    assert answerability_probability(parsed, answerable) > answerability_probability(parsed, no_answer)
    assert parsed.validation_metrics["noAnswerF1"] == 1.0

    result = evaluate_scores(_score_rows("test"), parsed)
    assert result["recallAt1"] == 1.0
    assert result["meanReciprocalRank"] == 1.0
    assert result["answerability"]["noAnswerF1"] == 1.0


def test_pins_base_model_and_converter_revisions() -> None:
    config = load_config(Path(__file__).parents[1] / "configs" / "modernbert-base-v1.json")

    assert config.base_model.id == "answerdotai/ModernBERT-base"
    assert len(config.base_model.revision) == 40
    assert config.runtime_target.node_llama_cpp == "3.19.1"
    assert len(config.export.llama_cpp_revision) == 40


def test_accepts_only_the_native_modernbert_classification_head(tmp_path: Path) -> None:
    config = load_config(Path(__file__).parents[1] / "configs" / "modernbert-base-v1.json")
    model = tmp_path / "source-model"
    model.mkdir()
    original = {
        "architectures": ["ModernBertForSequenceClassification"],
        "id2label": {"0": "LABEL_0"},
        "label2id": {"LABEL_0": 0},
    }
    (model / "config.json").write_text(json.dumps(original), encoding="utf-8")
    (model / "model.safetensors").write_bytes(b"test weights")

    staged = stage_model_for_conversion(model, tmp_path / "unused-staging", config)

    assert staged == model
    assert json.loads((model / "config.json").read_text(encoding="utf-8")) == original
    assert (staged / "model.safetensors").read_bytes() == b"test weights"


def test_export_validates_model_run_source_and_evaluation_provenance(tmp_path: Path) -> None:
    config = load_config(Path(__file__).parents[1] / "configs" / "modernbert-base-v1.json")
    run_root = tmp_path / "run"
    model = run_root / "model"
    model.mkdir(parents=True)
    (model / "config.json").write_text("{}", encoding="utf-8")
    (model / "model.safetensors").write_bytes(b"trained weights")
    for name, content in {
        "calibration.json": b'{"threshold":0.5}\n',
        "evaluation.json": b'{"recallAt1":1}\n',
        "scores-test.jsonl": b'{"split":"test"}\n',
        "scores-validation.jsonl": b'{"split":"validation"}\n',
    }.items():
        (run_root / name).write_bytes(content)
    source_sha256 = "9" * 64
    source_revision = "8" * 40
    run = {
        "version": 2,
        "baseModel": {
            "id": config.base_model.id,
            "revision": config.base_model.revision,
            "snapshotSha256": config.base_model.snapshot_sha256,
        },
        "configurationSha256": config.sha256,
        "dataset": {"groupsSha256": "7" * 64},
        "evaluationArtifacts": {
            "calibrationSha256": file_sha256(run_root / "calibration.json"),
            "evaluationSha256": file_sha256(run_root / "evaluation.json"),
            "testScoresSha256": file_sha256(run_root / "scores-test.jsonl"),
            "validationScoresSha256": file_sha256(run_root / "scores-validation.jsonl"),
        },
        "modelDirectory": "model",
        "modelTreeSha256": model_tree_sha256(model),
        "trainingCodeRevision": source_revision,
        "trainingSource": {
            "dirty": True,
            "fileCount": 42,
            "sha256": source_sha256,
        },
    }
    run_path = run_root / "run.json"
    run_path.write_text(json.dumps(run), encoding="utf-8")

    provenance = validate_export_run(run_root, run, config, model, run_path)

    assert provenance.manifest_revision == source_sha256[:40]
    assert provenance.source_identity_kind == "content-sha256"
    assert provenance.source_identity_value == source_sha256
    assert provenance.run_json_sha256 == file_sha256(run_path)
    assert provenance.calibration_sha256 == file_sha256(run_root / "calibration.json")

    clean = {**run, "trainingSource": {**run["trainingSource"], "dirty": False}}
    run_path.write_text(json.dumps(clean), encoding="utf-8")
    clean_provenance = validate_export_run(run_root, clean, config, model, run_path)
    assert clean_provenance.manifest_revision == source_revision
    assert clean_provenance.source_identity_kind == "git-commit"

    (run_root / "calibration.json").write_text('{"threshold":0.7}\n', encoding="utf-8")
    with pytest.raises(ValueError, match="calibration.json"):
        validate_export_run(run_root, clean, config, model, run_path)


def _write_dataset(root: Path) -> Path:
    source = {
        "id": "owned",
        "kind": "self_authored_synthetic",
        "license": "AGPL-3.0-or-later",
        "licenseUrl": "https://example.test/license",
        "privacyBasis": "self_authored",
        "provenance": "Self-authored test data.",
        "redistributionApproved": True,
        "revision": "test-v1",
        "sourceUri": "https://example.test/source",
        "trainingApproved": True,
    }
    groups = []
    for split in ("train", "validation", "test"):
        for answerability in ("answerable", "no_answer"):
            slug = f"{split}-{answerability}"
            candidates = [
                {
                    "id": f"{slug}-first",
                    "language": "en",
                    **({} if answerability == "answerable" else {"negativeKind": "no_answer_distractor"}),
                    "provenanceRecord": f"fixture:{slug}:first",
                    "relevance": 3 if answerability == "answerable" else 0,
                    "reviewed": True,
                    "sourceId": "owned",
                    "text": f"Evidence one for {slug}.",
                },
                {
                    "id": f"{slug}-second",
                    "language": "en",
                    "negativeKind": "lexical_hard",
                    "provenanceRecord": f"fixture:{slug}:second",
                    "relevance": 0,
                    "reviewed": True,
                    "sourceId": "owned",
                    "text": f"Distractor two for {slug}.",
                },
            ]
            groups.append(
                {
                    "answerability": answerability,
                    "candidates": candidates,
                    "id": slug,
                    "language": "en",
                    "partitionKey": f"partition:{slug}",
                    "provenanceRecord": f"fixture:{slug}",
                    "query": f"Question for {slug}?",
                    "sourceId": "owned",
                    "split": split,
                    "version": 1,
                }
            )
    content = "".join(json.dumps(group, separators=(",", ":")) + "\n" for group in groups)
    manifest = {
        "counts": {
            "candidates": 12,
            "groups": 6,
            "noAnswerGroups": 3,
            "splits": {"train": 2, "validation": 2, "test": 2},
        },
        "createdAt": "2026-08-03T00:00:00.000Z",
        "description": "Test fixture.",
        "generatorRevision": "test-v1",
        "groupFile": "groups.jsonl",
        "groupFileSha256": hashlib.sha256(content.encode()).hexdigest(),
        "groupsSha256": canonical_groups_sha256(groups),
        "labelMethod": "Reviewed fixture labels.",
        "name": "test",
        "partitionStrategy": "test partition",
        "privacyReviewed": True,
        "purpose": "harness_smoke",
        "reservedEvaluations": [_validation_policy()[0]["reservedEvaluation"]],
        "seed": 1,
        "sources": [source],
        "version": 1,
    }
    root.mkdir(parents=True, exist_ok=True)
    (root / "groups.jsonl").write_text(content, encoding="utf-8")
    (root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    _write_validation_receipt(root)
    return root


def _read_groups(root: Path) -> list[dict]:
    return [json.loads(line) for line in (root / "groups.jsonl").read_text(encoding="utf-8").splitlines()]


def _rewrite(root: Path, manifest: dict, groups: list[dict]) -> None:
    content = "".join(json.dumps(group, separators=(",", ":")) + "\n" for group in groups)
    manifest["groupFileSha256"] = hashlib.sha256(content.encode()).hexdigest()
    manifest["groupsSha256"] = canonical_groups_sha256(groups)
    (root / "groups.jsonl").write_text(content, encoding="utf-8")
    (root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    _write_validation_receipt(root)


def _validation_policy() -> tuple[dict, bytes]:
    path = Path(__file__).parents[1] / "validation-policy-v1.json"
    content = path.read_bytes()
    return json.loads(content), content


def _write_validation_receipt(root: Path) -> None:
    policy, policy_bytes = _validation_policy()
    manifest_bytes = (root / "manifest.json").read_bytes()
    manifest = json.loads(manifest_bytes)
    receipt = {
        "datasetName": manifest["name"],
        "datasetVersion": manifest["version"],
        "forbiddenTextsSha256": policy["forbiddenTextsSha256"],
        "groupFileSha256": manifest["groupFileSha256"],
        "groupsSha256": manifest["groupsSha256"],
        "manifestSha256": sha256_bytes(manifest_bytes),
        "reservedEvaluation": policy["reservedEvaluation"],
        "validationPolicySha256": sha256_bytes(policy_bytes),
        "validatorId": policy["validatorId"],
        "version": 1,
    }
    (root / policy["receiptFile"]).write_text(json.dumps(receipt), encoding="utf-8")


def _score_rows(split: str) -> list[dict]:
    return [
        {
            "answerability": "answerable",
            "candidates": [
                {"id": "positive", "relevance": 3, "score": 0.94},
                {"id": "negative", "relevance": 0, "score": 0.21},
            ],
            "groupId": f"{split}-answerable",
            "split": split,
        },
        {
            "answerability": "no_answer",
            "candidates": [
                {"id": "near", "relevance": 0, "score": 0.18},
                {"id": "far", "relevance": 0, "score": 0.08},
            ],
            "groupId": f"{split}-no-answer",
            "split": split,
        },
    ]
