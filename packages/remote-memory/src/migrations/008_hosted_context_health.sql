-- Hosted Context Health stores only scheduling metadata and content-free
-- receipts. Canonical memory bodies remain in Git.
CREATE TABLE remote_memory.context_health_policies (
  tenant_id text NOT NULL,
  share_id text NOT NULL,
  version text NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  policy_document jsonb NOT NULL CHECK (octet_length(policy_document::text) <= 16384),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, share_id, version),
  UNIQUE (tenant_id, share_id, version, digest),
  FOREIGN KEY (tenant_id, share_id) REFERENCES remote_memory.shares(tenant_id, id)
);

CREATE TABLE remote_memory.context_health_schedules (
  tenant_id text NOT NULL,
  share_id text NOT NULL,
  project_name text NOT NULL,
  schedule_id text NOT NULL CHECK (schedule_id ~ '^tnhs_[0-9a-f]{32}$'),
  cadence_minutes integer NOT NULL CHECK (cadence_minutes BETWEEN 5 AND 43200),
  policy_version text NOT NULL,
  policy_digest text NOT NULL CHECK (policy_digest ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  next_due_at timestamptz NOT NULL,
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures BETWEEN 0 AND 31),
  consecutive_stale_runs bigint NOT NULL DEFAULT 0 CHECK (consecutive_stale_runs >= 0),
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_success_receipt_id text,
  last_failure_at timestamptz,
  last_failure_receipt_id text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, share_id, project_name),
  UNIQUE (schedule_id),
  UNIQUE (tenant_id, schedule_id),
  FOREIGN KEY (tenant_id, share_id, project_name)
    REFERENCES remote_memory.projects(tenant_id, share_id, name),
  FOREIGN KEY (tenant_id, share_id, policy_version, policy_digest)
    REFERENCES remote_memory.context_health_policies(tenant_id, share_id, version, digest)
);

CREATE TABLE remote_memory.context_health_receipts (
  tenant_id text NOT NULL,
  share_id text NOT NULL,
  project_name text NOT NULL,
  receipt_id text NOT NULL CHECK (receipt_id ~ '^tnhr_[0-9a-f]{32}$'),
  schedule_id text NOT NULL CHECK (schedule_id ~ '^tnhs_[0-9a-f]{32}$'),
  input_digest text NOT NULL CHECK (input_digest ~ '^[0-9a-f]{64}$'),
  outcome text NOT NULL CHECK (outcome IN ('clean', 'findings', 'unknown')),
  receipt jsonb NOT NULL CHECK (octet_length(receipt::text) <= 65536),
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, share_id, project_name, receipt_id),
  UNIQUE (tenant_id, schedule_id, input_digest),
  FOREIGN KEY (tenant_id, share_id, project_name)
    REFERENCES remote_memory.context_health_schedules(tenant_id, share_id, project_name)
);

CREATE INDEX context_health_schedules_due
  ON remote_memory.context_health_schedules(next_due_at, tenant_id, schedule_id)
  WHERE status = 'active';

-- Cross-tenant discovery is deliberately limited to content-free scheduling
-- coordinates. Tenant data remains behind RLS in context_health_schedules;
-- every claimed job re-enters that tenant and revalidates its target and
-- immutable evidence before a receipt can be committed.
CREATE TABLE remote_memory.context_health_due_directory (
  schedule_id text PRIMARY KEY REFERENCES remote_memory.context_health_schedules(schedule_id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  tenant_id text NOT NULL,
  share_id text NOT NULL,
  project_name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  next_due_at timestamptz NOT NULL,
  claim_token text CHECK (claim_token IS NULL OR claim_token ~ '^[0-9a-f]{32}$'),
  claim_expires_at timestamptz,
  claim_generation bigint NOT NULL DEFAULT 0 CHECK (claim_generation >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((claim_token IS NULL) = (claim_expires_at IS NULL)),
  FOREIGN KEY (tenant_id, share_id, project_name)
    REFERENCES remote_memory.context_health_schedules(tenant_id, share_id, project_name)
);

CREATE INDEX context_health_due_directory_ready
  ON remote_memory.context_health_due_directory(next_due_at, tenant_id, schedule_id)
  WHERE status = 'active';

CREATE TRIGGER context_health_receipts_immutable
  BEFORE UPDATE OR DELETE ON remote_memory.context_health_receipts
  FOR EACH ROW EXECUTE FUNCTION remote_memory.reject_immutable_mutation();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'context_health_policies', 'context_health_schedules', 'context_health_receipts'
  ] LOOP
    EXECUTE format('ALTER TABLE remote_memory.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE remote_memory.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON remote_memory.%I USING '
      || '(tenant_id = current_setting(''threadnote.tenant_id'', true)) '
      || 'WITH CHECK (tenant_id = current_setting(''threadnote.tenant_id'', true))',
      table_name
    );
  END LOOP;
END $$;

-- One content-free scheduler row coordinates replicas. It never stores a
-- tenant, share, project, repository, path, identity, or memory body.
CREATE TABLE remote_memory.context_health_worker_state (
  worker_name text PRIMARY KEY CHECK (worker_name = 'context-health'),
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  last_success_at timestamptz,
  last_failure_at timestamptz,
  failure_class text,
  backlog_depth bigint NOT NULL DEFAULT 0 CHECK (backlog_depth >= 0),
  scheduler_lag_minutes integer NOT NULL DEFAULT 0 CHECK (scheduler_lag_minutes >= 0),
  tenant_cursor_ordinal bigint NOT NULL DEFAULT 0 CHECK (tenant_cursor_ordinal >= 0),
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO remote_memory.context_health_worker_state(worker_name) VALUES ('context-health');

-- The worker has no control-plane UPDATE authority. This narrow definer
-- function acquires share locks on the lifecycle rows so a receipt transaction
-- cannot race tenant suspension, share revocation, project archival, or
-- schedule pause. RLS still requires the caller to select the tenant context.
CREATE FUNCTION remote_memory.lock_context_health_target(
  requested_tenant_id text,
  requested_share_id text,
  requested_project_name text,
  requested_schedule_id text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE target_present boolean;
BEGIN
  IF current_setting('threadnote.tenant_id', true) IS DISTINCT FROM requested_tenant_id THEN
    RETURN false;
  END IF;
  SELECT true INTO target_present
  FROM remote_memory.tenants t
  JOIN remote_memory.shares s ON s.tenant_id = t.id
  JOIN remote_memory.projects p ON p.tenant_id = s.tenant_id AND p.share_id = s.id
  JOIN remote_memory.context_health_schedules c
    ON c.tenant_id = p.tenant_id AND c.share_id = p.share_id AND c.project_name = p.name
  WHERE t.id = requested_tenant_id AND s.id = requested_share_id
    AND p.name = requested_project_name AND c.schedule_id = requested_schedule_id
    AND t.status = 'active' AND s.status = 'active' AND p.status = 'active' AND c.status = 'active'
  FOR UPDATE OF s
  FOR SHARE OF t, p, c;
  IF NOT coalesce(target_present, false) THEN
    RETURN false;
  END IF;
  PERFORM 1
  FROM remote_memory.memory_heads h
  JOIN remote_memory.memory_revisions r
    ON r.tenant_id = h.tenant_id AND r.share_id = h.share_id
    AND r.head_id = h.id AND r.id = h.current_revision_id
  WHERE h.tenant_id = requested_tenant_id AND h.share_id = requested_share_id
    AND h.project = requested_project_name AND h.status = 'active'
  FOR SHARE OF h, r;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION remote_memory.lock_context_health_target(text, text, text, text) FROM PUBLIC;
