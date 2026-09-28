CREATE TABLE remote_memory.context_ci_control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  enabled boolean NOT NULL DEFAULT false
);
INSERT INTO remote_memory.context_ci_control(singleton) VALUES (true);

CREATE TABLE remote_memory.context_ci_targets (
  tenant_id text NOT NULL,
  repository_id text NOT NULL,
  share_id text NOT NULL,
  project_name text NOT NULL,
  policy_digest text NOT NULL CHECK (policy_digest ~ '^[a-f0-9]{64}$'),
  policy jsonb NOT NULL CHECK (octet_length(policy::text) <= 65536),
  opted_in boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, repository_id),
  FOREIGN KEY (tenant_id, share_id, project_name) REFERENCES remote_memory.projects(tenant_id, share_id, name)
);

CREATE TABLE remote_memory.context_ci_tenant_limits (
  tenant_id text PRIMARY KEY REFERENCES remote_memory.tenants(id),
  window_started_at timestamptz NOT NULL DEFAULT now(),
  request_count integer NOT NULL DEFAULT 0 CHECK (request_count BETWEEN 0 AND 1000)
);

CREATE TABLE remote_memory.context_ci_jobs (
  tenant_id text NOT NULL,
  repository_id text NOT NULL,
  job_id text NOT NULL CHECK (job_id ~ '^tnci_[a-f0-9]{64}$'),
  input_digest text NOT NULL CHECK (input_digest ~ '^[a-f0-9]{64}$'),
  job jsonb CHECK (octet_length(job::text) <= 16384),
  stage text NOT NULL DEFAULT 'queued' CHECK (stage IN ('queued', 'evaluated', 'published', 'failed', 'archived')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  available_at timestamptz NOT NULL DEFAULT now(),
  diagnostics jsonb CHECK (octet_length(diagnostics::text) <= 1048576),
  archived_outcome text CHECK (archived_outcome IN ('published', 'failed')),
  CHECK ((stage = 'archived' AND job IS NULL AND diagnostics IS NULL AND archived_outcome IS NOT NULL)
    OR (stage <> 'archived' AND job IS NOT NULL AND archived_outcome IS NULL)),
  PRIMARY KEY (tenant_id, job_id),
  FOREIGN KEY (tenant_id, repository_id) REFERENCES remote_memory.context_ci_targets(tenant_id, repository_id)
);
CREATE INDEX context_ci_jobs_due ON remote_memory.context_ci_jobs(tenant_id, stage, available_at, job_id)
  WHERE stage IN ('queued', 'evaluated');
CREATE INDEX context_ci_jobs_live_tenant ON remote_memory.context_ci_jobs(tenant_id)
  WHERE stage <> 'archived';

CREATE TRIGGER context_ci_tombstones_immutable BEFORE UPDATE OR DELETE ON remote_memory.context_ci_jobs
  FOR EACH ROW WHEN (OLD.stage = 'archived') EXECUTE FUNCTION remote_memory.reject_immutable_mutation();

CREATE TABLE remote_memory.context_ci_receipts (
  tenant_id text NOT NULL,
  job_id text NOT NULL,
  attempt integer NOT NULL CHECK (attempt BETWEEN 1 AND 20),
  receipt jsonb NOT NULL CHECK (octet_length(receipt::text) <= 4096),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, job_id, attempt),
  FOREIGN KEY (tenant_id, job_id) REFERENCES remote_memory.context_ci_jobs(tenant_id, job_id)
);
CREATE TRIGGER context_ci_receipts_immutable BEFORE UPDATE OR DELETE ON remote_memory.context_ci_receipts
  FOR EACH ROW EXECUTE FUNCTION remote_memory.reject_immutable_mutation();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['context_ci_targets', 'context_ci_tenant_limits', 'context_ci_jobs', 'context_ci_receipts'] LOOP
    EXECUTE format('ALTER TABLE remote_memory.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE remote_memory.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON remote_memory.%I USING '
      || '(tenant_id = current_setting(''threadnote.tenant_id'', true)) '
      || 'WITH CHECK (tenant_id = current_setting(''threadnote.tenant_id'', true))', table_name);
  END LOOP;
END $$;

CREATE FUNCTION remote_memory.lock_context_ci_target(requested_tenant text, requested_repository text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE present boolean;
BEGIN
  IF current_setting('threadnote.tenant_id', true) IS DISTINCT FROM requested_tenant THEN RETURN false; END IF;
  PERFORM 1 FROM remote_memory.context_ci_control WHERE singleton AND enabled FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT true INTO present
  FROM remote_memory.context_ci_targets c
  JOIN remote_memory.tenants t ON t.id = c.tenant_id
  JOIN remote_memory.shares s ON s.tenant_id = c.tenant_id AND s.id = c.share_id
  JOIN remote_memory.projects p ON p.tenant_id = c.tenant_id AND p.share_id = c.share_id AND p.name = c.project_name
  WHERE c.tenant_id = requested_tenant AND c.repository_id = requested_repository
    AND c.opted_in AND t.status = 'active' AND s.status = 'active' AND p.status = 'active'
  FOR SHARE OF c, t, s, p;
  RETURN coalesce(present, false);
END;
$$;
REVOKE ALL ON FUNCTION remote_memory.lock_context_ci_target(text, text) FROM PUBLIC;
