import {Clock, Effect} from 'effect';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import * as SqlError from 'effect/unstable/sql/SqlError';
import {
  CODE_GRAPH_REMOVED_VIEW_CLEANUP_CLAIM_LEASE_MILLISECONDS,
  CODE_GRAPH_REMOVED_VIEW_CLEANUP_PAGE_ROWS,
  CODE_GRAPH_REMOVED_VIEW_CLEANUP_PHASES,
  type CodeGraphOrphanProvenanceCandidatePage,
  type CodeGraphOrphanProvenanceViewObservation,
  type CodeGraphRemovedViewCleanupEntry,
  type CodeGraphRemovedViewCleanupEvidence,
  type CodeGraphRemovedViewCleanupUpdate,
  type CodeGraphWorktreeReconciliationCandidate,
} from './store_models.js';
import {
  MAXIMUM_CANONICAL_DATE_MILLISECONDS,
  REMOVED_VIEW_CLEANUP_ADMISSION_CURSOR_KEY,
  REMOVED_VIEW_CLEANUP_TRIGGER_DEFINITIONS,
} from './store_removed_view_schema_contracts.js';
import {
  removedViewAuthorityTableState,
  removedViewCleanupRecordedRevision,
} from './store_removed_view_schema_inspection.js';
import {normalizeSchemaDefinition} from './store_schema_normalization.js';
import {
  REMOVED_VIEW_CLEANUP_CURRENT_MAXIMUM_METADATA_ROWS,
  type SchemaMetadataMaximumRows,
  inspectBoundedSchemaMetadataRowCount,
  inspectBoundedSchemaMetadataValue,
} from './store_schema_metadata.js';
import {
  CODE_GRAPH_SCHEMA_VERSION,
  CodeGraphStoreCorruptionError,
  CodeGraphStoreError,
  CodeGraphStoreIncompatibleSchemaError,
} from './types.js';
import {codeGraphPersistentSchemaIsCurrent} from './store/schema_revision.js';
import {
  allocateRemovedViewCleanupEpoch,
  authorityPrimaryKeyBinary,
  boundedAuthorityTableDefinition,
  CLEANUP_TOKEN,
  CODE_GRAPH_RECONCILIATION_REQUIRED_INDEXES,
  CODE_GRAPH_RECONCILIATION_TABLE_COLUMNS,
  CODE_GRAPH_SNAPSHOT_ID,
  CODE_GRAPH_SNAPSHOT_LEASE_EXPIRY_INDEX,
  codeGraphReconciliationIndexState,
  type CodeGraphReconciliationTable,
  codeGraphWorktreeReconciliationCandidatePageStatement,
  decodeRemovedViewCleanupRow,
  exactCodeGraphSnapshotStateCheck,
  observeRemovedViewCleanupAuthority,
  REMOVED_VIEW_CLEANUP_BOUNDED_ROW_PROJECTION,
  REMOVED_VIEW_CLEANUP_FULL_ENTRY_PREDICATE,
  removedViewCleanupEntryCasParameters,
  type RemovedViewCleanupRow,
  removeMatchingLegacyCleanupPointer,
  revokeRemovedViewCleanupEntry,
  sameRemovedViewCleanupEntry,
  selectRemovedViewCleanupEntry,
  validateRemovedViewSnapshotAuthority,
  validCanonicalTimestamp,
  validRemovedViewCleanupBlockedCode,
  validRemovedViewCleanupEntry,
} from './store_reconciliation_core.js';
import {
  CODE_GRAPH_ACTIVE_SNAPSHOT_EXTRACTOR_TRIGGER_SQL,
  codeGraphRemovedViewCleanupBaseSchemaAdmission,
  inspectRemovedViewCleanupAdmissionCursor,
} from './store_schema_core.js';
import {
  boundedSnapshotLeaseProjection,
  type BoundedSnapshotLeaseRow,
  decodeSnapshotLeaseManifest,
} from './store_maintenance_core.js';
import {lastStatementChangeCount} from './store_activation_core.js';
import {type CodeGraphSqlQueryStatement} from './store_visualization_sql.js';

const WORKTREE_RECONCILIATION_CURSOR_KEY = 'worktree_reconciliation_cursor';
const WORKTREE_RECONCILIATION_CURSOR_PATTERN = /^[0-9a-f]{64}$/u;
const WORKTREE_RECONCILIATION_CURSOR_OPERATION = 'claim code graph reconciliation candidates';
const WORKTREE_RECONCILIATION_LEGACY_MAXIMUM_METADATA_ROWS = 67 satisfies SchemaMetadataMaximumRows;
const ORPHAN_PROVENANCE_CURSOR_KEY = 'orphan_provenance_cursor';
const ORPHAN_PROVENANCE_WORKTREE_ID_LIMIT = 4_096;

type WorktreeReconciliationCursorState =
  {readonly recorded: true; readonly value: string} | {readonly recorded: false; readonly value: undefined};

const admitOrRecoverWorktreeReconciliationSchema = Effect.fn('codeGraph.admitOrRecoverWorktreeReconciliationSchema')(
  function* (sql: SqlClient.SqlClient) {
    if (yield* codeGraphWorktreeReconciliationSchemaCompatible(sql)) return true;

    const revision = yield* removedViewCleanupRecordedRevision(
      sql,
      WORKTREE_RECONCILIATION_LEGACY_MAXIMUM_METADATA_ROWS,
    );
    if (revision.state !== 'recorded' || !codeGraphPersistentSchemaIsCurrent(revision.value)) {
      return false;
    }
    const metadataRowCount = yield* inspectBoundedSchemaMetadataRowCount(
      sql,
      WORKTREE_RECONCILIATION_LEGACY_MAXIMUM_METADATA_ROWS,
    );
    const cleanupCursor = yield* inspectRemovedViewCleanupAdmissionCursor(
      sql,
      WORKTREE_RECONCILIATION_LEGACY_MAXIMUM_METADATA_ROWS,
    );
    if (!cleanupCursor.current) return false;
    const admittedRows =
      REMOVED_VIEW_CLEANUP_CURRENT_MAXIMUM_METADATA_ROWS - (cleanupCursor.cursor === undefined ? 1 : 0);
    if (metadataRowCount !== admittedRows + 1) return false;

    const cursor = yield* inspectBoundedSchemaMetadataValue(
      sql,
      WORKTREE_RECONCILIATION_CURSOR_KEY,
      64,
      WORKTREE_RECONCILIATION_LEGACY_MAXIMUM_METADATA_ROWS,
    );
    if (cursor.state === 'invalid') {
      return yield* Effect.fail(worktreeReconciliationCursorStructuralError());
    }
    if (cursor.state === 'missing') return false;
    yield* clearWorktreeReconciliationCursor(sql, cursor.value);
    return yield* codeGraphWorktreeReconciliationSchemaCompatible(sql);
  },
);

