import type {Sql, TransactionSql} from 'postgres';
import {sha256HexSync} from '../crypto/sha256.js';
import {parseMemoryDocument} from '../memory_document.js';
import {parseRemoteShareAddress} from '../memory_domain/address.js';
import {inspectRemoteMemoryContent} from '../memory_domain/content.js';
import {parseResourceId} from '../storage/resource-id.js';
import {migrateRemoteMemoryDatabase} from './migrations.js';
import {PostgresRemoteControlPlane, type RemoteMemoryProvisioningInput} from './postgres_control_plane.js';
import {
  REMOTE_MEMORY_OPERATOR_CONTRACT_VERSION,
  remoteMemoryOperatorCapabilities,
  type RemoteMemoryOperatorAdapter,
} from './operator.js';
import {
  REMOTE_MEMORY_PORTABILITY_VERSION,
  type RemoteMemoryExistingRecordV1,
  type GitBetaImportApplyOutcomeV1,
  type RemoteMemoryPortableRecordV1,
} from './portability.js';

interface PortableRecordRow {
  readonly aliases: string[] | null;
  readonly canonical_uri: string;
  readonly content_hash: string;
  readonly kind: string;
  readonly markdown_body: string;
  readonly project: string;
  readonly topic: string;
}

/** Built-in operator adapter with one atomic revision/alias/import-receipt transaction. */
export class PostgresRemoteMemoryOperatorAdapter implements RemoteMemoryOperatorAdapter {
  readonly capabilities = remoteMemoryOperatorCapabilities([
    'apply_git_beta_import',
    'export_records',
    'inspect_records',
    'migrate_schema',
    'provision_control_plane',
  ]);

  private readonly controlPlane: PostgresRemoteControlPlane;

  constructor(readonly sql: Sql) {
    this.controlPlane = new PostgresRemoteControlPlane(sql);
  }

  readonly migrateSchema = async () => {
    await migrateRemoteMemoryDatabase(this.sql);
    return {readyVersions: [1], status: 'ready' as const, version: REMOTE_MEMORY_OPERATOR_CONTRACT_VERSION};
  };

  readonly provisionControlPlane = async (input: RemoteMemoryProvisioningInput): Promise<void> => {
    await this.controlPlane.provision(input);
  };

  readonly applyGitBetaImport = async (input: {
    readonly aliasCompatibilityEndsAt: string;
    readonly planDigest: string;
    readonly planId: string;
    readonly records: readonly RemoteMemoryPortableRecordV1[];
    readonly shareId: string;
  }): Promise<readonly GitBetaImportApplyOutcomeV1[]> => {
    validateApplyInput(input);
    const tenantId = await this.controlPlane.tenantForShare(input.shareId);
    if (!tenantId) throw new Error('The remote memory share does not exist or is inactive.');
    return this.withTenant(tenantId, async transaction => {
      const flag = await transaction<{enabled: boolean}[]>`
        SELECT 'git_beta_import' = ANY(feature_flags) AS enabled
        FROM remote_memory.shares
        WHERE tenant_id = ${tenantId} AND id = ${input.shareId} AND status = 'active'
        FOR UPDATE
      `;
      if (!flag[0]?.enabled) throw new Error('The remote share has not enabled git_beta_import.');
      const priorReceipts = await transaction<
        {outcome: GitBetaImportApplyOutcomeV1[]; plan_digest: string; plan_id: string}[]
      >`
        SELECT plan_id, plan_digest, outcome FROM remote_memory.git_beta_import_receipts
        WHERE tenant_id = ${tenantId} AND share_id = ${input.shareId}
          AND (plan_id = ${input.planId} OR plan_digest = ${input.planDigest})
      `;
      const priorReceipt = priorReceipts[0];
      if (priorReceipt) {
        if (priorReceipt.plan_id !== input.planId || priorReceipt.plan_digest !== input.planDigest) {
          throw new Error('The Git beta import plan identity conflicts with an existing immutable receipt.');
        }
        return priorReceipt.outcome;
      }
      const outcomes: GitBetaImportApplyOutcomeV1[] = [];
      for (const record of [...input.records].sort((left, right) => compareCodeUnits(left.uri, right.uri))) {
        outcomes.push(await importRecord(transaction, tenantId, input.shareId, input, record));
      }
      await transaction`
        INSERT INTO remote_memory.git_beta_import_receipts(
          tenant_id, share_id, plan_id, plan_digest, alias_compatibility_ends_at, outcome
        ) VALUES (
          ${tenantId}, ${input.shareId}, ${input.planId}, ${input.planDigest},
          ${input.aliasCompatibilityEndsAt}, ${transaction.json(outcomes.map(outcome => ({...outcome})))}
        )
      `;
      return outcomes;
    });
  };

