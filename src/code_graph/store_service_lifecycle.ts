import {Effect, Option} from 'effect';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import * as SqlError from 'effect/unstable/sql/SqlError';
import {ensureBoundedCodeGraphFact} from './fact_budget.js';
import {
  type CodeGraphSnapshotPurgeObservationResult,
  type CodeGraphSnapshotPurgeStoreResult,
  type CodeGraphViewObservationResult,
  type CodeGraphViewRemovalResult,
  type CodeGraphViewSnapshotLeaseRetainResult,
  type CodeGraphViewSnapshotLeaseValidationResult,
} from './store_models.js';
import {assertCodeGraphRuntimeSchemaCompatible} from './store_schema_metadata.js';
import {
  CODE_GRAPH_WRITER_MAIN_CACHE_KIB,
  CodeGraphDatabaseSession,
  type CodeGraphDatabaseSessionShape,
  configureConnection,
  configureReadConnection,
  configureSqliteWriterConnection,
  tableExists,
  useDatabase,
  useDatabaseDirect,
  useExistingDatabase,
  useReadOnlyDatabase,
} from './store_session.js';
import {CodeGraphStoreError} from './types.js';
import {storeError} from './store_utilities.js';
import {CodeGraphPromotionCapacityPlanChanged, type CodeGraphActivationLease} from './store_internal_models.js';
import {
  stageActivationFiles,
  stageActivationSymbols,
  stageActivationSymbolTerms,
  stageActivationEdges,
  activationMode,
} from './store_build_core.js';
import {validateViewRemovalTarget, observeActiveView} from './store_reconciliation_core.js';
import {
  cacheCapacityPlanningError,
  prepareFreshFactCacheChunks,
  storeFreshFactRows,
  prepareMaterializedShardCacheChunks,
  writeMaterializedShardCacheRows,
} from './store_cache.js';
import {validatedSnapshotLeaseDuration} from './store_maintenance_core.js';
import {validateSnapshotPurgeInput, observeSnapshotPurge} from './store_cleanup_core.js';
import {
  claimWorktreeReconciliationCandidates,
  claimRemovedViewCleanupCandidates,
  authorizeRemovedViewCleanup,
  updateRemovedViewCleanup,
} from './store_reconciliation.js';
import {preflightRemovedViewCleanupSchema} from './store_schema_migration.js';
import {acquireSnapshotLease, retainViewSnapshotLease, validateViewSnapshotLease} from './store_leases.js';
import {prepareActivationTables} from './store_staging_core.js';
import {initializeSchema} from './store_schema_initialization.js';
import {pruneRetiredSnapshotRowsPage, purgeSelectedSnapshot, removeActiveView} from './store_view_cleanup.js';
import {
  drainCompletedPersistentBuildRows,
  activatePersistedFullSnapshot,
  activateCleanSnapshotAlias,
} from './store_activation_persistent.js';
import {prepareWorktreeReconciliationIndex} from './store_reconciliation_preparation.js';
import {activateStagedSnapshot, activatePersistedIncrementalSnapshot} from './store_activation.js';
import {prepareSnapshotPromotionCapacity} from './store_build_preparation.js';
import {promoteSnapshot} from './store_resolution.js';
import {type CodeGraphStoreRuntime} from './store_runtime.js';
import {type CodeGraphStoreShape} from './store_shape.js';
import {temporaryActivationPublicationCapacity} from './store_temporary_capacity.js';

type CodeGraphStoreLifecycleMethods = Pick<
  CodeGraphStoreShape,
  | 'withSession'
  | 'assertRuntimeSchemaCompatible'
  | 'acquireSnapshotLease'
  | 'retainViewSnapshotLease'
  | 'validateViewSnapshotLease'
  | 'activate'
  | 'activateStaged'
  | 'activateCleanSnapshotAlias'
  | 'cacheFacts'
  | 'cacheMaterializedFileShards'
  | 'promote'
  | 'observeView'
  | 'observeSnapshotPurge'
  | 'claimWorktreeReconciliationCandidates'
  | 'prepareWorktreeReconciliationIndexes'
  | 'removeView'
  | 'purgeSnapshot'
  | 'claimRemovedViewCleanupCandidates'
  | 'authorizeRemovedViewCleanup'
  | 'updateRemovedViewCleanup'
