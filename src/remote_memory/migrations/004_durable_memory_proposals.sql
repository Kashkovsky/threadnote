CREATE TABLE remote_memory.durable_memory_proposals (
  tenant_id text NOT NULL,
  share_id text NOT NULL,
  id text NOT NULL,
  revision text NOT NULL,
  project text NOT NULL,
  topic text NOT NULL,
  proposer_principal_id text NOT NULL,
  operation_id text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  payload jsonb CHECK (payload IS NULL OR octet_length(payload::text) <= 1116384),
  payload_purged_at timestamptz,
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'conflict', 'expired')),
  workload_attestation_id text,
  expires_at timestamptz NOT NULL,
  decision_kind text CHECK (decision_kind IN ('approve', 'reject')),
  decision_operation_id text,
  decision_request_hash text CHECK (decision_request_hash IS NULL OR decision_request_hash ~ '^[0-9a-f]{64}$'),
  reviewer_principal_id text,
  reviewer_workload_attestation_id text,
  decision_claimed_at timestamptz,
  approval_revision_id text,
  approval_source_agent_client text CHECK (approval_source_agent_client IN ('cursor', 'remote')),
  decision_reason text CHECK (decision_reason IS NULL OR octet_length(decision_reason) <= 1024),
  result_receipt jsonb CHECK (result_receipt IS NULL OR octet_length(result_receipt::text) <= 16384),
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, share_id, id),
  UNIQUE (tenant_id, share_id, proposer_principal_id, operation_id),
  FOREIGN KEY (tenant_id, share_id) REFERENCES remote_memory.shares(tenant_id, id),
  FOREIGN KEY (tenant_id, proposer_principal_id) REFERENCES remote_memory.principals(tenant_id, id),
  FOREIGN KEY (tenant_id, reviewer_principal_id) REFERENCES remote_memory.principals(tenant_id, id),
  FOREIGN KEY (tenant_id, share_id, reviewer_workload_attestation_id)
    REFERENCES remote_memory.workload_attestations(tenant_id, share_id, id),
  FOREIGN KEY (tenant_id, share_id, workload_attestation_id)
    REFERENCES remote_memory.workload_attestations(tenant_id, share_id, id)
);

CREATE FUNCTION remote_memory.reject_proposal_payload_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  payload_purge boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'durable memory proposal audit rows cannot be deleted';
  END IF;
  payload_purge := OLD.payload IS NOT NULL
    AND NEW.payload IS NULL
    AND OLD.payload_purged_at IS NULL
    AND NEW.payload_purged_at IS NOT NULL
    AND NEW.expires_at <= NEW.payload_purged_at
    AND NEW.status <> 'pending';
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.share_id IS DISTINCT FROM OLD.share_id
    OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.revision IS DISTINCT FROM OLD.revision
    OR NEW.project IS DISTINCT FROM OLD.project
    OR NEW.topic IS DISTINCT FROM OLD.topic
    OR NEW.proposer_principal_id IS DISTINCT FROM OLD.proposer_principal_id
    OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
    OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
    OR (NEW.payload IS DISTINCT FROM OLD.payload AND NOT payload_purge)
    OR (NEW.payload_purged_at IS DISTINCT FROM OLD.payload_purged_at AND NOT payload_purge)
    OR NEW.workload_attestation_id IS DISTINCT FROM OLD.workload_attestation_id
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'durable memory proposal payload is immutable';
  END IF;
  IF OLD.approval_revision_id IS NOT NULL AND (
    NEW.approval_revision_id IS DISTINCT FROM OLD.approval_revision_id
    OR NEW.approval_source_agent_client IS DISTINCT FROM OLD.approval_source_agent_client
  ) THEN
    RAISE EXCEPTION 'durable memory proposal approval rendering plan is immutable';
  END IF;
  IF OLD.status <> 'pending' AND NEW IS DISTINCT FROM OLD AND NOT payload_purge THEN
    RAISE EXCEPTION 'terminal durable memory proposal is immutable';
  END IF;
  IF payload_purge AND (
    NEW.decision_kind IS DISTINCT FROM OLD.decision_kind
    OR NEW.decision_operation_id IS DISTINCT FROM OLD.decision_operation_id
    OR NEW.decision_request_hash IS DISTINCT FROM OLD.decision_request_hash
    OR NEW.reviewer_principal_id IS DISTINCT FROM OLD.reviewer_principal_id
    OR NEW.reviewer_workload_attestation_id IS DISTINCT FROM OLD.reviewer_workload_attestation_id
    OR NEW.decision_claimed_at IS DISTINCT FROM OLD.decision_claimed_at
    OR NEW.approval_revision_id IS DISTINCT FROM OLD.approval_revision_id
    OR NEW.approval_source_agent_client IS DISTINCT FROM OLD.approval_source_agent_client
    OR NEW.decision_reason IS DISTINCT FROM OLD.decision_reason
    OR NEW.result_receipt IS DISTINCT FROM OLD.result_receipt
  ) THEN
    RAISE EXCEPTION 'durable memory proposal purge cannot change decision audit fields';
  END IF;
  IF payload_purge AND OLD.status = 'pending'
    AND (NEW.status <> 'expired' OR NEW.reviewed_at IS NULL) THEN
    RAISE EXCEPTION 'expired durable memory proposal purge requires a terminal audit timestamp';
  END IF;
  IF payload_purge AND OLD.status <> 'pending'
    AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at) THEN
    RAISE EXCEPTION 'terminal durable memory proposal purge cannot change terminal status';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER durable_memory_proposals_immutable
  BEFORE UPDATE OR DELETE ON remote_memory.durable_memory_proposals
  FOR EACH ROW EXECUTE FUNCTION remote_memory.reject_proposal_payload_change();

CREATE INDEX durable_memory_proposals_review_queue
  ON remote_memory.durable_memory_proposals(tenant_id, share_id, status, created_at, id);

ALTER TABLE remote_memory.durable_memory_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE remote_memory.durable_memory_proposals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON remote_memory.durable_memory_proposals
  USING (tenant_id = current_setting('threadnote.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('threadnote.tenant_id', true));
