from __future__ import annotations

import json
import re
import unicodedata
from collections.abc import Iterator
from dataclasses import dataclass
from dataclasses import field as dataclass_field
from pathlib import Path
from typing import Any

from .io import canonical_groups_sha256, sha256_bytes

DATASET_VERSION = 1
SPLITS = ("train", "validation", "test")
PURPOSES = ("evaluation_holdout", "harness_smoke", "training_candidate")
MAX_CANDIDATES = 32
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_UNICODE_WHITESPACE = re.compile(
    "[\\u0009-\\u000d\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]+"
)
_PROJECT_ROOT = Path(__file__).parents[2]
_VALIDATION_POLICY_PATH = _PROJECT_ROOT / "validation-policy-v1.json"
_LOCAL_PATH = re.compile(
    r"(?:^|[\s\"'`(])(?:[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/]|/Users/|/home/|"
    r"/mnt/[a-z]/Users/|\\\\[^\\\s]+\\[^\\\s]+)",
    re.IGNORECASE,
)
_SECRETS = (
    re.compile(r"\bsk-[A-Za-z0-9_-]{16,}"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9_]{16,}"),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{20,}", re.IGNORECASE),
)


@dataclass(frozen=True)
class DatasetBundle:
    root: Path
    manifest: dict[str, Any]
    groups: tuple[dict[str, Any], ...]
    validation_receipt: dict[str, Any] = dataclass_field(default_factory=dict)

    @property
    def purpose(self) -> str:
        return str(self.manifest["purpose"])

    @property
    def groups_sha256(self) -> str:
        return str(self.manifest["groupsSha256"])

    def groups_for_split(self, split: str) -> tuple[dict[str, Any], ...]:
        if split not in SPLITS:
            raise ValueError(f"Unknown dataset split: {split}")
        return tuple(group for group in self.groups if group["split"] == split)


def load_dataset(path: str | Path) -> DatasetBundle:
    root = Path(path).resolve()
    manifest_path = root / "manifest.json"
    manifest_bytes = manifest_path.read_bytes()
    manifest = _decode_json_object(manifest_bytes, manifest_path)
    _require(manifest.get("version") == DATASET_VERSION, "Unsupported recall reranker dataset version.")
    group_file = manifest.get("groupFile")
    _require(isinstance(group_file, str) and _safe_relative_file(group_file), "Unsafe dataset group file path.")
    group_path = root / group_file
    group_bytes = group_path.read_bytes()
    _require(
        sha256_bytes(group_bytes) == manifest.get("groupFileSha256"),
        "Dataset group file checksum does not match its manifest.",
    )
    groups = tuple(_read_jsonl(group_bytes, group_path))
    policy_bytes = _VALIDATION_POLICY_PATH.read_bytes()
    policy = _decode_json_object(policy_bytes, _VALIDATION_POLICY_PATH)
    _validate_policy(policy)
    receipt_file = str(policy["receiptFile"])
    receipt_path = root / receipt_file
    _require(receipt_path.is_file(), f"Dataset requires the TypeScript validation receipt: {receipt_file}")
    receipt = _read_json_object(receipt_path)
    _validate_receipt(receipt, policy, policy_bytes, manifest, manifest_bytes)
    bundle = DatasetBundle(root=root, manifest=manifest, groups=groups, validation_receipt=receipt)
    validate_dataset(bundle)
    return bundle


