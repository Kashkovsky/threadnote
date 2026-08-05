import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import {Crypto, Effect, FileSystem, Option, Path} from 'effect';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import type {DoctorCheck} from '../types.js';
import {isFileLockTimeout, withExclusiveFileLock} from '../effect/file_lock.js';
import {
  codeGraphMaintenanceLockPath,
  codeGraphRepositoriesRoot,
  codeGraphRepositoryLockPath,
  codeGraphRepositoryRoot,
} from './layout.js';
import {
  awaitCodeGraphWorktreeBuilds,
  codeGraphRepositoryLockActive,
  codeGraphWorktreeBuildActive,
  withCodeGraphDatabaseWriteLock,
  withCodeGraphMaintenanceIntent,
} from './maintenance_gate.js';
import {
  CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION,
  CodeGraphStore,
  codeGraphPersistentExtensionSchemaCompatible,
  type CodeGraphDatabaseHealth,
} from './store.js';
import {CODE_GRAPH_SCHEMA_VERSION, type CodeGraphSnapshot} from './types.js';
import {BUILTIN_LANGUAGE_PACK_REGISTRY} from './languages/registry.js';

export interface CodeGraphRepairSummary {
  readonly databases: number;
  readonly deferredDatabases: number;
  readonly discarded: number;
  readonly migratedDatabases: number;
  readonly obsoleteStoreBytes: number;
  readonly obsoleteStoreCheckouts: number;
  readonly obsoleteStoreFiles: number;
  readonly removedIncompleteSnapshots: number;
  readonly removedTemporaryFiles: number;
  readonly unsafeObsoleteEntries: number;
}

export interface ObsoleteCodeGraphStoreFile {
  readonly bytes: number;
  readonly checkoutId: string;
  readonly fileName: string;
  readonly kind: 'database' | 'shm' | 'wal';
  readonly path: string;
  readonly schemaVersion: number;
}

export interface ObsoleteCodeGraphStoreCheckout {
  readonly bytes: number;
  readonly checkoutId: string;
  readonly files: readonly ObsoleteCodeGraphStoreFile[];
  readonly versions: readonly number[];
}

export interface ObsoleteCodeGraphStoreInventory {
  readonly bytes: number;
  readonly checkouts: readonly ObsoleteCodeGraphStoreCheckout[];
  readonly fileCount: number;
  readonly unsafeEntryCount: number;
}

export interface ObsoleteCodeGraphStorePurgeSummary {
  readonly bytes: number;
  readonly checkoutId: string;
  readonly dryRun: boolean;
  readonly fileCount: number;
  readonly versions: readonly number[];
}

export interface ObsoleteCodeGraphStorePurgeInterlock {
  readonly beforeVerification?: (inventory: ObsoleteCodeGraphStoreInventory) => Effect.Effect<void>;
}

export interface CodeGraphIndexPurgeSummary {
  readonly checkoutId: string;
  readonly dryRun: boolean;
  readonly existed: boolean;
}

export interface CodeGraphIndexPurgeInterlock {
  readonly beforeRemoval?: () => Effect.Effect<void>;
  readonly beforeVerification?: () => Effect.Effect<void>;
}

interface CodeGraphIndexPurgeTarget {
  readonly dev: number;
  readonly ino: number;
  readonly path: string;
}

export interface CodeGraphRepairCompletion {
  readonly doctorCheck: DoctorCheck;
  readonly summary: CodeGraphRepairSummary;
}

export interface CodeGraphMaintenanceProgress {
  readonly current: number;
  readonly phase:
    'checking' | 'cleaning-snapshots' | 'cleaning-vectors' | 'deferred' | 'discarding' | 'migrating-schema';
  readonly reason?: 'active-build' | 'deep-check-required' | 'schema-upgrade-on-use';
  readonly snapshots?: number;
  readonly total: number;
}

type CodeGraphProgressHandler = (progress: CodeGraphMaintenanceProgress) => Effect.Effect<void, unknown>;
type CodeGraphRepairCompletionHandler<R> = (completion: CodeGraphRepairCompletion) => Effect.Effect<void, unknown, R>;
type CodeGraphQuickCheck =
  {readonly health: CodeGraphDatabaseHealth; readonly state: 'checked'} | {readonly state: 'unreadable'};

const OBSOLETE_GRAPH_FILE_PATTERN = /^graph-v([1-9]\d*)\.sqlite(?:-(wal|shm))?$/;

/**
 * Inventories obsolete checkout-local SQLite artifacts using directory metadata only.
 * It never opens a database or follows a symbolic link outside the checkout root.
 */