  readonly inspectRecords = async (shareId: string): Promise<readonly RemoteMemoryExistingRecordV1[]> => {
    const rows = await this.portableRows(shareId);
    return rows.map(row => ({
      aliases: sortedAliases(row.aliases),
      contentHash: row.content_hash,
      uri: row.canonical_uri,
      version: REMOTE_MEMORY_PORTABILITY_VERSION,
    }));
  };

  readonly exportRecords = async (shareId: string): Promise<readonly RemoteMemoryPortableRecordV1[]> => {
    const rows = await this.portableRows(shareId);
    return rows.map(row => ({
      aliases: sortedAliases(row.aliases),
      canonicalContent: row.markdown_body,
      contentHash: row.content_hash,
      kind: remoteMemoryKind(row.kind),
      project: row.project,
      topic: row.topic,
      uri: row.canonical_uri,
      version: REMOTE_MEMORY_PORTABILITY_VERSION,
    }));
  };

  async close(): Promise<void> {
    await this.sql.end({timeout: 5});
  }

  private async portableRows(shareId: string): Promise<readonly PortableRecordRow[]> {
    const tenantId = await this.controlPlane.tenantForShare(shareId);
    if (!tenantId) throw new Error('The remote memory share does not exist or is inactive.');
    return (await this.sql.begin(async transaction => {
      await setTenant(transaction, tenantId);
      return transaction<PortableRecordRow[]>`
        SELECT h.canonical_uri, h.kind, h.project, h.topic, r.markdown_body, r.content_hash,
          COALESCE(array_agg(DISTINCT a.alias_uri)
            FILTER (WHERE a.alias_uri IS NOT NULL), '{}') AS aliases
        FROM remote_memory.memory_heads h
        JOIN remote_memory.memory_revisions r
          ON r.tenant_id = h.tenant_id AND r.share_id = h.share_id AND r.id = h.current_revision_id
        LEFT JOIN remote_memory.uri_aliases a
          ON a.tenant_id = h.tenant_id AND a.share_id = h.share_id AND a.canonical_uri = h.canonical_uri
          AND (a.expires_at IS NULL OR a.expires_at > now())
        WHERE h.tenant_id = ${tenantId} AND h.share_id = ${shareId}
        GROUP BY h.canonical_uri, h.kind, h.project, h.topic, r.markdown_body, r.content_hash
        ORDER BY h.canonical_uri
      `;
    })) as readonly PortableRecordRow[];
  }

  private async withTenant<A>(tenantId: string, use: (transaction: TransactionSql) => Promise<A>): Promise<A> {
    return (await this.sql.begin(async transaction => {
      await setTenant(transaction, tenantId);
      return use(transaction);
    })) as A;
  }
}