const inspectWorktreeReconciliationCursor = Effect.fn('codeGraph.inspectWorktreeReconciliationCursor')(function* (
  sql: SqlClient.SqlClient,
) {
  const inspection = yield* inspectBoundedSchemaMetadataValue(sql, WORKTREE_RECONCILIATION_CURSOR_KEY, 64);
  if (inspection.state === 'invalid') {
    return yield* Effect.fail(worktreeReconciliationCursorStructuralError());
  }
  if (inspection.state === 'missing') {
    return {recorded: false, value: undefined} satisfies WorktreeReconciliationCursorState;
  }
  if (WORKTREE_RECONCILIATION_CURSOR_PATTERN.test(inspection.value)) {
    return {recorded: true, value: inspection.value} satisfies WorktreeReconciliationCursorState;
  }
  yield* clearWorktreeReconciliationCursor(sql, inspection.value);
  return {recorded: false, value: undefined} satisfies WorktreeReconciliationCursorState;
});

const clearWorktreeReconciliationCursor = Effect.fn('codeGraph.clearWorktreeReconciliationCursor')(function* (
  sql: SqlClient.SqlClient,
  recordedCursor: string,
) {
  yield* sql.unsafe(
    `DELETE FROM schema_metadata
     WHERE key = ? COLLATE BINARY
       AND value = ? COLLATE BINARY`,
    [WORKTREE_RECONCILIATION_CURSOR_KEY, recordedCursor],
  );
  if ((yield* lastStatementChangeCount(sql)) !== 1) {
    return yield* Effect.fail(worktreeReconciliationCursorChangedError());
  }
  const clearedCursor = yield* inspectBoundedSchemaMetadataValue(sql, WORKTREE_RECONCILIATION_CURSOR_KEY, 64);
  if (clearedCursor.state !== 'missing') {
    return yield* Effect.fail(worktreeReconciliationCursorChangedError());
  }
});

const recordWorktreeReconciliationCursor = Effect.fn('codeGraph.recordWorktreeReconciliationCursor')(function* (
  sql: SqlClient.SqlClient,
  current: WorktreeReconciliationCursorState,
  nextCursor: string,
) {
  if (current.recorded) {
    yield* sql.unsafe(
      `UPDATE schema_metadata
       SET value = ?
       WHERE key = ? COLLATE BINARY
         AND value = ? COLLATE BINARY`,
      [nextCursor, WORKTREE_RECONCILIATION_CURSOR_KEY, current.value],
    );
  } else {
    const metadataRowCount = yield* inspectBoundedSchemaMetadataRowCount(sql);
    const cleanupCursor = yield* inspectRemovedViewCleanupAdmissionCursor(sql);
    if (metadataRowCount === undefined || !cleanupCursor.current) {
      return yield* Effect.fail(worktreeReconciliationCursorCapacityError());
    }
    const maximumRows =
      REMOVED_VIEW_CLEANUP_CURRENT_MAXIMUM_METADATA_ROWS - (cleanupCursor.cursor === undefined ? 1 : 0);
    if (metadataRowCount >= maximumRows) return;
    yield* sql.unsafe(
      `INSERT INTO schema_metadata (key, value)
       VALUES (?, ?)
       ON CONFLICT(key) DO NOTHING`,
      [WORKTREE_RECONCILIATION_CURSOR_KEY, nextCursor],
    );
  }
  if ((yield* lastStatementChangeCount(sql)) !== 1) {
    return yield* Effect.fail(worktreeReconciliationCursorChangedError());
  }
  const advancedCursor = yield* inspectBoundedSchemaMetadataValue(sql, WORKTREE_RECONCILIATION_CURSOR_KEY, 64);
  if (advancedCursor.state !== 'recorded' || advancedCursor.value !== nextCursor) {
    return yield* Effect.fail(worktreeReconciliationCursorChangedError());
  }
});

const claimWorktreeReconciliationCandidates = Effect.fn('codeGraph.claimWorktreeReconciliationCandidates')(function* (
  sql: SqlClient.SqlClient,
  requestedLimit: number,
) {
  const limit = Number.isSafeInteger(requestedLimit) ? Math.max(1, Math.min(32, requestedLimit)) : 32;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      if (!(yield* admitOrRecoverWorktreeReconciliationSchema(sql))) {
        return yield* Effect.fail(new CodeGraphStoreError('Code graph reconciliation schema is unavailable.'));
      }
      const cursorState = yield* inspectWorktreeReconciliationCursor(sql);
      const cursor = cursorState.value;
      const selectPage = (boundary: 'after' | 'through', pageLimit: number) => {
        const statement = codeGraphWorktreeReconciliationCandidatePageStatement(cursor, boundary, pageLimit);
        return sql.unsafe<{
          readonly repository_id: string | null;
          readonly snapshot_id: string;
          readonly snapshot_state: string;
          readonly tombstoned: number;
          readonly worktree_id: string;
        }>(statement.text, statement.parameters);
      };
      const after = yield* selectPage('after', limit);
      const rows =
        cursor === undefined || after.length >= limit
          ? after
          : [...after, ...(yield* selectPage('through', limit - after.length))];
      const nextCursor = rows.at(-1)?.worktree_id;
      if (
        rows.some(
          row =>
            typeof row.repository_id !== 'string' ||
            !/^[0-9a-f]{64}$/.test(row.repository_id) ||
            !/^[0-9a-f]{64}$/.test(row.worktree_id) ||
            !/^cgsn_[0-9a-f]{40}(?:-direct|-full-[0-9a-f]{16})?$/.test(row.snapshot_id) ||
            !['building', 'failed', 'ready', 'retired'].includes(row.snapshot_state) ||
            (Number(row.tombstoned) !== 0 && Number(row.tombstoned) !== 1),
        )
      ) {
        return yield* Effect.fail(new CodeGraphStoreError('Code graph reconciliation candidate is invalid.'));
      }
      if (nextCursor !== undefined) {
        yield* recordWorktreeReconciliationCursor(sql, cursorState, nextCursor);
      }
      return rows
        .filter(row => row.snapshot_state === 'ready' && Number(row.tombstoned) === 0)
        .map(row => ({
          repositoryId: row.repository_id!,
          snapshotId: row.snapshot_id,
          worktreeId: row.worktree_id,
        })) satisfies readonly CodeGraphWorktreeReconciliationCandidate[];
    }),
  );
});