export const inspectObsoleteCodeGraphStores = Effect.fn('codeGraph.inspectObsoleteStores')(function* (
  threadnoteHome: string,
  checkoutId?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (checkoutId !== undefined && !/^[0-9a-f]{64}$/.test(checkoutId)) {
    return yield* Effect.fail(new Error('Code graph checkout identity is invalid.'));
  }
  const repositories = codeGraphRepositoriesRoot(path, threadnoteHome);
  if (!(yield* fs.exists(repositories))) return emptyObsoleteInventory();
  if (yield* isSymbolicLink(fs, repositories)) {
    return {...emptyObsoleteInventory(), unsafeEntryCount: 1};
  }
  const repositoriesInfo = yield* fs.stat(repositories).pipe(Effect.option);
  if (repositoriesInfo._tag === 'None' || repositoriesInfo.value.type !== 'Directory') {
    return {...emptyObsoleteInventory(), unsafeEntryCount: 1};
  }
  const repositoriesRoot = yield* fs.realPath(repositories);
  const checkoutIds =
    checkoutId === undefined
      ? (yield* fs.readDirectory(repositories)).filter(value => /^[0-9a-f]{64}$/.test(value)).sort()
      : [checkoutId];
  const checkouts: ObsoleteCodeGraphStoreCheckout[] = [];
  let unsafeEntryCount = 0;
  for (const candidateCheckoutId of checkoutIds) {
    const repositoryRoot = codeGraphRepositoryRoot(path, threadnoteHome, candidateCheckoutId);
    if (!(yield* fs.exists(repositoryRoot))) continue;
    if (yield* isSymbolicLink(fs, repositoryRoot)) {
      unsafeEntryCount += 1;
      continue;
    }
    const repositoryInfo = yield* fs.stat(repositoryRoot).pipe(Effect.option);
    if (repositoryInfo._tag === 'None' || repositoryInfo.value.type !== 'Directory') {
      unsafeEntryCount += 1;
      continue;
    }
    const canonicalRepositoryRoot = yield* fs.realPath(repositoryRoot);
    if (!isContained(path, repositoriesRoot, canonicalRepositoryRoot)) {
      unsafeEntryCount += 1;
      continue;
    }
    const files: ObsoleteCodeGraphStoreFile[] = [];
    for (const fileName of (yield* fs.readDirectory(repositoryRoot)).sort()) {
      const parsed = obsoleteGraphFileName(fileName);
      if (!parsed) continue;
      const candidate = path.join(repositoryRoot, fileName);
      if (yield* isSymbolicLink(fs, candidate)) {
        unsafeEntryCount += 1;
        continue;
      }
      const info = yield* fs.stat(candidate).pipe(Effect.option);
      if (info._tag === 'None' || info.value.type !== 'File') {
        unsafeEntryCount += 1;
        continue;
      }
      const canonical = yield* fs.realPath(candidate).pipe(Effect.option);
      if (
        canonical._tag === 'None' ||
        !isContained(path, canonicalRepositoryRoot, canonical.value) ||
        path.dirname(canonical.value) !== canonicalRepositoryRoot
      ) {
        unsafeEntryCount += 1;
        continue;
      }
      const size = Number(info.value.size);
      if (!Number.isSafeInteger(size) || size < 0) {
        unsafeEntryCount += 1;
        continue;
      }
      files.push({
        bytes: size,
        checkoutId: candidateCheckoutId,
        fileName,
        kind: parsed.kind,
        path: canonical.value,
        schemaVersion: parsed.schemaVersion,
      });
    }
    if (files.length > 0) {
      checkouts.push({
        bytes: files.reduce((total, file) => total + file.bytes, 0),
        checkoutId: candidateCheckoutId,
        files,
        versions: [...new Set(files.map(file => file.schemaVersion))].sort((left, right) => left - right),
      });
    }
  }
  return {
    bytes: checkouts.reduce((total, entry) => total + entry.bytes, 0),
    checkouts,
    fileCount: checkouts.reduce((total, entry) => total + entry.files.length, 0),
    unsafeEntryCount,
  } satisfies ObsoleteCodeGraphStoreInventory;
});

