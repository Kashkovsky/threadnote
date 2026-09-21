ALTER TABLE remote_memory.external_identities
  ADD COLUMN client_id text NOT NULL DEFAULT '';

ALTER TABLE remote_memory.external_identities
  DROP CONSTRAINT external_identities_pkey;

ALTER TABLE remote_memory.external_identities
  ADD PRIMARY KEY (tenant_id, issuer, subject, client_id);

ALTER TABLE remote_memory.share_grants
  ADD COLUMN expires_at timestamptz;

CREATE INDEX share_grants_active_expiry
  ON remote_memory.share_grants(tenant_id, share_id, expires_at)
  WHERE status = 'active';

CREATE TABLE remote_memory.provisioning_receipts (
  tenant_id text NOT NULL REFERENCES remote_memory.tenants(id),
  plan_id text NOT NULL,
  plan_digest text NOT NULL,
  outcome jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, plan_id)
);

ALTER TABLE remote_memory.provisioning_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE remote_memory.provisioning_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON remote_memory.provisioning_receipts
  USING (tenant_id = current_setting('threadnote.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('threadnote.tenant_id', true));