>;

export function makeCodeGraphStoreLifecycleMethods(runtime: CodeGraphStoreRuntime): CodeGraphStoreLifecycleMethods {
  const {
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
  } = runtime;
  return {
    withSession: (databasePath, effect, options) => {
      const detachedCleanupRequest: CodeGraphDatabaseSessionShape['detachedCleanupRequest'] = {
        completedBuild: false,
        completedSnapshotId: undefined,
        routinePhysical: false,
      };
      return useDatabaseDirect(
        databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* options?.readOnly ? configureReadConnection(sql) : configureConnection(sql);
          if (options?.writerLockPath !== undefined) {
            // Keep hot upper B-tree pages resident for the one long-lived
            // indexing writer. Read/query sessions retain SQLite's small
            // default cache, so concurrent agents do not multiply this
            // bounded 64 MiB budget.
            if (options.sqliteWriterTuning) {
              yield* configureSqliteWriterConnection(
                sql,
                options.sqliteWriterTuning,
                'connection',
                options.onSqliteWriterConfigured,
              );
            } else {
              yield* sql.unsafe(`PRAGMA main.cache_size = -${CODE_GRAPH_WRITER_MAIN_CACHE_KIB}`);
            }
          }
          const session = {
            databasePath,
            detachedCleanupRequest,
            schemaInitialized: false,
            sql,
            ...options,
          } satisfies CodeGraphDatabaseSessionShape;
          return yield* Effect.gen(function* () {
            // Indexing sessions identify themselves with the checkout-wide
            // writer lock. Reclaim one bounded page from every completed
            // build table before normal work, then let a best-effort fiber
            // continue. A process killed immediately after the ready CAS
            // therefore self-heals on the next ordinary index without
            // making graph queries pay cleanup latency.
            if (options?.cleanupCompletedBuildRows && (yield* tableExists(sql, 'snapshots'))) {
              yield* preflightRemovedViewCleanupSchema(sql);
              const cleanup = yield* drainCompletedPersistentBuildRows(
                sql,
                undefined,
                write => withWriterGate(databasePath, write),
                1,
              ).pipe(Effect.option);
              if (Option.isSome(cleanup) && cleanup.value.remaining) {
                yield* scheduleCompletedBuildCleanup(databasePath);
              }
            }
            return yield* effect;
          }).pipe(Effect.provideService(CodeGraphDatabaseSession, session));
        }),
        options?.readOnly === true,
      ).pipe(
        Effect.catchTag('SqlError', cause =>
          Effect.fail(storeError('use code graph database session', cause as SqlError.SqlError)),
        ),
        Effect.tap(() =>
          detachedCleanupRequest.completedBuild
            ? startCompletedBuildCleanup(
                databasePath,
                detachedCleanupRequest.completedSnapshotId,
                detachedCleanupRequest.routinePhysical,
                options,
              )
            : detachedCleanupRequest.routinePhysical
              ? startRoutinePhysicalCleanup(databasePath, options)
              : Effect.void,
        ),
      );
    },
    assertRuntimeSchemaCompatible: databasePath =>
      fs.exists(databasePath).pipe(
        Effect.flatMap(exists =>
          exists ? useReadOnlyDatabase(databasePath, assertCodeGraphRuntimeSchemaCompatible()) : Effect.void,
        ),
        Effect.mapError(cause => storeError('check code graph runtime compatibility', cause)),
      ),
    acquireSnapshotLease: (databasePath, snapshotId, durationMilliseconds, options) =>
      Effect.gen(function* () {
        const token = `${system.processId}:${yield* crypto.randomUUIDv4}`;
        const acquired = yield* prepare(databasePath).pipe(
          Effect.andThen(
            withWriterGate(
              databasePath,
              useDatabase(
                databasePath,
                Effect.gen(function* () {
                  const sql = yield* SqlClient.SqlClient;
                  yield* ensureLeaseSchemaInitialized(databasePath, sql);
                  const acquiredToken = yield* acquireSnapshotLease(
                    snapshotId,
                    durationMilliseconds,
                    token,
                    options?.retireWhenInactive === true,
                  );
                  const cleanup = yield* pruneRetiredSnapshotRowsPage();
                  return {cleanup, token: acquiredToken};
                }),
              ),
              options?.waitTimeoutMilliseconds,
            ),
          ),
          Effect.mapError(cause => storeError('acquire code graph snapshot lease', cause)),
        );
        if (acquired.cleanup.remaining) yield* scheduleRoutinePhysicalCleanup(databasePath);
        return acquired.token;
      }).pipe(Effect.mapError(cause => storeError('acquire code graph snapshot lease', cause))),
    retainViewSnapshotLease: (databasePath, worktreeId, snapshotId, durationMilliseconds, options) =>
      Effect.gen(function* () {
        yield* validateViewRemovalTarget(worktreeId, snapshotId);
        const candidateToken = `${system.processId}:${yield* crypto.randomUUIDv4}`;
        return yield* withWriterGate(
          databasePath,
          Effect.gen(function* () {
            // The writer gate also serializes whole-checkout quarantine.
            // Recheck containment only after it is held so a purged store
            // cannot be recreated by SQLite between an outer stat and open.
            if (!(yield* fs.exists(databasePath))) {
              return {
                observation: {expectedSnapshotId: snapshotId, state: 'not-found'},
                state: 'view-unavailable',
              } satisfies CodeGraphViewSnapshotLeaseRetainResult;
            }
            if (Option.isSome(yield* fs.readLink(databasePath).pipe(Effect.option))) {
              return yield* Effect.fail(new CodeGraphStoreError('Code graph database target is a symbolic link.'));
            }
            if ((yield* fs.stat(databasePath)).type !== 'File') {
              return yield* Effect.fail(new CodeGraphStoreError('Code graph database target is not a regular file.'));
            }
            return yield* useDatabase(
              databasePath,
              Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient;
                yield* ensureLeaseSchemaInitialized(databasePath, sql);
                return yield* retainViewSnapshotLease(
                  sql,
                  worktreeId,
                  snapshotId,
                  durationMilliseconds,
                  candidateToken,
                  options,
                );
              }),
            );
          }),
          options?.waitTimeoutMilliseconds,
        );
      }).pipe(Effect.mapError(cause => storeError('retain code graph view snapshot lease', cause))),
    validateViewSnapshotLease: (databasePath, worktreeId, snapshotId, token, minimumRemainingMilliseconds) =>
      Effect.gen(function* () {
        yield* validateViewRemovalTarget(worktreeId, snapshotId);
        if (
          token.length === 0 ||
          token.length > 1_024 ||
          token.includes('\0') ||
          !Number.isSafeInteger(minimumRemainingMilliseconds) ||
          minimumRemainingMilliseconds < 0 ||
          minimumRemainingMilliseconds > 60 * 60_000
        ) {
          return {state: 'invalid'} as const satisfies CodeGraphViewSnapshotLeaseValidationResult;
        }
        if (!(yield* fs.exists(databasePath))) {
          return {state: 'invalid'} as const satisfies CodeGraphViewSnapshotLeaseValidationResult;
        }
        if (Option.isSome(yield* fs.readLink(databasePath).pipe(Effect.option))) {
          return {state: 'invalid'} as const satisfies CodeGraphViewSnapshotLeaseValidationResult;
        }
        if ((yield* fs.stat(databasePath)).type !== 'File') {
          return {state: 'invalid'} as const satisfies CodeGraphViewSnapshotLeaseValidationResult;
        }
        return yield* useDatabaseDirect(
          databasePath,
          validateViewSnapshotLease(worktreeId, snapshotId, token, minimumRemainingMilliseconds),
          true,
        );
      }).pipe(Effect.mapError(cause => storeError('validate code graph view snapshot lease', cause))),
    activate: (databasePath, identity, snapshot, files, symbols, edges) =>
      prepare(databasePath).pipe(
        Effect.andThen(
          withWriterGate(
            databasePath,
            useDatabase(
              databasePath,
              Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient;
                yield* initializeSchema(sql);
                yield* prepareActivationTables(sql);
                yield* stageActivationFiles(sql, files, 'insert');
                yield* stageActivationSymbols(sql, symbols, 'insert');
                yield* stageActivationSymbolTerms(sql, symbols, 'insert');
                yield* stageActivationEdges(sql, edges, 'insert');
                yield* activateStagedSnapshot(sql, identity, snapshot);
              }),
            ),
          ),
        ),
        Effect.mapError(cause => storeError('activate code graph snapshot', cause)),
      ),
    activateStaged: (
      databasePath,
      identity,
      snapshot,
      reusableBaseReceipt,
      promotionLeaseDurationMilliseconds,
      onProgress,
      persistentCapacityProtector,
    ) =>
      Effect.gen(function* () {
        const promotionLease =
          promotionLeaseDurationMilliseconds === undefined
            ? Option.none<CodeGraphActivationLease>()
            : Option.some({
                durationMilliseconds: validatedSnapshotLeaseDuration(promotionLeaseDurationMilliseconds),
                token: `${system.processId}:${yield* crypto.randomUUIDv4}`,
              });
        yield* prepare(databasePath);
        const completedPersistentSnapshot = yield* useDatabase(
          databasePath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const mode = yield* activationMode(sql);
            if (mode?.mode === 'persisted-delta') {
              const publication = withWriterGate(
                databasePath,
                activatePersistedIncrementalSnapshot(
                  sql,
                  identity,
                  snapshot,
                  mode.baseSnapshotId,
                  reusableBaseReceipt,
                  promotionLease,
                  onProgress,
                ),
              );
              const capacity = yield* temporaryPublicationCapacity(sql);
              yield* persistentCapacityProtector ? persistentCapacityProtector(capacity, publication) : publication;
              return undefined;
            }
            if (mode?.mode === 'persisted-full') {
              if (mode.snapshotId !== snapshot.id) {
                return yield* Effect.fail(
                  new CodeGraphStoreError('Persistent full-build activation identity changed.'),
                );
              }
              yield* activatePersistedFullSnapshot(
                sql,
                identity,
                snapshot,
                mode.ownerToken,
                reusableBaseReceipt,
                promotionLease,
                onProgress,
                effect => withWriterGate(databasePath, effect),
                persistentCapacityProtector,
              );
              return snapshot.id;
            }
            const publication = withWriterGate(
              databasePath,
              activateStagedSnapshot(sql, identity, snapshot, reusableBaseReceipt, promotionLease, onProgress),
            );
            const capacity = yield* temporaryPublicationCapacity(sql);
            yield* persistentCapacityProtector ? persistentCapacityProtector(capacity, publication) : publication;
            return undefined;
          }),
        );
        if (completedPersistentSnapshot) {
          yield* scheduleCompletedBuildCleanup(databasePath, completedPersistentSnapshot);
        }
        return Option.map(promotionLease, lease => lease.token);
      }).pipe(Effect.mapError(cause => storeError('activate staged code graph snapshot', cause))),
    activateCleanSnapshotAlias: (databasePath, identity, snapshot, baseSnapshotId) =>
      prepare(databasePath).pipe(
        Effect.andThen(
          useDatabase(
            databasePath,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* ensureSchemaInitialized(databasePath, sql);
              yield* withWriterGate(databasePath, activateCleanSnapshotAlias(sql, identity, snapshot, baseSnapshotId));
            }),
          ),
        ),
        Effect.mapError(cause => storeError('activate clean code graph snapshot alias', cause)),
      ),
    cacheFacts: (databasePath, files, facts, extractorSet, persistentCapacityProtector) =>
      Effect.gen(function* () {
        const chunks = yield* Effect.try({
          catch: cause => cacheCapacityPlanningError('file facts', cause),
          try: () =>
            prepareFreshFactCacheChunks(
              files,
              facts.map(ensureBoundedCodeGraphFact),
              extractorSet,
              new Date().toISOString(),
            ),
        });
        yield* prepare(databasePath);
        yield* useDatabase(
          databasePath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* ensureSchemaInitialized(databasePath, sql);
          }),
        );
        for (const chunk of chunks) {
          yield* persistentCapacityProtector(
            chunk.boundary,
            withWriterGate(
              databasePath,
              useDatabase(
                databasePath,
                Effect.gen(function* () {
                  const sql = yield* SqlClient.SqlClient;
                  yield* sql.withTransaction(storeFreshFactRows(sql, chunk.rows));
                }),
              ),
            ),
          );
        }
      }).pipe(Effect.mapError(cause => storeError('cache code graph file facts', cause))),
    cacheMaterializedFileShards: (
      databasePath,
      files,
      facts,
      extractorSet,
      derivationIdentity,
      persistentCapacityProtector,
    ) =>
      Effect.gen(function* () {
        const chunks = yield* Effect.try({
          catch: cause => cacheCapacityPlanningError('materialized file shards', cause),
          try: () =>
            prepareMaterializedShardCacheChunks(
              files,
              facts.map(ensureBoundedCodeGraphFact),
              extractorSet,
              derivationIdentity,
              new Date().toISOString(),
            ),
        });
        yield* prepare(databasePath);
        yield* useDatabase(
          databasePath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* ensureSchemaInitialized(databasePath, sql);
          }),
        );
        for (const chunk of chunks) {
          yield* writeMaterializedShardCacheRows({
            databasePath,
            persistentCapacityProtector,
            rows: chunk.rows,
            withWriterGate,
          });
        }
      }).pipe(Effect.mapError(cause => storeError('cache materialized code graph file shards', cause))),
    promote: (databasePath, identity, snapshotId, options) =>
      Effect.gen(function* () {
        yield* prepare(databasePath);
        yield* useDatabase(
          databasePath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* ensureSchemaInitialized(databasePath, sql);
          }),
        );
        for (;;) {
          const plan = yield* useDatabase(databasePath, prepareSnapshotPromotionCapacity(identity, snapshotId));
          const transaction = withWriterGate(
            databasePath,
            useDatabase(databasePath, promoteSnapshot(identity, snapshotId, plan)),
            options?.waitTimeoutMilliseconds,
          );
          const attempted = yield* (
            options?.persistentCapacityProtector
              ? options.persistentCapacityProtector(plan.boundary, transaction)
              : transaction
          ).pipe(
            Effect.map(value => ({state: 'completed' as const, value})),
            Effect.catch(error =>
              error instanceof CodeGraphPromotionCapacityPlanChanged
                ? Effect.succeed({state: 'retry' as const})
                : Effect.fail(error),
            ),
          );
          if (attempted.state === 'retry') {
            yield* Effect.yieldNow;
            continue;
          }
          break;
        }
        // A successful promotion can make pre-policy parser and shard
        // cache rows unreachable even when it does not displace a pointer.
        // The detached collector never waits for the writer gate and
        // reclaims at most one physical table page per acquisition.
        yield* scheduleRoutinePhysicalCleanup(databasePath);
      }).pipe(Effect.mapError(cause => storeError('promote code graph snapshot', cause))),
    observeView: (databasePath, worktreeId, expectedSnapshotId) =>
      Effect.gen(function* () {
        yield* validateViewRemovalTarget(worktreeId, expectedSnapshotId);
        if (!(yield* fs.exists(databasePath))) {
          return {expectedSnapshotId, state: 'not-found'} satisfies CodeGraphViewObservationResult;
        }
        if (Option.isSome(yield* fs.readLink(databasePath).pipe(Effect.option))) {
          return yield* Effect.fail(new CodeGraphStoreError('Code graph database target is a symbolic link.'));
        }
        if ((yield* fs.stat(databasePath)).type !== 'File') {
          return yield* Effect.fail(new CodeGraphStoreError('Code graph database target is not a regular file.'));
        }
        return yield* useReadOnlyDatabase(
          databasePath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql.unsafe('PRAGMA busy_timeout = 0');
            return yield* sql.withTransaction(observeActiveView(sql, worktreeId, expectedSnapshotId));
          }),
        );
      }).pipe(Effect.mapError(cause => storeError('observe code graph view', cause))),
    observeSnapshotPurge: (databasePath, snapshotId, nowMilliseconds) =>
      Effect.gen(function* () {
        yield* validateSnapshotPurgeInput(snapshotId, nowMilliseconds);
        if (!(yield* fs.exists(databasePath))) {
          return {snapshotId, state: 'not-found'} satisfies CodeGraphSnapshotPurgeObservationResult;
        }
        if (Option.isSome(yield* fs.readLink(databasePath).pipe(Effect.option))) {
          return yield* Effect.fail(new CodeGraphStoreError('Code graph database target is a symbolic link.'));
        }
        if ((yield* fs.stat(databasePath)).type !== 'File') {
          return yield* Effect.fail(new CodeGraphStoreError('Code graph database target is not a regular file.'));
        }
        return yield* useReadOnlyDatabase(
          databasePath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql.unsafe('PRAGMA busy_timeout = 0');
            return yield* observeSnapshotPurge(sql, snapshotId, nowMilliseconds);
          }),
        );
      }).pipe(Effect.mapError(cause => storeError('observe code graph snapshot purge', cause))),
    claimWorktreeReconciliationCandidates: (databasePath, limit, options) =>
      withWriterGate(
        databasePath,
        Effect.gen(function* () {
          yield* options?.beforeDatabaseOpen?.() ?? Effect.void;
          if (!(yield* fs.exists(databasePath))) return [];
          if (Option.isSome(yield* fs.readLink(databasePath).pipe(Effect.option))) {
            return yield* Effect.fail(new CodeGraphStoreError('Code graph database target is a symbolic link.'));
          }
          if ((yield* fs.stat(databasePath)).type !== 'File') {
            return yield* Effect.fail(new CodeGraphStoreError('Code graph database target is not a regular file.'));
          }
          return yield* useExistingDatabase(
            databasePath,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* sql.unsafe('PRAGMA busy_timeout = 0');
              return yield* claimWorktreeReconciliationCandidates(sql, limit);
            }),
          );
        }),
        options?.waitTimeoutMilliseconds ?? 0,
      ).pipe(Effect.mapError(cause => storeError('claim code graph reconciliation candidates', cause))),
    prepareWorktreeReconciliationIndexes: (databasePath, options) =>
      withWriterGate(
        databasePath,
        Effect.gen(function* () {
          yield* options?.beforeDatabaseOpen?.() ?? Effect.void;
          if (!(yield* fs.exists(databasePath))) {
            return {reason: 'incompatible-schema', state: 'deferred'} as const;
          }
          if (Option.isSome(yield* fs.readLink(databasePath).pipe(Effect.option))) {
            return yield* Effect.fail(new CodeGraphStoreError('Code graph database target is a symbolic link.'));
          }
          if ((yield* fs.stat(databasePath)).type !== 'File') {
            return yield* Effect.fail(new CodeGraphStoreError('Code graph database target is not a regular file.'));
          }
          return yield* useExistingDatabase(
            databasePath,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* sql.unsafe('PRAGMA foreign_keys = ON');
              yield* sql.unsafe('PRAGMA busy_timeout = 0');
              return yield* sql.withTransaction(prepareWorktreeReconciliationIndex(sql));
            }),
          );
        }),
        options?.waitTimeoutMilliseconds ?? 0,
      ).pipe(Effect.mapError(cause => storeError('prepare code graph reconciliation indexes', cause))),
    removeView: (databasePath, worktreeId, expectedSnapshotId, options) =>
      withWriterGate(
        databasePath,
        Effect.gen(function* () {
          yield* options?.beforeDatabaseOpen?.() ?? Effect.void;
          if (!(yield* fs.exists(databasePath))) {
            return {expectedSnapshotId, state: 'not-found'} satisfies CodeGraphViewRemovalResult;
          }
          if (Option.isSome(yield* fs.readLink(databasePath).pipe(Effect.option))) {
            return yield* Effect.fail(new CodeGraphStoreError('Code graph database target is a symbolic link.'));
          }
          if ((yield* fs.stat(databasePath)).type !== 'File') {
            return yield* Effect.fail(new CodeGraphStoreError('Code graph database target is not a regular file.'));
          }
          const remove = Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            if (options?.requireReconciliationSchema === true) {
              yield* sql.unsafe('PRAGMA foreign_keys = ON');
              yield* sql.unsafe('PRAGMA busy_timeout = 0');
            } else {
              yield* initializeSchema(sql);
            }
            return yield* removeActiveView(
              sql,
              worktreeId,
              expectedSnapshotId,
              options?.requireReconciliationSchema === true,
              options?.cleanupEvidence,
            );
          });
          const result = yield* options?.requireReconciliationSchema === true
            ? useExistingDatabase(databasePath, remove)
            : useDatabase(databasePath, remove);
          return result as CodeGraphViewRemovalResult;
        }),
        // View removal is opportunistic foreground maintenance. Never
        // queue it behind a checkout writer unless an internal caller
        // explicitly opts into a bounded wait.
        options?.waitTimeoutMilliseconds ?? 0,
      ).pipe(
        Effect.tap(result =>
          options?.requireReconciliationSchema !== true && 'retiredSnapshots' in result && result.retiredSnapshots > 0
            ? scheduleRoutinePhysicalCleanup(databasePath)
            : Effect.void,
        ),
        Effect.mapError(cause => storeError('remove code graph view', cause)),
      ),
    purgeSnapshot: (databasePath, snapshotId, expectedGraphEvidenceDigest, nowMilliseconds, options) =>
      withWriterGate(
        databasePath,
        Effect.gen(function* () {
          yield* validateSnapshotPurgeInput(snapshotId, nowMilliseconds);
          if (!/^[0-9a-f]{64}$/u.test(expectedGraphEvidenceDigest)) {
            return yield* Effect.fail(new CodeGraphStoreError('Code graph snapshot purge approval is invalid.'));
          }
          yield* options?.beforeDatabaseOpen?.() ?? Effect.void;
          if (!(yield* fs.exists(databasePath))) {
            return {snapshotId, state: 'not-found'} satisfies CodeGraphSnapshotPurgeStoreResult;
          }
          if (Option.isSome(yield* fs.readLink(databasePath).pipe(Effect.option))) {
            return yield* Effect.fail(new CodeGraphStoreError('Code graph database target is a symbolic link.'));
          }
          if ((yield* fs.stat(databasePath)).type !== 'File') {
            return yield* Effect.fail(new CodeGraphStoreError('Code graph database target is not a regular file.'));
          }
          return yield* useExistingDatabase(
            databasePath,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* sql.unsafe('PRAGMA foreign_keys = ON');
              yield* sql.unsafe('PRAGMA busy_timeout = 0');
              return yield* purgeSelectedSnapshot(sql, snapshotId, expectedGraphEvidenceDigest, nowMilliseconds);
            }),
          );
        }),
        options?.waitTimeoutMilliseconds ?? 0,
      ).pipe(Effect.mapError(cause => storeError('purge selected code graph snapshot', cause))),
    claimRemovedViewCleanupCandidates: (databasePath, nowMilliseconds, limit, options) =>
      withWriterGate(
        databasePath,
        Effect.gen(function* () {
          yield* options?.beforeDatabaseOpen?.() ?? Effect.void;
          if (!(yield* fs.exists(databasePath))) return [];
          if (Option.isSome(yield* fs.readLink(databasePath).pipe(Effect.option))) {
            return yield* Effect.fail(new CodeGraphStoreError('Code graph database target is a symbolic link.'));
          }
          if ((yield* fs.stat(databasePath)).type !== 'File') {
            return yield* Effect.fail(new CodeGraphStoreError('Code graph database target is not a regular file.'));
          }
          return yield* useExistingDatabase(
            databasePath,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* sql.unsafe('PRAGMA foreign_keys = ON');
              yield* sql.unsafe('PRAGMA busy_timeout = 0');
              return yield* claimRemovedViewCleanupCandidates(sql, nowMilliseconds, limit);
            }),
          );
        }),
        options?.waitTimeoutMilliseconds ?? 0,
      ).pipe(Effect.mapError(cause => storeError('claim removed code graph view cleanup', cause))),
    authorizeRemovedViewCleanup: (databasePath, entry, options) =>
      withWriterGate(
        databasePath,
        Effect.gen(function* () {
          yield* options?.beforeDatabaseOpen?.() ?? Effect.void;
          if (!(yield* fs.exists(databasePath))) return {state: 'stale'} as const;
          if (Option.isSome(yield* fs.readLink(databasePath).pipe(Effect.option))) {
            return yield* Effect.fail(new CodeGraphStoreError('Code graph database target is a symbolic link.'));
          }
          if ((yield* fs.stat(databasePath)).type !== 'File') {
            return yield* Effect.fail(new CodeGraphStoreError('Code graph database target is not a regular file.'));
          }
          return yield* useExistingDatabase(
            databasePath,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* sql.unsafe('PRAGMA foreign_keys = ON');
              yield* sql.unsafe('PRAGMA busy_timeout = 0');
              return yield* authorizeRemovedViewCleanup(sql, entry);
            }),
          );
        }),
        options?.waitTimeoutMilliseconds ?? 0,
      ).pipe(Effect.mapError(cause => storeError('authorize removed code graph view cleanup', cause))),
    updateRemovedViewCleanup: (databasePath, entry, update, options) =>
      withWriterGate(
        databasePath,
        Effect.gen(function* () {
          yield* options?.beforeDatabaseOpen?.() ?? Effect.void;
          if (!(yield* fs.exists(databasePath))) return {state: 'stale'} as const;
          if (Option.isSome(yield* fs.readLink(databasePath).pipe(Effect.option))) {
            return yield* Effect.fail(new CodeGraphStoreError('Code graph database target is a symbolic link.'));
          }
          if ((yield* fs.stat(databasePath)).type !== 'File') {
            return yield* Effect.fail(new CodeGraphStoreError('Code graph database target is not a regular file.'));
          }
          return yield* useExistingDatabase(
            databasePath,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* sql.unsafe('PRAGMA foreign_keys = ON');
              yield* sql.unsafe('PRAGMA busy_timeout = 0');
              return yield* updateRemovedViewCleanup(sql, entry, update);
            }),
          );
        }),
        options?.waitTimeoutMilliseconds ?? 0,
      ).pipe(Effect.mapError(cause => storeError('update removed code graph view cleanup', cause))),
  } as const;
}