export const codeGraphDoctorCheck = Effect.fn('codeGraph.doctorCheck')(function* (
  threadnoteHome: string,
  onProgress?: CodeGraphProgressHandler,
  precomputed?: DoctorCheck,
) {
  if (precomputed) return precomputed;
  const path = yield* Path.Path;
  const databases = yield* codeGraphDatabasePaths(threadnoteHome);
  const obsolete = yield* inspectObsoleteCodeGraphStores(threadnoteHome);
  if (databases.length === 0) return codeGraphDoctorResult(0, 0, 0, 0, 0, obsolete);
  let ready = 0;
  let deferred = 0;
  let incomplete = 0;
  let unhealthy = 0;
  for (const [index, database] of databases.entries()) {
    yield* onProgress?.({current: index + 1, phase: 'checking', total: databases.length}) ?? Effect.void;
    const repositoryId = path.basename(path.dirname(database));
    if (
      (yield* codeGraphRepositoryLockActive(threadnoteHome, repositoryId)) ||
      (yield* codeGraphWorktreeBuildActive(threadnoteHome, repositoryId))
    ) {
      deferred += 1;
      yield* onProgress?.({
        current: index + 1,
        phase: 'deferred',
        reason: 'active-build',
        total: databases.length,
      }) ?? Effect.void;
      continue;
    }
    const checked = yield* diagnoseCodeGraphDatabaseReadOnly(database, false).pipe(
      Effect.map(health => ({health, state: 'checked'}) as CodeGraphQuickCheck),
      Effect.catch(() => Effect.succeed<CodeGraphQuickCheck>({state: 'unreadable'})),
    );
    const health = checked.state === 'checked' ? checked.health : undefined;
    if (!health || health.integrity !== 'ok') {
      unhealthy += 1;
      continue;
    }
    ready += health.readySnapshots;
    incomplete += health.buildingSnapshots + health.failedSnapshots;
  }
  return codeGraphDoctorResult(databases.length, ready, incomplete, unhealthy, deferred, obsolete);
});

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
      const extensionRevisionRows = yield* sql<{readonly value: string}>`
        SELECT value FROM schema_metadata WHERE key = 'persistent_extension_schema_revision'
      `;
      const schemaVersion = Number.parseInt(schemaRows[0]?.value ?? '', 10);
      const persistentExtensionSchemaRevision = Number.parseInt(extensionRevisionRows[0]?.value ?? '', 10);
      const persistentExtensionCurrent =
        persistentExtensionSchemaRevision === CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION &&
        (yield* codeGraphPersistentExtensionSchemaCompatible(sql));
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
        integrity:
          !Number.isSafeInteger(schemaVersion) ||
          schemaVersion !== CODE_GRAPH_SCHEMA_VERSION ||
          !persistentExtensionCurrent
            ? 'incompatible'
            : integrityOk
              ? 'ok'
              : 'corrupt',
        readySnapshots: counts.get('ready') ?? 0,
        persistentExtensionSchemaRevision: Number.isSafeInteger(persistentExtensionSchemaRevision)
          ? persistentExtensionSchemaRevision
          : undefined,
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

export const repairCodeGraphIndexes = Effect.fn('codeGraph.repairIndexes')(function* <R = never>(
  threadnoteHome: string,
  dryRun: boolean,
  onProgress?: CodeGraphProgressHandler,
  onComplete?: CodeGraphRepairCompletionHandler<R>,
  options: {readonly migrateSchema?: boolean; readonly mode?: 'deep' | 'quick'} = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const store = yield* CodeGraphStore;
  return yield* withExclusiveFileLock(
    fs,
    codeGraphMaintenanceLockPath(path, threadnoteHome),
    CODE_GRAPH_LOCK_OPTIONS,
    withCodeGraphMaintenanceIntent(
      threadnoteHome,
      Effect.gen(function* () {
        const databases = yield* codeGraphDatabasePaths(threadnoteHome);
        const obsoleteBefore = yield* inspectObsoleteCodeGraphStores(threadnoteHome);
        const deep = options.mode !== 'quick';
        let deferredDatabases = 0;
        let discarded = 0;
        let migratedDatabases = 0;
        let removedIncompleteSnapshots = 0;
        let remainingIncompleteSnapshots = 0;
        let removedTemporaryFiles = 0;
        let readySnapshots = 0;
        for (const [index, database] of databases.entries()) {
          const progress = (input: Omit<CodeGraphMaintenanceProgress, 'current' | 'total'>) =>
            onProgress?.({current: index + 1, total: databases.length, ...input}) ?? Effect.void;
          yield* progress({phase: 'checking'});
          const repositoryRoot = path.dirname(database);
          const maintained = yield* withDatabaseLock(
            fs,
            path,
            threadnoteHome,
            database,
            Effect.gen(function* () {
              const decision = yield* store.withSession(
                database,
                Effect.gen(function* () {
                  let diagnosed = deep
                    ? yield* store.diagnose(database).pipe(Effect.option)
                    : yield* diagnoseCodeGraphDatabaseReadOnly(database, false).pipe(Effect.option);
                  if (
                    diagnosed._tag === 'Some' &&
                    diagnosed.value?.schemaVersion === CODE_GRAPH_SCHEMA_VERSION &&
                    diagnosed.value.integrity === 'incompatible'
                  ) {
                    if (options.migrateSchema) {
                      migratedDatabases += 1;
                      yield* progress({phase: 'migrating-schema'});
                      if (dryRun) return 'maintained' as const;
                      yield* store.initialize(database);
                      diagnosed = deep
                        ? yield* store.diagnose(database).pipe(Effect.option)
                        : yield* diagnoseCodeGraphDatabaseReadOnly(database, false).pipe(Effect.option);
                    } else {
                      // Same-version beta databases with a missing revision or an
                      // incompatible extension-table contract are recoverable on the
                      // next ordinary writer open.
                      // Never discard their ready snapshots as if the canonical graph
                      // rows were corrupt merely because this maintenance pass is
                      // deliberately read-only while holding the checkout gate.
                      return 'schema-upgrade-on-use' as const;
                    }
                  }
                  if (diagnosed._tag === 'None' || diagnosed.value?.integrity !== 'ok') {
                    return deep ? ('discard' as const) : ('deep-check-required' as const);
                  }
                  const incomplete = diagnosed.value.buildingSnapshots + diagnosed.value.failedSnapshots;
                  readySnapshots += diagnosed.value.readySnapshots;
                  if (!deep && incomplete > 0) return 'deep-check-required' as const;
                  if (!deep) return 'maintained' as const;
                  if (incomplete > 0) {
                    yield* progress({phase: 'cleaning-snapshots', snapshots: incomplete});
                    const repaired = yield* store.repair(database, dryRun);
                    const removed = repaired?.removedSnapshots ?? 0;
                    removedIncompleteSnapshots += removed;
                    remainingIncompleteSnapshots += Math.max(0, incomplete - removed);
                  }
                  // Build-time cache GC can delete parser facts belonging to another
                  // linked worktree before that worktree activates its snapshot. This
                  // path owns the global maintenance intent and has drained every
                  // checkout worktree lock, so it is the safe place to collect them.
                  if (!dryRun) {
                    yield* store.pruneRetiredSnapshots(database);
                    yield* store.pruneCachedFacts(database, BUILTIN_LANGUAGE_PACK_REGISTRY.cacheIdentities);
                  }
                  yield* progress({phase: 'cleaning-vectors'});
                  removedTemporaryFiles += yield* cleanTemporaryVectorFiles(
                    fs,
                    path,
                    path.join(repositoryRoot, 'vectors'),
                    dryRun,
                  );
                  return 'maintained' as const;
                }),
                {writerGateHeld: true},
              );
              if (decision !== 'discard') return decision;

              // The session-scoped SqliteClient has finalized before this branch.
              // Keep the repository and database writer gates held while closing
              // the handle first, otherwise Windows rejects recursive deletion of
              // the incompatible SQLite store with a sharing violation.
              discarded += 1;
              yield* progress({phase: 'discarding'});
              if (!dryRun) yield* fs.remove(repositoryRoot, {force: true, recursive: true});
              return 'maintained' as const;
            }),
            0,
          ).pipe(
            Effect.catch(cause =>
              isFileLockTimeout(cause) ? Effect.succeed('active-build' as const) : Effect.fail(cause),
            ),
          );
          if (maintained !== 'maintained') {
            deferredDatabases += 1;
            yield* progress({
              phase: 'deferred',
              reason: maintained,
            });
          }
        }
        const currentDatabases = yield* codeGraphDatabasePaths(threadnoteHome);
        const obsolete = dryRun ? obsoleteBefore : yield* inspectObsoleteCodeGraphStores(threadnoteHome);
        const summary = {
          databases: databases.length,
          deferredDatabases,
          discarded,
          migratedDatabases,
          obsoleteStoreBytes: obsolete.bytes,
          obsoleteStoreCheckouts: obsolete.checkouts.length,
          obsoleteStoreFiles: obsolete.fileCount,
          removedIncompleteSnapshots,
          removedTemporaryFiles,
          unsafeObsoleteEntries: obsolete.unsafeEntryCount,
        } satisfies CodeGraphRepairSummary;
        yield* onComplete?.({
          doctorCheck: codeGraphDoctorResult(
            currentDatabases.length,
            readySnapshots,
            dryRun ? removedIncompleteSnapshots + remainingIncompleteSnapshots : remainingIncompleteSnapshots,
            dryRun ? discarded + migratedDatabases : 0,
            deferredDatabases,
            obsolete,
          ),
          summary,
        }) ?? Effect.void;
        return summary;
      }),
    ),
  );
});

