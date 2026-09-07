import type {Sql, TransactionSql} from 'postgres';
import {remoteMemoryError} from './errors.js';

interface RuntimeGrant {
  readonly privilege: string;
  readonly tables: readonly string[];
  readonly columns?: readonly string[];
}

// Keep this boundary aligned with deploy/remote-memory/grants/001-runtime.sql.
const RUNTIME_GRANTS: readonly RuntimeGrant[] = [
  {
    privilege: 'SELECT',
    tables: [
      'share_directory',
      'challenge_directory',
      'worker_health',
      'tenant_memberships',
      'shares',
      'share_grants',
      'projects',
      'grant_policy_versions',
      'share_policy_versions',
      'project_repository_bindings',
      'memory_heads',
      'workload_attestations',
      'attestation_challenges',
      'memory_revisions',
      'idempotency_records',
      'outbox_events',
      'rate_limit_windows',
      'uri_aliases',
      'search_documents',
    ],
  },
  {
    privilege: 'SELECT',
    tables: ['tenants'],
    columns: ['id', 'status'],
  },
  {
    privilege: 'SELECT',
    tables: ['principals'],
    columns: ['tenant_id', 'id', 'status'],
  },
  {
    privilege: 'SELECT',
    tables: ['external_identities'],
    columns: ['tenant_id', 'issuer', 'subject', 'principal_id'],
  },
  {
    privilege: 'INSERT',
    tables: [
      'challenge_directory',
      'memory_heads',
      'workload_attestations',
      'attestation_challenges',
      'memory_revisions',
      'idempotency_records',
      'outbox_events',
      'audit_events',
      'rate_limit_windows',
      'search_documents',
      'projects',
    ],
  },
  {
    privilege: 'UPDATE',
    tables: ['shares'],
    columns: [
      'share_generation',
      'indexed_generation',
      'git_ingest_snapshot_commit',
      'git_ingest_cursor',
      'git_ingest_rejected_path',
    ],
  },
  {
    privilege: 'UPDATE',
    tables: ['memory_heads'],
    columns: ['current_revision_id', 'status', 'retention_class', 'expires_at', 'updated_at'],
  },
  {
    privilege: 'UPDATE',
    tables: ['workload_attestations'],
    columns: ['issuer', 'subject', 'jwt_id', 'cloud_agent_id', 'turn_id', 'team_id', 'owner_id', 'repository_urls'],
  },
  {
    privilege: 'UPDATE',
    tables: ['attestation_challenges'],
    columns: ['attempts', 'consumed_at'],
  },
  {
    privilege: 'UPDATE',
    tables: ['idempotency_records'],
    columns: ['outcome'],
  },
  {
    privilege: 'UPDATE',
    tables: ['worker_health'],
    columns: [
      'heartbeat_at',
      'last_success_at',
      'last_failure_at',
      'failure_class',
      'pending_work',
      'oldest_pending_at',
      'updated_at',
    ],
  },
  {
    privilege: 'UPDATE',
    tables: ['outbox_events'],
    columns: ['attempts', 'available_at', 'processed_at', 'dead_lettered_at', 'last_error_class'],
  },
  {
    privilege: 'UPDATE',
    tables: ['rate_limit_windows'],
    columns: ['window_started_at', 'request_count'],
  },
  {
    privilege: 'UPDATE',
    tables: ['search_documents'],
    columns: ['revision_id', 'generation', 'project', 'topic', 'kind', 'searchable', 'updated_at'],
  },
  {
    privilege: 'DELETE',
    tables: ['challenge_directory', 'attestation_challenges', 'uri_aliases'],
  },
];

interface GrantedPrivilege {
  readonly table_name: string;
  readonly column_name: string | null;
  readonly privilege: string;
  readonly can_delegate: boolean;
  readonly granted: boolean;
}

/** Checks effective privileges, including PUBLIC grants, before accepting runtime traffic. */
export async function assertRemoteMemoryRuntimePrivileges(sql: Sql): Promise<void> {
  await sql.begin(async transaction => {
    await transaction`SELECT pg_catalog.set_config('search_path', 'pg_catalog', true)`;
    await transaction`SELECT set_config('statement_timeout', '5000', true)`;
    await transaction`SELECT set_config('transaction_timeout', '5000', true)`;
    await inspectRuntimePrivileges(transaction);
  });
}

