import {Database} from 'bun:sqlite';
import {it as effectIt} from '@effect/vitest';
import {Clock, Deferred, Effect, Fiber, FileSystem, Path} from 'effect';
import {afterEach, describe, expect, it} from 'vitest';
import {runCodeGraphRepair} from '../../src/code_graph/commands.js';
import {
  codeGraphDoctorCheck,
  diagnoseCodeGraphDatabaseReadOnly,
  repairCodeGraphIndexes,
} from '../../src/code_graph/maintenance.js';
import {codeGraphRepositoryLockPath, codeGraphWorktreeLockPath} from '../../src/code_graph/layout.js';
import {
  CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION,
  CODE_GRAPH_SCHEMA_VERSION,
} from '../../src/code_graph/types.js';
import {CodeGraphStore} from '../../src/code_graph/store.js';
import {captureConsole} from '../../src/effect/console.js';
import {withExclusiveFileLock} from '../../src/effect/file_lock.js';
import type {RuntimeConfig} from '../../src/types.js';
import {join, mkdir, mkdtemp, rm, writeFile} from '../helpers/effect-filesystem.js';
import {runEffect} from '../helpers/effect-runtime.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';

describe('bounded code graph maintenance', () => {
  const homes: string[] = [];

  afterEach(async () => {
    await Promise.all(homes.splice(0).map(home => rm(home, {force: true, recursive: true})));
  });

  it('lets update-time quick repair defer an actively built large store without waiting or opening it', async () => {
    const home = await mkdtemp('threadnote-graph-maintenance-');
    homes.push(home);
    const checkoutId = 'a'.repeat(64);
    const repositoryRoot = join(home, 'indexes', 'code-graph', 'repositories', checkoutId);
    const databasePath = join(repositoryRoot, `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`);
    await mkdir(repositoryRoot, {recursive: true});
    await writeFile(databasePath, 'this file must never be opened while its build lock is active');
    const progress: string[] = [];

    const result = await runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const lockPath = codeGraphWorktreeLockPath(path, home, checkoutId, 'b'.repeat(64));
        const acquired = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const owner = yield* Effect.forkChild(
          withExclusiveFileLock(
            fs,
            lockPath,
            {
              heartbeatIntervalMilliseconds: 20,
              onAcquired: () => Deferred.succeed(acquired, undefined).pipe(Effect.asVoid),
              retryIntervalMilliseconds: 5,
              staleAfterMilliseconds: 100,
              waitTimeoutMilliseconds: 5_000,
            },
            Deferred.await(release),
          ),
        );
        yield* Deferred.await(acquired);
        const startedAt = yield* Clock.currentTimeMillis;
        const summary = yield* repairCodeGraphIndexes(
          home,
          false,
          state => Effect.sync(() => progress.push(`${state.phase}:${state.reason ?? 'none'}`)),
          undefined,
          {mode: 'quick'},
        );
        const elapsedMilliseconds = (yield* Clock.currentTimeMillis) - startedAt;
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(owner);
        return {elapsedMilliseconds, summary};
      }),
    );

    expect(result.elapsedMilliseconds).toBeLessThan(1_000);
    expect(result.summary).toMatchObject({
      databases: 1,
      deferredDatabases: 1,
      discarded: 0,
      removedIncompleteSnapshots: 0,
      removedTemporaryFiles: 0,
    });
    expect(progress).toEqual(['checking:none', 'deferred:active-build']);
    expect(await Bun.file(databasePath).text()).toContain('must never be opened');
  });

  it('recovers an orphaned checkout lock instead of deferring doctor forever', async () => {
    const home = await mkdtemp('threadnote-graph-maintenance-stale-checkout-');
    homes.push(home);
    const checkoutId = 'c'.repeat(64);
    const repositoryRoot = join(home, 'indexes', 'code-graph', 'repositories', checkoutId);
    const databasePath = join(repositoryRoot, `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`);
    await mkdir(repositoryRoot, {recursive: true});
    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
      }),
    );
    const lockPath = await runEffect(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        return codeGraphRepositoryLockPath(path, home, checkoutId);
      }),
    );
    await mkdir(join(lockPath, '..'), {recursive: true});
    await writeFile(
      lockPath,
      `${JSON.stringify({
        processId: 2_147_483_647,
        processStartIdentity: 'orphaned-process-instance',
        token: 'orphaned-checkout-lock',
        version: 1,
      })}\n`,
    );
    const progress: string[] = [];

    const doctor = await runEffect(
      codeGraphDoctorCheck(home, state => Effect.sync(() => progress.push(`${state.phase}:${state.reason ?? 'none'}`))),
    );

    expect(doctor).toMatchObject({status: 'ok'});
    expect(progress).toEqual(['checking:none']);
    await expect(Bun.file(lockPath).exists()).resolves.toBe(false);
  });

  effectIt.effect('reports revision-8 cleanup authority drift as incompatible without mutating it', () =>
    Effect.gen(function* () {
      const cases = [
        {
          mutate: (database: Database) => database.run('DROP TABLE removed_view_cleanup'),
          name: 'missing-table',
        },
        {
          mutate: (database: Database) => {
            database.run('DROP INDEX removed_view_cleanup_due');
            database.run('CREATE INDEX removed_view_cleanup_due ON removed_view_cleanup(phase)');
          },
          name: 'wrong-index',
        },
        {
          mutate: (database: Database) =>
            database.run(
              "UPDATE schema_metadata SET key = 'PERSISTENT_EXTENSION_SCHEMA_REVISION' WHERE key = 'persistent_extension_schema_revision'",
            ),
          name: 'uppercase-revision',
        },
        {
          mutate: (database: Database) =>
            database.run(
              "INSERT INTO schema_metadata (key, value) VALUES ('removed_view_cleanup_admission_cursor', 'invalid')",
            ),
          name: 'malformed-cursor',
        },
      ] as const;
      const store = yield* CodeGraphStore;
      for (const testCase of cases) {
        const home = yield* Effect.promise(() => mkdtemp(`threadnote-graph-health-${testCase.name}-`));
        homes.push(home);
        const databasePath = join(
          home,
          'indexes',
          'code-graph',
          'repositories',
          'f'.repeat(64),
          `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`,
        );
        yield* store.initialize(databasePath);
        const before = yield* Effect.sync(() => {
          const database = new Database(databasePath, {strict: true});
          try {
            testCase.mutate(database);
            return readCleanupHealthSurface(database);
          } finally {
            database.close(false);
          }
        });

        expect((yield* diagnoseCodeGraphDatabaseReadOnly(databasePath, false)).integrity).toBe('incompatible');
        expect(
          yield* Effect.sync(() => {
            const database = new Database(databasePath, {readonly: true, strict: true});
            try {
              return readCleanupHealthSurface(database);
            } finally {
              database.close(false);
            }
          }),
        ).toEqual(before);
      }
    }).pipe(Effect.provide(ApplicationLayer)),
  );

  it('defers deep repair when database diagnosis is unreadable instead of discarding it', async () => {
    const home = await mkdtemp('threadnote-graph-maintenance-unreadable-');
    homes.push(home);
    const checkoutId = 'b'.repeat(64);
    const repositoryRoot = join(home, 'indexes', 'code-graph', 'repositories', checkoutId);
    const databasePath = join(repositoryRoot, `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`);
    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
      }),
    );
    const unreadable = new Database(databasePath, {strict: true});
    try {
      unreadable.exec('ALTER TABLE schema_metadata RENAME TO unreadable_schema_metadata_fixture');
    } finally {
      unreadable.close(false);
    }
    const progress: string[] = [];

    const repair = await runEffect(
      repairCodeGraphIndexes(
        home,
        false,
        state => Effect.sync(() => progress.push(`${state.phase}:${state.reason ?? 'none'}`)),
        undefined,
        {mode: 'deep'},
      ),
    );

    expect(repair).toMatchObject({databases: 1, deferredDatabases: 1, discarded: 0});
    expect(progress).toEqual(['checking:none', 'deferred:unreadable-database']);
    await expect(Bun.file(databasePath).exists()).resolves.toBe(true);
    const preserved = new Database(databasePath, {readonly: true, strict: true});
    try {
      expect(
        preserved
          .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'unreadable_schema_metadata_fixture'")
          .get(),
      ).toEqual({name: 'unreadable_schema_metadata_fixture'});
    } finally {
      preserved.close(false);
    }
  });

  effectIt.effect('reports an interrupted extension revision and never discards the recoverable database', () =>
    Effect.gen(function* () {
      const home = yield* Effect.promise(() => mkdtemp('threadnote-graph-maintenance-extension-revision-'));
      homes.push(home);
      const checkoutId = 'd'.repeat(64);
      const repositoryRoot = join(home, 'indexes', 'code-graph', 'repositories', checkoutId);
      const databasePath = join(repositoryRoot, `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`);
      const store = yield* CodeGraphStore;
      yield* store.initialize(databasePath);
      yield* Effect.sync(() => makeRecoverableInterruptedExtension(databasePath));

      const progress: string[] = [];
      const doctorBefore = yield* codeGraphDoctorCheck(home);
      const repair = yield* repairCodeGraphIndexes(
        home,
        false,
        state => Effect.sync(() => progress.push(`${state.phase}:${state.reason ?? 'none'}`)),
        undefined,
        {mode: 'deep'},
      );

      expect(doctorBefore).toMatchObject({status: 'fail'});
      expect(repair).toMatchObject({databases: 1, deferredDatabases: 1, discarded: 0});
      expect(progress).toEqual(['checking:none', 'deferred:schema-upgrade-on-use']);
      expect(yield* Effect.promise(() => Bun.file(databasePath).exists())).toBe(true);

      yield* store.initialize(databasePath);
      expect(yield* codeGraphDoctorCheck(home)).toMatchObject({status: 'ok'});
    }).pipe(Effect.provide(ApplicationLayer)),
  );

  it('reports exact extension contract drift with a current receipt and preserves the database for self-healing', async () => {
    const home = await mkdtemp('threadnote-graph-maintenance-extension-contract-');
    homes.push(home);
    const checkoutId = 'e'.repeat(64);
    const repositoryRoot = join(home, 'indexes', 'code-graph', 'repositories', checkoutId);
    const databasePath = join(repositoryRoot, `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`);
    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
      }),
    );
    const drifted = new Database(databasePath, {strict: true});
    try {
      drifted.exec('PRAGMA foreign_keys = OFF');
      drifted.exec(`
        DROP TABLE snapshot_build_owners;
        CREATE TABLE snapshot_build_owners (
          snapshot_id TEXT PRIMARY KEY NOT NULL REFERENCES snapshots(id),
          owner_token TEXT NOT NULL,
          claimed_at TEXT NOT NULL
        );
      `);
    } finally {
      drifted.close(false);
    }

    const doctorBefore = await runEffect(codeGraphDoctorCheck(home));
    const repair = await runEffect(repairCodeGraphIndexes(home, false, undefined, undefined, {mode: 'deep'}));

    expect(doctorBefore).toMatchObject({status: 'fail'});
    expect(repair).toMatchObject({databases: 1, deferredDatabases: 1, discarded: 0});
    await expect(Bun.file(databasePath).exists()).resolves.toBe(true);

    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
      }),
    );
    await expect(runEffect(codeGraphDoctorCheck(home))).resolves.toMatchObject({status: 'ok'});
  });

  effectIt.effect('explicitly migrates recoverable schemas without waiting for a graph query', () =>
    Effect.gen(function* () {
      const home = yield* Effect.promise(() => mkdtemp('threadnote-graph-maintenance-explicit-migration-'));
      homes.push(home);
      const checkoutId = 'f'.repeat(64);
      const repositoryRoot = join(home, 'indexes', 'code-graph', 'repositories', checkoutId);
      const databasePath = join(repositoryRoot, `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`);
      const store = yield* CodeGraphStore;
      yield* store.initialize(databasePath);
      yield* Effect.sync(() => makeRecoverableInterruptedExtension(databasePath));

      const previewProgress: string[] = [];
      const preview = yield* repairCodeGraphIndexes(
        home,
        true,
        state => Effect.sync(() => previewProgress.push(state.phase)),
        undefined,
        {migrateSchema: true, mode: 'quick'},
      );
      expect(preview).toMatchObject({deferredDatabases: 0, migratedDatabases: 1});
      expect(previewProgress).toEqual(['checking', 'migrating-schema']);
      expect(yield* codeGraphDoctorCheck(home)).toMatchObject({status: 'fail'});

      const repairProgress: string[] = [];
      const repair = yield* repairCodeGraphIndexes(
        home,
        false,
        state => Effect.sync(() => repairProgress.push(state.phase)),
        undefined,
        {migrateSchema: true, mode: 'quick'},
      );
      expect(repair).toMatchObject({deferredDatabases: 0, migratedDatabases: 1});
      expect(repairProgress).toEqual(['checking', 'migrating-schema']);
      expect(yield* codeGraphDoctorCheck(home)).toMatchObject({status: 'ok'});
    }).pipe(Effect.provide(ApplicationLayer)),
  );

  effectIt.effect('prepares legacy reconciliation indexes before an explicit extension repair', () =>
    Effect.gen(function* () {
      const home = yield* Effect.promise(() => mkdtemp('threadnote-graph-repair-pre-index-revision-7-'));
      homes.push(home);
      const checkoutId = '7'.repeat(64);
      const databasePath = join(
        home,
        'indexes',
        'code-graph',
        'repositories',
        checkoutId,
        `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`,
      );
      const store = yield* CodeGraphStore;
      yield* store.initialize(databasePath);
      yield* Effect.sync(() => makePreReconciliationIndexRevision7(databasePath));

      const progress: string[] = [];
      const repair = yield* repairCodeGraphIndexes(
        home,
        false,
        state => Effect.sync(() => progress.push(state.phase)),
        undefined,
        {migrateSchema: true, mode: 'quick'},
      );

      expect(repair).toMatchObject({deferredDatabases: 0, migratedDatabases: 1});
      expect(progress).toEqual(['checking', 'migrating-schema']);
      expect(yield* codeGraphDoctorCheck(home)).toMatchObject({status: 'ok'});
      expect(
        yield* Effect.sync(() => {
          const database = new Database(databasePath, {readonly: true, strict: true});
          try {
            return {
              indexes: database
                .query(
                  `SELECT name FROM sqlite_master
                   WHERE type = 'index' AND name IN (
                     'active_snapshots_snapshot_worktree',
                     'snapshots_base_state_id',
                     'snapshot_leases_snapshot_expiry'
                   )
                   ORDER BY name`,
                )
                .all(),
              revision: database
                .query("SELECT value FROM schema_metadata WHERE key = 'persistent_extension_schema_revision'")
                .get(),
            };
          } finally {
            database.close(false);
          }
        }),
      ).toEqual({
        indexes: [
          {name: 'active_snapshots_snapshot_worktree'},
          {name: 'snapshot_leases_snapshot_expiry'},
          {name: 'snapshots_base_state_id'},
        ],
        revision: {value: String(CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION)},
      });
    }).pipe(Effect.provide(ApplicationLayer)),
  );

  effectIt.effect('exposes foreground schema migration through graph repair --all', () =>
    Effect.gen(function* () {
      const home = yield* Effect.promise(() => mkdtemp('threadnote-graph-repair-command-'));
      homes.push(home);
      const checkoutId = '1'.repeat(64);
      const databasePath = join(
        home,
        'indexes',
        'code-graph',
        'repositories',
        checkoutId,
        `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`,
      );
      const store = yield* CodeGraphStore;
      yield* store.initialize(databasePath);
      yield* Effect.sync(() => makeRecoverableInterruptedExtension(databasePath));
      const config: RuntimeConfig = {
        account: 'local',
        agentContextHome: home,
        agentId: 'threadnote',
        manifestPath: join(home, 'manifest.yaml'),
        user: 'tester',
      };

      const output = yield* captureConsole(runCodeGraphRepair(config, {all: true, json: true}));

      expect(JSON.parse(output.output)).toMatchObject({
        doctor: {status: 'ok'},
        dryRun: false,
        mode: 'quick',
        summary: {deferredDatabases: 0, migratedDatabases: 1},
        type: 'code-graph-repair',
        version: 1,
      });
      expect(yield* codeGraphDoctorCheck(home)).toMatchObject({status: 'ok'});
    }).pipe(Effect.provide(ApplicationLayer)),
  );
});

