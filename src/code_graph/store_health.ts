import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import {Effect} from 'effect';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import {type CodeGraphDatabaseHealth} from './store_models.js';
import {codeGraphPersistentExtensionSchemaCompatible} from './store_schema_inspection.js';
import {codeGraphRemovedViewCleanupSchemaAdmission} from './store_schema_migration.js';
import {codeGraphWorktreeReconciliationSchemaCompatible} from './store_reconciliation.js';
import {
  CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION,
  CODE_GRAPH_SCHEMA_VERSION,
  type CodeGraphSnapshot,
} from './types.js';

export type CodeGraphDatabaseIntegrity = 'corrupt' | 'incompatible' | 'migration-pending' | 'ok';

/** Oldest released additive extension revision that the current reader can safely serve. */
export const CODE_GRAPH_MINIMUM_BACKGROUND_MIGRATION_REVISION = 6;

export function codeGraphDatabaseIntegrity(input: {
  readonly coreReadSchemaCompatible: boolean;
  readonly integrityOk: boolean;
  readonly persistentExtensionCurrent: boolean;
  readonly persistentExtensionSchemaRevision?: number;
  readonly schemaVersion?: number;
}): CodeGraphDatabaseIntegrity {
  if (input.schemaVersion !== CODE_GRAPH_SCHEMA_VERSION) return 'incompatible';
  if (input.persistentExtensionCurrent) return input.integrityOk ? 'ok' : 'corrupt';
  const revision = input.persistentExtensionSchemaRevision;
  const migrationPending =
    input.coreReadSchemaCompatible &&
    revision !== undefined &&
    Number.isSafeInteger(revision) &&
    revision >= CODE_GRAPH_MINIMUM_BACKGROUND_MIGRATION_REVISION &&
    revision < CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION;
  if (migrationPending) return input.integrityOk ? 'migration-pending' : 'corrupt';
  return 'incompatible';
}

export const diagnoseCodeGraphDatabaseReadOnly = Effect.fn('codeGraph.diagnoseDatabaseReadOnly')(function* (
  databasePath: string,
  deep: boolean,
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe('PRAGMA query_only = ON');
      yield* sql.unsafe(`PRAGMA busy_timeout = ${deep ? 5_000 : 250}`);
      const integrityRows = deep
        ? yield* sql.unsafe<{readonly integrity_check: string}>('PRAGMA integrity_check(10)')
        : [{integrity_check: 'ok'}];
      const schemaRows = yield* sql<{readonly value: string}>`
        SELECT value FROM schema_metadata WHERE key = 'schema_version'
      `;
      const schemaVersion = Number.parseInt(schemaRows[0]?.value ?? '', 10);
      const cleanupAdmission = yield* codeGraphRemovedViewCleanupSchemaAdmission(sql);
      const persistentExtensionSchemaRevision = cleanupAdmission.persistentExtensionSchemaRevision;
      const persistentExtensionCurrent =
        persistentExtensionSchemaRevision === CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION &&
        (yield* codeGraphPersistentExtensionSchemaCompatible(sql)) &&
        cleanupAdmission.current;
      const coreReadSchemaCompatible = yield* codeGraphWorktreeReconciliationSchemaCompatible(
        sql,
        false,
        false,
        false,
        false,
      );
      const stateRows = yield* sql<{readonly count: number; readonly state: CodeGraphSnapshot['state']}>`
        SELECT state, COUNT(*) AS count FROM snapshots GROUP BY state
      `;
      const activeRows = yield* sql<{readonly count: number}>`SELECT COUNT(*) AS count FROM active_snapshots`;
      const cacheRows = deep ? yield* sql<{readonly count: number}>`SELECT COUNT(*) AS count FROM file_blobs` : [];
      const foreignKeyRows = deep ? yield* sql.unsafe('PRAGMA foreign_key_check') : [];
      const counts = new Map(stateRows.map(row => [row.state, Number(row.count)]));
      const integrityOk =
        integrityRows.length === 1 && integrityRows[0]?.integrity_check === 'ok' && foreignKeyRows.length === 0;
      return {
        activeSnapshots: Number(activeRows[0]?.count ?? 0),
        buildingSnapshots: counts.get('building') ?? 0,
        cachedFileBlobs: Number(cacheRows[0]?.count ?? 0),
        failedSnapshots: counts.get('failed') ?? 0,
        foreignKeyViolations: foreignKeyRows.length,
        integrity: codeGraphDatabaseIntegrity({
          coreReadSchemaCompatible,
          integrityOk,
          persistentExtensionCurrent,
          persistentExtensionSchemaRevision,
          schemaVersion: Number.isSafeInteger(schemaVersion) ? schemaVersion : undefined,
        }),
        readySnapshots: counts.get('ready') ?? 0,
        persistentExtensionSchemaRevision,
        schemaVersion: Number.isSafeInteger(schemaVersion) ? schemaVersion : undefined,
      } satisfies CodeGraphDatabaseHealth;
    }).pipe(
      Effect.provide(
        SqliteClient.layer({
          create: false,
          disableWAL: true,
          filename: databasePath,
          readonly: true,
          readwrite: false,
        }),
      ),
    ),
  );
});