const temporaryPublicationCapacity = Effect.fn('codeGraph.temporaryPublicationCapacity')(function* (
  sql: SqlClient.SqlClient,
) {
  const rows = yield* sql.unsafe<{
    readonly edges: unknown;
    readonly files: unknown;
    readonly lookup_keys: unknown;
    readonly reexports: unknown;
    readonly symbols: unknown;
    readonly terms: unknown;
    readonly workspace_rows: unknown;
  }>(`
    SELECT
      (SELECT COUNT(*) FROM activation_edges) AS edges,
      (SELECT COUNT(*) FROM activation_files) AS files,
      (SELECT COUNT(*) FROM activation_symbol_lookup) AS lookup_keys,
      (SELECT COUNT(*) FROM activation_reexport_provenance) AS reexports,
      (SELECT COUNT(*) FROM activation_symbols) AS symbols,
      (SELECT COUNT(*) FROM activation_symbol_terms) AS terms,
      (SELECT COUNT(*) FROM activation_workspace_scopes)
        + (SELECT COUNT(*) FROM activation_workspace_components)
        + (SELECT COUNT(*) FROM activation_workspace_dependencies) AS workspace_rows
  `);
  const counts = rows[0];
  return temporaryActivationPublicationCapacity({
    edges: Number(counts?.edges ?? Number.NaN),
    files: Number(counts?.files ?? Number.NaN),
    lookupKeys: Number(counts?.lookup_keys ?? Number.NaN),
    reexports: Number(counts?.reexports ?? Number.NaN),
    symbols: Number(counts?.symbols ?? Number.NaN),
    terms: Number(counts?.terms ?? Number.NaN),
    workspaceRows: Number(counts?.workspace_rows ?? Number.NaN),
  });
});
