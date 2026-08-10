import {Crypto, Effect, FileSystem, Option, Path} from 'effect';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import {isFileLockTimeout, withExclusiveFileLock} from '../effect/file_lock.js';
import {SystemInfo} from '../effect/system.js';
import {type CodeGraphDatabaseSessionOptions} from './store_shape.js';
import {
  CODE_GRAPH_CLEANUP_YIELD_MILLISECONDS,
  CODE_GRAPH_DETACHED_CLEANUP_LOCK_OPTIONS,
  CODE_GRAPH_INTERNAL_CLEANUP_FOREGROUND_WAIT_MILLISECONDS,
  CODE_GRAPH_SQL_WRITER_LOCK_OPTIONS,
  CodeGraphDatabaseSession,
  configureConnection,
  configureSqliteWriterConnection,
  inferredCodeGraphWriterLockPath,
  normalizedWriterGateWaitTimeout,
  useDatabaseDirect,
} from './store_session.js';
import {storeError} from './store_utilities.js';
import {initializeSchema} from './store_schema_initialization.js';
import {pruneRoutinePhysicalRowsPage} from './store_routine_cleanup.js';
import {drainCompletedPersistentBuildRows} from './store_activation_persistent.js';
import {initializeRoutineMaintenanceSchema} from './store_leases.js';

