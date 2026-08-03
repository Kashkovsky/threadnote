from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import platform
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from .configuration import HarnessConfig, load_config
from .dataset import DatasetBundle, candidate_pairs, load_dataset
from .io import atomic_write_json, sha256_bytes

FIXTURE_VERSION = 1
DEFAULT_MAXIMUM_GROUPS = 8


def generate_parity_fixture(
    run_directory: str | Path,
    dataset: DatasetBundle,
    config: HarnessConfig,
    output: str | Path,
    *,
    maximum_groups: int = DEFAULT_MAXIMUM_GROUPS,
    device: str | None = None,
) -> dict[str, Any]:
    """Score a deterministic validation-only sample with the trained model.

    The fixture deliberately contains the exact query/document text consumed by
    Sentence Transformers. The production-runtime gate can therefore replay the
    same pairs without reading the training dataset or trusting path-local state.
    """

    if maximum_groups <= 0:
        raise ValueError("Parity fixture maximum groups must be positive.")
    run_root = Path(run_directory).resolve()
    run_path = run_root / "run.json"
    run_bytes = run_path.read_bytes()
    run = _read_object_bytes(run_bytes, run_path)
    _validate_run_binding(run, dataset, config)
    model_path = resolve_run_model_path(run_root, run)
    model_sha256_before = validate_run_model_tree(run, model_path)
    selected = select_validation_groups(dataset, maximum_groups)

    try:
        import torch
        from sentence_transformers.cross_encoder import CrossEncoder
    except ImportError as cause:
        raise RuntimeError("Training dependencies are not installed; run uv sync --locked for this project.") from cause

    selected_device = device or ("mps" if torch.backends.mps.is_available() else "cpu")
    model = CrossEncoder(
        str(model_path),
        device=selected_device,
        local_files_only=True,
        max_length=config.training.max_length,
        trust_remote_code=False,
    )
    groups: list[dict[str, Any]] = []
    for group in selected:
        scores = model.predict(
            candidate_pairs(group, config.runtime_target.document_character_limit),
            batch_size=config.training.batch_size,
            convert_to_numpy=True,
            show_progress_bar=False,
        )
        flattened = scores.reshape(-1).tolist() if hasattr(scores, "reshape") else list(scores)
        if len(flattened) != len(group["candidates"]):
            raise RuntimeError(f"Model returned the wrong score count for {group['id']}.")
        candidates = []
        for candidate, score in zip(group["candidates"], flattened, strict=True):
            score_value = float(score)
            if not _finite(score_value):
                raise RuntimeError(f"Python reranker returned a non-finite score for {candidate['id']}.")
            candidates.append(
                {
                    "candidateId": candidate["id"],
                    "document": candidate["text"][: config.runtime_target.document_character_limit],
                    "pythonScore": score_value,
                    "relevance": candidate["relevance"],
                }
            )
        groups.append({"candidates": candidates, "groupId": group["id"], "query": group["query"]})

    model_sha256_after = model_tree_sha256(model_path)
    if model_sha256_after != model_sha256_before:
        raise RuntimeError("Trained model files changed while the parity fixture was being scored.")
    manifest_path = dataset.root / "manifest.json"
    fixture = {
        "version": FIXTURE_VERSION,
        "kind": "threadnote_recall_reranker_python_parity",
        "split": "validation",
        "configurationSha256": config.sha256,
        "dataset": {
            "groupFileSha256": dataset.manifest["groupFileSha256"],
            "groupsSha256": dataset.groups_sha256,
            "manifestSha256": sha256_bytes(manifest_path.read_bytes()),
            "purpose": dataset.purpose,
        },
        "run": {
            "modelTreeSha256": model_sha256_before,
            "runJsonSha256": sha256_bytes(run_bytes),
            "trainingCodeRevision": run["trainingCodeRevision"],
        },
        "runtimeTarget": {
            "architecture": config.runtime_target.architecture,
            "contextLimit": config.runtime_target.context_limit,
            "documentCharacterLimit": config.runtime_target.document_character_limit,
            "nodeLlamaCpp": config.runtime_target.node_llama_cpp,
        },
        "scoring": {
            "backend": "sentence-transformers-cross-encoder",
            "device": selected_device,
            "python": platform.python_version(),
            "sentenceTransformers": importlib.metadata.version("sentence-transformers"),
            "torch": importlib.metadata.version("torch"),
            "transformers": importlib.metadata.version("transformers"),
        },
        "selection": {
            "algorithm": "sha256-stratified-answerability-v1",
            "maximumGroups": maximum_groups,
        },
        "groups": groups,
    }
    atomic_write_json(Path(output).resolve(), fixture)
    return fixture