def validate_dataset(dataset: DatasetBundle) -> None:
    manifest = dataset.manifest
    groups = dataset.groups
    _require(manifest.get("purpose") in PURPOSES, "Invalid dataset purpose.")
    _require(manifest.get("privacyReviewed") is True, "Dataset has not passed privacy review.")
    _require(_SHA256.fullmatch(str(manifest.get("groupsSha256", ""))) is not None, "Invalid groups hash.")
    _require(
        canonical_groups_sha256(groups) == manifest["groupsSha256"],
        "Canonical dataset hash does not match its manifest.",
    )
    reserved = manifest.get("reservedEvaluations")
    _require(isinstance(reserved, list) and reserved, "Dataset must declare reserved evaluation hashes.")
    for item in reserved:
        _require(
            isinstance(item, dict) and _SHA256.fullmatch(str(item.get("sha256", ""))) is not None,
            "Invalid reserved evaluation hash.",
        )

    sources = manifest.get("sources")
    _require(isinstance(sources, list) and sources, "Dataset must declare sources.")
    source_ids: set[str] = set()
    for source in sources:
        _require(isinstance(source, dict), "Invalid source record.")
        source_id = _non_empty(source.get("id"), "source ID")
        _require(source_id not in source_ids, f"Duplicate source ID: {source_id}")
        source_ids.add(source_id)
        _validate_source(source)

    group_ids: set[str] = set()
    normalized_queries: set[str] = set()
    partition_splits: dict[str, str] = {}
    document_splits: dict[str, str] = {}
    observed_splits: set[str] = set()
    candidate_count = 0
    no_answer_count = 0

    for group in groups:
        _require(group.get("version") == DATASET_VERSION, "Invalid query-group version.")
        group_id = _non_empty(group.get("id"), "query-group ID")
        _require(group_id not in group_ids, f"Duplicate query-group ID: {group_id}")
        group_ids.add(group_id)
        split = str(group.get("split"))
        _require(split in SPLITS, f"Invalid split for {group_id}.")
        observed_splits.add(split)
        _require(group.get("sourceId") in source_ids, f"Missing query source for {group_id}.")
        query = _safe_text(group.get("query"), f"query {group_id}")
        normalized_query = normalize_text(query)
        _require(normalized_query not in normalized_queries, f"Duplicate normalized query: {group_id}")
        normalized_queries.add(normalized_query)
        partition = normalize_text(_safe_text(group.get("partitionKey"), f"partition {group_id}"))
        _one_split(partition_splits, partition, split, "partition")
        _safe_text(group.get("provenanceRecord"), f"provenance {group_id}")
        candidates = group.get("candidates")
        _require(isinstance(candidates, list), f"Invalid candidates for {group_id}.")
        _require(
            2 <= len(candidates) <= MAX_CANDIDATES, f"Query group {group_id} must have 2-{MAX_CANDIDATES} candidates."
        )
        candidate_count += len(candidates)
        candidate_ids: set[str] = set()
        positives = 0
        negatives = 0
        for candidate in candidates:
            _require(isinstance(candidate, dict), f"Invalid candidate in {group_id}.")
            candidate_id = _non_empty(candidate.get("id"), "candidate ID")
            _require(candidate_id not in candidate_ids, f"Duplicate candidate {candidate_id} in {group_id}.")
            candidate_ids.add(candidate_id)
            _require(candidate.get("sourceId") in source_ids, f"Missing source for candidate {candidate_id}.")
            text = _safe_text(candidate.get("text"), f"candidate text {candidate_id}")
            _safe_text(candidate.get("provenanceRecord"), f"candidate provenance {candidate_id}")
            relevance = candidate.get("relevance")
            _require(type(relevance) is int and 0 <= relevance <= 3, f"Invalid relevance for {candidate_id}.")
            _require(candidate.get("reviewed") is True, f"Candidate {candidate_id} is unreviewed.")
            _one_split(document_splits, normalize_text(text), split, "document")
            if relevance > 0:
                positives += 1
                _require(
                    candidate.get("negativeKind") is None, f"Positive candidate {candidate_id} has a negative kind."
                )
            else:
                negatives += 1
                _require(
                    isinstance(candidate.get("negativeKind"), str),
                    f"Negative candidate {candidate_id} lacks a negative kind.",
                )
        answerability = group.get("answerability")
        if answerability == "answerable":
            _require(positives > 0 and negatives > 0, f"Answerable group {group_id} requires positives and negatives.")
        elif answerability == "no_answer":
            no_answer_count += 1
            _require(positives == 0, f"No-answer group {group_id} contains a positive.")
        else:
            raise ValueError(f"Invalid answerability for {group_id}.")

    _require(observed_splits == set(SPLITS), "Dataset must contain train, validation, and test splits.")
    expected_counts = {
        "candidates": candidate_count,
        "groups": len(groups),
        "noAnswerGroups": no_answer_count,
        "splits": {split: sum(group["split"] == split for group in groups) for split in SPLITS},
    }
    _require(manifest.get("counts") == expected_counts, "Dataset counts do not match its manifest.")


def pair_rows(dataset: DatasetBundle, split: str, document_character_limit: int) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for group in dataset.groups_for_split(split):
        for candidate in group["candidates"]:
            rows.append(
                {
                    "document": candidate["text"][:document_character_limit],
                    "label": float(candidate["relevance"]) / 3.0,
                    "query": group["query"],
                }
            )
    return rows


def candidate_pairs(group: dict[str, Any], document_character_limit: int) -> list[tuple[str, str]]:
    return [(group["query"], candidate["text"][:document_character_limit]) for candidate in group["candidates"]]


def _read_json_object(path: Path) -> dict[str, Any]:
    return _decode_json_object(path.read_bytes(), path)


