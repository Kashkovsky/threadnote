-- Rebuildable opaque projection of canonical code-citation selectors. It never
-- contains citation bodies, repository identifiers, paths, commits, node IDs,
-- or hashes; only the selector digest is retained.
CREATE TABLE remote_memory.code_link_backlinks (
  tenant_id text NOT NULL,
  share_id text NOT NULL,
  head_id text NOT NULL,
  revision_id text NOT NULL,
  citation_ordinal integer NOT NULL CHECK (citation_ordinal >= 0 AND citation_ordinal < 8),
  selector_kind text NOT NULL CHECK (selector_kind IN ('file-content', 'file-path', 'symbol-locator', 'symbol-node')),
  selector_digest text NOT NULL CHECK (selector_digest ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (tenant_id, share_id, revision_id, citation_ordinal, selector_kind),
  FOREIGN KEY (tenant_id, share_id, head_id)
    REFERENCES remote_memory.memory_heads(tenant_id, share_id, id),
  FOREIGN KEY (tenant_id, share_id, revision_id)
    REFERENCES remote_memory.memory_revisions(tenant_id, share_id, id)
);

CREATE INDEX code_link_backlinks_lookup
  ON remote_memory.code_link_backlinks(tenant_id, share_id, selector_kind, selector_digest, revision_id, head_id);

ALTER TABLE remote_memory.code_link_backlinks ENABLE ROW LEVEL SECURITY;
ALTER TABLE remote_memory.code_link_backlinks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON remote_memory.code_link_backlinks
  USING (tenant_id = current_setting('threadnote.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('threadnote.tenant_id', true));

-- Reuse the bounded, resumable indexer queue to rebuild existing canonical
-- heads after upgrade. The indexer hydrates Git-backed rows when necessary and
-- verifies the current head before replacing this private projection.
DO $$
DECLARE target_tenant text;
BEGIN
  FOR target_tenant IN
    SELECT DISTINCT tenant_id FROM remote_memory.share_directory ORDER BY tenant_id
  LOOP
    PERFORM set_config('threadnote.tenant_id', target_tenant, true);
    INSERT INTO remote_memory.outbox_events(
      tenant_id, share_id, id, generation, event_type, aggregate_id
    )
    SELECT
      h.tenant_id,
      h.share_id,
      'code-link-backfill:' || h.id,
      r.generation,
      'code_link_backfill',
      h.id
    FROM remote_memory.memory_heads h
    JOIN remote_memory.memory_revisions r
      ON r.tenant_id = h.tenant_id AND r.share_id = h.share_id AND r.id = h.current_revision_id
    WHERE h.tenant_id = target_tenant
    ON CONFLICT DO NOTHING;
  END LOOP;
  PERFORM set_config('threadnote.tenant_id', '', true);
END $$;
