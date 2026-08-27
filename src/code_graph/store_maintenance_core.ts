import {Clock, Effect, Option} from 'effect';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import {SystemInfo} from '../effect/system.js';
import {classifyCodeGraphBuildOwner} from './build_owner.js';
import {MAXIMUM_CANONICAL_DATE_MILLISECONDS} from './store_removed_view_schema_contracts.js';
import {removedViewCleanupRecordedRevision} from './store_removed_view_schema_inspection.js';
import {normalizeSchemaDefinition} from './store_schema_normalization.js';
import {
  CODE_GRAPH_ABANDONED_BUILD_CANDIDATE_LIMIT,
  CODE_GRAPH_ABANDONED_BUILD_CURSOR_KEY,
  tableExists,
} from './store_session.js';
import {
  CODE_GRAPH_EXTRACTOR_GENERATION,
  CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION,
  CodeGraphStoreError,
} from './types.js';
import {type CodeGraphActivationLease, type PersistentBuildOwnerCandidate} from './store_internal_models.js';
import {lastStatementChangeCount} from './store_activation_core.js';

const CODE_GRAPH_ROUTINE_EXPIRED_LEASE_PAGE_SIZE = 100;

const CODE_GRAPH_ROUTINE_CACHE_PAGE_SIZE = 100;

/** Fresh facts are written before the durable building snapshot owns its inventory. */
const CODE_GRAPH_ROUTINE_CACHE_MINIMUM_AGE_MILLISECONDS = 24 * 60 * 60_000;

const CODE_GRAPH_SNAPSHOT_FILE_BLOB_REFERENCE_INDEX = {
  columns: ['path', 'content_hash'],
  definition: 'CREATE INDEX snapshot_files_blob ON snapshot_files(path, content_hash)',
  name: 'snapshot_files_blob',
  table: 'snapshot_files',
} as const;

const CODE_GRAPH_SNAPSHOT_FILE_CONTENT_REFERENCE_INDEX = {
  columns: ['content_hash'],
  definition: 'CREATE INDEX snapshot_files_content_hash ON snapshot_files(content_hash)',
  name: 'snapshot_files_content_hash',
  table: 'snapshot_files',
} as const;

const CODE_GRAPH_SNAPSHOT_FILE_RAW_CONTENT_REFERENCE_INDEX = {
  columns: ['raw_content_hash'],
  definition:
    'CREATE INDEX snapshot_files_raw_content_hash ON snapshot_files(raw_content_hash) WHERE raw_content_hash IS NOT NULL',
  name: 'snapshot_files_raw_content_hash',
  table: 'snapshot_files',
} as const;

const CODE_GRAPH_MATERIALIZED_SHARD_REFERENCE_INDEX = {
  columns: ['shard_id'],
  definition: 'CREATE INDEX snapshot_file_shards_shard ON snapshot_file_shards(shard_id)',
  name: 'snapshot_file_shards_shard',
  table: 'snapshot_file_shards',
} as const;

interface RoutineFileBlobCacheKey {
  readonly contentHash: string;
  readonly extractorSet: string;
  readonly path: string;
}

export function codeGraphRoutineFileBlobCleanupPageStatement(
  candidates: readonly RoutineFileBlobCacheKey[],
  eligibleBefore: string,
): {
  readonly parameters: readonly string[];
  readonly text: string;
} {
  if (candidates.length === 0 || candidates.length > CODE_GRAPH_ROUTINE_CACHE_PAGE_SIZE) {
    throw new CodeGraphStoreError('File fact cache cleanup candidates are invalid.');
  }
  return {
    parameters: [
      ...candidates.flatMap(candidate => [candidate.contentHash, candidate.extractorSet, candidate.path]),
      eligibleBefore,
    ],
    text: `DELETE FROM file_blobs
      WHERE (content_hash, extractor_set, path_hint) IN (${candidates.map(() => '(?, ?, ?)').join(', ')})
        AND created_at <= ?
        AND NOT EXISTS (
          SELECT 1
          FROM snapshots AS build
          WHERE build.state = 'building'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM snapshot_files AS file
          WHERE file.path = file_blobs.path_hint
            AND file.content_hash = file_blobs.content_hash
        )
        AND NOT (
          file_blobs.blob_id IS NOT NULL
          AND file_blobs.reuse_class IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM snapshot_files AS reusable_file
            WHERE reusable_file.content_hash = file_blobs.content_hash
          )
        )`,
  };
}