async function importRecord(
  transaction: TransactionSql,
  tenantId: string,
  shareId: string,
  plan: {readonly aliasCompatibilityEndsAt: string; readonly planId: string},
  record: RemoteMemoryPortableRecordV1,
): Promise<GitBetaImportApplyOutcomeV1> {
  const address = validatePortableRecord(record, shareId);
  const project = await transaction<{name: string}[]>`
    SELECT name FROM remote_memory.projects
    WHERE tenant_id = ${tenantId} AND share_id = ${shareId}
      AND name = ${address.project} AND status = 'active'
  `;
  if (!project[0]) throw new Error(`Git beta import target project is not active: ${address.project}.`);
  await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${record.uri}, 0))`;
  const current = await transaction<{content_hash: string; head_id: string}[]>`
    SELECT h.id AS head_id, r.content_hash
    FROM remote_memory.memory_heads h
    JOIN remote_memory.memory_revisions r
      ON r.tenant_id = h.tenant_id AND r.share_id = h.share_id AND r.id = h.current_revision_id
    WHERE h.tenant_id = ${tenantId} AND h.share_id = ${shareId} AND h.canonical_uri = ${record.uri}
    FOR UPDATE OF h
  `;
  if (current[0]) {
    if (current[0].content_hash !== record.contentHash) {
      throw new Error(`Git beta import conflicts with an existing memory: ${record.uri}.`);
    }
    await upsertAliases(transaction, tenantId, shareId, record, plan.aliasCompatibilityEndsAt);
    return {
      sourceUri: requireSourceAlias(record),
      status: 'unchanged',
      targetUri: record.uri,
      version: REMOTE_MEMORY_PORTABILITY_VERSION,
    };
  }
  const headId = crypto.randomUUID();
  const revisionId = crypto.randomUUID();
  const generations = await transaction<{indexed_generation: string | number; share_generation: string | number}[]>`
    UPDATE remote_memory.shares SET share_generation = share_generation + 1
    WHERE tenant_id = ${tenantId} AND id = ${shareId} AND status = 'active'
    RETURNING share_generation, indexed_generation
  `;
  const generation = generations[0]?.share_generation;
  if (generation === undefined) throw new Error('The remote memory share is no longer active.');
  await transaction`
    INSERT INTO remote_memory.memory_heads(
      tenant_id, share_id, id, kind, project, topic, canonical_uri, status
    ) VALUES (
      ${tenantId}, ${shareId}, ${headId}, ${record.kind}, ${address.project}, ${address.topic}, ${record.uri}, 'active'
    )
  `;
  await transaction`
    INSERT INTO remote_memory.memory_revisions(
      tenant_id, share_id, id, head_id, generation, status, markdown_body, content_hash,
      oauth_principal_id, operation_id
    ) VALUES (
      ${tenantId}, ${shareId}, ${revisionId}, ${headId}, ${generation}, 'active',
      ${record.canonicalContent}, ${record.contentHash}, 'system:migration', ${`import:${plan.planId}:${headId}`}
    )
  `;
  await transaction`
    UPDATE remote_memory.memory_heads SET current_revision_id = ${revisionId}
    WHERE tenant_id = ${tenantId} AND share_id = ${shareId} AND id = ${headId}
  `;
  await upsertAliases(transaction, tenantId, shareId, record, plan.aliasCompatibilityEndsAt);
  await transaction`
        INSERT INTO remote_memory.outbox_events(tenant_id, share_id, id, generation, event_type, aggregate_id)
        VALUES (${tenantId}, ${shareId}, ${crypto.randomUUID()}, ${generation}, 'memory_head_changed', ${headId})
      `;
  const migrationPrincipalId = 'system:migration';
  const migrationPolicyVersion = 'system:migration-v1';
  const migrationPolicyDocument = {capabilities: ['memory:admin'], internal: 'migration'};
  const migrationPolicyDigest = sha256HexSync(JSON.stringify(migrationPolicyDocument));
  await transaction`
    INSERT INTO remote_memory.principals(tenant_id, id, status)
    VALUES (${tenantId}, ${migrationPrincipalId}, 'active')
    ON CONFLICT (tenant_id, id) DO NOTHING
  `;
  await transaction`
    INSERT INTO remote_memory.grant_policy_versions(
      tenant_id, share_id, version, principal_id, policy_document, policy_digest
    ) VALUES (
      ${tenantId}, ${shareId}, ${migrationPolicyVersion}, ${migrationPrincipalId},
      ${transaction.json(migrationPolicyDocument)}, ${migrationPolicyDigest}
    ) ON CONFLICT (tenant_id, share_id, version, principal_id) DO NOTHING
  `;
  await transaction`
    INSERT INTO remote_memory.audit_events(
      tenant_id, share_id, id, request_id, principal_id, operation, result,
      policy_version, share_policy_version, generation
    )
    SELECT ${tenantId}, ${shareId}, ${crypto.randomUUID()}, ${plan.planId}, ${migrationPrincipalId},
      'git_beta_import', 'committed', ${migrationPolicyVersion}, policy_version, ${generation}
    FROM remote_memory.shares WHERE tenant_id = ${tenantId} AND id = ${shareId}
  `;
  return {
    sourceUri: requireSourceAlias(record),
    status: 'imported',
    targetUri: record.uri,
    version: REMOTE_MEMORY_PORTABILITY_VERSION,
  };
}

async function upsertAliases(
  transaction: TransactionSql,
  tenantId: string,
  shareId: string,
  record: RemoteMemoryPortableRecordV1,
  expiresAt: string,
): Promise<void> {
  for (const alias of record.aliases) {
    const rows = await transaction<{alias_uri: string}[]>`
      INSERT INTO remote_memory.uri_aliases(
        tenant_id, share_id, alias_uri, canonical_uri, source, expires_at
      ) VALUES (${tenantId}, ${shareId}, ${alias}, ${record.uri}, 'git_beta_import', ${expiresAt})
      ON CONFLICT (tenant_id, share_id, alias_uri) DO UPDATE SET
        canonical_uri = EXCLUDED.canonical_uri, source = EXCLUDED.source, expires_at = EXCLUDED.expires_at
      WHERE remote_memory.uri_aliases.canonical_uri = EXCLUDED.canonical_uri
      RETURNING alias_uri
    `;
    if (!rows[0]) throw new Error(`Git beta import alias conflicts with another memory: ${alias}.`);
  }
}

function validateApplyInput(input: {
  readonly aliasCompatibilityEndsAt: string;
  readonly planDigest: string;
  readonly planId: string;
  readonly records: readonly RemoteMemoryPortableRecordV1[];
  readonly shareId: string;
}): void {
  if (!/^tnmi_[0-9a-f]{32}$/u.test(input.planId) || !/^[0-9a-f]{64}$/u.test(input.planDigest)) {
    throw new Error('Git beta import plan identity is invalid.');
  }
  if (
    !Number.isFinite(Date.parse(input.aliasCompatibilityEndsAt)) ||
    Date.parse(input.aliasCompatibilityEndsAt) <= Date.now()
  ) {
    throw new Error('Git beta import alias compatibility end is invalid.');
  }
  if (input.records.length > 10_000) throw new Error('Git beta import exceeds the record limit.');
  let totalBytes = 0;
  for (const record of input.records) {
    const bytes = new TextEncoder().encode(record.canonicalContent).byteLength;
    if (bytes > 1024 * 1024) throw new Error('A Git beta memory exceeds the import size limit.');
    totalBytes += bytes;
    if (totalBytes > 100 * 1024 * 1024) throw new Error('Git beta import exceeds the total size limit.');
  }
  if (new Set(input.records.map(record => record.uri)).size !== input.records.length) {
    throw new Error('Git beta import contains duplicate target URIs.');
  }
  const aliases = input.records.flatMap(record => [...record.aliases]);
  if (new Set(aliases).size !== aliases.length) throw new Error('Git beta import contains duplicate aliases.');
}

function validatePortableRecord(record: RemoteMemoryPortableRecordV1, shareId: string) {
  if (record.version !== REMOTE_MEMORY_PORTABILITY_VERSION) throw new Error('Portable record version is unsupported.');
  const address = parseRemoteShareAddress(record.uri);
  if (
    address.shareId !== shareId ||
    address.kind !== record.kind ||
    address.canonicalUri !== record.uri ||
    address.project !== record.project ||
    address.topic !== record.topic ||
    record.kind !== 'durable'
  ) {
    throw new Error('Portable record identity mismatch.');
  }
  const inspection = inspectRemoteMemoryContent(record.canonicalContent);
  if (!inspection.allowed || inspection.canonicalContent !== record.canonicalContent) {
    throw new Error('Portable record does not pass canonical content policy.');
  }
  if (sha256HexSync(record.canonicalContent) !== record.contentHash) {
    throw new Error('Portable record content hash mismatch.');
  }
  const document = parseMemoryDocument(record.uri, record.canonicalContent);
  if (
    !document ||
    document.headerTitle !== 'MEMORY' ||
    document.metadata.kind !== record.kind ||
    document.metadata.project !== address.project ||
    document.metadata.topic !== address.topic
  ) {
    throw new Error('Portable record Markdown metadata mismatch.');
  }
  if (record.aliases.length === 0) throw new Error('Git beta imports require a source alias.');
  for (const alias of record.aliases) validateGitBetaAlias(alias);
  return address;
}

function validateGitBetaAlias(alias: string): void {
  if (alias.length > 4096) throw new Error('Git beta import alias is too long.');
  const resource = parseResourceId(alias);
  const [, memories, shared, team, kind, scope, project, file] = resource.segments;
  if (
    resource.inputScheme !== 'threadnote' ||
    resource.anchor ||
    resource.canonicalUri !== alias ||
    resource.namespace !== 'user' ||
    memories !== 'memories' ||
    shared !== 'shared' ||
    !team ||
    kind !== 'durable' ||
    scope !== 'projects' ||
    !project ||
    !file?.endsWith('.md') ||
    resource.segments.length !== 8
  ) {
    throw new Error('Git beta import alias is not canonical or has an unsupported layout.');
  }
}

function requireSourceAlias(record: RemoteMemoryPortableRecordV1): string {
  const alias = record.aliases[0];
  if (!alias) throw new Error('Git beta imports require a source alias.');
  return alias;
}

function remoteMemoryKind(value: string): 'durable' | 'handoff' {
  if (value === 'durable' || value === 'handoff') return value;
  throw new Error('The remote memory store contains an unsupported memory kind.');
}

function sortedAliases(values: readonly string[] | null): readonly string[] {
  return [...new Set(values ?? [])].sort(compareCodeUnits);
}

async function setTenant(transaction: TransactionSql, tenantId: string): Promise<void> {
  await transaction`SELECT set_config('threadnote.tenant_id', ${tenantId}, true)`;
  await transaction`SELECT set_config('statement_timeout', '120000', true)`;
  await transaction`SELECT set_config('lock_timeout', '5000', true)`;
  await transaction`SELECT set_config('transaction_timeout', '300000', true)`;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
