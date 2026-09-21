\set ON_ERROR_STOP on

-- Separate from the MCP runtime, Git reader, and provider check publisher.
REVOKE ALL ON ALL TABLES IN SCHEMA remote_memory FROM threadnote_context_ci_worker;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA remote_memory FROM threadnote_context_ci_worker;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA remote_memory FROM threadnote_context_ci_worker;
REVOKE ALL ON SCHEMA remote_memory FROM threadnote_context_ci_worker;
GRANT USAGE ON SCHEMA remote_memory TO threadnote_context_ci_worker;
GRANT EXECUTE ON FUNCTION remote_memory.lock_context_ci_target(text, text) TO threadnote_context_ci_worker;
GRANT SELECT ON remote_memory.context_ci_targets, remote_memory.context_ci_jobs,
  remote_memory.context_ci_tenant_limits, remote_memory.context_ci_receipts TO threadnote_context_ci_worker;
GRANT INSERT ON remote_memory.context_ci_jobs, remote_memory.context_ci_receipts TO threadnote_context_ci_worker;
GRANT UPDATE (window_started_at, request_count) ON remote_memory.context_ci_tenant_limits TO threadnote_context_ci_worker;
GRANT UPDATE (stage, attempts, available_at, diagnostics) ON remote_memory.context_ci_jobs TO threadnote_context_ci_worker;
