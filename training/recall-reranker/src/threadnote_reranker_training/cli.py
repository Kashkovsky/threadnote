from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from .calibration import fit_answerability_calibration, parse_calibration
from .configuration import load_config
from .dataset import load_dataset
from .export import export_gguf
from .io import atomic_write_json
from .metrics import evaluate_scores
from .model_snapshot import prepare_base_model_snapshot
from .scores import load_score_rows, rows_for_split
from .trainer import train


def main(arguments: list[str] | None = None) -> None:
    parser = _parser()
    options = parser.parse_args(arguments)
    if options.command == "validate":
        dataset = load_dataset(options.dataset)
        result = {
            "candidates": dataset.manifest["counts"]["candidates"],
            "groups": len(dataset.groups),
            "groupsSha256": dataset.groups_sha256,
            "name": dataset.manifest["name"],
            "purpose": dataset.purpose,
        }
    elif options.command == "prepare-base-model":
        config = load_config(options.config)
        snapshot = prepare_base_model_snapshot(config, allow_network=options.allow_network)
        result = {
            "files": len(config.base_model.snapshot_files),
            "id": config.base_model.id,
            "revision": config.base_model.revision,
            "snapshotSha256": config.base_model.snapshot_sha256,
            "status": "verified",
        }
        del snapshot
    elif options.command == "train":
        result = train(
            options.dataset,
            load_config(options.config),
            options.output,
            allow_smoke=options.allow_smoke,
            device=options.device,
        )
    elif options.command == "calibrate":
        rows = rows_for_split(load_score_rows(options.scores), "validation")
        calibration = fit_answerability_calibration(rows)
        result = calibration.to_json()
        atomic_write_json(Path(options.output).resolve(), result)
    elif options.command == "evaluate":
        scores = rows_for_split(load_score_rows(options.scores), options.split)
        calibration = parse_calibration(_read_object(options.calibration))
        result = evaluate_scores(scores, calibration)
        if options.output:
            atomic_write_json(Path(options.output).resolve(), result)
    elif options.command == "export":
        result = export_gguf(options.run, load_config(options.config), options.llama_cpp, options.output)
    else:
        parser.error(f"Unknown command: {options.command}")
        return
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="threadnote-reranker",
        description="Development-only Threadnote recall-reranker training harness.",
    )
    commands = parser.add_subparsers(dest="command", required=True)
    validate = commands.add_parser("validate", help="Validate dataset integrity, provenance, and split isolation.")
    validate.add_argument("--dataset", required=True)

    prepare = commands.add_parser(
        "prepare-base-model", help="Download or verify the exact reviewed base-model snapshot before loading data."
    )
    prepare.add_argument("--config", required=True)
    prepare.add_argument("--allow-network", action="store_true")

    training = commands.add_parser("train", help="Fine-tune, score, calibrate, and evaluate one pinned model.")
    training.add_argument("--dataset", required=True)
    training.add_argument("--config", required=True)
    training.add_argument("--output", required=True)
    training.add_argument("--device", choices=("cpu", "mps"))
    training.add_argument("--allow-smoke", action="store_true")

    calibrate = commands.add_parser("calibrate", help="Fit answerability calibration from validation scores.")
    calibrate.add_argument("--scores", required=True)
    calibrate.add_argument("--output", required=True)

    evaluate = commands.add_parser("evaluate", help="Evaluate ranked scores and no-answer calibration.")
    evaluate.add_argument("--scores", required=True)
    evaluate.add_argument("--calibration", required=True)
    evaluate.add_argument("--split", choices=("validation", "test"), default="test")
    evaluate.add_argument("--output")

    exporter = commands.add_parser("export", help="Convert a trained model with a pinned llama.cpp checkout.")
    exporter.add_argument("--run", required=True)
    exporter.add_argument("--config", required=True)
    exporter.add_argument("--llama-cpp", required=True)
    exporter.add_argument("--output", required=True)
    return parser


def _read_object(path: str | Path) -> dict[str, Any]:
    value = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"Expected a JSON object: {path}")
    return value


if __name__ == "__main__":
    main()
