CREATE SCHEMA IF NOT EXISTS remote_memory;

CREATE TABLE IF NOT EXISTS remote_memory.schema_migrations (
  version integer PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE remote_memory.tenants (
  id text PRIMARY KEY,
  region text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'disabled', 'deleted')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE remote_memory.principals (
  tenant_id text NOT NULL REFERENCES remote_memory.tenants(id),
  id text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE remote_memory.external_identities (
  tenant_id text NOT NULL REFERENCES remote_memory.tenants(id),
  issuer text NOT NULL,
  subject text NOT NULL,
  principal_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, issuer, subject),
  FOREIGN KEY (tenant_id, principal_id) REFERENCES remote_memory.principals(tenant_id, id)
);

-- This content-free directory lets the service select the tenant RLS context
-- before it reads a share grant. Share ids are opaque; no display name, member,
-- project, or memory metadata is exposed here.
CREATE TABLE remote_memory.share_directory (
  share_id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES remote_memory.tenants(id),
  status text NOT NULL CHECK (status IN ('active', 'revoked', 'deleted'))
);

CREATE TABLE remote_memory.challenge_directory (
  challenge_id text PRIMARY KEY,
  share_id text NOT NULL REFERENCES remote_memory.share_directory(share_id),
  tenant_id text NOT NULL REFERENCES remote_memory.tenants(id),
  expires_at timestamptz NOT NULL
);

-- Tenant-less operational aggregate maintained by the in-process workers.
-- Readiness reads these two fixed rows in O(1); no customer identifiers or
-- content are stored here.
CREATE TABLE remote_memory.worker_health (
  worker_name text PRIMARY KEY CHECK (worker_name IN ('indexer', 'retention')),
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  last_success_at timestamptz,
  last_failure_at timestamptz,
  failure_class text,
  pending_work bigint NOT NULL DEFAULT 0 CHECK (pending_work >= 0),
  oldest_pending_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO remote_memory.worker_health(worker_name) VALUES ('indexer'), ('retention');

CREATE TABLE remote_memory.tenant_memberships (
  tenant_id text NOT NULL REFERENCES remote_memory.tenants(id),
  principal_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, principal_id),
  FOREIGN KEY (tenant_id, principal_id) REFERENCES remote_memory.principals(tenant_id, id)
);

CREATE TABLE remote_memory.shares (
  tenant_id text NOT NULL REFERENCES remote_memory.tenants(id),
  id text NOT NULL,
  display_name text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'revoked', 'deleted')),
  policy_version text NOT NULL,
  policy_digest text NOT NULL,
  cursor_team_id text,
  feature_flags text[] NOT NULL DEFAULT ARRAY['remote_memory_read'],
  share_generation bigint NOT NULL DEFAULT 0 CHECK (share_generation >= 0),
  indexed_generation bigint NOT NULL DEFAULT 0 CHECK (indexed_generation >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (id),
  CHECK (indexed_generation <= share_generation)
);

CREATE TABLE remote_memory.share_grants (
  tenant_id text NOT NULL,
  share_id text NOT NULL,
  principal_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'revoked')),
  capabilities text[] NOT NULL,
  allowed_projects text[],
  cursor_owner_ids text[] NOT NULL DEFAULT '{}',
  cursor_subjects text[] NOT NULL DEFAULT '{}',
  cursor_attestation_required boolean NOT NULL DEFAULT true,
  policy_version text NOT NULL,
  policy_digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, share_id, principal_id),
  FOREIGN KEY (tenant_id, share_id) REFERENCES remote_memory.shares(tenant_id, id),
  FOREIGN KEY (tenant_id, principal_id) REFERENCES remote_memory.principals(tenant_id, id)
);

CREATE TABLE remote_memory.projects (
  tenant_id text NOT NULL,
  share_id text NOT NULL,
  name text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, share_id, name),
  FOREIGN KEY (tenant_id, share_id) REFERENCES remote_memory.shares(tenant_id, id)
);

CREATE TABLE remote_memory.grant_policy_versions (
  tenant_id text NOT NULL,
  share_id text NOT NULL,
  version text NOT NULL,
  principal_id text NOT NULL,
  policy_document jsonb NOT NULL,
  policy_digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, share_id, version, principal_id),
  UNIQUE (tenant_id, share_id, version, principal_id, policy_digest),
  FOREIGN KEY (tenant_id, share_id) REFERENCES remote_memory.shares(tenant_id, id),
  FOREIGN KEY (tenant_id, principal_id) REFERENCES remote_memory.principals(tenant_id, id)
);