function worktreeReconciliationCursorStructuralError(): CodeGraphStoreCorruptionError {
  return new CodeGraphStoreCorruptionError('Code graph reconciliation cursor metadata is structurally invalid.', {
    operation: WORKTREE_RECONCILIATION_CURSOR_OPERATION,
  });
}

function worktreeReconciliationCursorChangedError(): CodeGraphStoreError {
  return new CodeGraphStoreCorruptionError(
    'Code graph reconciliation cursor metadata changed before it could advance.',
    {
      operation: WORKTREE_RECONCILIATION_CURSOR_OPERATION,
    },
  );
}

function worktreeReconciliationCursorCapacityError(): CodeGraphStoreIncompatibleSchemaError {
  return new CodeGraphStoreIncompatibleSchemaError(
    'Code graph reconciliation cursor metadata capacity is unavailable.',
    {
      operation: WORKTREE_RECONCILIATION_CURSOR_OPERATION,
    },
  );
}

const claimOrphanProvenanceCandidates = Effect.fn('codeGraph.claimOrphanProvenanceCandidates')(function* (
  sql: SqlClient.SqlClient,
  requestedWorktreeIds: readonly string[],
  requestedLimit: number,
) {
  if (
    requestedWorktreeIds.length > ORPHAN_PROVENANCE_WORKTREE_ID_LIMIT ||
    requestedWorktreeIds.some(worktreeId => !/^[0-9a-f]{64}$/.test(worktreeId))
  ) {
    return yield* Effect.fail(new CodeGraphStoreError('Code graph provenance candidate inventory is invalid.'));
  }
  const worktreeIds = [...new Set(requestedWorktreeIds)].sort();
  if (worktreeIds.length !== requestedWorktreeIds.length) {
    return yield* Effect.fail(new CodeGraphStoreError('Code graph provenance candidate inventory is invalid.'));
  }
  if (worktreeIds.length === 0) {
    return {worktreeIds: []} as const satisfies CodeGraphOrphanProvenanceCandidatePage;
  }
  const limit = Number.isSafeInteger(requestedLimit) ? Math.max(1, Math.min(32, requestedLimit)) : 32;
  const encodedWorktreeIds = JSON.stringify(worktreeIds);
  const worktreeIdSet = new Set(worktreeIds);
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      if (!(yield* codeGraphWorktreeReconciliationSchemaCompatible(sql))) {
        return yield* Effect.fail(new CodeGraphStoreError('Code graph reconciliation schema is unavailable.'));
      }
      const cursorInspection = yield* inspectBoundedSchemaMetadataValue(sql, ORPHAN_PROVENANCE_CURSOR_KEY, 64);
      if (cursorInspection.state === 'invalid') {
        return yield* Effect.fail(
          new CodeGraphStoreError('Code graph provenance reconciliation cursor metadata is invalid.'),
        );
      }
      const cursor =
        cursorInspection.state === 'recorded' && /^[0-9a-f]{64}$/u.test(cursorInspection.value)
          ? cursorInspection.value
          : undefined;
      const cursorRecovery =
        cursorInspection.state === 'recorded' && cursor === undefined ? ('invalid-format' as const) : undefined;
      const selectPage = (boundary: 'after' | 'through', pageLimit: number) => {
        const predicate =
          cursor === undefined ? '' : boundary === 'after' ? 'AND candidate.value > ?' : 'AND candidate.value <= ?';
        const parameters =
          cursor === undefined ? [encodedWorktreeIds, pageLimit] : [encodedWorktreeIds, cursor, pageLimit];
        return sql.unsafe<{readonly worktree_id: unknown}>(
          `SELECT candidate.value AS worktree_id
           FROM json_each(?) AS candidate
           LEFT JOIN active_snapshots AS active ON active.worktree_id = candidate.value
           WHERE candidate.type = 'text'
             AND active.worktree_id IS NULL
             ${predicate}
           ORDER BY candidate.value
           LIMIT ?`,
          parameters,
        );
      };
      const after = yield* selectPage('after', limit);
      const rows =
        cursor === undefined || after.length >= limit
          ? after
          : [...after, ...(yield* selectPage('through', limit - after.length))];
      if (
        rows.some(
          row =>
            typeof row.worktree_id !== 'string' ||
            !/^[0-9a-f]{64}$/.test(row.worktree_id) ||
            !worktreeIdSet.has(row.worktree_id),
        )
      ) {
        return yield* Effect.fail(
          new CodeGraphStoreError('Code graph provenance reconciliation candidate is invalid.'),
        );
      }
      const selected = rows.map(row => row.worktree_id as string);
      const nextCursor = selected.at(-1);
      if (nextCursor !== undefined) {
        if (cursorInspection.state === 'missing') {
          const metadataRowCount = yield* inspectBoundedSchemaMetadataRowCount(sql);
          const removedViewAdmissionCursor = yield* inspectRemovedViewCleanupAdmissionCursor(sql);
          const metadataRowLimit =
            removedViewAdmissionCursor.cursor === undefined
              ? REMOVED_VIEW_CLEANUP_CURRENT_MAXIMUM_METADATA_ROWS - 1
              : REMOVED_VIEW_CLEANUP_CURRENT_MAXIMUM_METADATA_ROWS;
          if (
            metadataRowCount === undefined ||
            !removedViewAdmissionCursor.current ||
            metadataRowCount >= metadataRowLimit
          ) {
            return yield* Effect.fail(
              new CodeGraphStoreError('Code graph provenance reconciliation cursor metadata has no capacity.'),
            );
          }
          yield* sql.unsafe(`INSERT INTO schema_metadata (key, value) VALUES (?, ?)`, [
            ORPHAN_PROVENANCE_CURSOR_KEY,
            nextCursor,
          ]);
        } else {
          yield* sql.unsafe(`UPDATE schema_metadata SET value = ? WHERE key = ? AND value = ?`, [
            nextCursor,
            ORPHAN_PROVENANCE_CURSOR_KEY,
            cursorInspection.value,
          ]);
          if ((yield* lastStatementChangeCount(sql)) !== 1) {
            return yield* Effect.fail(new CodeGraphStoreError('Code graph provenance reconciliation cursor changed.'));
          }
        }
      } else if (cursorRecovery !== undefined && cursorInspection.state === 'recorded') {
        yield* sql.unsafe(`DELETE FROM schema_metadata WHERE key = ? AND value = ?`, [
          ORPHAN_PROVENANCE_CURSOR_KEY,
          cursorInspection.value,
        ]);
        if ((yield* lastStatementChangeCount(sql)) !== 1) {
          return yield* Effect.fail(new CodeGraphStoreError('Code graph provenance reconciliation cursor changed.'));
        }
      }
      return {
        ...(cursorRecovery === undefined ? {} : {cursorRecovery}),
        worktreeIds: selected,
      } as const satisfies CodeGraphOrphanProvenanceCandidatePage;
    }),
  );
});