async function inspectRuntimePrivileges(sql: TransactionSql): Promise<void> {
  const [role] = await sql<{unsafe: boolean}[]>`
    SELECT (
      r.oid <> backend.usesysid OR current_user <> session_user
      OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolbypassrls OR r.rolreplication
      OR current_setting('session_replication_role') <> 'origin'
      OR EXISTS (
        SELECT 1 FROM pg_parameter_acl p
        WHERE has_parameter_privilege(current_user, p.parname, 'SET, ALTER SYSTEM')
      )
      OR has_database_privilege(current_user, current_database(), 'CREATE')
      OR EXISTS (
        SELECT 1 FROM pg_roles other WHERE other.oid <> r.oid
          AND (pg_has_role(current_user, other.oid, 'USAGE')
            OR pg_has_role(current_user, other.oid, 'SET')
            OR pg_has_role(current_user, other.oid, 'MEMBER WITH ADMIN OPTION'))
      )
      OR EXISTS (
        SELECT 1 FROM pg_namespace n WHERE n.nspname IN ('public', 'remote_memory')
          AND (n.nspowner = r.oid OR has_schema_privilege(current_user, n.oid, 'CREATE'))
      )
      OR EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'remote_memory' AND c.relowner = r.oid
      )
    ) AS unsafe FROM pg_roles r
    JOIN pg_stat_activity backend ON backend.pid = pg_backend_pid()
    WHERE r.rolname = current_user
  `;
  if (!role || role.unsafe) throw runtimePrivilegeError();

  const columns = await sql<GrantedPrivilege[]>`
    SELECT c.relname AS table_name, a.attname AS column_name, p.privilege,
      has_column_privilege(current_user, c.oid, a.attnum, p.privilege) AS granted,
      has_column_privilege(current_user, c.oid, a.attnum, p.privilege || ' WITH GRANT OPTION') AS can_delegate
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) AS p(privilege)
    WHERE n.nspname = 'remote_memory' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
  `;
  const tables = await sql<GrantedPrivilege[]>`
    SELECT c.relname AS table_name, NULL::text AS column_name, p.privilege,
      has_table_privilege(current_user, c.oid, p.privilege) AS granted,
      has_table_privilege(current_user, c.oid, p.privilege || ' WITH GRANT OPTION') AS can_delegate
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN unnest(ARRAY['DELETE', 'TRUNCATE', 'TRIGGER', 'MAINTAIN']) AS p(privilege)
    WHERE n.nspname = 'remote_memory' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
  `;
  const [sequences] = await sql<{unsafe: boolean}[]>`
    SELECT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'remote_memory' AND c.relkind = 'S'
        AND has_sequence_privilege(current_user, c.oid, 'USAGE, SELECT, UPDATE')
    ) AS unsafe
  `;
  const presentTables = new Set(columns.map(column => column.table_name));
  if (
    sequences?.unsafe ||
    RUNTIME_GRANTS.some(grant =>
      grant.tables.some(
        table =>
          !presentTables.has(table) ||
          grant.columns?.some(
            column => !columns.some(actual => actual.table_name === table && actual.column_name === column),
          ),
      ),
    ) ||
    [...columns, ...tables].some(privilege => privilege.granted !== runtimeGrantAllows(privilege))
  ) {
    throw runtimePrivilegeError();
  }
}

function runtimeGrantAllows(privilege: GrantedPrivilege): boolean {
  if (privilege.can_delegate) return false;
  return RUNTIME_GRANTS.some(
    grant =>
      grant.privilege === privilege.privilege &&
      grant.tables.includes(privilege.table_name) &&
      (grant.columns === undefined ||
        (privilege.column_name !== null && grant.columns.includes(privilege.column_name))),
  );
}

function runtimePrivilegeError() {
  return remoteMemoryError(
    'service_unavailable',
    'The database account does not match the runtime privilege contract. Use a dedicated runtime role and the versioned grants.',
    {reason: 'unsafe_runtime_database_role'},
  );
}