function codeGraphDoctorResult(
  databases: number,
  readySnapshots: number,
  incompleteSnapshots: number,
  unhealthyDatabases: number,
  deferredDatabases = 0,
  obsolete = emptyObsoleteInventory(),
): DoctorCheck {
  if (databases === 0 && obsolete.fileCount === 0 && obsolete.unsafeEntryCount === 0) {
    return {
      detail: 'no repository graph built yet; `threadnote graph query` builds one lazily',
      name: 'native code graph',
      status: 'ok',
    };
  }
  return {
    detail:
      `${databases} database(s); ${readySnapshots} ready snapshot(s); ${incompleteSnapshots} incomplete snapshot(s)` +
      (unhealthyDatabases > 0 ? `; ${unhealthyDatabases} database(s) need a disposable rebuild` : '') +
      (deferredDatabases > 0 ? `; ${deferredDatabases} database maintenance check(s) deferred` : '') +
      (obsolete.fileCount > 0
        ? `; ${obsolete.fileCount} obsolete store file(s), ${obsolete.bytes} byte(s), across ${obsolete.checkouts.length} checkout(s); run \`threadnote graph purge --obsolete\``
        : '') +
      (obsolete.unsafeEntryCount > 0
        ? `; ${obsolete.unsafeEntryCount} unsafe obsolete-shaped filesystem entry/entries require manual review`
        : ''),
    name: 'native code graph',
    status:
      unhealthyDatabases > 0 || obsolete.unsafeEntryCount > 0
        ? 'fail'
        : incompleteSnapshots > 0 || deferredDatabases > 0 || obsolete.fileCount > 0
          ? 'warn'
          : 'ok',
  };
}