CREATE TABLE remote_memory.share_policy_versions (
  tenant_id text NOT NULL,
  share_id text NOT NULL,
  version text NOT NULL,
  policy_document jsonb NOT NULL,
  policy_digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, share_id, version),
  UNIQUE (tenant_id, share_id, version, policy_digest),
  FOREIGN KEY (tenant_id, share_id) REFERENCES remote_memory.shares(tenant_id, id)
);

ALTER TABLE remote_memory.shares
  ADD CONSTRAINT shares_current_policy_fk
  FOREIGN KEY (tenant_id, id, policy_version, policy_digest)
  REFERENCES remote_memory.share_policy_versions(tenant_id, share_id, version, policy_digest)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE remote_memory.share_grants
  ADD CONSTRAINT share_grants_current_policy_fk
  FOREIGN KEY (tenant_id, share_id, policy_version, principal_id, policy_digest)
  REFERENCES remote_memory.grant_policy_versions(tenant_id, share_id, version, principal_id, policy_digest)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE remote_memory.project_repository_bindings (
  tenant_id text NOT NULL,
  share_id text NOT NULL,
  project_name text NOT NULL,
  repository_url text NOT NULL,
  PRIMARY KEY (tenant_id, share_id, project_name, repository_url),
  FOREIGN KEY (tenant_id, share_id, project_name)
    REFERENCES remote_memory.projects(tenant_id, share_id, name)
);

CREATE TABLE remote_memory.memory_heads (
  tenant_id text NOT NULL,
  share_id text NOT NULL,
  id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('durable', 'handoff')),
  project text NOT NULL,
  topic text NOT NULL,
  canonical_uri text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'superseded', 'archived', 'expired')),
  current_revision_id text,
  retention_class text,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, share_id, id),
  UNIQUE (tenant_id, share_id, kind, project, topic),
  UNIQUE (tenant_id, share_id, canonical_uri),
  FOREIGN KEY (tenant_id, share_id) REFERENCES remote_memory.shares(tenant_id, id)
);

CREATE TABLE remote_memory.workload_attestations (
  tenant_id text NOT NULL,
  share_id text NOT NULL,
  id text NOT NULL,
  principal_id text NOT NULL,
  issuer text NOT NULL,
  subject text NOT NULL,
  jwt_id text NOT NULL,
  cloud_agent_id text NOT NULL,
  turn_id text,
  team_id text,
  owner_id text,
  repository_urls text[],
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, share_id, id),
  UNIQUE (issuer, jwt_id),
  FOREIGN KEY (tenant_id, share_id) REFERENCES remote_memory.shares(tenant_id, id),
  FOREIGN KEY (tenant_id, principal_id) REFERENCES remote_memory.principals(tenant_id, id)
);

CREATE TABLE remote_memory.attestation_challenges (
  tenant_id text NOT NULL,
  share_id text NOT NULL,
  id text NOT NULL,
  principal_id text NOT NULL,
  nonce text NOT NULL,
  audience text NOT NULL,
  completion_url text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, share_id, id),
  FOREIGN KEY (tenant_id, share_id) REFERENCES remote_memory.shares(tenant_id, id),
  FOREIGN KEY (tenant_id, principal_id) REFERENCES remote_memory.principals(tenant_id, id)
);

CREATE TABLE remote_memory.memory_revisions (
  tenant_id text NOT NULL,
  share_id text NOT NULL,
  id text NOT NULL,
  head_id text NOT NULL,
  base_revision_id text,
  generation bigint NOT NULL CHECK (generation > 0),
  status text NOT NULL CHECK (status IN ('active', 'superseded', 'archived', 'expired')),
  markdown_body text NOT NULL,
  content_hash text NOT NULL,
  oauth_principal_id text NOT NULL,
  workload_attestation_id text,
  operation_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, share_id, id),
  UNIQUE (tenant_id, share_id, head_id, id),
  UNIQUE (tenant_id, share_id, head_id, generation),
  FOREIGN KEY (tenant_id, share_id, head_id)
    REFERENCES remote_memory.memory_heads(tenant_id, share_id, id),
  FOREIGN KEY (tenant_id, share_id, workload_attestation_id)
    REFERENCES remote_memory.workload_attestations(tenant_id, share_id, id),
  FOREIGN KEY (tenant_id, share_id, head_id, base_revision_id)
    REFERENCES remote_memory.memory_revisions(tenant_id, share_id, head_id, id)
);

ALTER TABLE remote_memory.memory_heads
  ADD CONSTRAINT memory_heads_current_revision_fk
  FOREIGN KEY (tenant_id, share_id, id, current_revision_id)
  REFERENCES remote_memory.memory_revisions(tenant_id, share_id, head_id, id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE remote_memory.idempotency_records (
  tenant_id text NOT NULL,
  share_id text NOT NULL,
  principal_id text NOT NULL,
  operation_id text NOT NULL,
  request_hash text NOT NULL,
  outcome jsonb,
  outcome_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, principal_id, operation_id),
  FOREIGN KEY (tenant_id, share_id) REFERENCES remote_memory.shares(tenant_id, id)
);