function readCleanupHealthSurface(database: Database): {
  readonly metadata: readonly unknown[];
  readonly objects: readonly unknown[];
} {
  return {
    metadata: database
      .query(
        `SELECT key, value
         FROM schema_metadata
         WHERE key COLLATE NOCASE IN (
           'persistent_extension_schema_revision',
           'removed_view_cleanup_admission_cursor',
           'removed_view_cleanup_epoch_sequence'
         )
         ORDER BY key`,
      )
      .all(),
    objects: database
      .query(
        `SELECT name, type, sql
         FROM sqlite_master
         WHERE name LIKE 'removed_view_cleanup%'
            OR name LIKE 'removed_views_cleanup_revoke_%'
         ORDER BY name`,
      )
      .all(),
  };
}

function makeRecoverableInterruptedExtension(databasePath: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database.run('PRAGMA foreign_keys = OFF');
    database.run('BEGIN IMMEDIATE');
    try {
      database.exec(`
        DROP TRIGGER IF EXISTS removed_views_cleanup_revoke_delete;
        DROP TRIGGER IF EXISTS removed_views_cleanup_revoke_insert;
        DROP TRIGGER IF EXISTS removed_views_cleanup_revoke_update;
        DROP TABLE IF EXISTS removed_view_cleanup;
        DROP TABLE IF EXISTS snapshot_build_owner_instances;
        DROP TABLE IF EXISTS building_materialization_batches;
        DELETE FROM schema_metadata
        WHERE key IN (
          'persistent_extension_schema_revision',
          'removed_view_cleanup_admission_cursor',
          'removed_view_cleanup_epoch_sequence'
        );
      `);
      database.run('COMMIT');
    } catch (error) {
      if (database.inTransaction) database.run('ROLLBACK');
      throw error;
    } finally {
      database.run('PRAGMA foreign_keys = ON');
    }
  } finally {
    database.close(false);
  }
}

function makePreReconciliationIndexRevision7(databasePath: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database.run('BEGIN IMMEDIATE');
    try {
      database.exec(`
        DROP TRIGGER removed_views_cleanup_revoke_delete;
        DROP TRIGGER removed_views_cleanup_revoke_insert;
        DROP TRIGGER removed_views_cleanup_revoke_update;
        DROP TABLE removed_view_cleanup;
        DROP INDEX active_snapshots_snapshot_worktree;
        DROP INDEX snapshots_base_state_id;
        DROP INDEX snapshot_leases_snapshot_expiry;
        DELETE FROM schema_metadata
        WHERE key IN ('removed_view_cleanup_admission_cursor', 'removed_view_cleanup_epoch_sequence');
        UPDATE schema_metadata
        SET value = '7'
        WHERE key = 'persistent_extension_schema_revision';
      `);
      database.run('COMMIT');
    } catch (error) {
      if (database.inTransaction) database.run('ROLLBACK');
      throw error;
    }
  } finally {
    database.close(false);
  }
}