const observeOrphanProvenanceView = Effect.fn('codeGraph.observeOrphanProvenanceView')(function* (
  sql: SqlClient.SqlClient,
  worktreeId: string,
) {
  if (!/^[0-9a-f]{64}$/.test(worktreeId)) {
    return yield* Effect.fail(new CodeGraphStoreError('Code graph worktree identity is invalid.'));
  }
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      if (!(yield* codeGraphWorktreeReconciliationSchemaCompatible(sql))) {
        return yield* Effect.fail(new CodeGraphStoreError('Code graph reconciliation schema is unavailable.'));
      }
      const rows = yield* sql.unsafe<{readonly snapshot_id: unknown}>(
        `SELECT snapshot_id FROM active_snapshots WHERE worktree_id = ? LIMIT 2`,
        [worktreeId],
      );
      if (
        rows.length > 1 ||
        (rows[0] !== undefined &&
          (typeof rows[0].snapshot_id !== 'string' || !CODE_GRAPH_SNAPSHOT_ID.test(rows[0].snapshot_id)))
      ) {
        return yield* Effect.fail(new CodeGraphStoreError('Code graph view authority is invalid.'));
      }
      return rows[0] === undefined
        ? ({state: 'absent'} as const satisfies CodeGraphOrphanProvenanceViewObservation)
        : ({
            snapshotId: rows[0].snapshot_id as string,
            state: 'active',
          } as const satisfies CodeGraphOrphanProvenanceViewObservation);
    }),
  );
});

/** @internal Indexed cursor-page statement retained for query-plan and high-cardinality regressions. */