export function codeGraphRoutineMaterializedShardCleanupPageStatement(
  candidates: readonly string[],
  eligibleBefore: string,
): {
  readonly parameters: readonly string[];
  readonly text: string;
} {
  if (candidates.length === 0 || candidates.length > CODE_GRAPH_ROUTINE_CACHE_PAGE_SIZE) {
    throw new CodeGraphStoreError('Materialized shard cache cleanup candidates are invalid.');
  }
  return {
    parameters: [...candidates, eligibleBefore],
    text: `DELETE FROM materialized_file_shards
      WHERE id IN (${candidates.map(() => '?').join(', ')})
        AND last_used_at <= ?
        AND NOT EXISTS (
          SELECT 1
          FROM snapshots AS build
          WHERE build.state = 'building'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM snapshot_file_shards AS association
          WHERE association.shard_id = materialized_file_shards.id
        )`,
  };
}

interface RoutineExpiredLeasePage {
  readonly candidates: readonly string[];
  readonly deleted: number;
  readonly remaining: boolean;
}

interface RoutinePhysicalCleanupPage {
  readonly cleanup: 'file-blob-cache' | 'materialized-shard-cache' | 'none' | 'retired-snapshot';
  readonly deleted: number;
  readonly remaining: boolean;
}

type RoutineCacheCleanupState =
  | {readonly cursor?: RoutineFileBlobCacheKey; readonly phase: 'file-blobs'}
  | {readonly cursor?: string; readonly phase: 'materialized-shards'};

const routineMaintenanceColumnsAvailable = Effect.fn('codeGraph.routineMaintenanceColumnsAvailable')(function* (
  sql: SqlClient.SqlClient,
  table: string,
  required: readonly string[],
) {
  if (!/^[a-z_]+$/u.test(table)) return false;
  const columns = yield* sql.unsafe<{readonly name: string}>(`PRAGMA table_info("${table}")`);
  const available = new Set(columns.map(column => column.name));
  return required.every(column => available.has(column));
});

const selectPersistentBuildOwnerCandidates = Effect.fn('codeGraph.selectPersistentBuildOwnerCandidates')(function* (
  sql: SqlClient.SqlClient,
) {
  if (
    !(yield* tableExists(sql, 'schema_metadata')) ||
    !(yield* tableExists(sql, 'snapshot_build_owners')) ||
    !(yield* tableExists(sql, 'snapshot_build_owner_instances')) ||
    !(yield* routineMaintenanceColumnsAvailable(sql, 'snapshot_build_owners', ['owner_token', 'snapshot_id'])) ||
    !(yield* routineMaintenanceColumnsAvailable(sql, 'snapshot_build_owner_instances', [
      'build_id',
      'logical_snapshot_id',
      'owner_token',
      'process_id',
      'process_start_identity',
      'snapshot_id',
    ]))
  ) {
    // Legacy and partially migrated writers provide no exact process-instance
    // evidence. Keep their builds untouched until a current writer reclaims
    // them through an ordinary explicit build.
    return [];
  }
  const rows = yield* sql.withTransaction(
    Effect.gen(function* () {
      const cursors = yield* sql<{readonly value: string}>`
        SELECT value FROM schema_metadata WHERE key = ${CODE_GRAPH_ABANDONED_BUILD_CURSOR_KEY} LIMIT 1
      `;
      const cursor = cursors[0]?.value ?? '';
      const candidates = yield* sql<{
        readonly build_id: string;
        readonly logical_snapshot_id: string;
        readonly owner_token: string;
        readonly process_id: number;
        readonly process_start_identity: unknown;
        readonly snapshot_id: string;
        readonly worktree_id: string;
      }>`
        SELECT
          instance.snapshot_id,
          instance.owner_token,
          instance.build_id,
          instance.process_id,
          instance.process_start_identity,
          instance.logical_snapshot_id,
          snapshot.worktree_id
        FROM snapshot_build_owner_instances AS instance
        JOIN snapshot_build_owners AS owner
          ON owner.snapshot_id = instance.snapshot_id
         AND owner.owner_token = instance.owner_token
        JOIN snapshots AS snapshot ON snapshot.id = instance.snapshot_id
        WHERE snapshot.state IN ('building', 'failed')
        ORDER BY CASE WHEN instance.snapshot_id > ${cursor} THEN 0 ELSE 1 END, instance.snapshot_id
        LIMIT ${CODE_GRAPH_ABANDONED_BUILD_CANDIDATE_LIMIT}
      `;
      const examined = candidates[0]?.snapshot_id;
      if (examined !== undefined) {
        yield* sql`
          INSERT INTO schema_metadata (key, value)
          VALUES (${CODE_GRAPH_ABANDONED_BUILD_CURSOR_KEY}, ${examined})
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `;
      }
      return candidates;
    }),
  );
  return rows.map(
    row =>
      ({
        buildId: row.build_id,
        evidenceValid:
          row.process_start_identity == null ||
          (typeof row.process_start_identity === 'string' &&
            row.process_start_identity.length > 0 &&
            row.process_start_identity.length <= 256),
        logicalSnapshotId: row.logical_snapshot_id,
        ownerToken: row.owner_token,
        processId: Number(row.process_id),
        ...(typeof row.process_start_identity === 'string' ? {processStartIdentity: row.process_start_identity} : {}),
        snapshotId: row.snapshot_id,
        worktreeId: row.worktree_id,
      }) satisfies PersistentBuildOwnerCandidate,
  );
});

