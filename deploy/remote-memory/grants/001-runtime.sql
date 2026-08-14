\set ON_ERROR_STOP on

REVOKE ALL ON ALL TABLES IN SCHEMA remote_memory FROM threadnote_remote_runtime;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA remote_memory FROM threadnote_remote_runtime;
REVOKE CREATE ON SCHEMA remote_memory FROM threadnote_remote_runtime;
GRANT USAGE ON SCHEMA remote_memory TO threadnote_remote_runtime;

GRANT SELECT ON
  remote_memory.share_directory,
  remote_memory.challenge_directory,
  remote_memory.worker_health,
  remote_memory.tenant_memberships,
  remote_memory.shares,
  remote_memory.share_grants,
  remote_memory.projects,
  remote_memory.grant_policy_versions,
  remote_memory.share_policy_versions,
  remote_memory.project_repository_bindings,
  remote_memory.memory_heads,
  remote_memory.workload_attestations,
  remote_memory.attestation_challenges,
  remote_memory.memory_revisions,
  remote_memory.idempotency_records,
  remote_memory.outbox_events,
  remote_memory.rate_limit_windows,
  remote_memory.uri_aliases,
  remote_memory.search_documents
TO threadnote_remote_runtime;

GRANT SELECT (id, status) ON remote_memory.tenants TO threadnote_remote_runtime;
GRANT SELECT (tenant_id, id, status) ON remote_memory.principals TO threadnote_remote_runtime;
GRANT SELECT (tenant_id, issuer, subject, principal_id)
  ON remote_memory.external_identities TO threadnote_remote_runtime;

GRANT INSERT ON
  remote_memory.challenge_directory,
  remote_memory.memory_heads,
  remote_memory.workload_attestations,
  remote_memory.attestation_challenges,
  remote_memory.memory_revisions,
  remote_memory.idempotency_records,
  remote_memory.outbox_events,
  remote_memory.audit_events,
  remote_memory.rate_limit_windows,
  remote_memory.search_documents
TO threadnote_remote_runtime;

GRANT UPDATE (share_generation, indexed_generation) ON remote_memory.shares TO threadnote_remote_runtime;
GRANT UPDATE (current_revision_id, status, retention_class, expires_at, updated_at)
  ON remote_memory.memory_heads TO threadnote_remote_runtime;
GRANT UPDATE (issuer, subject, jwt_id, cloud_agent_id, turn_id, team_id, owner_id, repository_urls)
  ON remote_memory.workload_attestations TO threadnote_remote_runtime;
GRANT UPDATE (attempts, consumed_at) ON remote_memory.attestation_challenges TO threadnote_remote_runtime;
GRANT UPDATE (outcome) ON remote_memory.idempotency_records TO threadnote_remote_runtime;
GRANT UPDATE (heartbeat_at, last_success_at, last_failure_at, failure_class, pending_work, oldest_pending_at, updated_at)
  ON remote_memory.worker_health TO threadnote_remote_runtime;
GRANT UPDATE (attempts, available_at, processed_at, dead_lettered_at, last_error_class)
  ON remote_memory.outbox_events TO threadnote_remote_runtime;
GRANT UPDATE (window_started_at, request_count) ON remote_memory.rate_limit_windows TO threadnote_remote_runtime;
GRANT UPDATE (revision_id, generation, project, topic, kind, searchable, updated_at)
  ON remote_memory.search_documents TO threadnote_remote_runtime;

GRANT DELETE ON
  remote_memory.challenge_directory,
  remote_memory.attestation_challenges,
  remote_memory.uri_aliases
TO threadnote_remote_runtime;