const codeGraphWorktreeReconciliationSchemaCompatible: (
  sql: SqlClient.SqlClient,
  requireIndexes?: boolean,
  requireCleanup?: boolean,
  requireRemovedViewAuthority?: boolean,
  requireLeaseExpiryIndex?: boolean,
) => Effect.Effect<boolean, SqlError.SqlError> = Effect.fn('codeGraph.worktreeReconciliationSchemaCompatible')(
  function* (
    sql: SqlClient.SqlClient,
    requireIndexes = true,
    requireCleanup = true,
    requireRemovedViewAuthority = true,
    requireLeaseExpiryIndex = true,
  ) {
    const extensionRevision = yield* removedViewCleanupRecordedRevision(sql);
    if (extensionRevision.state === 'invalid') return false;
    for (const table of Object.keys(CODE_GRAPH_RECONCILIATION_TABLE_COLUMNS) as CodeGraphReconciliationTable[]) {
      if (table === 'removed_view_cleanup' && !requireCleanup) continue;
      if (table === 'removed_views' && !requireRemovedViewAuthority) continue;
      const columns = yield* sql.unsafe<{
        readonly dflt_value: unknown;
        readonly hidden: number;
        readonly name: string;
        readonly notnull: number;
        readonly pk: number;
        readonly type: string;
      }>(
        `SELECT * FROM pragma_table_xinfo('${table}')
         LIMIT ${CODE_GRAPH_RECONCILIATION_TABLE_COLUMNS[table].length + 1}`,
      );
      const observed = columns
        .map(column => ({
          hidden: Number(column.hidden),
          defaultValue: column.dflt_value,
          name: column.name,
          notNull: Number(column.notnull) === 1,
          primaryKeyPosition: Number(column.pk),
          type: column.type.toUpperCase(),
        }))
        .sort((left, right) => left.name.localeCompare(right.name));
      const expected = [...CODE_GRAPH_RECONCILIATION_TABLE_COLUMNS[table]].sort((left, right) =>
        left.name.localeCompare(right.name),
      );
      if (
        observed.length !== expected.length ||
        observed.some((column, index) => {
          const contract = expected[index];
          return (
            contract === undefined ||
            column.hidden !== 0 ||
            column.defaultValue !== ('defaultValue' in contract ? contract.defaultValue : null) ||
            column.name !== contract.name ||
            column.type !== contract.type ||
            column.notNull !== contract.notNull ||
            column.primaryKeyPosition !== contract.primaryKeyPosition
          );
        })
      ) {
        return false;
      }
    }
    if (
      !(yield* authorityPrimaryKeyBinary(sql, 'active_snapshots', 'worktree_id')) ||
      !(yield* authorityPrimaryKeyBinary(sql, 'snapshot_leases', 'token')) ||
      !(yield* authorityPrimaryKeyBinary(sql, 'snapshots', 'id')) ||
      (requireLeaseExpiryIndex &&
        (yield* codeGraphReconciliationIndexState(sql, CODE_GRAPH_SNAPSHOT_LEASE_EXPIRY_INDEX)) !== 'ready')
    ) {
      return false;
    }
    const schemaVersion = yield* inspectBoundedSchemaMetadataValue(sql, 'schema_version', 16);
    if (schemaVersion.state !== 'recorded' || schemaVersion.value !== String(CODE_GRAPH_SCHEMA_VERSION)) {
      if (!(extensionRevision.state === 'missing' && schemaVersion.state === 'missing')) return false;
    }
    const activeForeignKeys = yield* sql.unsafe<{
      readonly from: string;
      readonly match: string;
      readonly on_delete: string;
      readonly on_update: string;
      readonly table: string;
      readonly to: string;
    }>(`SELECT * FROM pragma_foreign_key_list('active_snapshots') LIMIT 2`);
    if (
      activeForeignKeys.length !== 1 ||
      activeForeignKeys[0]?.from !== 'snapshot_id' ||
      activeForeignKeys[0]?.to !== 'id' ||
      activeForeignKeys[0]?.table !== 'snapshots' ||
      activeForeignKeys[0]?.on_delete.toUpperCase() !== 'CASCADE' ||
      activeForeignKeys[0]?.on_update.toUpperCase() !== 'NO ACTION' ||
      activeForeignKeys[0]?.match.toUpperCase() !== 'NONE'
    ) {
      return false;
    }
    const removedForeignKeys = yield* sql.unsafe(`SELECT 1 FROM pragma_foreign_key_list('removed_views') LIMIT 1`);
    if (removedForeignKeys.length !== 0) return false;
    if (requireCleanup && !(yield* codeGraphRemovedViewCleanupBaseSchemaAdmission(sql)).current) {
      return false;
    }
    const snapshotForeignKeys = yield* sql.unsafe<{
      readonly from: string;
      readonly match: string;
      readonly on_delete: string;
      readonly on_update: string;
      readonly table: string;
      readonly to: string;
    }>(`SELECT * FROM pragma_foreign_key_list('snapshots') LIMIT 2`);
    if (
      snapshotForeignKeys.length !== 1 ||
      snapshotForeignKeys[0]?.from !== 'repository_id' ||
      snapshotForeignKeys[0]?.to !== 'id' ||
      snapshotForeignKeys[0]?.table !== 'repositories' ||
      snapshotForeignKeys[0]?.on_delete.toUpperCase() !== 'CASCADE' ||
      snapshotForeignKeys[0]?.on_update.toUpperCase() !== 'NO ACTION' ||
      snapshotForeignKeys[0]?.match.toUpperCase() !== 'NONE'
    ) {
      return false;
    }
    const leaseForeignKeys = yield* sql.unsafe<{
      readonly from: string;
      readonly match: string;
      readonly on_delete: string;
      readonly on_update: string;
      readonly table: string;
      readonly to: string;
    }>(`SELECT * FROM pragma_foreign_key_list('snapshot_leases') LIMIT 2`);
    if (
      leaseForeignKeys.length !== 1 ||
      leaseForeignKeys[0]?.from !== 'snapshot_id' ||
      leaseForeignKeys[0]?.to !== 'id' ||
      leaseForeignKeys[0]?.table !== 'snapshots' ||
      leaseForeignKeys[0]?.on_delete.toUpperCase() !== 'CASCADE' ||
      leaseForeignKeys[0]?.on_update.toUpperCase() !== 'NO ACTION' ||
      leaseForeignKeys[0]?.match.toUpperCase() !== 'NONE'
    ) {
      return false;
    }
    const leaseDefinition = yield* boundedAuthorityTableDefinition(sql, 'snapshot_leases');
    const snapshotDefinition = yield* boundedAuthorityTableDefinition(sql, 'snapshots');
    if (!(
      (!requireRemovedViewAuthority || (yield* removedViewAuthorityTableState(sql)) === 'compatible') &&
      leaseDefinition !== undefined &&
      /\bretire_when_inactive\s+INTEGER\s+NOT\s+NULL\s+DEFAULT\s+0\s+CHECK\s*\(\s*retire_when_inactive\s+IN\s*\(\s*0\s*,\s*1\s*\)\s*\)/iu.test(
        leaseDefinition,
      ) &&
      snapshotDefinition !== undefined &&
      exactCodeGraphSnapshotStateCheck(snapshotDefinition)
    )) {
      return false;
    }
    if (requireIndexes) {
      for (const index of CODE_GRAPH_RECONCILIATION_REQUIRED_INDEXES) {
        if ((yield* codeGraphReconciliationIndexState(sql, index)) !== 'ready') return false;
      }
    }
    const triggers = yield* sql.unsafe<{
      readonly bounded_sql: unknown;
      readonly name: unknown;
      readonly sql_bytes: unknown;
      readonly tbl_name: unknown;
    }>(`SELECT name, tbl_name,
               CASE
                 WHEN typeof(sql) = 'text' AND length(CAST(sql AS BLOB)) <= 8192 THEN sql
                 ELSE NULL
               END AS bounded_sql,
               length(CAST(sql AS BLOB)) AS sql_bytes
        FROM sqlite_master
        WHERE type = 'trigger'
          AND (tbl_name = 'schema_metadata' COLLATE NOCASE
            OR tbl_name = 'active_snapshots' COLLATE NOCASE
            OR tbl_name = 'removed_views' COLLATE NOCASE
            OR tbl_name = 'snapshots' COLLATE NOCASE
            OR tbl_name = 'snapshot_leases' COLLATE NOCASE)
        ORDER BY name
        LIMIT 5`);
    const activeTrigger = triggers.filter(trigger => trigger.name === 'active_snapshots_require_current_extractor');
    const cleanupTriggers = triggers.filter(trigger =>
      REMOVED_VIEW_CLEANUP_TRIGGER_DEFINITIONS.some(expected => expected.name === trigger.name),
    );
    const expectedTriggerCount = 1 + cleanupTriggers.length;
    if (
      triggers.length !== expectedTriggerCount ||
      triggers.some(
        trigger =>
          typeof trigger.name !== 'string' ||
          trigger.name !== trigger.name.toLowerCase() ||
          typeof trigger.tbl_name !== 'string' ||
          trigger.tbl_name !== trigger.tbl_name.toLowerCase() ||
          typeof trigger.sql_bytes !== 'number' ||
          !Number.isSafeInteger(trigger.sql_bytes) ||
          trigger.sql_bytes > 8192 ||
          typeof trigger.bounded_sql !== 'string',
      ) ||
      activeTrigger.length !== 1 ||
      activeTrigger[0]?.tbl_name !== 'active_snapshots' ||
      normalizeSchemaDefinition((activeTrigger[0]?.bounded_sql as string) ?? '') !==
        normalizeSchemaDefinition(CODE_GRAPH_ACTIVE_SNAPSHOT_EXTRACTOR_TRIGGER_SQL) ||
      (cleanupTriggers.length !== 0 && cleanupTriggers.length !== REMOVED_VIEW_CLEANUP_TRIGGER_DEFINITIONS.length) ||
      (requireCleanup && cleanupTriggers.length !== REMOVED_VIEW_CLEANUP_TRIGGER_DEFINITIONS.length) ||
      cleanupTriggers.some(trigger => {
        const expected = REMOVED_VIEW_CLEANUP_TRIGGER_DEFINITIONS.find(candidate => candidate.name === trigger.name);
        return (
          expected === undefined ||
          trigger.tbl_name !== 'removed_views' ||
          normalizeSchemaDefinition((trigger.bounded_sql as string) ?? '') !== normalizeSchemaDefinition(expected.sql)
        );
      })
    ) {
      return false;
    }
    return true;
  },
);