CREATE TABLE remote_memory.outbox_events (
  tenant_id text NOT NULL,
  share_id text NOT NULL,
  id text NOT NULL,
  generation bigint NOT NULL,
  event_type text NOT NULL,
  aggregate_id text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  dead_lettered_at timestamptz,
  last_error_class text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, share_id, id),
  UNIQUE (tenant_id, share_id, generation, event_type, aggregate_id),
  FOREIGN KEY (tenant_id, share_id) REFERENCES remote_memory.shares(tenant_id, id)
);

CREATE TABLE remote_memory.audit_events (
  tenant_id text NOT NULL,
  share_id text NOT NULL,
  id text NOT NULL,
  request_id text NOT NULL,
  principal_id text NOT NULL,
  workload_attestation_id text,
  operation text NOT NULL,
  result text NOT NULL,
  policy_version text NOT NULL,
  share_policy_version text NOT NULL,
  generation bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, share_id, id),
  FOREIGN KEY (tenant_id, share_id) REFERENCES remote_memory.shares(tenant_id, id),
  FOREIGN KEY (tenant_id, share_id, policy_version, principal_id)
    REFERENCES remote_memory.grant_policy_versions(tenant_id, share_id, version, principal_id),
  FOREIGN KEY (tenant_id, share_id, share_policy_version)
    REFERENCES remote_memory.share_policy_versions(tenant_id, share_id, version)
);

CREATE TABLE remote_memory.rate_limit_windows (
  tenant_id text NOT NULL,
  share_id text NOT NULL,
  principal_id text NOT NULL,
  operation text NOT NULL,
  window_started_at timestamptz NOT NULL,
  request_count bigint NOT NULL CHECK (request_count > 0),
  PRIMARY KEY (tenant_id, share_id, principal_id, operation),
  FOREIGN KEY (tenant_id, share_id) REFERENCES remote_memory.shares(tenant_id, id)
);

CREATE TABLE remote_memory.uri_aliases (
  tenant_id text NOT NULL,
  share_id text NOT NULL,
  alias_uri text NOT NULL,
  canonical_uri text NOT NULL,
  source text NOT NULL,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, share_id, alias_uri),
  FOREIGN KEY (tenant_id, share_id) REFERENCES remote_memory.shares(tenant_id, id),
  FOREIGN KEY (tenant_id, share_id, canonical_uri)
    REFERENCES remote_memory.memory_heads(tenant_id, share_id, canonical_uri)
);

CREATE TABLE remote_memory.git_beta_import_receipts (
  tenant_id text NOT NULL,
  share_id text NOT NULL,
  plan_id text NOT NULL,
  plan_digest text NOT NULL,
  alias_compatibility_ends_at timestamptz NOT NULL,
  outcome jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, share_id, plan_id),
  UNIQUE (tenant_id, share_id, plan_digest),
  FOREIGN KEY (tenant_id, share_id) REFERENCES remote_memory.shares(tenant_id, id)
);

CREATE TABLE remote_memory.search_documents (
  tenant_id text NOT NULL,
  share_id text NOT NULL,
  head_id text NOT NULL,
  revision_id text NOT NULL,
  generation bigint NOT NULL,
  project text NOT NULL,
  topic text NOT NULL,
  kind text NOT NULL,
  searchable tsvector NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, share_id, head_id),
  FOREIGN KEY (tenant_id, share_id, head_id)
    REFERENCES remote_memory.memory_heads(tenant_id, share_id, id),
  FOREIGN KEY (tenant_id, share_id, revision_id)
    REFERENCES remote_memory.memory_revisions(tenant_id, share_id, id),
  FOREIGN KEY (tenant_id, share_id, head_id, revision_id)
    REFERENCES remote_memory.memory_revisions(tenant_id, share_id, head_id, id)
);

CREATE FUNCTION remote_memory.reject_immutable_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'remote memory immutable record cannot be updated or deleted';
END;
$$;

CREATE TRIGGER memory_revisions_immutable
  BEFORE UPDATE OR DELETE ON remote_memory.memory_revisions
  FOR EACH ROW EXECUTE FUNCTION remote_memory.reject_immutable_mutation();
CREATE TRIGGER audit_events_immutable
  BEFORE UPDATE OR DELETE ON remote_memory.audit_events
  FOR EACH ROW EXECUTE FUNCTION remote_memory.reject_immutable_mutation();
CREATE TRIGGER policy_versions_immutable
  BEFORE UPDATE OR DELETE ON remote_memory.grant_policy_versions
  FOR EACH ROW EXECUTE FUNCTION remote_memory.reject_immutable_mutation();
