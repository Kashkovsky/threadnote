\set ON_ERROR_STOP on

REVOKE ALL ON ALL TABLES IN SCHEMA remote_memory FROM threadnote_context_health_worker;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA remote_memory FROM threadnote_context_health_worker;
REVOKE ALL PRIVILEGES ON SCHEMA remote_memory FROM threadnote_context_health_worker;
GRANT USAGE ON SCHEMA remote_memory TO threadnote_context_health_worker;

REVOKE ALL PRIVILEGES ON FUNCTION remote_memory.lock_context_health_target(text, text, text, text)
  FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION remote_memory.lock_context_health_target(text, text, text, text)
  FROM threadnote_context_health_worker;
GRANT EXECUTE ON FUNCTION remote_memory.lock_context_health_target(text, text, text, text)
  TO threadnote_context_health_worker;

GRANT SELECT (id, status)
  ON remote_memory.tenants TO threadnote_context_health_worker;
GRANT SELECT (tenant_id, id, status, git_ingest_snapshot_commit, share_generation)
  ON remote_memory.shares TO threadnote_context_health_worker;
GRANT SELECT (tenant_id, share_id, name, status)
  ON remote_memory.projects TO threadnote_context_health_worker;
GRANT SELECT (tenant_id, share_id, project_name)
  ON remote_memory.project_repository_bindings TO threadnote_context_health_worker;
GRANT SELECT (tenant_id, share_id, id, kind, topic, current_revision_id, project, status)
  ON remote_memory.memory_heads TO threadnote_context_health_worker;
GRANT SELECT (tenant_id, share_id, head_id, id, content_hash, git_commit, git_observed_commit)
  ON remote_memory.memory_revisions TO threadnote_context_health_worker;
GRANT SELECT (tenant_id, share_id, version, digest, policy_document)
  ON remote_memory.context_health_policies TO threadnote_context_health_worker;
GRANT SELECT (tenant_id, share_id, project_name, schedule_id, cadence_minutes, policy_version,
  policy_digest, status, next_due_at, consecutive_failures, consecutive_stale_runs,
  last_success_at, last_success_receipt_id, last_failure_at, last_failure_receipt_id)
  ON remote_memory.context_health_schedules TO threadnote_context_health_worker;
GRANT SELECT (tenant_id, schedule_id, input_digest, receipt)
  ON remote_memory.context_health_receipts TO threadnote_context_health_worker;
GRANT SELECT (schedule_id, tenant_id, share_id, project_name, status, next_due_at,
  claim_token, claim_expires_at, claim_generation)
  ON remote_memory.context_health_due_directory TO threadnote_context_health_worker;
GRANT SELECT (worker_name, generation, tenant_cursor_ordinal, last_success_at, last_failure_at)
  ON remote_memory.context_health_worker_state TO threadnote_context_health_worker;

GRANT INSERT (tenant_id, share_id, project_name, receipt_id, schedule_id, input_digest,
  outcome, receipt, observed_at)
  ON remote_memory.context_health_receipts TO threadnote_context_health_worker;
GRANT UPDATE (next_due_at, consecutive_failures, consecutive_stale_runs,
  last_attempt_at, last_success_at, last_success_receipt_id, last_failure_at,
  last_failure_receipt_id, updated_at)
  ON remote_memory.context_health_schedules TO threadnote_context_health_worker;
GRANT UPDATE (next_due_at, claim_token, claim_expires_at, claim_generation, updated_at)
  ON remote_memory.context_health_due_directory TO threadnote_context_health_worker;
GRANT UPDATE (heartbeat_at, last_success_at, last_failure_at, failure_class, backlog_depth,
  scheduler_lag_minutes, tenant_cursor_ordinal, generation, updated_at)
  ON remote_memory.context_health_worker_state TO threadnote_context_health_worker;
