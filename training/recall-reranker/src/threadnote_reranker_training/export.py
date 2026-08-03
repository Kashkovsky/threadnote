from __future__ import annotations

import json
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .configuration import HarnessConfig
from .io import atomic_write_json
from .parity import resolve_run_model_path, validate_run_model_tree
from .provenance import file_sha256, git_source_state

_OUT_TYPES = {"f16": "F16"}
_RUN_ARTIFACTS = {
    "calibrationSha256": "calibration.json",
    "evaluationSha256": "evaluation.json",
    "testScoresSha256": "scores-test.jsonl",
    "validationScoresSha256": "scores-validation.jsonl",
}


@dataclass(frozen=True)
class ExportRunProvenance:
    calibration_sha256: str
    manifest_revision: str
    model_tree_sha256: str
    run_json_sha256: str
    source_dirty: bool
    source_file_count: int
    source_identity_kind: str
    source_identity_value: str
    source_revision: str
    source_sha256: str


def export_gguf(
    run_directory: str | Path,
    config: HarnessConfig,
    llama_cpp: str | Path,
    output: str | Path,
) -> dict[str, Any]:
    run_root = Path(run_directory).resolve()
    run_path = run_root / "run.json"
    if run_path.is_symlink() or not run_path.is_file():
        raise ValueError("Training run manifest is missing or unsafe.")
    run = _read_object(run_path)
    model = resolve_run_model_path(run_root, run)
    provenance = validate_export_run(run_root, run, config, model, run_path)
    checkout = Path(llama_cpp).resolve()
    converter = checkout / "convert_hf_to_gguf.py"
    if not converter.is_file():
        raise ValueError(f"llama.cpp converter does not exist: {converter}")
    revision = _git_revision(checkout)
    if revision != config.export.llama_cpp_revision:
        raise ValueError(
            f"llama.cpp checkout is {revision}; expected pinned revision {config.export.llama_cpp_revision}."
        )
    converter_source = git_source_state(checkout, include_untracked=False)
    if converter_source.dirty:
        raise ValueError("llama.cpp converter checkout is dirty; refusing an unreviewed export toolchain.")
    quantization = _OUT_TYPES.get(config.export.out_type)
    if quantization is None:
        raise ValueError(f"Unsupported reviewed GGUF output type: {config.export.out_type}")
    target = Path(output).resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=f".{target.name}.export-", dir=target.parent) as output_staging:
        temporary = Path(output_staging) / target.name
        with tempfile.TemporaryDirectory(prefix="threadnote-reranker-model-") as staging_root:
            converter_model = stage_model_for_conversion(model, Path(staging_root), config)
            command = [
                sys.executable,
                str(converter),
                str(converter_model),
                "--outfile",
                str(temporary),
                "--outtype",
                config.export.out_type,
            ]
            subprocess.run(command, cwd=checkout, check=True)
        with temporary.open("rb") as handle:
            header = handle.read(4)
        if header != b"GGUF":
            raise RuntimeError("Converted artifact does not have a GGUF header.")
        if validate_export_run(run_root, run, config, model, run_path) != provenance:
            raise RuntimeError("Training run provenance changed while the GGUF was being converted.")
        temporary.replace(target)
    size = target.stat().st_size
    digest = file_sha256(target)
    model_manifest = {
        "architecture": config.runtime_target.architecture,
        "contextLimit": config.runtime_target.context_limit,
        "file": target.name,
        "id": f"threadnote-recall-reranker-{str(run['dataset']['groupsSha256'])[:12]}-{config.export.out_type}",
        "license": "LicenseRef-Threadnote-Candidate-Review-Required",
        "minimumRamBytes": 512 * 1024 * 1024,
        "quantization": quantization,
        "repository": "Kashkovsky/threadnote",
        "revision": provenance.manifest_revision,
        "role": "reranker",
        "runtime": {"nodeLlamaCpp": config.runtime_target.node_llama_cpp},
        "sha256": digest,
        "size": size,
        "task": "threadnote-recall-reranking-candidate",
        "version": 1,
    }
    artifact = {
        "version": 1,
        "architecture": config.runtime_target.architecture,
        "baseModel": run["baseModel"],
        "contextLimit": config.runtime_target.context_limit,
        "convertedAt": datetime.now(UTC).isoformat(),
        "converter": {
            "adapter": "modernbert-native-sequence-classification-v2-explicit-pair-template",
            "repository": "https://github.com/ggml-org/llama.cpp",
            "revision": revision,
            "sourceSha256": converter_source.content_sha256,
            "tag": config.export.llama_cpp_tag,
        },
        "file": target.name,
        "localModelManifest": model_manifest,
        "nodeLlamaCpp": config.runtime_target.node_llama_cpp,
        "outType": config.export.out_type,
        "releaseEligible": False,
        "releaseGates": {
            "coldLoad": False,
            "frozenRecall": False,
            "latency": False,
            "pythonNativeParity": False,
            "rss": False,
        },
        "releaseBlockers": [
            "The GGUF must pass Python-versus-node score parity, cold-load, latency, RSS, and frozen recall gates."
        ],
        "sha256": model_manifest["sha256"],
        "size": size,
        "trainingRun": {
            "calibrationSha256": provenance.calibration_sha256,
            "modelTreeSha256": provenance.model_tree_sha256,
            "runJsonSha256": provenance.run_json_sha256,
            "source": {
                "dirty": provenance.source_dirty,
                "fileCount": provenance.source_file_count,
                "identity": {
                    "kind": provenance.source_identity_kind,
                    "value": provenance.source_identity_value,
                },
                "revision": provenance.source_revision,
                "sha256": provenance.source_sha256,
            },
        },
        "trainingRunReleaseEligible": run.get("releaseEligible") is True,
    }
    atomic_write_json(target.with_suffix(target.suffix + ".manifest.json"), artifact)
    atomic_write_json(target.with_suffix(target.suffix + ".model.json"), model_manifest)
    return artifact


