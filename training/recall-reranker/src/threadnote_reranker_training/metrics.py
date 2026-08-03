from __future__ import annotations

import math
from collections.abc import Iterable
from typing import Any

from .calibration import AnswerabilityCalibration, answerability_probability, no_answer_metrics


def evaluate_scores(rows: Iterable[dict[str, Any]], calibration: AnswerabilityCalibration) -> dict[str, Any]:
    selected = list(rows)
    answerable = [row for row in selected if row["answerability"] == "answerable"]
    if not selected or not answerable:
        raise ValueError("Evaluation requires score rows including answerable examples.")
    recalls = {1: [], 5: [], 10: []}
    reciprocal_ranks: list[float] = []
    ndcg = {5: [], 10: []}
    for row in answerable:
        ranked = sorted(row["candidates"], key=lambda candidate: (-float(candidate["score"]), candidate["id"]))
        relevant_ranks = [index + 1 for index, candidate in enumerate(ranked) if candidate["relevance"] > 0]
        reciprocal_ranks.append(1.0 / min(relevant_ranks) if relevant_ranks else 0.0)
        for cutoff in recalls:
            recalls[cutoff].append(1.0 if any(rank <= cutoff for rank in relevant_ranks) else 0.0)
        for cutoff in ndcg:
            ndcg[cutoff].append(_ndcg_at(ranked, cutoff))
    probabilities = [answerability_probability(calibration, row) for row in selected]
    labels = [1.0 if row["answerability"] == "answerable" else 0.0 for row in selected]
    answerability = no_answer_metrics(probabilities, labels, calibration.threshold)
    return {
        "answerability": answerability,
        "answerableGroups": len(answerable),
        "groups": len(selected),
        "meanNdcgAt10": _mean(ndcg[10]),
        "meanNdcgAt5": _mean(ndcg[5]),
        "meanReciprocalRank": _mean(reciprocal_ranks),
        "recallAt1": _mean(recalls[1]),
        "recallAt10": _mean(recalls[10]),
        "recallAt5": _mean(recalls[5]),
        "version": 1,
    }


def _ndcg_at(ranked: list[dict[str, Any]], cutoff: int) -> float:
    grades = [int(candidate["relevance"]) for candidate in ranked]
    ideal = sorted(grades, reverse=True)
    actual_dcg = _dcg(grades[:cutoff])
    ideal_dcg = _dcg(ideal[:cutoff])
    return actual_dcg / ideal_dcg if ideal_dcg > 0 else 0.0


def _dcg(grades: list[int]) -> float:
    return sum((2**grade - 1) / math.log2(index + 2) for index, grade in enumerate(grades))


def _mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0
