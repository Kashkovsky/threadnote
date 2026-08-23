import {provideTestLayer} from '../helpers/effect-layer.js';
import {Database} from 'bun:sqlite';
import {it as effectIt} from '@effect/vitest';
import {Effect, Exit, FileSystem, Path} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION, CodeGraphStore} from '../../src/code_graph/store.js';
import {CODE_GRAPH_EXTRACTOR_GENERATION, CODE_GRAPH_SCHEMA_VERSION} from '../../src/code_graph/types.js';
import {
  CODE_GRAPH_SCHEMA_INITIALIZATION_CONTRACT_REVISION,
  CODE_GRAPH_SCHEMA_INITIALIZATION_RECEIPT_TABLE,
  CODE_GRAPH_SQLITE_SCHEMA_VERSION_MAXIMUM,
  CODE_GRAPH_SQLITE_SCHEMA_VERSION_MINIMUM,
  currentCodeGraphSchemaInitializationReceipt,
} from '../../src/code_graph/store_schema_receipt.js';
import {REMOVED_VIEW_CLEANUP_CURRENT_MAXIMUM_METADATA_ROWS} from '../../src/code_graph/store_schema_metadata.js';
import {REMOVED_VIEW_CLEANUP_EPOCH_SEQUENCE_KEY} from '../../src/code_graph/store_removed_view_schema_contracts.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';