def _decode_json_object(content: bytes, path: Path) -> dict[str, Any]:
    value = json.loads(content.decode("utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"Expected a JSON object: {path}")
    return value


def _read_jsonl(content: bytes, path: Path) -> Iterator[dict[str, Any]]:
    for index, raw_line in enumerate(content.decode("utf-8").splitlines(), start=1):
        if not raw_line.strip():
            continue
        value = json.loads(raw_line)
        if not isinstance(value, dict):
            raise ValueError(f"Expected an object at {path}:{index}")
        yield value


def _validate_source(source: dict[str, Any]) -> None:
    source_id = str(source["id"])
    for field in ("license", "licenseUrl", "provenance", "revision", "sourceUri"):
        _safe_text(source.get(field), f"source {source_id} {field}")
    _require(source.get("trainingApproved") is True, f"Source {source_id} is not approved for training.")
    _require(source.get("redistributionApproved") is True, f"Source {source_id} is not approved for redistribution.")
    kind = source.get("kind")
    privacy = source.get("privacyBasis")
    if kind == "self_authored_synthetic":
        _require(privacy == "self_authored", f"Invalid privacy basis for {source_id}.")
    elif kind in ("public_dataset", "public_repository"):
        _require(privacy == "public_licensed", f"Invalid privacy basis for {source_id}.")
    elif kind == "opt_in_sanitized":
        _require(privacy == "explicit_opt_in", f"Invalid privacy basis for {source_id}.")
        _safe_text(source.get("consentReference"), f"source {source_id} consent reference")
    else:
        raise ValueError(f"Invalid source kind for {source_id}.")


def normalize_text(value: str) -> str:
    return _UNICODE_WHITESPACE.sub(" ", unicodedata.normalize("NFKC", value)).strip(" ").lower()


def _validate_policy(policy: dict[str, Any]) -> None:
    _require(policy.get("version") == 1, "Unsupported validation policy version.")
    _non_empty(policy.get("validatorId"), "validation policy validator ID")
    receipt_file = _non_empty(policy.get("receiptFile"), "validation receipt file")
    _require(_safe_relative_file(receipt_file), "Unsafe validation receipt file path.")
    _require(
        _SHA256.fullmatch(str(policy.get("forbiddenTextsSha256", ""))) is not None,
        "Invalid validation policy forbidden-text hash.",
    )
    reserved = policy.get("reservedEvaluation")
    _require(isinstance(reserved, dict), "Invalid validation policy reserved evaluation.")
    _non_empty(reserved.get("name"), "validation policy reserved evaluation name")
    _require(
        _SHA256.fullmatch(str(reserved.get("sha256", ""))) is not None,
        "Invalid validation policy reserved evaluation hash.",
    )


def _validate_receipt(
    receipt: dict[str, Any],
    policy: dict[str, Any],
    policy_bytes: bytes,
    manifest: dict[str, Any],
    manifest_bytes: bytes,
) -> None:
    _require(receipt.get("version") == 1, "Unsupported validation receipt version.")
    _require(receipt.get("validatorId") == policy["validatorId"], "Validation receipt validator mismatch.")
    _require(receipt.get("datasetVersion") == manifest.get("version"), "Validation receipt dataset version mismatch.")
    _require(receipt.get("datasetName") == manifest.get("name"), "Validation receipt dataset name mismatch.")
    _require(
        receipt.get("manifestSha256") == sha256_bytes(manifest_bytes),
        "Validation receipt does not match the exact manifest content.",
    )
    _require(
        receipt.get("groupFileSha256") == manifest.get("groupFileSha256"),
        "Validation receipt group-file hash mismatch.",
    )
    _require(
        receipt.get("groupsSha256") == manifest.get("groupsSha256"),
        "Validation receipt canonical-groups hash mismatch.",
    )
    _require(
        receipt.get("validationPolicySha256") == sha256_bytes(policy_bytes),
        "Validation receipt policy hash mismatch.",
    )
    _require(
        receipt.get("reservedEvaluation") == policy["reservedEvaluation"],
        "Validation receipt frozen-holdout identity mismatch.",
    )
    _require(
        receipt.get("forbiddenTextsSha256") == policy["forbiddenTextsSha256"],
        "Validation receipt frozen-holdout exclusion hash mismatch.",
    )
    reserved = manifest.get("reservedEvaluations")
    _require(
        isinstance(reserved, list) and policy["reservedEvaluation"] in reserved,
        "Dataset manifest does not reserve the current frozen holdout.",
    )


def _safe_text(value: Any, label: str) -> str:
    text = _non_empty(value, label)
    if _LOCAL_PATH.search(text):
        raise ValueError(f"{label} contains an absolute local path.")
    if any(pattern.search(text) for pattern in _SECRETS):
        raise ValueError(f"{label} contains credential-like content.")
    return text


def _non_empty(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"Missing {label}.")
    return value


def _one_split(seen: dict[str, str], key: str, split: str, label: str) -> None:
    previous = seen.get(key)
    if previous is not None and previous != split:
        raise ValueError(f"Dataset {label} leaks across {previous} and {split} splits.")
    seen[key] = split


def _safe_relative_file(value: str) -> bool:
    path = Path(value)
    return not path.is_absolute() and ".." not in path.parts and all(part not in ("", ".") for part in path.parts)


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)