function persistentBuildOwnerCandidateValid(candidate: PersistentBuildOwnerCandidate): boolean {
  return (
    candidate.evidenceValid &&
    /^cgsn_[0-9a-f]{40}$/u.test(candidate.logicalSnapshotId) &&
    /^[0-9a-f]{64}$/u.test(candidate.worktreeId) &&
    /^[0-9a-f-]{16,64}$/u.test(candidate.buildId) &&
    Number.isSafeInteger(candidate.processId) &&
    candidate.processId > 0 &&
    candidate.ownerToken.length > 0 &&
    candidate.ownerToken.length <= 256 &&
    persistentSnapshotMatchesLogicalIdentity(candidate.snapshotId, candidate.logicalSnapshotId) &&
    (candidate.processStartIdentity === undefined ||
      (candidate.processStartIdentity.length > 0 && candidate.processStartIdentity.length <= 256))
  );
}

function persistentSnapshotMatchesLogicalIdentity(snapshotId: string, logicalSnapshotId: string): boolean {
  return (
    snapshotId === logicalSnapshotId ||
    snapshotId === `${logicalSnapshotId}-direct` ||
    new RegExp(`^${logicalSnapshotId}-full-[0-9a-f]{16}$`, 'u').test(snapshotId)
  );
}

const observePersistentBuildOwner = Effect.fn('codeGraph.observePersistentBuildOwner')(function* (
  candidate: PersistentBuildOwnerCandidate,
) {
  const system = yield* SystemInfo;
  const isRunning = system.isProcessRunning(candidate.processId);
  const processStartIdentity =
    isRunning && candidate.processStartIdentity !== undefined
      ? yield* system.processStartIdentity(candidate.processId)
      : undefined;
  return classifyCodeGraphBuildOwner(candidate, {isRunning, processStartIdentity});
});

interface BoundedSnapshotLeaseRow {
  readonly expires_at: unknown;
  readonly retire_when_inactive: unknown;
  readonly snapshot_id: unknown;
  readonly token: unknown;
}

interface SnapshotLeaseManifest {
  readonly expiresAt: number;
  readonly retireWhenInactive: 0 | 1;
  readonly snapshotId: string;
  readonly token: string;
}

function boundedSnapshotLeaseProjection(alias: string): string {
  return `CASE
      WHEN typeof(${alias}.token) = 'text'
        AND length(CAST(${alias}.token AS BLOB)) BETWEEN 1 AND 1024
      THEN ${alias}.token ELSE NULL END AS token,
    CASE
      WHEN typeof(${alias}.snapshot_id) = 'text'
        AND length(CAST(${alias}.snapshot_id AS BLOB)) BETWEEN 1 AND 1024
      THEN ${alias}.snapshot_id ELSE NULL END AS snapshot_id,
    CASE
      WHEN typeof(${alias}.expires_at) = 'integer'
        AND ${alias}.expires_at BETWEEN 0 AND ${MAXIMUM_CANONICAL_DATE_MILLISECONDS}
      THEN ${alias}.expires_at ELSE NULL END AS expires_at,
    CASE
      WHEN typeof(${alias}.retire_when_inactive) = 'integer'
        AND ${alias}.retire_when_inactive IN (0, 1)
      THEN ${alias}.retire_when_inactive ELSE NULL END AS retire_when_inactive`;
}

