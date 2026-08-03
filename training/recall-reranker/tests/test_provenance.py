from __future__ import annotations

import subprocess
from pathlib import Path

from threadnote_reranker_training.provenance import directory_sha256, git_source_state


def test_directory_hash_is_path_and_content_sensitive(tmp_path: Path) -> None:
    first = tmp_path / "first"
    second = tmp_path / "second"
    first.mkdir()
    second.mkdir()
    (first / "a.txt").write_text("one", encoding="utf-8")
    (second / "a.txt").write_text("one", encoding="utf-8")

    assert directory_sha256(first) == directory_sha256(second)
    (second / "b.txt").write_text("two", encoding="utf-8")
    assert directory_sha256(first) != directory_sha256(second)


def test_git_source_state_includes_uncommitted_content(tmp_path: Path) -> None:
    _git(tmp_path, "init")
    _git(tmp_path, "config", "user.email", "test@example.invalid")
    _git(tmp_path, "config", "user.name", "Threadnote test")
    (tmp_path / "tracked.txt").write_text("tracked", encoding="utf-8")
    _git(tmp_path, "add", "tracked.txt")
    _git(tmp_path, "commit", "-m", "fixture")

    clean = git_source_state(tmp_path)
    assert clean.dirty is False
    assert clean.file_count == 1
    assert git_source_state(tmp_path / "tracked.txt") == clean

    (tmp_path / "untracked.txt").write_text("untracked", encoding="utf-8")
    dirty = git_source_state(tmp_path)
    assert dirty.dirty is True
    assert dirty.file_count == 2
    assert dirty.content_sha256 != clean.content_sha256


def _git(root: Path, *arguments: str) -> None:
    subprocess.run(["git", "-C", str(root), *arguments], check=True, capture_output=True)