def select_validation_groups(dataset: DatasetBundle, maximum_groups: int) -> tuple[dict[str, Any], ...]:
    if maximum_groups <= 0:
        raise ValueError("Parity fixture maximum groups must be positive.")
    validation = dataset.groups_for_split("validation")
    if not validation:
        raise ValueError("Dataset has no validation groups for the parity fixture.")

    def key(group: dict[str, Any]) -> tuple[str, str]:
        digest = hashlib.sha256(f"{dataset.groups_sha256}\0{group['id']}".encode()).hexdigest()
        return digest, str(group["id"])

    buckets = {
        answerability: sorted(
            (group for group in validation if group["answerability"] == answerability),
            key=key,
        )
        for answerability in ("answerable", "no_answer")
    }
    selected: list[dict[str, Any]] = []
    index = 0
    while len(selected) < maximum_groups:
        added = False
        for answerability in ("answerable", "no_answer"):
            bucket = buckets[answerability]
            if index < len(bucket):
                selected.append(bucket[index])
                added = True
                if len(selected) == maximum_groups:
                    break
        if not added:
            break
        index += 1
    return tuple(selected)


def model_tree_sha256(root: Path) -> str:
    entries: list[str] = []
    for path in sorted(root.rglob("*"), key=lambda candidate: candidate.relative_to(root).as_posix()):
        if path.is_symlink():
            raise ValueError(f"Trained model directory contains a symbolic link: {path}")
        if not path.is_file():
            continue
        relative = path.relative_to(root).as_posix()
        entries.append(
            json.dumps(
                [relative, path.stat().st_size, _file_sha256(path)],
                ensure_ascii=False,
                separators=(",", ":"),
            )
        )
    if not entries:
        raise ValueError(f"Trained model directory contains no files: {root}")
    return sha256_bytes(("\n".join(entries) + "\n").encode())


def resolve_run_model_path(run_root: Path, run: dict[str, Any]) -> Path:
    model_directory = run.get("modelDirectory")
    if not isinstance(model_directory, str) or not model_directory.strip():
        raise ValueError("Training run contains an invalid model directory.")
    relative = Path(model_directory)
    if relative.is_absolute() or any(part in ("", ".", "..") for part in relative.parts):
        raise ValueError("Training run model directory must be a safe relative path.")
    root = run_root.resolve()
    unresolved = root / relative
    if unresolved.is_symlink():
        raise ValueError("Training run model directory cannot be a symbolic link.")
    model_path = unresolved.resolve()
    if model_path == root or root not in model_path.parents:
        raise ValueError("Training run model directory escapes the run directory.")
    if not model_path.is_dir():
        raise ValueError(f"Trained model directory does not exist: {model_path}")
    return model_path


def validate_run_model_tree(run: dict[str, Any], model_path: Path) -> str:
    recorded = run.get("modelTreeSha256")
    if not isinstance(recorded, str) or not _sha256(recorded):
        raise ValueError("Training run does not contain a valid trained-model tree hash.")
    actual = model_tree_sha256(model_path)
    if actual != recorded:
        raise ValueError("Trained model tree does not match the training run.")
    return actual


def _validate_run_binding(run: dict[str, Any], dataset: DatasetBundle, config: HarnessConfig) -> None:
    if run.get("version") != 2:
        raise ValueError("Parity fixtures require a version 2 training run.")
    if run.get("configurationSha256") != config.sha256:
        raise ValueError("Training run does not match the parity configuration.")
    run_dataset = run.get("dataset")
    if not isinstance(run_dataset, dict) or run_dataset.get("groupsSha256") != dataset.groups_sha256:
        raise ValueError("Training run does not match the validated parity dataset.")
    revision = run.get("trainingCodeRevision")
    if (
        not isinstance(revision, str)
        or len(revision) != 40
        or any(character not in "0123456789abcdef" for character in revision)
    ):
        raise ValueError("Training run does not contain an immutable source revision.")


def _read_object_bytes(content: bytes, path: Path) -> dict[str, Any]:
    value = json.loads(content)
    if not isinstance(value, dict):
        raise ValueError(f"Expected a JSON object: {path}")
    return value


def _finite(value: float) -> bool:
    return value == value and value not in (float("inf"), float("-inf"))


def _sha256(value: str) -> bool:
    return len(value) == 64 and all(character in "0123456789abcdef" for character in value)


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m threadnote_reranker_training.parity",
        description="Create a deterministic validation-only Python score fixture for native parity.",
    )
    parser.add_argument("--run", required=True)
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--config", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--maximum-groups", type=int, default=DEFAULT_MAXIMUM_GROUPS)
    parser.add_argument("--device", choices=("cpu", "mps"))
    return parser


def main(arguments: Sequence[str] | None = None) -> None:
    options = _parser().parse_args(arguments)
    fixture = generate_parity_fixture(
        options.run,
        load_dataset(options.dataset),
        load_config(options.config),
        options.output,
        maximum_groups=options.maximum_groups,
        device=options.device,
    )
    summary = {
        "datasetGroupsSha256": fixture["dataset"]["groupsSha256"],
        "groups": len(fixture["groups"]),
        "modelTreeSha256": fixture["run"]["modelTreeSha256"],
        "output": str(Path(options.output).resolve()),
        "split": fixture["split"],
        "version": fixture["version"],
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