export const codeGraphDatabasePaths = Effect.fn('codeGraph.databasePaths')(function* (threadnoteHome: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repositories = codeGraphRepositoriesRoot(path, threadnoteHome);
  if ((yield* fs.readLink(repositories).pipe(Effect.option))._tag === 'Some') return [];
  if (!(yield* fs.exists(repositories))) return [];
  const output: string[] = [];
  for (const repositoryId of yield* fs.readDirectory(repositories)) {
    if (!/^[0-9a-f]{64}$/.test(repositoryId)) continue;
    const repositoryRoot = path.join(repositories, repositoryId);
    if ((yield* fs.readLink(repositoryRoot).pipe(Effect.option))._tag === 'Some') continue;
    const repositoryInfo = yield* fs.stat(repositoryRoot).pipe(Effect.option);
    if (repositoryInfo._tag === 'None' || repositoryInfo.value.type !== 'Directory') continue;
    const database = path.join(repositoryRoot, `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`);
    if ((yield* fs.readLink(database).pipe(Effect.option))._tag === 'Some') continue;
    const databaseInfo = yield* fs.stat(database).pipe(Effect.option);
    if (databaseInfo._tag === 'Some' && databaseInfo.value.type === 'File') output.push(database);
  }
  return output.sort();
});

/**
 * Explicitly removes only older schema-version SQLite artifacts from one checkout.
 * Both maintenance and checkout locks are attempted once; an active build or repair
 * causes an immediate failure rather than a surprising wait.
 */
export const purgeObsoleteCodeGraphStores = Effect.fn('codeGraph.purgeObsoleteStores')(function* (
  threadnoteHome: string,
  checkoutId: string,
  options: {
    readonly dryRun: boolean;
    readonly interlock?: ObsoleteCodeGraphStorePurgeInterlock;
  },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!/^[0-9a-f]{64}$/.test(checkoutId)) {
    return yield* Effect.fail(new Error('Code graph checkout identity is invalid.'));
  }
  return yield* withExclusiveFileLock(
    fs,
    codeGraphMaintenanceLockPath(path, threadnoteHome),
    CODE_GRAPH_PURGE_LOCK_OPTIONS,
    withCodeGraphMaintenanceIntent(
      threadnoteHome,
      withExclusiveFileLock(
        fs,
        codeGraphRepositoryLockPath(path, threadnoteHome, checkoutId),
        CODE_GRAPH_PURGE_LOCK_OPTIONS,
        Effect.gen(function* () {
          yield* awaitCodeGraphWorktreeBuilds(threadnoteHome, checkoutId, 0);
          return yield* withCodeGraphDatabaseWriteLock(
            threadnoteHome,
            checkoutId,
            Effect.gen(function* () {
              const initial = yield* inspectObsoleteCodeGraphStores(threadnoteHome, checkoutId);
              yield* refuseUnsafeObsoleteInventory(initial);
              yield* options.interlock?.beforeVerification?.(initial) ?? Effect.void;
              const verified = yield* inspectObsoleteCodeGraphStores(threadnoteHome, checkoutId);
              yield* refuseUnsafeObsoleteInventory(verified);
              const checkout = verified.checkouts.find(entry => entry.checkoutId === checkoutId);
              const files = checkout?.files ?? [];
              if (!options.dryRun) {
                for (const file of files) {
                  yield* verifyObsoletePurgeTarget(fs, path, threadnoteHome, checkoutId, file);
                }
                for (const file of files) yield* fs.remove(file.path);
              }
              return {
                bytes: checkout?.bytes ?? 0,
                checkoutId,
                dryRun: options.dryRun,
                fileCount: files.length,
                versions: checkout?.versions ?? [],
              } satisfies ObsoleteCodeGraphStorePurgeSummary;
            }),
            0,
          );
        }),
      ),
    ),
  );
});

/**
 * Removes one checkout-local disposable graph store without resolving a source worktree.
 * The checkout root is derived from a validated identity, checked twice under all graph
 * maintenance locks, and must remain an immediate non-symbolic-link child of the graph
 * repositories directory.
 */