function decodeSnapshotLeaseManifest(row: BoundedSnapshotLeaseRow): SnapshotLeaseManifest | undefined {
  if (
    typeof row.token !== 'string' ||
    row.token.length === 0 ||
    row.token.length > 1_024 ||
    row.token.includes('\0') ||
    typeof row.snapshot_id !== 'string' ||
    row.snapshot_id.length === 0 ||
    row.snapshot_id.length > 1_024 ||
    row.snapshot_id.includes('\0') ||
    typeof row.expires_at !== 'number' ||
    !Number.isSafeInteger(row.expires_at) ||
    row.expires_at < 0 ||
    row.expires_at > MAXIMUM_CANONICAL_DATE_MILLISECONDS ||
    (row.retire_when_inactive !== 0 && row.retire_when_inactive !== 1)
  ) {
    return undefined;
  }
  return {
    expiresAt: row.expires_at,
    retireWhenInactive: row.retire_when_inactive,
    snapshotId: row.snapshot_id,
    token: row.token,
  };
}

const routineCacheSchemaCurrent = Effect.fn('codeGraph.routineCacheSchemaCurrent')(function* (
  sql: SqlClient.SqlClient,
) {
  const revision = yield* removedViewCleanupRecordedRevision(sql);
  return (
    revision.state === 'recorded' &&
    revision.value === CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION &&
    (yield* tableExists(sql, 'file_blobs')) &&
    (yield* tableExists(sql, 'snapshot_files')) &&
    (yield* tableExists(sql, 'materialized_file_shards')) &&
    (yield* tableExists(sql, 'snapshot_file_shards')) &&
    (yield* tableExists(sql, 'routine_cache_cleanup_state')) &&
    (yield* routineMaintenanceColumnsAvailable(sql, 'file_blobs', [
      'blob_id',
      'content_hash',
      'extractor_set',
      'path_hint',
      'reuse_class',
    ])) &&
    (yield* routineMaintenanceColumnsAvailable(sql, 'snapshot_files', ['content_hash', 'path', 'raw_content_hash'])) &&
    (yield* routineMaintenanceColumnsAvailable(sql, 'materialized_file_shards', ['id'])) &&
    (yield* routineMaintenanceColumnsAvailable(sql, 'snapshot_file_shards', ['shard_id'])) &&
    (yield* routineMaintenanceColumnsAvailable(sql, 'routine_cache_cleanup_state', [
      'file_content_hash',
      'file_extractor_set',
      'file_path_hint',
      'materialized_shard_id',
      'phase',
      'singleton',
    ])) &&
    (yield* codeGraphCacheReferenceIndexState(sql, CODE_GRAPH_SNAPSHOT_FILE_BLOB_REFERENCE_INDEX)) === 'ready' &&
    (yield* codeGraphCacheReferenceIndexState(sql, CODE_GRAPH_SNAPSHOT_FILE_CONTENT_REFERENCE_INDEX)) === 'ready' &&
    (yield* codeGraphCacheReferenceIndexState(sql, CODE_GRAPH_SNAPSHOT_FILE_RAW_CONTENT_REFERENCE_INDEX)) === 'ready' &&
    (yield* codeGraphCacheReferenceIndexState(sql, CODE_GRAPH_MATERIALIZED_SHARD_REFERENCE_INDEX)) === 'ready'
  );
});

type CodeGraphCacheReferenceIndex =
  | typeof CODE_GRAPH_SNAPSHOT_FILE_BLOB_REFERENCE_INDEX
  | typeof CODE_GRAPH_SNAPSHOT_FILE_CONTENT_REFERENCE_INDEX
  | typeof CODE_GRAPH_SNAPSHOT_FILE_RAW_CONTENT_REFERENCE_INDEX
  | typeof CODE_GRAPH_MATERIALIZED_SHARD_REFERENCE_INDEX;