describe('code graph schema initialization receipt', () => {
  it('admits only an exact receipt across arbitrary schema-cookie observations', () => {
    fc.assert(
      fc.property(
        fc.integer({max: CODE_GRAPH_SQLITE_SCHEMA_VERSION_MAXIMUM, min: CODE_GRAPH_SQLITE_SCHEMA_VERSION_MINIMUM}),
        fc.integer({max: 1_000, min: 1}),
        fc.integer({max: 1_000, min: 0}),
        fc.boolean(),
        (sqliteSchemaVersion, increment, extractorIncrement, cleanupCursorRecorded) => {
          const current = {
            metadataCoreSchemaVersion: CODE_GRAPH_SCHEMA_VERSION,
            metadataMinimumExtractorGeneration: CODE_GRAPH_EXTRACTOR_GENERATION + extractorIncrement,
            metadataPersistentExtensionRevision: CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION,
            metadataRemovedViewCleanupCursorCurrent: true,
            metadataRemovedViewCleanupCursorRecorded: cleanupCursorRecorded,
            metadataRemovedViewCleanupEpochCurrent: true,
            metadataRowCount: REMOVED_VIEW_CLEANUP_CURRENT_MAXIMUM_METADATA_ROWS - (cleanupCursorRecorded ? 0 : 1),
            observedSqliteSchemaVersion: sqliteSchemaVersion,
            receiptContractRevision: CODE_GRAPH_SCHEMA_INITIALIZATION_CONTRACT_REVISION,
            receiptCoreSchemaVersion: CODE_GRAPH_SCHEMA_VERSION,
            receiptPersistentExtensionRevision: CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION,
            receiptSqliteSchemaVersion: sqliteSchemaVersion,
          };
          expect(currentCodeGraphSchemaInitializationReceipt(current)).toBe(true);
          for (const drifted of [
            {...current, metadataCoreSchemaVersion: current.metadataCoreSchemaVersion + increment},
            {
              ...current,
              metadataPersistentExtensionRevision: current.metadataPersistentExtensionRevision + increment,
            },
            {...current, metadataMinimumExtractorGeneration: CODE_GRAPH_EXTRACTOR_GENERATION - 1},
            {...current, metadataRemovedViewCleanupCursorCurrent: false},
            {...current, metadataRemovedViewCleanupEpochCurrent: false},
            {...current, metadataRowCount: current.metadataRowCount + 1},
            {...current, observedSqliteSchemaVersion: current.observedSqliteSchemaVersion + increment},
            {...current, receiptContractRevision: current.receiptContractRevision + increment},
            {...current, receiptCoreSchemaVersion: current.receiptCoreSchemaVersion + increment},
            {
              ...current,
              receiptPersistentExtensionRevision: current.receiptPersistentExtensionRevision + increment,
            },
            {...current, receiptSqliteSchemaVersion: current.receiptSqliteSchemaVersion + increment},
          ]) {
            expect(currentCodeGraphSchemaInitializationReceipt(drifted)).toBe(false);
          }
        },
      ),
      {numRuns: 150},
    );
  });

  effectIt.effect('skips validated no-op DDL and falls back after a persistent schema-cookie change', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const store = yield* CodeGraphStore;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-schema-receipt-'});
        const databasePath = path.join(root, 'graph.sqlite');
        const writerLockPath = path.join(root, 'writer.lock');

        yield* store.initialize(databasePath);
        yield* useWritableDatabase(databasePath, database => {
          database.exec('CREATE TABLE schema_initialization_test_marker (value INTEGER NOT NULL)');
        });

        // The marker changes main.schema_version, so this pass must replay full
        // validation once and bind a fresh receipt to the new cookie.
        yield* store.withSession(databasePath, store.initialize(databasePath), {
          cleanupCompletedBuildRows: true,
          writerLockPath,
        });

        const observer = yield* Effect.acquireRelease(
          Effect.sync(() => new Database(databasePath, {readonly: true, strict: true})),
          database => Effect.sync(() => database.close(false)),
        );
        const beforeFastPath = dataVersion(observer);

        yield* store.withSession(databasePath, store.initialize(databasePath), {
          cleanupCompletedBuildRows: true,
          writerLockPath,
        });
        expect(dataVersion(observer)).toBe(beforeFastPath);

        yield* useWritableDatabase(databasePath, database => {
          database.exec('DROP INDEX edges_source');
        });
        const beforeRepair = dataVersion(observer);

        // Required-index DDL drift advances the cookie. The next process/session
        // must use the full path, repair it, and publish a new exact receipt.
        yield* store.withSession(databasePath, store.initialize(databasePath), {
          cleanupCompletedBuildRows: true,
          writerLockPath,
        });
        expect(dataVersion(observer)).not.toBe(beforeRepair);
        yield* useReadonlyDatabase(databasePath, database => {
          const schemaVersion = database
            .query<{readonly schema_version: number}, []>('PRAGMA main.schema_version')
            .get()?.schema_version;
          expect(database.query("SELECT type FROM sqlite_master WHERE name = 'edges_source'").get()).toEqual({
            type: 'index',
          });
          expect(
            database.query(`SELECT sqlite_schema_version FROM ${CODE_GRAPH_SCHEMA_INITIALIZATION_RECEIPT_TABLE}`).get(),
          ).toEqual({sqlite_schema_version: schemaVersion});
        });
      }).pipe(provideTestLayer(ApplicationLayer)),
    ),
  );

  effectIt.effect('never lets a receipt bypass mutable cleanup-authority corruption', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const store = yield* CodeGraphStore;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-schema-receipt-corrupt-'});
        const databasePath = path.join(root, 'graph.sqlite');
        const writerLockPath = path.join(root, 'writer.lock');

        yield* store.initialize(databasePath);
        yield* useWritableDatabase(databasePath, database => {
          database
            .query('UPDATE schema_metadata SET value = ? WHERE key = ?')
            .run('malformed', REMOVED_VIEW_CLEANUP_EPOCH_SEQUENCE_KEY);
        });

        const exit = yield* store
          .withSession(databasePath, store.initialize(databasePath), {
            cleanupCompletedBuildRows: true,
            writerLockPath,
          })
          .pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        yield* useReadonlyDatabase(databasePath, database => {
          expect(
            database
              .query('SELECT value FROM schema_metadata WHERE key = ?')
              .get(REMOVED_VIEW_CLEANUP_EPOCH_SEQUENCE_KEY),
          ).toEqual({value: 'malformed'});
        });
      }).pipe(provideTestLayer(ApplicationLayer)),
    ),
  );

  effectIt.effect('fails closed on a drifted receipt definition before schema repair', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const store = yield* CodeGraphStore;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-schema-receipt-drift-'});
        const databasePath = path.join(root, 'graph.sqlite');

        yield* store.initialize(databasePath);
        yield* useWritableDatabase(databasePath, database => {
          database.exec(`
            DROP TABLE ${CODE_GRAPH_SCHEMA_INITIALIZATION_RECEIPT_TABLE};
            CREATE TABLE ${CODE_GRAPH_SCHEMA_INITIALIZATION_RECEIPT_TABLE} (
              singleton INTEGER PRIMARY KEY,
              incompatible TEXT NOT NULL
            );
          `);
        });

        const exit = yield* store.initialize(databasePath).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        yield* useReadonlyDatabase(databasePath, database => {
          expect(
            database
              .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
              .get(CODE_GRAPH_SCHEMA_INITIALIZATION_RECEIPT_TABLE),
          ).toMatchObject({sql: expect.stringContaining('incompatible TEXT NOT NULL')});
        });
      }).pipe(provideTestLayer(ApplicationLayer)),
    ),
  );
});

function dataVersion(database: Database): number {
  return Number(database.query<{readonly data_version: number}, []>('PRAGMA data_version').get()?.data_version ?? -1);
}

function useWritableDatabase<A>(databasePath: string, use: (database: Database) => A) {
  return Effect.acquireUseRelease(
    Effect.sync(() => new Database(databasePath, {strict: true})),
    database => Effect.sync(() => use(database)),
    database => Effect.sync(() => database.close(false)),
  );
}

function useReadonlyDatabase<A>(databasePath: string, use: (database: Database) => A) {
  return Effect.acquireUseRelease(
    Effect.sync(() => new Database(databasePath, {readonly: true, strict: true})),
    database => Effect.sync(() => use(database)),
    database => Effect.sync(() => database.close(false)),
  );
}