export const purgeCodeGraphIndex = Effect.fn('codeGraph.purgeIndex')(function* (
  threadnoteHome: string,
  checkoutId: string,
  options: {
    readonly dryRun: boolean;
    readonly interlock?: CodeGraphIndexPurgeInterlock;
    readonly waitTimeoutMilliseconds?: number;
  },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  if (!/^[0-9a-f]{64}$/.test(checkoutId)) {
    return yield* Effect.fail(new Error('Code graph checkout identity is invalid.'));
  }
  const waitTimeoutMilliseconds = options.waitTimeoutMilliseconds ?? 0;
  const lockOptions = {...CODE_GRAPH_PURGE_LOCK_OPTIONS, waitTimeoutMilliseconds};
  return yield* withExclusiveFileLock(
    fs,
    codeGraphMaintenanceLockPath(path, threadnoteHome),
    lockOptions,
    withCodeGraphMaintenanceIntent(
      threadnoteHome,
      withExclusiveFileLock(
        fs,
        codeGraphRepositoryLockPath(path, threadnoteHome, checkoutId),
        lockOptions,
        Effect.gen(function* () {
          yield* awaitCodeGraphWorktreeBuilds(threadnoteHome, checkoutId, waitTimeoutMilliseconds);
          return yield* withCodeGraphDatabaseWriteLock(
            threadnoteHome,
            checkoutId,
            Effect.gen(function* () {
              const purgeTarget = yield* Effect.scoped(
                Effect.gen(function* () {
                  // Keep the original directory open until it has been moved into quarantine.
                  // POSIX may recycle a deleted directory's inode immediately; the live handle
                  // prevents that replacement from comparing equal to the planned target.
                  const initial = yield* openCodeGraphIndexPurgeTarget(fs, path, threadnoteHome, checkoutId);
                  yield* options.interlock?.beforeVerification?.() ?? Effect.void;
                  const verified = yield* inspectCodeGraphIndexPurgeTarget(fs, path, threadnoteHome, checkoutId);
                  if (!sameCodeGraphIndexPurgeTarget(initial, verified)) {
                    return yield* Effect.fail(new Error('Code graph checkout target changed before purge.'));
                  }
                  if (verified === undefined || options.dryRun) {
                    return {existed: verified !== undefined, quarantine: undefined};
                  }

                  yield* options.interlock?.beforeRemoval?.() ?? Effect.void;
                  const quarantine = path.join(
                    path.dirname(verified.path),
                    `.${checkoutId}.${yield* crypto.randomUUIDv4}.purging`,
                  );
                  yield* fs.rename(verified.path, quarantine);
                  const moved = yield* inspectQuarantinedCodeGraphIndexPurgeTarget(fs, quarantine);
                  if (!sameCodeGraphIndexPurgeTarget(verified, moved)) {
                    yield* restoreQuarantinedCodeGraphIndexPurgeTarget(fs, quarantine, verified.path);
                    return yield* Effect.fail(new Error('Code graph checkout target changed before purge.'));
                  }
                  return {existed: true, quarantine};
                }),
              );
              if (purgeTarget.quarantine !== undefined) {
                // Close the directory handle before recursive deletion for Windows parity.
                yield* fs.remove(purgeTarget.quarantine, {force: true, recursive: true});
              }
              return {
                checkoutId,
                dryRun: options.dryRun,
                existed: purgeTarget.existed,
              } satisfies CodeGraphIndexPurgeSummary;
            }),
            waitTimeoutMilliseconds,
          );
        }),
      ),
    ),
  );
});

export const purgeAllCodeGraphIndexes = Effect.fn('codeGraph.purgeAllIndexes')(function* (threadnoteHome: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repositories = codeGraphRepositoriesRoot(path, threadnoteHome);
  return yield* withExclusiveFileLock(
    fs,
    codeGraphMaintenanceLockPath(path, threadnoteHome),
    CODE_GRAPH_LOCK_OPTIONS,
    withCodeGraphMaintenanceIntent(
      threadnoteHome,
      Effect.gen(function* () {
        if (!(yield* fs.exists(repositories))) return path.dirname(repositories);
        if ((yield* fs.readLink(repositories).pipe(Effect.option))._tag === 'Some') {
          yield* fs.remove(repositories, {force: true});
          return path.dirname(repositories);
        }
        const repositoryIds = (yield* fs.readDirectory(repositories))
          .filter(name => /^[0-9a-f]{64}$/.test(name))
          .sort();
        for (const repositoryId of repositoryIds) {
          const repositoryRoot = path.join(repositories, repositoryId);
          if ((yield* fs.readLink(repositoryRoot).pipe(Effect.option))._tag === 'Some') continue;
          yield* withExclusiveFileLock(
            fs,
            codeGraphRepositoryLockPath(path, threadnoteHome, repositoryId),
            CODE_GRAPH_LOCK_OPTIONS,
            awaitCodeGraphWorktreeBuilds(
              threadnoteHome,
              repositoryId,
              CODE_GRAPH_LOCK_OPTIONS.waitTimeoutMilliseconds,
            ).pipe(
              Effect.andThen(
                withCodeGraphDatabaseWriteLock(
                  threadnoteHome,
                  repositoryId,
                  fs.remove(repositoryRoot, {force: true, recursive: true}),
                ),
              ),
            ),
          );
        }
        const graphRoot = path.dirname(repositories);
        yield* fs.remove(graphRoot, {force: true, recursive: true});
        return graphRoot;
      }),
    ),
  );
});

function cleanTemporaryVectorFiles(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  directory: string,
  dryRun: boolean,
): Effect.Effect<number, unknown> {
  return Effect.gen(function* () {
    if ((yield* fs.readLink(directory).pipe(Effect.option))._tag === 'Some') return 0;
    if (!(yield* fs.exists(directory))) return 0;
    const root = yield* fs.realPath(directory);
    return yield* cleanTemporaryVectorFilesContained(fs, path, root, root, dryRun);
  });
}