const codeGraphCacheReferenceIndexState = Effect.fn('codeGraph.cacheReferenceIndexState')(function* (
  sql: SqlClient.SqlClient,
  index: CodeGraphCacheReferenceIndex,
) {
  const definitions = yield* sql.unsafe<{
    readonly bounded_sql: unknown;
    readonly name: unknown;
    readonly sql_bytes: unknown;
    readonly tbl_name: unknown;
    readonly type: unknown;
  }>(
    `SELECT name, type, tbl_name,
            CASE
              WHEN typeof(sql) = 'text' AND length(CAST(sql AS BLOB)) <= 1024 THEN sql
              ELSE NULL
            END AS bounded_sql,
            length(CAST(sql AS BLOB)) AS sql_bytes
     FROM sqlite_master
     WHERE name = ? COLLATE NOCASE
     LIMIT 2`,
    [index.name],
  );
  if (definitions.length === 0) return 'missing' as const;
  if (
    definitions.length !== 1 ||
    definitions[0]?.name !== index.name ||
    definitions[0]?.type !== 'index' ||
    definitions[0]?.tbl_name !== index.table ||
    typeof definitions[0]?.sql_bytes !== 'number' ||
    !Number.isSafeInteger(definitions[0].sql_bytes) ||
    definitions[0].sql_bytes > 1024 ||
    typeof definitions[0]?.bounded_sql !== 'string' ||
    normalizeSchemaDefinition(definitions[0].bounded_sql) !== normalizeSchemaDefinition(index.definition)
  ) {
    return 'incompatible' as const;
  }
  const xinfo = yield* sql.unsafe<{
    readonly coll: string;
    readonly desc: number;
    readonly key: number;
    readonly name: string | null;
    readonly seqno: number;
  }>(`SELECT * FROM pragma_index_xinfo(?) LIMIT 8`, [index.name]);
  const keyColumns = xinfo.filter(column => Number(column.key) === 1).sort((left, right) => left.seqno - right.seqno);
  // WITHOUT ROWID secondary indexes carry the table primary-key columns as
  // non-key payload. The stored SQL fixes the declared key surface; admit the
  // SQLite-added payload while still requiring the exact ordered BINARY keys.
  return xinfo.length > 0 &&
    xinfo.length < 8 &&
    keyColumns.length === index.columns.length &&
    keyColumns.every(
      (column, columnIndex) =>
        column.name === index.columns[columnIndex] &&
        column.coll.toUpperCase() === 'BINARY' &&
        Number(column.desc) === 0,
    )
    ? ('ready' as const)
    : ('incompatible' as const);
});

interface RawRoutineCacheCleanupState {
  readonly file_content_hash: unknown;
  readonly file_extractor_set: unknown;
  readonly file_path_hint: unknown;
  readonly materialized_shard_id: unknown;
  readonly phase: unknown;
  readonly singleton: unknown;
}

function validRoutineCacheCursorText(value: unknown, maximumBytes = 16_384): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximumBytes &&
    !value.includes('\0') &&
    Buffer.byteLength(value, 'utf8') <= maximumBytes
  );
}

function decodeRoutineCacheCleanupState(row: RawRoutineCacheCleanupState): RoutineCacheCleanupState | undefined {
  if (row.singleton !== 1) return undefined;
  if (row.phase === 'file-blobs') {
    if (row.materialized_shard_id !== null) return undefined;
    if (row.file_content_hash === null && row.file_extractor_set === null && row.file_path_hint === null) {
      return {phase: 'file-blobs'};
    }
    if (
      !validRoutineCacheCursorText(row.file_content_hash, 1_024) ||
      !validRoutineCacheCursorText(row.file_extractor_set, 4_096) ||
      !validRoutineCacheCursorText(row.file_path_hint)
    ) {
      return undefined;
    }
    return {
      cursor: {
        contentHash: row.file_content_hash,
        extractorSet: row.file_extractor_set,
        path: row.file_path_hint,
      },
      phase: 'file-blobs',
    };
  }
  if (
    row.phase !== 'materialized-shards' ||
    row.file_content_hash !== null ||
    row.file_extractor_set !== null ||
    row.file_path_hint !== null
  ) {
    return undefined;
  }
  if (row.materialized_shard_id === null) return {phase: 'materialized-shards'};
  return validRoutineCacheCursorText(row.materialized_shard_id, 1_024)
    ? {cursor: row.materialized_shard_id, phase: 'materialized-shards'}
    : undefined;
}

