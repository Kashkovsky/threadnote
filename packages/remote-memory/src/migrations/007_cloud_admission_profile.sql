ALTER TABLE remote_memory.share_grants
  ADD COLUMN cloud_admission_required boolean NOT NULL DEFAULT false;