def validate_export_run(
    run_root: Path,
    run: dict[str, Any],
    config: HarnessConfig,
    model: Path,
    run_path: Path,
) -> ExportRunProvenance:
    if run.get("version") != 2:
        raise ValueError("ModernBERT export requires a version 2 training run.")
    if run.get("configurationSha256") != config.sha256:
        raise ValueError("Run configuration does not match the requested export configuration.")
    base_model = _record(run, "baseModel")
    if (
        base_model.get("id") != config.base_model.id
        or base_model.get("revision") != config.base_model.revision
        or base_model.get("snapshotSha256") != config.base_model.snapshot_sha256
    ):
        raise ValueError("Training run base-model provenance does not match the export configuration.")
    dataset = _record(run, "dataset")
    if not _sha256(dataset.get("groupsSha256")):
        raise ValueError("Training run does not contain a valid dataset groups hash.")

    source_revision = run.get("trainingCodeRevision")
    if not isinstance(source_revision, str) or re.fullmatch(r"[0-9a-f]{40}", source_revision) is None:
        raise ValueError("Training run does not contain an immutable source revision.")
    training_source = _record(run, "trainingSource")
    source_dirty = training_source.get("dirty")
    source_file_count = training_source.get("fileCount")
    source_sha256 = training_source.get("sha256")
    if type(source_dirty) is not bool:
        raise ValueError("Training run source dirty state is invalid.")
    if type(source_file_count) is not int or source_file_count <= 0:
        raise ValueError("Training run source file count is invalid.")
    if not _sha256(source_sha256):
        raise ValueError("Training run source content hash is invalid.")

    evaluation_artifacts = _record(run, "evaluationArtifacts")
    verified_artifacts: dict[str, str] = {}
    for field, relative_path in _RUN_ARTIFACTS.items():
        recorded = evaluation_artifacts.get(field)
        if not _sha256(recorded):
            raise ValueError(f"Training run {field} is invalid.")
        artifact_path = run_root / relative_path
        if artifact_path.is_symlink() or not artifact_path.is_file():
            raise ValueError(f"Training run artifact is missing or unsafe: {relative_path}.")
        actual = file_sha256(artifact_path)
        if actual != recorded:
            raise ValueError(f"Training run artifact does not match {relative_path}.")
        verified_artifacts[field] = actual

    model_tree_sha256 = validate_run_model_tree(run, model)
    run_json_sha256 = file_sha256(run_path)
    source_identity_kind = "content-sha256" if source_dirty else "git-commit"
    source_identity_value = source_sha256 if source_dirty else source_revision
    # LocalModelManifest currently requires a 40-hex revision. Dirty training
    # runs are identified by the first 160 bits of their full source content
    # hash rather than falsely claiming that HEAD represents the trained code.
    manifest_revision = source_sha256[:40] if source_dirty else source_revision
    return ExportRunProvenance(
        calibration_sha256=verified_artifacts["calibrationSha256"],
        manifest_revision=manifest_revision,
        model_tree_sha256=model_tree_sha256,
        run_json_sha256=run_json_sha256,
        source_dirty=source_dirty,
        source_file_count=source_file_count,
        source_identity_kind=source_identity_kind,
        source_identity_value=source_identity_value,
        source_revision=source_revision,
        source_sha256=source_sha256,
    )


def stage_model_for_conversion(model: Path, staging_root: Path, config: HarnessConfig) -> Path:
    """Verify that the trained head maps natively in the pinned converter.

    ModernBERT's mean-pooling, GELU classification head, normalization, and
    output projection are all represented by llama.cpp b10068. No tensor or
    configuration rewrite is allowed here: parity must validate the exact
    model saved by the trainer.
    """

    del staging_root
    if config.runtime_target.architecture != "modern-bert":
        raise ValueError("No reviewed converter adapter exists for this runtime architecture.")
    config_path = model / "config.json"
    model_config = _read_object(config_path)
    if model_config.get("architectures") != ["ModernBertForSequenceClassification"]:
        raise ValueError("Unexpected trained ModernBERT architecture; refusing GGUF conversion.")
    labels = model_config.get("id2label")
    if labels != {"0": "LABEL_0"}:
        raise ValueError("Expected a single-label ModernBERT reranker head before GGUF conversion.")
    return model


def _read_object(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"Expected a JSON object: {path}")
    return value


def _record(parent: dict[str, Any], key: str) -> dict[str, Any]:
    value = parent.get(key)
    if not isinstance(value, dict):
        raise ValueError(f"Training run is missing {key} provenance.")
    return value


def _sha256(value: object) -> bool:
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None


def _git_revision(checkout: Path) -> str:
    result = subprocess.run(
        ["git", "-C", str(checkout), "rev-parse", "HEAD"],
        capture_output=True,
        check=False,
        text=True,
    )
    return result.stdout.strip() if result.returncode == 0 else "unknown"