const selectRoutineCacheCleanupState = Effect.fn('codeGraph.selectRoutineCacheCleanupState')(function* (
  sql: SqlClient.SqlClient,
) {
  const rows = yield* sql.unsafe<RawRoutineCacheCleanupState>(
    `SELECT singleton, phase, file_content_hash, file_extractor_set, file_path_hint, materialized_shard_id
     FROM routine_cache_cleanup_state
     LIMIT 2`,
  );
  const state = rows[0] === undefined ? undefined : decodeRoutineCacheCleanupState(rows[0]);
  if (rows.length !== 1 || state === undefined) {
    return yield* Effect.fail(new CodeGraphStoreError('Routine code graph cache cleanup state is invalid.'));
  }
  return state;
});

const updateRoutineCacheCleanupState = Effect.fn('codeGraph.updateRoutineCacheCleanupState')(function* (
  sql: SqlClient.SqlClient,
  state: RoutineCacheCleanupState,
) {
  const fileCursor = state.phase === 'file-blobs' ? state.cursor : undefined;
  const materializedCursor = state.phase === 'materialized-shards' ? state.cursor : undefined;
  yield* sql.unsafe(
    `UPDATE routine_cache_cleanup_state
     SET phase = ?,
         file_content_hash = ?,
         file_extractor_set = ?,
         file_path_hint = ?,
         materialized_shard_id = ?
     WHERE singleton = 1`,
    [
      state.phase,
      fileCursor?.contentHash ?? null,
      fileCursor?.extractorSet ?? null,
      fileCursor?.path ?? null,
      materializedCursor ?? null,
    ],
  );
  if ((yield* lastStatementChangeCount(sql)) !== 1) {
    return yield* Effect.fail(new CodeGraphStoreError('Routine code graph cache cleanup state changed.'));
  }
});

const selectRoutineFileBlobCacheCandidates = Effect.fn('codeGraph.selectRoutineFileBlobCacheCandidates')(function* (
  sql: SqlClient.SqlClient,
  cursor: RoutineFileBlobCacheKey | undefined,
) {
  const rows = yield* sql.unsafe<{
    readonly content_hash: unknown;
    readonly extractor_set: unknown;
    readonly path_hint: unknown;
  }>(
    `SELECT content_hash, extractor_set, path_hint
     FROM file_blobs
     WHERE (? IS NULL OR (content_hash, extractor_set, path_hint) > (?, ?, ?))
     ORDER BY content_hash, extractor_set, path_hint
     LIMIT ?`,
    [
      cursor?.contentHash ?? null,
      cursor?.contentHash ?? null,
      cursor?.extractorSet ?? null,
      cursor?.path ?? null,
      CODE_GRAPH_ROUTINE_CACHE_PAGE_SIZE,
    ],
  );
  if (
    rows.some(
      row =>
        !validRoutineCacheCursorText(row.content_hash, 1_024) ||
        !validRoutineCacheCursorText(row.extractor_set, 4_096) ||
        !validRoutineCacheCursorText(row.path_hint),
    )
  ) {
    return yield* Effect.fail(new CodeGraphStoreError('File fact cache cleanup cursor is invalid.'));
  }
  return rows.map(row => ({
    contentHash: row.content_hash as string,
    extractorSet: row.extractor_set as string,
    path: row.path_hint as string,
  }));
});

const selectRoutineMaterializedShardCacheCandidates = Effect.fn(
  'codeGraph.selectRoutineMaterializedShardCacheCandidates',
)(function* (sql: SqlClient.SqlClient, cursor: string | undefined) {
  const rows = yield* sql.unsafe<{readonly id: unknown}>(
    `SELECT id
     FROM materialized_file_shards
     WHERE (? IS NULL OR id > ?)
     ORDER BY id
     LIMIT ?`,
    [cursor ?? null, cursor ?? null, CODE_GRAPH_ROUTINE_CACHE_PAGE_SIZE],
  );
  if (rows.some(row => !validRoutineCacheCursorText(row.id, 1_024))) {
    return yield* Effect.fail(new CodeGraphStoreError('Materialized shard cache cleanup cursor is invalid.'));
  }
  return rows.map(row => row.id as string);
});

