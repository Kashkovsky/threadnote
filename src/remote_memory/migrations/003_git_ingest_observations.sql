ALTER TABLE remote_memory.shares
  ADD COLUMN git_ingest_snapshot_commit text,
  ADD COLUMN git_ingest_cursor text,
  ADD COLUMN git_ingest_rejected_path text,
  ADD CONSTRAINT shares_git_ingest_commit_shape CHECK (
    git_ingest_snapshot_commit IS NULL OR git_ingest_snapshot_commit ~ '^[0-9a-f]{40,64}$'
  );

ALTER TABLE remote_memory.memory_revisions
  ADD COLUMN git_observed_commit text,
  ADD CONSTRAINT memory_revisions_git_observation_shape CHECK (
    git_observed_commit IS NULL OR (git_commit IS NOT NULL AND git_observed_commit ~ '^[0-9a-f]{40,64}$')
  );