const markSnapshotLeaseRetirementBaton = Effect.fn('codeGraph.markSnapshotLeaseRetirementBaton')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  now: number,
  onlyIfDirty = false,
) {
  // Ordinary pointer displacement retires only disposable dirty overlays.
  // Explicit view removal leaves onlyIfDirty false so its exact clean or dirty
  // target still retires after the final reader releases it.
  const rows = yield* sql.unsafe<BoundedSnapshotLeaseRow & {readonly lease_rowid: unknown}>(
    `SELECT
       CASE WHEN typeof(lease.rowid) = 'integer' AND lease.rowid BETWEEN 1 AND 9007199254740991
         THEN lease.rowid ELSE NULL END AS lease_rowid,
       ${boundedSnapshotLeaseProjection('lease')}
     FROM snapshot_leases AS lease INDEXED BY snapshot_leases_snapshot_expiry
     JOIN snapshots AS snapshot
       ON snapshot.id = lease.snapshot_id
     WHERE lease.snapshot_id = ? AND lease.expires_at > ?
       AND (${onlyIfDirty ? 1 : 0} = 0 OR snapshot.dirty = 1)
     ORDER BY lease.expires_at
     LIMIT 1`,
    [snapshotId, now],
  );
  if (rows.length === 0) return 0;
  const lease = decodeSnapshotLeaseManifest(rows[0]);
  const rowid = rows[0]?.lease_rowid;
  if (
    lease === undefined ||
    lease.snapshotId !== snapshotId ||
    typeof rowid !== 'number' ||
    !Number.isSafeInteger(rowid) ||
    rowid <= 0
  ) {
    return yield* Effect.fail(new CodeGraphStoreError('Code graph snapshot lease baton is invalid.'));
  }
  yield* sql`
    UPDATE snapshot_leases
    SET retire_when_inactive = 1
    WHERE rowid = ${rowid}
  `;
  return yield* lastStatementChangeCount(sql);
});

const ensureRemovedViewCleanupEpoch = Effect.fn('codeGraph.ensureRemovedViewCleanupEpoch')(function* (
  sql: SqlClient.SqlClient,
  worktreeId: string,
  expectedSnapshotId: string,
  updatedAt: string,
  bindNewEpochEvidence: boolean,
  evidence?: CodeGraphRemovedViewCleanupEvidence,
  requireExistingEvidenceMatch = false,
) {
  const existing = yield* selectRemovedViewCleanupEntry(sql, worktreeId, expectedSnapshotId);
  if (existing !== undefined) {
    if (existing.removedAt !== updatedAt) {
      yield* sql`
        DELETE FROM removed_view_cleanup
        WHERE worktree_id = ${worktreeId}
          AND expected_snapshot_id = ${expectedSnapshotId}
          AND removed_at = ${existing.removedAt}
          AND epoch = ${existing.epoch}
          AND revision = ${existing.revision}
      `;
      if ((yield* lastStatementChangeCount(sql)) !== 1) {
        return yield* Effect.fail(new CodeGraphStoreError('Code graph removed view cleanup epoch changed.'));
      }
    } else {
      if (
        (bindNewEpochEvidence || requireExistingEvidenceMatch) &&
        existing.repositoryId !== undefined &&
        evidence !== undefined &&
        (existing.repositoryId !== evidence.repositoryId ||
          existing.provenanceRecordDigest !== evidence.recordDigest ||
          existing.provenanceRecordIdentity !== evidence.recordIdentity)
      ) {
        return yield* Effect.fail(new CodeGraphStoreError('Code graph removed view cleanup evidence changed.'));
      }
      // Epoch evidence is immutable. A later retry cannot attach current
      // sidecar evidence to a legacy tombstone that predates that evidence.
      if (!bindNewEpochEvidence) {
        yield* markSnapshotLeaseRetirementBaton(sql, expectedSnapshotId, yield* Clock.currentTimeMillis);
      }
      return;
    }
  }

  const boundEvidence = bindNewEpochEvidence ? evidence : undefined;
  const epoch = yield* allocateRemovedViewCleanupEpoch(sql);
  yield* sql`
    INSERT INTO removed_view_cleanup (
      worktree_id, expected_snapshot_id, removed_at, epoch, repository_id,
      provenance_record_digest, provenance_record_identity,
      phase, cursor_token, revision, attempts, next_attempt_at,
      blocked_code, updated_at
    ) VALUES (
      ${worktreeId}, ${expectedSnapshotId}, ${updatedAt}, ${epoch}, ${boundEvidence?.repositoryId ?? null},
      ${boundEvidence?.recordDigest ?? null}, ${boundEvidence?.recordIdentity ?? null},
      'vector-pointers', NULL, 0, 0, 0, NULL, ${updatedAt}
    )
  `;
  if (!bindNewEpochEvidence) {
    yield* markSnapshotLeaseRetirementBaton(sql, expectedSnapshotId, yield* Clock.currentTimeMillis);
  }
});

function validRemovedViewCleanupUpdate(
  entry: CodeGraphRemovedViewCleanupEntry,
  update: CodeGraphRemovedViewCleanupUpdate,
): boolean {
  const currentPhase = CODE_GRAPH_REMOVED_VIEW_CLEANUP_PHASES.indexOf(entry.phase);
  const nextPhase = CODE_GRAPH_REMOVED_VIEW_CLEANUP_PHASES.indexOf(update.phase);
  const samePhase = nextPhase === currentPhase;
  const advancesPhase = nextPhase === currentPhase + 1;
  const progress =
    samePhase &&
    update.blockedCode === undefined &&
    update.cursorToken !== undefined &&
    update.cursorToken !== entry.cursorToken;
  const deferred = samePhase && update.blockedCode !== undefined;
  return (
    currentPhase >= 0 &&
    currentPhase < CODE_GRAPH_REMOVED_VIEW_CLEANUP_PHASES.length - 1 &&
    (samePhase || advancesPhase) &&
    entry.revision < Number.MAX_SAFE_INTEGER &&
    Number.isSafeInteger(update.attempts) &&
    Number.isSafeInteger(update.nextAttemptAt) &&
    update.nextAttemptAt >= 0 &&
    update.nextAttemptAt <= MAXIMUM_CANONICAL_DATE_MILLISECONDS &&
    (update.cursorToken === undefined || CLEANUP_TOKEN.test(update.cursorToken)) &&
    (update.blockedCode === undefined || validRemovedViewCleanupBlockedCode(update.blockedCode)) &&
    validCanonicalTimestamp(update.updatedAt) &&
    Date.parse(update.updatedAt) >= Date.parse(entry.updatedAt) &&
    ((progress && update.attempts === entry.attempts) ||
      (deferred &&
        entry.attempts < Number.MAX_SAFE_INTEGER &&
        update.attempts === entry.attempts + 1 &&
        update.cursorToken === entry.cursorToken &&
        update.nextAttemptAt > entry.nextAttemptAt) ||
      (advancesPhase &&
        update.attempts === 0 &&
        update.cursorToken === undefined &&
        update.blockedCode === undefined)) &&
    (update.phase !== 'complete' || (update.cursorToken === undefined && update.blockedCode === undefined))
  );
}

