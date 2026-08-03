from __future__ import annotations

from pathlib import Path

import pytest

from threadnote_reranker_training.dataset import DatasetBundle
from threadnote_reranker_training.parity import (
    model_tree_sha256,
    resolve_run_model_path,
    select_validation_groups,
    validate_run_model_tree,
)


def test_selects_a_deterministic_stratified_validation_sample(tmp_path: Path) -> None:
    groups = tuple(
        {
            "answerability": answerability,
            "id": f"{answerability}-{index}",
            "split": "validation" if index < 4 else "train",
        }
        for index in range(5)
        for answerability in ("answerable", "no_answer")
    )
    dataset = DatasetBundle(
        root=tmp_path,
        manifest={"groupsSha256": "a" * 64, "purpose": "harness_smoke"},
        groups=groups,
        validation_receipt={},
    )

    first = select_validation_groups(dataset, 5)
    second = select_validation_groups(dataset, 5)

    assert first == second
    assert len(first) == 5
    assert all(group["split"] == "validation" for group in first)
    assert [group["answerability"] for group in first[:4]] == [
        "answerable",
        "no_answer",
        "answerable",
        "no_answer",
    ]


def test_model_tree_hash_binds_paths_and_bytes_and_rejects_symlinks(tmp_path: Path) -> None:
    model = tmp_path / "model"
    model.mkdir()
    (model / "config.json").write_text("{}", encoding="utf-8")
    weights = model / "weights.bin"
    weights.write_bytes(b"one")
    before = model_tree_sha256(model)

    weights.write_bytes(b"two")
    after = model_tree_sha256(model)

    assert before != after
    link = model / "linked.bin"
    try:
        link.symlink_to(weights)
    except OSError:
        pytest.skip("Symbolic links are unavailable on this platform.")
    with pytest.raises(ValueError, match="symbolic link"):
        model_tree_sha256(model)


def test_training_run_must_bind_the_exact_safe_model_tree(tmp_path: Path) -> None:
    run_root = tmp_path / "run"
    model = run_root / "model"
    model.mkdir(parents=True)
    weights = model / "weights.bin"
    weights.write_bytes(b"trained weights")
    run = {"modelDirectory": "model", "modelTreeSha256": model_tree_sha256(model)}

    resolved = resolve_run_model_path(run_root, run)
    assert resolved == model
    assert validate_run_model_tree(run, resolved) == run["modelTreeSha256"]

    weights.write_bytes(b"tampered weights")
    with pytest.raises(ValueError, match="does not match"):
        validate_run_model_tree(run, resolved)
    with pytest.raises(ValueError, match="safe relative path"):
        resolve_run_model_path(run_root, {**run, "modelDirectory": "../outside"})
