from __future__ import annotations

import hashlib
import json
import os
from collections.abc import Iterable
from pathlib import Path
from typing import Any


def sha256_bytes(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def canonical_groups_sha256(groups: Iterable[dict[str, Any]]) -> str:
    lines = [
        json.dumps(_canonical_value(group), ensure_ascii=False, separators=(",", ":"))
        for group in sorted(groups, key=lambda candidate: str(candidate["id"]).encode("utf-8"))
    ]
    return sha256_bytes(("\n".join(lines) + "\n").encode("utf-8"))


def _canonical_value(value: Any) -> Any:
    if isinstance(value, list):
        return [_canonical_value(item) for item in value]
    if not isinstance(value, dict):
        return value
    return {key: _canonical_value(value[key]) for key in sorted(value, key=lambda item: item.encode("utf-8"))}


def atomic_write_json(path: Path, value: Any) -> None:
    atomic_write_text(path, json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n")


def atomic_write_jsonl(path: Path, rows: Iterable[dict[str, Any]]) -> None:
    atomic_write_text(
        path,
        "".join(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n" for row in rows),
    )


def atomic_write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    try:
        with temporary.open("x", encoding="utf-8", newline="\n") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