/** @internal Bounded keyset page retained for admission query-plan and load regressions. */
export function codeGraphRemovedViewCleanupAdmissionPageStatement(
  cursor: string | undefined,
  boundary: 'after' | 'through',
  requestedLimit = CODE_GRAPH_REMOVED_VIEW_CLEANUP_PAGE_ROWS,
): CodeGraphSqlQueryStatement {
  const limit = Number.isSafeInteger(requestedLimit)
    ? Math.max(1, Math.min(CODE_GRAPH_REMOVED_VIEW_CLEANUP_PAGE_ROWS, requestedLimit))
    : CODE_GRAPH_REMOVED_VIEW_CLEANUP_PAGE_ROWS;
  const predicate =
    cursor === undefined
      ? ''
      : boundary === 'after'
        ? 'WHERE removed.worktree_id > ?'
        : 'WHERE removed.worktree_id <= ?';
  return {
    parameters: cursor === undefined ? [limit] : [cursor, limit],
    text: `SELECT
        CASE WHEN typeof(worktree_id) = 'text' AND length(CAST(worktree_id AS BLOB)) = 64
          THEN worktree_id ELSE NULL END AS worktree_id,
        CASE WHEN typeof(expected_snapshot_id) = 'text'
               AND length(CAST(expected_snapshot_id AS BLOB)) BETWEEN 45 AND 67
          THEN expected_snapshot_id ELSE NULL END AS expected_snapshot_id,
        CASE WHEN typeof(removed_at) = 'text' AND length(CAST(removed_at AS BLOB)) = 24
          THEN removed_at ELSE NULL END AS removed_at
      FROM removed_views AS removed
      ${predicate}
      ORDER BY removed.worktree_id
      LIMIT ?`,
  };
}

/** @internal Indexed due page retained for query-plan and crash-fairness regressions. */
export function codeGraphRemovedViewCleanupDuePageStatement(
  nowMilliseconds: number,
  requestedLimit = CODE_GRAPH_REMOVED_VIEW_CLEANUP_PAGE_ROWS,
): CodeGraphSqlQueryStatement {
  const limit = Number.isSafeInteger(requestedLimit)
    ? Math.max(1, Math.min(CODE_GRAPH_REMOVED_VIEW_CLEANUP_PAGE_ROWS, requestedLimit))
    : CODE_GRAPH_REMOVED_VIEW_CLEANUP_PAGE_ROWS;
  return {
    parameters: [nowMilliseconds, limit],
    text: `SELECT ${REMOVED_VIEW_CLEANUP_BOUNDED_ROW_PROJECTION}
      FROM removed_view_cleanup AS cleanup INDEXED BY removed_view_cleanup_due
      WHERE cleanup.phase <> 'complete' AND cleanup.next_attempt_at <= ?
      ORDER BY cleanup.next_attempt_at, cleanup.worktree_id, cleanup.expected_snapshot_id
      LIMIT ?`,
  };
}

const admitRemovedViewCleanupEpoch = Effect.fn('codeGraph.admitRemovedViewCleanupEpoch')(function* (
  sql: SqlClient.SqlClient,
) {
  const cursorInspection = yield* inspectRemovedViewCleanupAdmissionCursor(sql);
  if (!cursorInspection.current) {
    return yield* Effect.fail(new CodeGraphStoreError('Code graph removed view cleanup admission cursor is invalid.'));
  }
  const cursor = cursorInspection.cursor;
  const selectPage = (boundary: 'after' | 'through', limit: number) => {
    const statement = codeGraphRemovedViewCleanupAdmissionPageStatement(cursor, boundary, limit);
    return sql.unsafe<{
      readonly expected_snapshot_id: unknown;
      readonly removed_at: unknown;
      readonly worktree_id: unknown;
    }>(statement.text, statement.parameters);
  };
  const after = yield* selectPage('after', CODE_GRAPH_REMOVED_VIEW_CLEANUP_PAGE_ROWS);
  const rows =
    cursor === undefined || after.length >= CODE_GRAPH_REMOVED_VIEW_CLEANUP_PAGE_ROWS
      ? after
      : [...after, ...(yield* selectPage('through', CODE_GRAPH_REMOVED_VIEW_CLEANUP_PAGE_ROWS - after.length))];
  const tombstones = rows.map(row => {
    if (
      typeof row.worktree_id !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(row.worktree_id) ||
      typeof row.expected_snapshot_id !== 'string' ||
      !CODE_GRAPH_SNAPSHOT_ID.test(row.expected_snapshot_id) ||
      typeof row.removed_at !== 'string' ||
      !validCanonicalTimestamp(row.removed_at)
    ) {
      return undefined;
    }
    return {
      expectedSnapshotId: row.expected_snapshot_id,
      removedAt: row.removed_at,
      worktreeId: row.worktree_id,
    };
  });
  if (tombstones.some(tombstone => tombstone === undefined)) {
    return yield* Effect.fail(new CodeGraphStoreError('Code graph removed view cleanup admission row is invalid.'));
  }

  let nextCursor = tombstones.at(-1)?.worktreeId;
  for (const tombstone of tombstones as readonly {
    readonly expectedSnapshotId: string;
    readonly removedAt: string;
    readonly worktreeId: string;
  }[]) {
    const existing = yield* selectRemovedViewCleanupEntry(sql, tombstone.worktreeId, tombstone.expectedSnapshotId);
    if (existing !== undefined && existing.removedAt === tombstone.removedAt) continue;
    yield* validateRemovedViewSnapshotAuthority(sql, tombstone.expectedSnapshotId, false);
    yield* ensureRemovedViewCleanupEpoch(
      sql,
      tombstone.worktreeId,
      tombstone.expectedSnapshotId,
      tombstone.removedAt,
      false,
    );
    nextCursor = tombstone.worktreeId;
    break;
  }
  if (nextCursor !== undefined) {
    yield* sql`
      INSERT INTO schema_metadata (key, value)
      VALUES (${REMOVED_VIEW_CLEANUP_ADMISSION_CURSOR_KEY}, ${nextCursor})
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `;
  }
});