function cleanTemporaryVectorFilesContained(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  directory: string,
  dryRun: boolean,
): Effect.Effect<number, unknown> {
  return Effect.gen(function* () {
    let removed = 0;
    for (const name of yield* fs.readDirectory(directory)) {
      const child = path.join(directory, name);
      if ((yield* fs.readLink(child).pipe(Effect.option))._tag === 'Some') continue;
      const canonical = yield* fs.realPath(child).pipe(Effect.option);
      if (canonical._tag === 'None' || !isContained(path, root, canonical.value)) continue;
      const info = yield* fs.stat(child);
      if (info.type === 'Directory') {
        removed += yield* cleanTemporaryVectorFilesContained(fs, path, root, canonical.value, dryRun);
      } else if (info.type === 'File' && (name.endsWith('.tmp') || name.endsWith('.staging'))) {
        removed += 1;
        if (!dryRun) yield* fs.remove(canonical.value, {force: true});
      }
    }
    return removed;
  });
}

function withDatabaseLock<A, E, R>(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  threadnoteHome: string,
  database: string,
  effect: Effect.Effect<A, E, R>,
  waitTimeoutMilliseconds = CODE_GRAPH_LOCK_OPTIONS.waitTimeoutMilliseconds,
) {
  const repositoryId = path.basename(path.dirname(database));
  return withExclusiveFileLock(
    fs,
    codeGraphRepositoryLockPath(path, threadnoteHome, repositoryId),
    {...CODE_GRAPH_LOCK_OPTIONS, waitTimeoutMilliseconds},
    awaitCodeGraphWorktreeBuilds(threadnoteHome, repositoryId, waitTimeoutMilliseconds).pipe(
      Effect.andThen(withCodeGraphDatabaseWriteLock(threadnoteHome, repositoryId, effect, waitTimeoutMilliseconds)),
    ),
  );
}

function obsoleteGraphFileName(
  fileName: string,
): {readonly kind: ObsoleteCodeGraphStoreFile['kind']; readonly schemaVersion: number} | undefined {
  const match = OBSOLETE_GRAPH_FILE_PATTERN.exec(fileName);
  if (!match) return undefined;
  const schemaVersion = Number.parseInt(match[1]!, 10);
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion >= CODE_GRAPH_SCHEMA_VERSION) return undefined;
  return {
    kind: match[2] === 'wal' ? 'wal' : match[2] === 'shm' ? 'shm' : 'database',
    schemaVersion,
  };
}

function emptyObsoleteInventory(): ObsoleteCodeGraphStoreInventory {
  return {bytes: 0, checkouts: [], fileCount: 0, unsafeEntryCount: 0};
}

function openCodeGraphIndexPurgeTarget(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  threadnoteHome: string,
  checkoutId: string,
) {
  return Effect.gen(function* () {
    const planned = yield* inspectCodeGraphIndexPurgeTarget(fs, path, threadnoteHome, checkoutId);
    if (planned === undefined) return undefined;

    const opened = yield* fs.open(planned.path, {flag: 'r'});
    const openedInfo = yield* opened.stat;
    const openedIno = Option.getOrUndefined(openedInfo.ino);
    if (openedInfo.type !== 'Directory' || openedIno === undefined) {
      return yield* Effect.fail(new Error('Refusing code graph purge without stable checkout identity metadata.'));
    }
    const target = {dev: openedInfo.dev, ino: openedIno, path: planned.path} satisfies CodeGraphIndexPurgeTarget;
    const current = yield* inspectCodeGraphIndexPurgeTarget(fs, path, threadnoteHome, checkoutId);
    if (!sameCodeGraphIndexPurgeTarget(target, current)) {
      return yield* Effect.fail(new Error('Code graph checkout target changed before purge.'));
    }
    return target;
  });
}

function inspectCodeGraphIndexPurgeTarget(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  threadnoteHome: string,
  checkoutId: string,
): Effect.Effect<CodeGraphIndexPurgeTarget | undefined, Error | unknown> {
  return Effect.gen(function* () {
    const repositories = codeGraphRepositoriesRoot(path, threadnoteHome);
    if (!(yield* fs.exists(repositories))) return undefined;
    if (yield* isSymbolicLink(fs, repositories)) {
      return yield* Effect.fail(new Error('Refusing code graph purge through a symbolic-link repositories root.'));
    }
    const repositoriesInfo = yield* fs.stat(repositories).pipe(Effect.option);
    if (repositoriesInfo._tag === 'None' || repositoriesInfo.value.type !== 'Directory') {
      return yield* Effect.fail(
        new Error('Refusing code graph purge because the repositories root is not a directory.'),
      );
    }
    const canonicalRepositories = yield* fs.realPath(repositories);
    const repositoryRoot = codeGraphRepositoryRoot(path, threadnoteHome, checkoutId);
    if (!(yield* fs.exists(repositoryRoot))) return undefined;
    if (yield* isSymbolicLink(fs, repositoryRoot)) {
      return yield* Effect.fail(new Error('Refusing code graph purge through a symbolic-link checkout root.'));
    }
    const repositoryInfo = yield* fs.stat(repositoryRoot).pipe(Effect.option);
    if (repositoryInfo._tag === 'None' || repositoryInfo.value.type !== 'Directory') {
      return yield* Effect.fail(new Error('Refusing code graph purge because the checkout root is not a directory.'));
    }
    const canonicalRepository = yield* fs.realPath(repositoryRoot);
    if (
      path.dirname(canonicalRepository) !== canonicalRepositories ||
      path.basename(canonicalRepository) !== checkoutId ||
      !isContained(path, canonicalRepositories, canonicalRepository)
    ) {
      return yield* Effect.fail(new Error('Refusing code graph purge outside the repositories root.'));
    }
    const ino = Option.getOrUndefined(repositoryInfo.value.ino);
    if (ino === undefined) {
      return yield* Effect.fail(new Error('Refusing code graph purge without stable checkout identity metadata.'));
    }
    return {dev: repositoryInfo.value.dev, ino, path: canonicalRepository};
  });
}

