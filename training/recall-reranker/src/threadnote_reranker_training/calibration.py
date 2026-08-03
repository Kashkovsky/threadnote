from __future__ import annotations

import math
import statistics
from collections.abc import Iterable
from dataclasses import asdict, dataclass
from typing import Any

FEATURES = ("top_score", "top_margin", "top_three_mean")


@dataclass(frozen=True)
class AnswerabilityCalibration:
    version: int
    features: tuple[str, ...]
    means: tuple[float, ...]
    scales: tuple[float, ...]
    weights: tuple[float, ...]
    bias: float
    threshold: float
    validation_metrics: dict[str, float | int]

    def to_json(self) -> dict[str, Any]:
        return asdict(self)


def fit_answerability_calibration(
    rows: Iterable[dict[str, Any]],
    *,
    iterations: int = 4_000,
    learning_rate: float = 0.05,
    l2: float = 0.01,
) -> AnswerabilityCalibration:
    examples = list(rows)
    if not examples:
        raise ValueError("Calibration requires score rows.")
    labels = [1.0 if row["answerability"] == "answerable" else 0.0 for row in examples]
    if len(set(labels)) != 2:
        raise ValueError("Calibration requires both answerable and no-answer rows.")
    raw_features = [answerability_features(row) for row in examples]
    columns = list(zip(*raw_features, strict=True))
    means = tuple(statistics.fmean(column) for column in columns)
    scales = tuple(max(statistics.pstdev(column), 1e-6) for column in columns)
    features = [
        tuple((value - means[index]) / scales[index] for index, value in enumerate(row)) for row in raw_features
    ]
    weights = [0.0] * len(FEATURES)
    bias = 0.0
    count = float(len(features))
    for _ in range(iterations):
        weight_gradients = [0.0] * len(weights)
        bias_gradient = 0.0
        for vector, label in zip(features, labels, strict=True):
            probability = _sigmoid(bias + sum(weight * value for weight, value in zip(weights, vector, strict=True)))
            error = probability - label
            bias_gradient += error
            for index, value in enumerate(vector):
                weight_gradients[index] += error * value
        bias -= learning_rate * bias_gradient / count
        for index in range(len(weights)):
            weights[index] -= learning_rate * (weight_gradients[index] / count + l2 * weights[index])
    probabilities = [
        _sigmoid(bias + sum(weight * value for weight, value in zip(weights, vector, strict=True)))
        for vector in features
    ]
    threshold, metrics = select_threshold(probabilities, labels)
    return AnswerabilityCalibration(
        version=1,
        features=FEATURES,
        means=means,
        scales=scales,
        weights=tuple(weights),
        bias=bias,
        threshold=threshold,
        validation_metrics=metrics,
    )


def parse_calibration(value: dict[str, Any]) -> AnswerabilityCalibration:
    if value.get("version") != 1 or tuple(value.get("features", ())) != FEATURES:
        raise ValueError("Unsupported answerability calibration artifact.")
    calibration = AnswerabilityCalibration(
        version=1,
        features=FEATURES,
        means=_finite_tuple(value.get("means"), len(FEATURES), "means"),
        scales=_finite_tuple(value.get("scales"), len(FEATURES), "scales"),
        weights=_finite_tuple(value.get("weights"), len(FEATURES), "weights"),
        bias=_finite_number(value.get("bias"), "bias"),
        threshold=_finite_number(value.get("threshold"), "threshold"),
        validation_metrics=dict(value.get("validation_metrics", {})),
    )
    if any(scale <= 0 for scale in calibration.scales) or not 0 <= calibration.threshold <= 1:
        raise ValueError("Invalid answerability calibration scale or threshold.")
    return calibration


def answerability_probability(calibration: AnswerabilityCalibration, row: dict[str, Any]) -> float:
    raw = answerability_features(row)
    normalized = tuple(
        (value - calibration.means[index]) / calibration.scales[index] for index, value in enumerate(raw)
    )
    return _sigmoid(
        calibration.bias + sum(weight * value for weight, value in zip(calibration.weights, normalized, strict=True))
    )


def predicts_answer(calibration: AnswerabilityCalibration, row: dict[str, Any]) -> bool:
    return answerability_probability(calibration, row) >= calibration.threshold


def answerability_features(row: dict[str, Any]) -> tuple[float, float, float]:
    scores = sorted((float(candidate["score"]) for candidate in row["candidates"]), reverse=True)
    top = scores[0]
    margin = top - scores[1]
    top_three = scores[:3]
    return top, margin, statistics.fmean(top_three)


def select_threshold(probabilities: list[float], labels: list[float]) -> tuple[float, dict[str, float | int]]:
    ordered = sorted(set([0.0, 1.0, *probabilities]))
    candidates = set(ordered)
    candidates.update((left + right) / 2.0 for left, right in zip(ordered, ordered[1:], strict=False))
    best_threshold = 0.5
    best_metrics: dict[str, float | int] = {}
    best_key = (-1.0, -1.0, -1.0, -1.0)
    for threshold in sorted(candidates):
        metrics = no_answer_metrics(probabilities, labels, threshold)
        key = (
            float(metrics["noAnswerF1"]),
            float(metrics["noAnswerRecall"]),
            float(metrics["noAnswerPrecision"]),
            -abs(threshold - 0.5),
        )
        if key > best_key:
            best_key = key
            best_threshold = threshold
            best_metrics = metrics
    return best_threshold, best_metrics


def no_answer_metrics(probabilities: list[float], labels: list[float], threshold: float) -> dict[str, float | int]:
    true_positive = false_positive = false_negative = true_negative = 0
    for probability, answerable in zip(probabilities, labels, strict=True):
        predicted_no_answer = probability < threshold
        expected_no_answer = answerable == 0.0
        if predicted_no_answer and expected_no_answer:
            true_positive += 1
        elif predicted_no_answer:
            false_positive += 1
        elif expected_no_answer:
            false_negative += 1
        else:
            true_negative += 1
    precision = _ratio(true_positive, true_positive + false_positive)
    recall = _ratio(true_positive, true_positive + false_negative)
    f1 = _ratio(2 * precision * recall, precision + recall)
    accuracy = _ratio(true_positive + true_negative, len(labels))
    return {
        "accuracy": accuracy,
        "falseNegative": false_negative,
        "falsePositive": false_positive,
        "noAnswerF1": f1,
        "noAnswerPrecision": precision,
        "noAnswerRecall": recall,
        "trueNegative": true_negative,
        "truePositive": true_positive,
    }


def _finite_tuple(value: Any, length: int, label: str) -> tuple[float, ...]:
    if not isinstance(value, (list, tuple)) or len(value) != length:
        raise ValueError(f"Calibration {label} must contain {length} values.")
    return tuple(_finite_number(item, label) for item in value)


def _finite_number(value: Any, label: str) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
        raise ValueError(f"Calibration {label} contains a non-finite value.")
    return float(value)


def _sigmoid(value: float) -> float:
    if value >= 0:
        inverse = math.exp(-value)
        return 1.0 / (1.0 + inverse)
    exponential = math.exp(value)
    return exponential / (1.0 + exponential)


def _ratio(numerator: float, denominator: float) -> float:
    return numerator / denominator if denominator > 0 else 0.0