const claimRemovedViewCleanupCandidates = Effect.fn('codeGraph.claimRemovedViewCleanupCandidates')(function* (
  sql: SqlClient.SqlClient,
  nowMilliseconds: number,
  requestedLimit: number,
) {
  if (
    !Number.isSafeInteger(nowMilliseconds) ||
    nowMilliseconds < 0 ||
    nowMilliseconds > MAXIMUM_CANONICAL_DATE_MILLISECONDS - CODE_GRAPH_REMOVED_VIEW_CLEANUP_CLAIM_LEASE_MILLISECONDS ||
    !Number.isSafeInteger(requestedLimit) ||
    requestedLimit <= 0
  ) {
    return yield* Effect.fail(new CodeGraphStoreError('Code graph removed view cleanup claim time is invalid.'));
  }
  const nextAttemptAt = nowMilliseconds + CODE_GRAPH_REMOVED_VIEW_CLEANUP_CLAIM_LEASE_MILLISECONDS;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      if (!(yield* codeGraphWorktreeReconciliationSchemaCompatible(sql))) {
        return yield* Effect.fail(new CodeGraphStoreError('Code graph removed view cleanup schema is unavailable.'));
      }
      yield* admitRemovedViewCleanupEpoch(sql);
      const statement = codeGraphRemovedViewCleanupDuePageStatement(nowMilliseconds, requestedLimit);
      const rows = yield* sql.unsafe<RemovedViewCleanupRow>(statement.text, statement.parameters);
      const entries = rows.map(decodeRemovedViewCleanupRow);
      if (
        entries.some(entry => entry === undefined) ||
        entries.some(entry => entry !== undefined && entry.revision >= Number.MAX_SAFE_INTEGER)
      ) {
        return yield* Effect.fail(new CodeGraphStoreError('Code graph removed view cleanup claim row is invalid.'));
      }
      const claimed: CodeGraphRemovedViewCleanupEntry[] = [];
      for (const entry of entries as readonly CodeGraphRemovedViewCleanupEntry[]) {
        const claimedAt = new Date(Math.max(nowMilliseconds, Date.parse(entry.updatedAt))).toISOString();
        yield* sql.unsafe(
          `UPDATE removed_view_cleanup
           SET revision = ?, next_attempt_at = ?, updated_at = ?
           WHERE ${REMOVED_VIEW_CLEANUP_FULL_ENTRY_PREDICATE}`,
          [entry.revision + 1, nextAttemptAt, claimedAt, ...removedViewCleanupEntryCasParameters(entry)],
        );
        if ((yield* lastStatementChangeCount(sql)) !== 1) {
          return yield* Effect.fail(new CodeGraphStoreError('Code graph removed view cleanup claim changed.'));
        }
        claimed.push({...entry, nextAttemptAt, revision: entry.revision + 1, updatedAt: claimedAt});
      }
      return claimed;
    }),
  );
});

const authorizeRemovedViewCleanup = Effect.fn('codeGraph.authorizeRemovedViewCleanup')(function* (
  sql: SqlClient.SqlClient,
  entry: CodeGraphRemovedViewCleanupEntry,
) {
  if (!validRemovedViewCleanupEntry(entry) || entry.phase === 'complete') {
    return yield* Effect.fail(new CodeGraphStoreError('Code graph removed view cleanup candidate is invalid.'));
  }
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      if (!(yield* codeGraphWorktreeReconciliationSchemaCompatible(sql))) {
        return yield* Effect.fail(new CodeGraphStoreError('Code graph removed view cleanup schema is unavailable.'));
      }
      const current = yield* selectRemovedViewCleanupEntry(sql, entry.worktreeId, entry.expectedSnapshotId);
      if (current === undefined || !sameRemovedViewCleanupEntry(current, entry)) return {state: 'stale'} as const;
      const authority = yield* observeRemovedViewCleanupAuthority(sql, entry);
      if (authority.state === 'stale') {
        yield* revokeRemovedViewCleanupEntry(sql, entry);
        return authority;
      }
      if (authority.state !== 'authorized') return authority;
      yield* removeMatchingLegacyCleanupPointer(sql, entry, authority.matchingActivePointer);
      return {entry, state: 'authorized'} as const;
    }),
  );
});

const updateRemovedViewCleanup = Effect.fn('codeGraph.updateRemovedViewCleanup')(function* (
  sql: SqlClient.SqlClient,
  entry: CodeGraphRemovedViewCleanupEntry,
  update: CodeGraphRemovedViewCleanupUpdate,
) {
  if (!validRemovedViewCleanupEntry(entry) || !validRemovedViewCleanupUpdate(entry, update)) {
    return yield* Effect.fail(new CodeGraphStoreError('Code graph removed view cleanup update is invalid.'));
  }
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      if (!(yield* codeGraphWorktreeReconciliationSchemaCompatible(sql))) {
        return yield* Effect.fail(new CodeGraphStoreError('Code graph removed view cleanup schema is unavailable.'));
      }
      const current = yield* selectRemovedViewCleanupEntry(sql, entry.worktreeId, entry.expectedSnapshotId);
      if (current === undefined || !sameRemovedViewCleanupEntry(current, entry)) return {state: 'stale'} as const;
      const authority = yield* observeRemovedViewCleanupAuthority(sql, entry);
      if (authority.state === 'stale') {
        yield* revokeRemovedViewCleanupEntry(sql, entry);
        return authority;
      }
      if (authority.state !== 'authorized') return authority;
      yield* sql.unsafe(
        `UPDATE removed_view_cleanup
         SET phase = ?, cursor_token = ?, revision = ?, attempts = ?,
             next_attempt_at = ?, blocked_code = ?, updated_at = ?
         WHERE ${REMOVED_VIEW_CLEANUP_FULL_ENTRY_PREDICATE}`,
        [
          update.phase,
          update.cursorToken ?? null,
          entry.revision + 1,
          update.attempts,
          update.nextAttemptAt,
          update.blockedCode ?? null,
          update.updatedAt,
          ...removedViewCleanupEntryCasParameters(entry),
        ],
      );
      if ((yield* lastStatementChangeCount(sql)) !== 1) {
        return yield* Effect.fail(new CodeGraphStoreError('Code graph removed view cleanup update changed.'));
      }
      yield* removeMatchingLegacyCleanupPointer(sql, entry, authority.matchingActivePointer);
      const updated = yield* selectRemovedViewCleanupEntry(sql, entry.worktreeId, entry.expectedSnapshotId);
      if (updated === undefined) {
        return yield* Effect.fail(new CodeGraphStoreError('Code graph removed view cleanup update disappeared.'));
      }
      return {entry: updated, state: 'updated'} as const;
    }),
  );
});

export {
  codeGraphWorktreeReconciliationSchemaCompatible,
  markSnapshotLeaseRetirementBaton,
  ensureRemovedViewCleanupEpoch,
  validRemovedViewCleanupUpdate,
  admitRemovedViewCleanupEpoch,
  claimOrphanProvenanceCandidates,
  claimWorktreeReconciliationCandidates,
  observeOrphanProvenanceView,
  claimRemovedViewCleanupCandidates,
  authorizeRemovedViewCleanup,
  updateRemovedViewCleanup,
};
