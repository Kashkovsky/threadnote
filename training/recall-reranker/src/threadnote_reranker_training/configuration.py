from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .io import sha256_bytes

_COMMIT = re.compile(r"^[0-9a-f]{40}$")


@dataclass(frozen=True)
class BaseModelConfig:
    id: str
    revision: str
    license: str
    license_url: str
    snapshot_files: tuple[str, ...]
    snapshot_sha256: str


@dataclass(frozen=True)
class RuntimeTargetConfig:
    architecture: str
    context_limit: int
    document_character_limit: int
    node_llama_cpp: str


@dataclass(frozen=True)
class ExportConfig:
    llama_cpp_revision: str
    llama_cpp_tag: str
    out_type: str


@dataclass(frozen=True)
class TrainingParameters:
    batch_size: int
    epochs: int
    gradient_accumulation_steps: int
    learning_rate: float
    max_length: int
    seed: int
    warmup_ratio: float
    weight_decay: float


@dataclass(frozen=True)
class HarnessConfig:
    source: Path
    sha256: str
    base_model: BaseModelConfig
    runtime_target: RuntimeTargetConfig
    export: ExportConfig
    training: TrainingParameters


def load_config(path: str | Path) -> HarnessConfig:
    source = Path(path).resolve()
    content = source.read_bytes()
    value = json.loads(content)
    if not isinstance(value, dict) or value.get("version") != 1:
        raise ValueError("Unsupported training configuration version.")
    base = _record(value, "baseModel")
    runtime = _record(value, "runtimeTarget")
    export = _record(value, "export")
    training = _record(value, "training")
    base_revision = _string(base, "revision")
    converter_revision = _string(export, "llamaCppRevision")
    if _COMMIT.fullmatch(base_revision) is None:
        raise ValueError("Base-model revision must be an immutable 40-character commit.")
    if _COMMIT.fullmatch(converter_revision) is None:
        raise ValueError("llama.cpp revision must be an immutable 40-character commit.")
    result = HarnessConfig(
        source=source,
        sha256=sha256_bytes(content),
        base_model=BaseModelConfig(
            id=_string(base, "id"),
            revision=base_revision,
            license=_string(base, "license"),
            license_url=_string(base, "licenseUrl"),
            snapshot_files=_string_tuple(base, "snapshotFiles"),
            snapshot_sha256=_sha256(base, "snapshotSha256"),
        ),
        runtime_target=RuntimeTargetConfig(
            architecture=_string(runtime, "architecture"),
            context_limit=_positive_int(runtime, "contextLimit"),
            document_character_limit=_positive_int(runtime, "documentCharacterLimit"),
            node_llama_cpp=_string(runtime, "nodeLlamaCpp"),
        ),
        export=ExportConfig(
            llama_cpp_revision=converter_revision,
            llama_cpp_tag=_string(export, "llamaCppTag"),
            out_type=_string(export, "outType"),
        ),
        training=TrainingParameters(
            batch_size=_positive_int(training, "batchSize"),
            epochs=_positive_int(training, "epochs"),
            gradient_accumulation_steps=_positive_int(training, "gradientAccumulationSteps"),
            learning_rate=_positive_number(training, "learningRate"),
            max_length=_positive_int(training, "maxLength"),
            seed=_positive_int(training, "seed"),
            warmup_ratio=_bounded_number(training, "warmupRatio", 0.0, 1.0),
            weight_decay=_bounded_number(training, "weightDecay", 0.0, 1.0),
        ),
    )
    if result.training.max_length > result.runtime_target.context_limit:
        raise ValueError("Training max length cannot exceed the target runtime context limit.")
    return result


def _record(parent: dict[str, Any], key: str) -> dict[str, Any]:
    value = parent.get(key)
    if not isinstance(value, dict):
        raise ValueError(f"Missing configuration object: {key}")
    return value


def _string(parent: dict[str, Any], key: str) -> str:
    value = parent.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"Missing configuration string: {key}")
    return value


def _positive_int(parent: dict[str, Any], key: str) -> int:
    value = parent.get(key)
    if type(value) is not int or value <= 0:
        raise ValueError(f"Configuration {key} must be a positive integer.")
    return value


def _positive_number(parent: dict[str, Any], key: str) -> float:
    value = parent.get(key)
    if not isinstance(value, (int, float)) or isinstance(value, bool) or value <= 0:
        raise ValueError(f"Configuration {key} must be positive.")
    return float(value)


def _bounded_number(parent: dict[str, Any], key: str, minimum: float, maximum: float) -> float:
    value = parent.get(key)
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not minimum <= value <= maximum:
        raise ValueError(f"Configuration {key} must be between {minimum} and {maximum}.")
    return float(value)


def _sha256(parent: dict[str, Any], key: str) -> str:
    value = _string(parent, key)
    if re.fullmatch(r"[0-9a-f]{64}", value) is None:
        raise ValueError(f"Configuration {key} must be a lowercase SHA-256 digest.")
    return value


def _string_tuple(parent: dict[str, Any], key: str) -> tuple[str, ...]:
    value = parent.get(key)
    if not isinstance(value, list) or not value:
        raise ValueError(f"Configuration {key} must be a non-empty string list.")
    values = tuple(item for item in value if isinstance(item, str) and item.strip())
    if len(values) != len(value) or len(set(values)) != len(values):
        raise ValueError(f"Configuration {key} contains invalid or duplicate entries.")
    return values
