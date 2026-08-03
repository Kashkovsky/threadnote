from __future__ import annotations

import json
import math
from collections.abc import Iterable
from pathlib import Path
from typing import Any


def load_score_rows(path: str | Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for index, line in enumerate(Path(path).read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        value = json.loads(line)
        if not isinstance(value, dict):
            raise ValueError(f"Expected score object at line {index}.")
        validate_score_row(value)
        rows.append(value)
    if not rows:
        raise ValueError("Score file contains no rows.")
    return rows


def validate_score_row(row: dict[str, Any]) -> None:
    if not isinstance(row.get("groupId"), str) or not row["groupId"]:
        raise ValueError("Score row is missing groupId.")
    if row.get("answerability") not in ("answerable", "no_answer"):
        raise ValueError(f"Invalid answerability in score row {row['groupId']}.")
    if row.get("split") not in ("train", "validation", "test"):
        raise ValueError(f"Invalid split in score row {row['groupId']}.")
    candidates = row.get("candidates")
    if not isinstance(candidates, list) or len(candidates) < 2:
        raise ValueError(f"Score row {row['groupId']} requires at least two candidates.")
    ids: set[str] = set()
    for candidate in candidates:
        if not isinstance(candidate, dict) or not isinstance(candidate.get("id"), str):
            raise ValueError(f"Invalid candidate in score row {row['groupId']}.")
        if candidate["id"] in ids:
            raise ValueError(f"Duplicate candidate score {candidate['id']} in {row['groupId']}.")
        ids.add(candidate["id"])
        score = candidate.get("score")
        relevance = candidate.get("relevance")
        if not isinstance(score, (int, float)) or isinstance(score, bool) or not math.isfinite(score):
            raise ValueError(f"Non-finite score for {candidate['id']}.")
        if type(relevance) is not int or not 0 <= relevance <= 3:
            raise ValueError(f"Invalid relevance for {candidate['id']}.")


def rows_for_split(rows: Iterable[dict[str, Any]], split: str) -> list[dict[str, Any]]:
    selected = [row for row in rows if row["split"] == split]
    if not selected:
        raise ValueError(f"Score rows contain no {split} examples.")
    return selected