const deleteRoutineFileBlobCacheCandidates = Effect.fn('codeGraph.deleteRoutineFileBlobCacheCandidates')(function* (
  sql: SqlClient.SqlClient,
  candidates: readonly RoutineFileBlobCacheKey[],
) {
  if (candidates.length === 0) return 0;
  const eligibleBefore = new Date(
    (yield* Clock.currentTimeMillis) - CODE_GRAPH_ROUTINE_CACHE_MINIMUM_AGE_MILLISECONDS,
  ).toISOString();
  const statement = codeGraphRoutineFileBlobCleanupPageStatement(candidates, eligibleBefore);
  yield* sql.unsafe(statement.text, statement.parameters);
  const deleted = yield* lastStatementChangeCount(sql);
  if (!Number.isSafeInteger(deleted) || deleted < 0 || deleted > candidates.length) {
    return yield* Effect.fail(new CodeGraphStoreError('File fact cache cleanup returned an invalid row count.'));
  }
  return deleted;
});

const deleteRoutineMaterializedShardCacheCandidates = Effect.fn(
  'codeGraph.deleteRoutineMaterializedShardCacheCandidates',
)(function* (sql: SqlClient.SqlClient, candidates: readonly string[]) {
  if (candidates.length === 0) return 0;
  const eligibleBefore = new Date(
    (yield* Clock.currentTimeMillis) - CODE_GRAPH_ROUTINE_CACHE_MINIMUM_AGE_MILLISECONDS,
  ).toISOString();
  const statement = codeGraphRoutineMaterializedShardCleanupPageStatement(candidates, eligibleBefore);
  yield* sql.unsafe(statement.text, statement.parameters);
  const deleted = yield* lastStatementChangeCount(sql);
  if (!Number.isSafeInteger(deleted) || deleted < 0 || deleted > candidates.length) {
    return yield* Effect.fail(new CodeGraphStoreError('Materialized shard cache cleanup returned an invalid count.'));
  }
  return deleted;
});

const pruneRoutineMaterializedShardCacheRowsPage = Effect.fn('codeGraph.pruneRoutineMaterializedShardCacheRowsPage')(
  function* (sql: SqlClient.SqlClient, cursor: string | undefined) {
    const candidates = yield* selectRoutineMaterializedShardCacheCandidates(sql, cursor);
    const deleted = yield* deleteRoutineMaterializedShardCacheCandidates(sql, candidates);
    const remaining = candidates.length === CODE_GRAPH_ROUTINE_CACHE_PAGE_SIZE;
    yield* updateRoutineCacheCleanupState(
      sql,
      remaining ? {cursor: candidates.at(-1)!, phase: 'materialized-shards'} : {phase: 'file-blobs'},
    );
    return {
      cleanup: deleted > 0 ? 'materialized-shard-cache' : 'none',
      deleted,
      remaining,
    } satisfies RoutinePhysicalCleanupPage;
  },
);

const pruneRoutineCacheRowsPage = Effect.fn('codeGraph.pruneRoutineCacheRowsPage')(function* (
  sql: SqlClient.SqlClient,
) {
  if (!(yield* routineCacheSchemaCurrent(sql))) {
    return {cleanup: 'none', deleted: 0, remaining: false} satisfies RoutinePhysicalCleanupPage;
  }
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const activeBuild = yield* sql.unsafe<{readonly id: string}>(
        "SELECT id FROM snapshots WHERE state = 'building' LIMIT 1",
      );
      // Fresh parser facts and materialized shards are written before their
      // snapshot associations. A checkout-wide building row is therefore the
      // durable interlock that prevents routine cleanup from racing that gap.
      if (activeBuild.length > 0) {
        return {cleanup: 'none', deleted: 0, remaining: false} satisfies RoutinePhysicalCleanupPage;
      }
      const state = yield* selectRoutineCacheCleanupState(sql);
      if (state.phase === 'materialized-shards') {
        return yield* pruneRoutineMaterializedShardCacheRowsPage(sql, state.cursor);
      }
      const candidates = yield* selectRoutineFileBlobCacheCandidates(sql, state.cursor);
      if (candidates.length === 0) {
        // An empty keyset page performs no cache-row work, so the same tick may
        // start the materialized phase without combining two physical pages.
        return yield* pruneRoutineMaterializedShardCacheRowsPage(sql, undefined);
      }
      const deleted = yield* deleteRoutineFileBlobCacheCandidates(sql, candidates);
      yield* updateRoutineCacheCleanupState(
        sql,
        candidates.length === CODE_GRAPH_ROUTINE_CACHE_PAGE_SIZE
          ? {cursor: candidates.at(-1)!, phase: 'file-blobs'}
          : {phase: 'materialized-shards'},
      );
      return {
        cleanup: deleted > 0 ? 'file-blob-cache' : 'none',
        deleted,
        // A complete file-blob scan still needs the materialized-shard phase.
        remaining: true,
      } satisfies RoutinePhysicalCleanupPage;
    }),
  );
});