CREATE TRIGGER share_policy_versions_immutable
  BEFORE UPDATE OR DELETE ON remote_memory.share_policy_versions
  FOR EACH ROW EXECUTE FUNCTION remote_memory.reject_immutable_mutation();

CREATE FUNCTION remote_memory.reject_memory_revision_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  old_generation bigint;
  new_generation bigint;
BEGIN
  IF OLD.current_revision_id IS NOT NULL THEN
    IF NEW.current_revision_id IS NULL OR NEW.current_revision_id = OLD.current_revision_id THEN
      RAISE EXCEPTION 'memory head revision must advance on every mutation';
    END IF;

    SELECT generation INTO old_generation
      FROM remote_memory.memory_revisions
      WHERE tenant_id = OLD.tenant_id
        AND share_id = OLD.share_id
        AND head_id = OLD.id
        AND id = OLD.current_revision_id;
    SELECT generation INTO new_generation
      FROM remote_memory.memory_revisions
      WHERE tenant_id = NEW.tenant_id
        AND share_id = NEW.share_id
        AND head_id = NEW.id
        AND id = NEW.current_revision_id;

    IF old_generation IS NULL OR new_generation IS NULL OR new_generation <= old_generation THEN
      RAISE EXCEPTION 'memory head revision generation must advance';
    END IF;
  END IF;
  IF OLD.kind IS DISTINCT FROM NEW.kind
    OR OLD.project IS DISTINCT FROM NEW.project
    OR OLD.topic IS DISTINCT FROM NEW.topic
    OR OLD.canonical_uri IS DISTINCT FROM NEW.canonical_uri THEN
    RAISE EXCEPTION 'memory head logical identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER memory_heads_revision_guard
  BEFORE UPDATE ON remote_memory.memory_heads
  FOR EACH ROW EXECUTE FUNCTION remote_memory.reject_memory_revision_change();

CREATE FUNCTION remote_memory.allow_expired_attestation_minimization() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.expires_at > now()
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.share_id IS DISTINCT FROM OLD.share_id
    OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.principal_id IS DISTINCT FROM OLD.principal_id
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.issuer IS DISTINCT FROM 'expired'
    OR NEW.subject IS DISTINCT FROM 'expired'
    OR NEW.jwt_id IS DISTINCT FROM (OLD.tenant_id || ':' || OLD.share_id || ':' || OLD.id)
    OR NEW.cloud_agent_id IS DISTINCT FROM 'expired'
    OR NEW.turn_id IS NOT NULL
    OR NEW.team_id IS NOT NULL
    OR NEW.owner_id IS NOT NULL
    OR NEW.repository_urls IS NOT NULL THEN
    RAISE EXCEPTION 'workload attestation updates may only minimize expired attribution';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER workload_attestations_minimization_guard
  BEFORE UPDATE ON remote_memory.workload_attestations
  FOR EACH ROW EXECUTE FUNCTION remote_memory.allow_expired_attestation_minimization();

CREATE INDEX remote_memory_search_documents_gin
  ON remote_memory.search_documents USING gin(searchable);
CREATE INDEX remote_memory_heads_scope
  ON remote_memory.memory_heads(tenant_id, share_id, project, kind, status);
CREATE INDEX remote_memory_revisions_generation
  ON remote_memory.memory_revisions(tenant_id, share_id, generation);
CREATE INDEX remote_memory_idempotency_expiry
  ON remote_memory.idempotency_records(tenant_id, outcome_expires_at) WHERE outcome IS NOT NULL;
CREATE INDEX remote_memory_alias_expiry
  ON remote_memory.uri_aliases(tenant_id, expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX remote_memory_attestation_expiry
  ON remote_memory.workload_attestations(tenant_id, expires_at);
CREATE INDEX remote_memory_outbox_ready
  ON remote_memory.outbox_events(tenant_id, share_id, available_at)
  WHERE processed_at IS NULL AND dead_lettered_at IS NULL;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'principals', 'external_identities', 'tenant_memberships',
    'shares', 'share_grants', 'projects', 'grant_policy_versions',
    'share_policy_versions',
    'project_repository_bindings',
    'memory_heads', 'workload_attestations', 'attestation_challenges', 'memory_revisions',
    'idempotency_records', 'outbox_events', 'audit_events', 'rate_limit_windows',
    'uri_aliases', 'git_beta_import_receipts', 'search_documents'
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

ALTER TABLE remote_memory.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE remote_memory.tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON remote_memory.tenants
  USING (id = current_setting('threadnote.tenant_id', true))
  WITH CHECK (id = current_setting('threadnote.tenant_id', true));