function inspectQuarantinedCodeGraphIndexPurgeTarget(
  fs: FileSystem.FileSystem,
  quarantine: string,
): Effect.Effect<CodeGraphIndexPurgeTarget | undefined, never> {
  return Effect.gen(function* () {
    if (yield* isSymbolicLink(fs, quarantine)) return undefined;
    const info = yield* fs.stat(quarantine).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== 'Directory') return undefined;
    const ino = Option.getOrUndefined(info.value.ino);
    return ino === undefined ? undefined : {dev: info.value.dev, ino, path: quarantine};
  }).pipe(Effect.catch(() => Effect.succeed(undefined)));
}

function sameCodeGraphIndexPurgeTarget(
  left: CodeGraphIndexPurgeTarget | undefined,
  right: CodeGraphIndexPurgeTarget | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.dev === right.dev && left.ino === right.ino;
}

function restoreQuarantinedCodeGraphIndexPurgeTarget(
  fs: FileSystem.FileSystem,
  quarantine: string,
  target: string,
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    if (yield* fs.exists(target)) return;
    yield* fs.rename(quarantine, target);
  }).pipe(Effect.catch(() => Effect.void));
}

function isSymbolicLink(fs: FileSystem.FileSystem, candidate: string): Effect.Effect<boolean, never> {
  return fs.readLink(candidate).pipe(
    Effect.option,
    Effect.map(result => result._tag === 'Some'),
  );
}

function refuseUnsafeObsoleteInventory(inventory: ObsoleteCodeGraphStoreInventory): Effect.Effect<void, Error> {
  return inventory.unsafeEntryCount > 0
    ? Effect.fail(
        new Error(
          `Refusing obsolete code graph cleanup: ${inventory.unsafeEntryCount} obsolete-shaped entry/entries are symbolic links, non-files, or outside the checkout root.`,
        ),
      )
    : Effect.void;
}

function verifyObsoletePurgeTarget(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  threadnoteHome: string,
  checkoutId: string,
  file: ObsoleteCodeGraphStoreFile,
): Effect.Effect<void, Error | unknown> {
  return Effect.gen(function* () {
    const parsed = obsoleteGraphFileName(file.fileName);
    if (!parsed || parsed.schemaVersion !== file.schemaVersion || parsed.kind !== file.kind) {
      return yield* Effect.fail(new Error(`Refusing unexpected obsolete graph target ${file.fileName}.`));
    }
    const repositoryRoot = codeGraphRepositoryRoot(path, threadnoteHome, checkoutId);
    if (yield* isSymbolicLink(fs, repositoryRoot)) {
      return yield* Effect.fail(new Error('Refusing obsolete graph cleanup through a symbolic-link checkout root.'));
    }
    const candidate = path.join(repositoryRoot, file.fileName);
    if (yield* isSymbolicLink(fs, candidate)) {
      return yield* Effect.fail(new Error(`Refusing symbolic-link obsolete graph target ${file.fileName}.`));
    }
    const info = yield* fs.stat(candidate).pipe(Effect.option);
    if (info._tag === 'None' || info.value.type !== 'File') {
      return yield* Effect.fail(new Error(`Obsolete graph target changed before cleanup: ${file.fileName}.`));
    }
    const canonicalRoot = yield* fs.realPath(repositoryRoot);
    const canonical = yield* fs.realPath(candidate);
    if (
      canonical !== file.path ||
      path.dirname(canonical) !== canonicalRoot ||
      !isContained(path, canonicalRoot, canonical)
    ) {
      return yield* Effect.fail(new Error(`Obsolete graph target escaped its checkout root: ${file.fileName}.`));
    }
  });
}

function isContained(path: Path.Path, root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

const CODE_GRAPH_LOCK_OPTIONS = {
  retryIntervalMilliseconds: 100,
  staleAfterMilliseconds: 120_000,
  waitTimeoutMilliseconds: 10 * 60_000,
} as const;

const CODE_GRAPH_PURGE_LOCK_OPTIONS = {
  retryIntervalMilliseconds: 1,
  staleAfterMilliseconds: 120_000,
  waitTimeoutMilliseconds: 0,
} as const;