const resetRoutineCacheCleanupState = Effect.fn('codeGraph.resetRoutineCacheCleanupState')(function* (
  sql: SqlClient.SqlClient,
) {
  if (!(yield* routineCacheSchemaCurrent(sql))) return;
  yield* sql.withTransaction(updateRoutineCacheCleanupState(sql, {phase: 'file-blobs'}));
});

function validatedSnapshotLeaseDuration(durationMilliseconds: number): number {
  const finiteDuration = Number.isFinite(durationMilliseconds) ? Math.floor(durationMilliseconds) : 1_000;
  return Math.max(1_000, Math.min(60 * 60_000, finiteDuration));
}

const insertActivationLease = Effect.fn('codeGraph.insertActivationLease')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  lease: Option.Option<CodeGraphActivationLease>,
) {
  if (Option.isNone(lease)) return;
  const now = yield* Clock.currentTimeMillis;
  yield* sql`
    INSERT INTO snapshot_leases (token, snapshot_id, expires_at)
    VALUES (${lease.value.token}, ${snapshotId}, ${now + lease.value.durationMilliseconds})
  `;
});

const recordSnapshotExtractorGeneration = Effect.fn('codeGraph.recordSnapshotExtractorGeneration')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
) {
  yield* sql`
    INSERT INTO snapshot_extractor_generations (snapshot_id, generation)
    VALUES (${snapshotId}, ${CODE_GRAPH_EXTRACTOR_GENERATION})
    ON CONFLICT(snapshot_id) DO UPDATE SET
      generation = MAX(snapshot_extractor_generations.generation, excluded.generation)
  `;
});

export {
  CODE_GRAPH_ROUTINE_CACHE_PAGE_SIZE,
  BoundedSnapshotLeaseRow,
  boundedSnapshotLeaseProjection,
  recordSnapshotExtractorGeneration,
  RoutineFileBlobCacheKey,
  insertActivationLease,
  RoutinePhysicalCleanupPage,
  routineMaintenanceColumnsAvailable,
  validRoutineCacheCursorText,
  CODE_GRAPH_ROUTINE_EXPIRED_LEASE_PAGE_SIZE,
  CODE_GRAPH_ROUTINE_CACHE_MINIMUM_AGE_MILLISECONDS,
  CODE_GRAPH_SNAPSHOT_FILE_BLOB_REFERENCE_INDEX,
  CODE_GRAPH_SNAPSHOT_FILE_CONTENT_REFERENCE_INDEX,
  CODE_GRAPH_MATERIALIZED_SHARD_REFERENCE_INDEX,
  RoutineCacheCleanupState,
  updateRoutineCacheCleanupState,
  persistentSnapshotMatchesLogicalIdentity,
  SnapshotLeaseManifest,
  decodeSnapshotLeaseManifest,
  RawRoutineCacheCleanupState,
  RoutineExpiredLeasePage,
  CodeGraphCacheReferenceIndex,
  codeGraphCacheReferenceIndexState,
  routineCacheSchemaCurrent,
  decodeRoutineCacheCleanupState,
  selectRoutineCacheCleanupState,
  selectRoutineFileBlobCacheCandidates,
  selectRoutineMaterializedShardCacheCandidates,
  deleteRoutineFileBlobCacheCandidates,
  deleteRoutineMaterializedShardCacheCandidates,
  pruneRoutineMaterializedShardCacheRowsPage,
  pruneRoutineCacheRowsPage,
  resetRoutineCacheCleanupState,
  selectPersistentBuildOwnerCandidates,
  persistentBuildOwnerCandidateValid,
  observePersistentBuildOwner,
  validatedSnapshotLeaseDuration,
};
