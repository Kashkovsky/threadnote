ALTER TABLE remote_memory.memory_revisions
  ADD COLUMN git_commit text,
  ADD COLUMN git_path text;

ALTER TABLE remote_memory.memory_revisions
  ADD CONSTRAINT memory_revisions_git_pointers_consistent CHECK (
    (git_commit IS NULL) = (git_path IS NULL)
  );

ALTER TABLE remote_memory.memory_revisions
  ADD CONSTRAINT memory_revisions_git_commit_shape CHECK (
    git_commit IS NULL OR git_commit ~ '^[0-9a-f]{40,64}$'
  );

ALTER TABLE remote_memory.memory_revisions
  ADD CONSTRAINT memory_revisions_git_body_empty CHECK (
    git_commit IS NULL OR markdown_body = ''
  );
