from __future__ import annotations

import hashlib
import subprocess
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class GitSourceState:
    revision: str
    content_sha256: str
    dirty: bool
    file_count: int


def file_sha256(path: str | Path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def directory_sha256(path: str | Path) -> tuple[str, int]:
    root = Path(path).resolve()
    files = sorted((candidate for candidate in root.rglob("*") if candidate.is_file()), key=_relative(root))
    return _hash_files(root, files), len(files)


def selected_files_sha256(path: str | Path, relative_paths: tuple[str, ...]) -> str:
    root = Path(path).resolve()
    if not relative_paths:
        raise ValueError("At least one provenance file is required.")
    files: list[Path] = []
    for relative_value in relative_paths:
        relative = Path(relative_value)
        if relative.is_absolute() or any(part in ("", ".", "..") for part in relative.parts):
            raise ValueError(f"Unsafe provenance file path: {relative_value}")
        candidate = root / relative
        if not candidate.is_file():
            raise ValueError(f"Provenance file is missing: {relative_value}")
        files.append(candidate)
    return _hash_files(root, sorted(files, key=_relative(root)))


def git_source_state(path: str | Path, *, include_untracked: bool = True) -> GitSourceState:
    source = Path(path).resolve()
    working_directory = source.parent if source.is_file() else source
    root = Path(_git(working_directory, "rev-parse", "--show-toplevel")).resolve()
    revision = _git(root, "rev-parse", "HEAD")
    if len(revision) != 40 or any(character not in "0123456789abcdef" for character in revision):
        raise ValueError("Git source revision is not an immutable commit.")
    listing = ["ls-files", "--cached", "-z"]
    if include_untracked:
        listing[1:1] = ["--others", "--exclude-standard"]
    raw_paths = _git_bytes(root, *listing)
    relative_paths = sorted(
        (Path(value.decode("utf-8")) for value in raw_paths.split(b"\0") if value),
        key=lambda candidate: candidate.as_posix().encode("utf-8"),
    )
    files = [root / relative for relative in relative_paths if (root / relative).is_file()]
    dirty = bool(_git(root, "status", "--porcelain=v1", "--untracked-files=all"))
    return GitSourceState(
        revision=revision,
        content_sha256=_hash_files(root, files),
        dirty=dirty,
        file_count=len(files),
    )


def _git(path: str | Path, *arguments: str) -> str:
    return _git_bytes(path, *arguments).decode("utf-8").strip()


def _git_bytes(path: str | Path, *arguments: str) -> bytes:
    result = subprocess.run(
        ["git", "-C", str(Path(path).resolve()), *arguments],
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", errors="replace").strip()
        raise ValueError(f"Could not inspect Git provenance: {detail or 'git command failed'}")
    return result.stdout


def _hash_files(root: Path, files: list[Path]) -> str:
    digest = hashlib.sha256()
    for path in files:
        relative = path.relative_to(root).as_posix().encode("utf-8")
        digest.update(relative)
        digest.update(b"\0")
        digest.update(hashlib.sha256(path.read_bytes()).digest())
        digest.update(b"\0")
    return digest.hexdigest()


def _relative(root: Path):
    return lambda candidate: candidate.relative_to(root).as_posix().encode("utf-8")