export const makeCodeGraphStoreRuntime = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;

  const path = yield* Path.Path;

  const crypto = yield* Crypto.Crypto;

  const system = yield* SystemInfo;

  const scope = yield* Effect.scope;

  const detachedCleanupActive = new Set<string>();

  const scheduleDetachedCleanup = (databasePath: string, cleanup: Effect.Effect<void>) =>
    Effect.gen(function* () {
      // Every detached collector is opportunistic and resumable. Running
      // more than one domain for the same database only adds SQLite
      // sessions and writer contention; a later foreground or maintenance
      // pass will resume whichever bounded domain was coalesced here.
      if (detachedCleanupActive.has(databasePath)) return;
      detachedCleanupActive.add(databasePath);
      const release = Effect.sync(() => detachedCleanupActive.delete(databasePath));
      yield* cleanup.pipe(Effect.ensuring(release), Effect.forkIn(scope));
    }).pipe(Effect.asVoid);

  const prepare = (databasePath: string) =>
    fs
      .makeDirectory(path.dirname(databasePath), {recursive: true, mode: 0o700})
      .pipe(Effect.mapError(cause => storeError('prepare code graph database', cause)));

  const withWriterGate = <A, E, R>(
    databasePath: string,
    effect: Effect.Effect<A, E, R>,
    waitTimeoutMilliseconds?: number,
  ) =>
    Effect.serviceOption(CodeGraphDatabaseSession).pipe(
      Effect.flatMap(session => {
        const options =
          Option.isSome(session) && session.value.databasePath === databasePath ? session.value : undefined;
        if (options?.writerGateHeld) return effect;
        const writerLockPath = options?.writerLockPath ?? inferredCodeGraphWriterLockPath(path, databasePath);
        if (!writerLockPath) return effect;
        const requestedWaitTimeout = normalizedWriterGateWaitTimeout(waitTimeoutMilliseconds);
        const effectiveWaitTimeout =
          requestedWaitTimeout === 0 && detachedCleanupActive.has(databasePath)
            ? CODE_GRAPH_INTERNAL_CLEANUP_FOREGROUND_WAIT_MILLISECONDS
            : requestedWaitTimeout;
        return withExclusiveFileLock(
          fs,
          writerLockPath,
          {
            ...CODE_GRAPH_SQL_WRITER_LOCK_OPTIONS,
            waitTimeoutMilliseconds: effectiveWaitTimeout,
            onAcquired: () => options?.onWriterAcquired?.() ?? Effect.void,
            onContention: () => options?.onWriterContention?.() ?? Effect.void,
          },
          effect,
        ).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(Path.Path, path),
          Effect.provideService(SystemInfo, system),
        );
      }),
    );

  const leaseSchemasInitialized = new Set<string>();

  const ensureLeaseSchemaInitialized = (databasePath: string, sql: SqlClient.SqlClient) => {
    if (leaseSchemasInitialized.has(databasePath)) return Effect.void;
    return initializeRoutineMaintenanceSchema(sql).pipe(
      Effect.flatMap(ready => (ready ? Effect.void : initializeSchema(sql))),
      Effect.tap(() =>
        Effect.sync(() => {
          leaseSchemasInitialized.add(databasePath);
        }),
      ),
    );
  };

  const ensureSchemaInitialized = (databasePath: string, sql: SqlClient.SqlClient, waitTimeoutMilliseconds?: number) =>
    Effect.gen(function* () {
      const session = yield* Effect.serviceOption(CodeGraphDatabaseSession);
      const matching =
        Option.isSome(session) && session.value.databasePath === databasePath ? session.value : undefined;
      if (matching?.schemaInitialized) return;
      yield* withWriterGate(databasePath, initializeSchema(sql), waitTimeoutMilliseconds);
      if (matching?.sqliteWriterTuning) {
        yield* configureSqliteWriterConnection(
          sql,
          matching.sqliteWriterTuning,
          'connection',
          matching.onSqliteWriterConfigured,
        );
      }
      if (matching) matching.schemaInitialized = true;
    });

  const startCompletedBuildCleanup = (
    databasePath: string,
    snapshotId: string | undefined,
    includeRoutinePhysical: boolean,
    options: CodeGraphDatabaseSessionOptions | undefined,
  ) =>
    Effect.gen(function* () {
      const writerLockPath = options?.writerLockPath ?? inferredCodeGraphWriterLockPath(path, databasePath);
      let completedBuildRemaining = true;
      const cleanupSweep = Effect.gen(function* () {
        // Purge owns the same gate before deleting the repository root. Check
        // existence only after acquiring it, and open SQLite inside the same
        // critical section, so a detached cleanup fiber cannot retain a
        // Windows file handle or recreate a database after purge.
        if (!(yield* fs.exists(databasePath))) return {deleted: 0, remaining: false};
        return yield* useDatabaseDirect(
          databasePath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* configureConnection(sql);
            let deleted = 0;
            if (completedBuildRemaining) {
              yield* options?.onCompletedBuildCleanupConnection?.() ?? Effect.void;
              const completed = yield* drainCompletedPersistentBuildRows(sql, snapshotId, undefined, 1);
              completedBuildRemaining = completed.remaining;
              deleted += completed.deleted;
              if (completed.remaining || !includeRoutinePhysical) {
                return {deleted, remaining: completed.remaining};
              }
            }
            const routine = yield* pruneRoutinePhysicalRowsPage(sql);
            return {deleted: deleted + routine.deleted, remaining: routine.remaining};
          }),
        );
      });
      const runSweep =
        writerLockPath === undefined
          ? cleanupSweep.pipe(Effect.map(Option.some))
          : withExclusiveFileLock(fs, writerLockPath, CODE_GRAPH_DETACHED_CLEANUP_LOCK_OPTIONS, cleanupSweep).pipe(
              Effect.map(Option.some),
              Effect.catch(error => (isFileLockTimeout(error) ? Effect.succeed(Option.none()) : Effect.fail(error))),
              Effect.provideService(Crypto.Crypto, crypto),
              Effect.provideService(Path.Path, path),
              Effect.provideService(SystemInfo, system),
            );
      const cleanup = Effect.gen(function* () {
        for (;;) {
          const result = yield* runSweep;
          // Detached cleanup is opportunistic. Once a foreground writer
          // contends, stop this fiber and leave the reconstructible rows
          // for the next session or maintenance pass.
          if (Option.isNone(result) || !result.value.remaining) return;
          // Foreground writers poll the checkout gate every 25 ms. Detached
          // cleanup never queues on that gate and waits for two polling
          // windows before another bounded page.
          yield* Effect.sleep(CODE_GRAPH_CLEANUP_YIELD_MILLISECONDS);
        }
      });
      yield* scheduleDetachedCleanup(databasePath, cleanup.pipe(Effect.ignore));
    }).pipe(Effect.asVoid);

  const scheduleCompletedBuildCleanup = (databasePath: string, snapshotId?: string) =>
    Effect.gen(function* () {
      const session = yield* Effect.serviceOption(CodeGraphDatabaseSession);
      const options = Option.isSome(session) && session.value.databasePath === databasePath ? session.value : undefined;
      if (options) {
        const request = options.detachedCleanupRequest;
        if (!request.completedBuild) {
          request.completedBuild = true;
          request.completedSnapshotId = snapshotId;
        } else if (request.completedSnapshotId !== snapshotId) {
          // Different snapshot-specific requests collapse safely to the
          // complete set of unreachable build-only rows.
          request.completedSnapshotId = undefined;
        }
        return;
      }
      yield* startCompletedBuildCleanup(databasePath, snapshotId, false, undefined);
    }).pipe(Effect.asVoid);

  const startRoutinePhysicalCleanup = (databasePath: string, options: CodeGraphDatabaseSessionOptions | undefined) =>
    Effect.gen(function* () {
      const writerLockPath = options?.writerLockPath ?? inferredCodeGraphWriterLockPath(path, databasePath);
      const cleanupSweep = Effect.gen(function* () {
        // Open SQLite only while holding the checkout writer gate. Purge
        // owns the same gate, so a detached collector cannot retain a
        // Windows handle or recreate a database after targeted deletion.
        if (!(yield* fs.exists(databasePath))) return {deleted: 0, remaining: false};
        return yield* useDatabaseDirect(
          databasePath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* configureConnection(sql);
            return yield* pruneRoutinePhysicalRowsPage(sql);
          }),
        );
      });
      const runSweep =
        writerLockPath === undefined
          ? cleanupSweep.pipe(Effect.map(Option.some))
          : withExclusiveFileLock(fs, writerLockPath, CODE_GRAPH_DETACHED_CLEANUP_LOCK_OPTIONS, cleanupSweep).pipe(
              Effect.map(Option.some),
              Effect.catch(error => (isFileLockTimeout(error) ? Effect.succeed(Option.none()) : Effect.fail(error))),
              Effect.provideService(Crypto.Crypto, crypto),
              Effect.provideService(Path.Path, path),
              Effect.provideService(SystemInfo, system),
            );
      const cleanup = Effect.gen(function* () {
        // Pointer publication and lease release stay latency-bounded. Give
        // the foreground operation one polling window to finish before the
        // opportunistic collector attempts its first page.
        yield* Effect.sleep(CODE_GRAPH_CLEANUP_YIELD_MILLISECONDS);
        for (;;) {
          const result = yield* runSweep;
          // This collector is opportunistic and bounded to one table page
          // per writer-gate acquisition. Foreground work always wins; the
          // next lease/index/maintenance pass resumes any remaining rows.
          if (Option.isNone(result) || !result.value.remaining) return;
          yield* Effect.sleep(CODE_GRAPH_CLEANUP_YIELD_MILLISECONDS);
        }
      });
      yield* scheduleDetachedCleanup(databasePath, cleanup.pipe(Effect.ignore));
    }).pipe(Effect.asVoid);

  const scheduleRoutinePhysicalCleanup = (databasePath: string) =>
    Effect.gen(function* () {
      const session = yield* Effect.serviceOption(CodeGraphDatabaseSession);
      const options = Option.isSome(session) && session.value.databasePath === databasePath ? session.value : undefined;
      if (options) {
        options.detachedCleanupRequest.routinePhysical = true;
        return;
      }
      yield* startRoutinePhysicalCleanup(databasePath, undefined);
    }).pipe(Effect.asVoid);
  return {
    withWriterGate,
    scheduleCompletedBuildCleanup,
    startCompletedBuildCleanup,
    startRoutinePhysicalCleanup,
    fs,
    system,
    crypto,
    prepare,
    ensureLeaseSchemaInitialized,
    scheduleRoutinePhysicalCleanup,
    ensureSchemaInitialized,
    scope,
    path,
  } as const;
});

export type CodeGraphStoreRuntime = Effect.Success<typeof makeCodeGraphStoreRuntime>;
