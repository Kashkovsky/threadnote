from __future__ import annotations

from pathlib import Path

from .configuration import HarnessConfig
from .provenance import selected_files_sha256


def prepare_base_model_snapshot(config: HarnessConfig, *, allow_network: bool) -> Path:
    try:
        from huggingface_hub import snapshot_download
    except ImportError as cause:
        raise RuntimeError("huggingface-hub is required to prepare the pinned base-model snapshot.") from cause

    snapshot = Path(
        snapshot_download(
            repo_id=config.base_model.id,
            revision=config.base_model.revision,
            allow_patterns=list(config.base_model.snapshot_files),
            local_files_only=not allow_network,
        )
    ).resolve()
    digest = selected_files_sha256(snapshot, config.base_model.snapshot_files)
    if digest != config.base_model.snapshot_sha256:
        raise ValueError(
            f"Base-model snapshot digest {digest} does not match pinned digest {config.base_model.snapshot_sha256}."
        )
    return snapshot
