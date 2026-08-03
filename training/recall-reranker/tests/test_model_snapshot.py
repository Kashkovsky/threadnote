from __future__ import annotations

from pathlib import Path

import pytest

from threadnote_reranker_training.configuration import load_config
from threadnote_reranker_training.provenance import selected_files_sha256


def test_pinned_snapshot_hash_rejects_missing_or_changed_files(tmp_path: Path) -> None:
    config = load_config(Path(__file__).parents[1] / "configs" / "modernbert-base-v1.json")
    for relative in config.base_model.snapshot_files:
        path = tmp_path / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(relative, encoding="utf-8")

    digest = selected_files_sha256(tmp_path, config.base_model.snapshot_files)
    assert len(digest) == 64
    (tmp_path / config.base_model.snapshot_files[0]).write_text("changed", encoding="utf-8")
    assert selected_files_sha256(tmp_path, config.base_model.snapshot_files) != digest

    (tmp_path / config.base_model.snapshot_files[-1]).unlink()
    with pytest.raises(ValueError, match="missing"):
        selected_files_sha256(tmp_path, config.base_model.snapshot_files)
