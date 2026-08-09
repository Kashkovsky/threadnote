import {Database} from 'bun:sqlite';
import {Effect, FileSystem, Option, Path} from 'effect';
import {isFileLockTimeout, withExclusiveFileLock} from '../effect/file_lock.js';
import {SystemInfo, type SystemInfoShape} from '../effect/system.js';
import {codeGraphMaintenanceLockPath, codeGraphRepositoryLockPath, codeGraphRepositoryRoot} from './layout.js';
import {
  awaitCodeGraphWorktreeBuilds,
  codeGraphRepositoryLockActive,
  codeGraphWorktreeBuildActive,
  withCodeGraphDatabaseWriteLock,
  withCodeGraphMaintenanceIntent,
} from './maintenance_gate.js';
import {CODE_GRAPH_SCHEMA_VERSION, type CodeGraphSnapshot} from './types.js';

export const CODE_GRAPH_COMPACTION_MIN_RECLAIMABLE_BYTES = 512 * 1024 * 1024;
export const CODE_GRAPH_COMPACTION_MIN_RECLAIMABLE_RATIO = 0.2;
export const CODE_GRAPH_COMPACTION_MIN_SAFETY_MARGIN_BYTES = 512 * 1024 * 1024;
export const CODE_GRAPH_COMPACTION_SAFETY_MARGIN_RATIO = 0.1;
export const CODE_GRAPH_STORAGE_ATTRIBUTION_OBJECT_LIMIT = 128;

export interface CodeGraphStorageThreshold {
  readonly minimumReclaimableBytes: number;
  readonly minimumReclaimableRatio: number;
  readonly recommended: boolean;
}

export interface CodeGraphPageStorage {
  readonly attribution?: CodeGraphStorageAttribution;
  readonly freelistPages: number;
  readonly pageCount: number;
  readonly pageSize: number;
  readonly reclaimableBytes: number;
  readonly reclaimableRatio: number;
  readonly state: 'available';
  readonly threshold: CodeGraphStorageThreshold;
}

export interface CodeGraphStorageObjectAttribution {
  readonly bytes: number;
  readonly kind: 'index' | 'internal' | 'table';
  readonly name: string;
  readonly pages: number;
}

export interface CodeGraphStorageAttribution {
  /** Logical allocated bytes represented by page_count * page_size. */
  readonly allocatedBytes: number;
  /** Bytes assigned by SQLite dbstat to named B-trees. */
  readonly attributedBytes: number;
  readonly freelistBytes: number;
  readonly objectCount: number;
  readonly objects: readonly CodeGraphStorageObjectAttribution[];
  readonly objectsTruncated: boolean;
  readonly state: 'available';
  /** Pointer-map or other pages not assigned to a named B-tree or freelist. */
  readonly unattributedBytes: number;
}

/** @internal Exact remainder after assigning allocated SQLite pages to objects and the freelist. */
export function codeGraphStorageUnattributedBytes(
  allocatedBytes: number,
  attributedBytes: number,
  freelistBytes: number,
): number {
  for (const [label, value] of [
    ['allocated', allocatedBytes],
    ['attributed', attributedBytes],
    ['freelist', freelistBytes],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid SQLite ${label} storage bytes.`);
  }
  if (attributedBytes > allocatedBytes || freelistBytes > allocatedBytes - attributedBytes) {
    throw new Error('SQLite storage attribution exceeds allocated page bytes.');
  }
  return allocatedBytes - attributedBytes - freelistBytes;
}

export interface CodeGraphDeferredPageStorage {
  readonly reason: 'active-build';
  readonly state: 'deferred';
  readonly threshold: Omit<CodeGraphStorageThreshold, 'recommended'>;
}

export interface CodeGraphUnavailablePageStorage {
  readonly reason: 'database-busy-or-unreadable';
  readonly state: 'unavailable';
  readonly threshold: Omit<CodeGraphStorageThreshold, 'recommended'>;
}

export interface CodeGraphActiveStorage {
  readonly checkoutId: string;
  readonly databaseBytes: number;
  readonly databasePath: string;
  readonly pageStorage: CodeGraphDeferredPageStorage | CodeGraphPageStorage | CodeGraphUnavailablePageStorage;
  readonly shmBytes: number;
  readonly state: 'available';
  readonly totalBytes: number;
  readonly walBytes: number;
}

export interface CodeGraphMissingStorage {
  readonly checkoutId: string;
  readonly databasePath: string;
  readonly state: 'missing';
}

export type CodeGraphStorage = CodeGraphActiveStorage | CodeGraphMissingStorage;

export interface CodeGraphCompactionInterlock {
  readonly beforeRevalidation?: (storage: CodeGraphActiveStorage) => Effect.Effect<void>;
}

export interface CodeGraphCompactionSummary {
  readonly action: 'compacted' | 'deferred' | 'missing' | 'not-needed' | 'would-compact';
  readonly after?: CodeGraphActiveStorage;
  readonly before?: CodeGraphActiveStorage;
  readonly checkoutId: string;
  readonly databasePath: string;
  readonly dryRun: boolean;
  readonly reason?: 'active-build' | 'active-maintenance';
  readonly reclaimedBytes: number;
}

interface CodeGraphFileIdentity {
  readonly birthtimeMilliseconds: number;
  readonly dev: number;
  readonly ino: number;
  readonly modifiedAtMilliseconds: number;
  readonly size: bigint;
}

interface CodeGraphCompactionReceipt {
  readonly activeSnapshots: number;
  readonly schemaVersion: number;
  readonly snapshotStates: Readonly<Record<CodeGraphSnapshot['state'], number>>;
}

const STORAGE_LOCK_OPTIONS = {
  retryIntervalMilliseconds: 1,
  staleAfterMilliseconds: 120_000,
  waitTimeoutMilliseconds: 0,
} as const;

/**
 * Reads exact DB/WAL/SHM bytes from filesystem metadata. Page statistics require
 * a tiny read-only PRAGMA connection, which is deliberately skipped whenever an
 * active repository lock is present.
 */
export const inspectCodeGraphStorage = Effect.fn('codeGraph.inspectStorage')(function* (
  threadnoteHome: string,
  checkoutId: string,
  options: {readonly attributeObjects?: boolean; readonly openWhileLocked?: boolean} = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repositoryRoot = codeGraphRepositoryRoot(path, threadnoteHome, checkoutId);
  const databasePath = path.join(repositoryRoot, `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`);
  const database = yield* regularFileBytes(fs, databasePath);
  if (database.state === 'missing') {
    return {checkoutId, databasePath, state: 'missing'} satisfies CodeGraphMissingStorage;
  }
  const [wal, shm] = yield* Effect.all(
    [regularFileBytes(fs, `${databasePath}-wal`), regularFileBytes(fs, `${databasePath}-shm`)],
    {concurrency: 2},
  );
  const locked =
    !options.openWhileLocked &&
    ((yield* codeGraphRepositoryLockActive(threadnoteHome, checkoutId)) ||
      (yield* codeGraphWorktreeBuildActive(threadnoteHome, checkoutId)));
  const threshold = {
    minimumReclaimableBytes: CODE_GRAPH_COMPACTION_MIN_RECLAIMABLE_BYTES,
    minimumReclaimableRatio: CODE_GRAPH_COMPACTION_MIN_RECLAIMABLE_RATIO,
  } as const;
  const pageStorage = locked
    ? ({reason: 'active-build', state: 'deferred', threshold} satisfies CodeGraphDeferredPageStorage)
    : yield* readPageStorage(databasePath, options.attributeObjects === true).pipe(
        Effect.catch(() =>
          Effect.succeed({
            reason: 'database-busy-or-unreadable',
            state: 'unavailable',
            threshold,
          } satisfies CodeGraphUnavailablePageStorage),
        ),
      );
  return {
    checkoutId,
    databaseBytes: database.bytes,
    databasePath,
    pageStorage,
    shmBytes: shm.state === 'available' ? shm.bytes : 0,
    state: 'available',
    totalBytes:
      database.bytes + (wal.state === 'available' ? wal.bytes : 0) + (shm.state === 'available' ? shm.bytes : 0),
    walBytes: wal.state === 'available' ? wal.bytes : 0,
  } satisfies CodeGraphActiveStorage;
});

/**
 * Explicit compaction uses SQLite's transactional VACUUM implementation. SQLite
 * builds a private replacement database and commits it back atomically; a failed
 * or interrupted VACUUM leaves the original database intact. Threadnote adds its
 * maintenance + checkout locks, zero-wait contention deferral, target-identity
 * revalidation, pre/post integrity receipts, and WAL checkpoints around it.
 */
export const compactCodeGraphStorage = Effect.fn('codeGraph.compactStorage')(function* (
  threadnoteHome: string,
  checkoutId: string,
  options: {
    readonly dryRun: boolean;
    readonly force?: boolean;
    readonly interlock?: CodeGraphCompactionInterlock;
  },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const databasePath = path.join(
    codeGraphRepositoryRoot(path, threadnoteHome, checkoutId),
    `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`,
  );
  const deferred = (reason: CodeGraphCompactionSummary['reason']) =>
    ({
      action: 'deferred',
      checkoutId,
      databasePath,
      dryRun: options.dryRun,
      reason,
      reclaimedBytes: 0,
    }) satisfies CodeGraphCompactionSummary;
  const checkoutMaintenance = withExclusiveFileLock(
    fs,
    codeGraphRepositoryLockPath(path, threadnoteHome, checkoutId),
    STORAGE_LOCK_OPTIONS,
    Effect.gen(function* () {
      yield* awaitCodeGraphWorktreeBuilds(threadnoteHome, checkoutId, 0);
      return yield* withCodeGraphDatabaseWriteLock(
        threadnoteHome,
        checkoutId,
        Effect.gen(function* () {
          const before = yield* inspectCodeGraphStorage(threadnoteHome, checkoutId, {openWhileLocked: true});
          if (before.state === 'missing') {
            return {
              action: 'missing',
              checkoutId,
              databasePath,
              dryRun: options.dryRun,
              reclaimedBytes: 0,
            } satisfies CodeGraphCompactionSummary;
          }
          if (before.pageStorage.state !== 'available') {
            return yield* Effect.fail(new Error('Code graph page storage could not be inspected under its lock.'));
          }
          if (!options.force && !before.pageStorage.threshold.recommended) {
            return {
              action: 'not-needed',
              before,
              checkoutId,
              databasePath,
              dryRun: options.dryRun,
              reclaimedBytes: 0,
            } satisfies CodeGraphCompactionSummary;
          }
          const identity = yield* requireRegularFileIdentity(fs, databasePath);
          const receipt = yield* readCompactionReceipt(databasePath);
          yield* options.interlock?.beforeRevalidation?.(before) ?? Effect.void;
          yield* verifyRegularFileIdentity(fs, databasePath, identity);
          if (options.dryRun) {
            return {
              action: 'would-compact',
              before,
              checkoutId,
              databasePath,
              dryRun: true,
              reclaimedBytes: before.pageStorage.reclaimableBytes,
            } satisfies CodeGraphCompactionSummary;
          }
          yield* verifyCompactionDiskHeadroom(system, path.dirname(databasePath), before);
          yield* vacuumDatabase(databasePath);
          const afterReceipt = yield* readCompactionReceipt(databasePath);
          if (!sameCompactionReceipt(receipt, afterReceipt)) {
            return yield* Effect.fail(new Error('Code graph compaction changed the active snapshot receipt.'));
          }
          const after = yield* inspectCodeGraphStorage(threadnoteHome, checkoutId, {openWhileLocked: true});
          if (after.state === 'missing') {
            return yield* Effect.fail(new Error('Code graph database disappeared during compaction.'));
          }
          return {
            action: 'compacted',
            after,
            before,
            checkoutId,
            databasePath,
            dryRun: false,
            reclaimedBytes: Math.max(0, before.databaseBytes - after.databaseBytes),
          } satisfies CodeGraphCompactionSummary;
        }),
        0,
      );
    }),
  ).pipe(
    Effect.catch(cause => (isFileLockTimeout(cause) ? Effect.succeed(deferred('active-build')) : Effect.fail(cause))),
  );
  const maintain = withExclusiveFileLock(
    fs,
    codeGraphMaintenanceLockPath(path, threadnoteHome),
    STORAGE_LOCK_OPTIONS,
    withCodeGraphMaintenanceIntent(threadnoteHome, checkoutMaintenance),
  ).pipe(
    Effect.catch(cause =>
      isFileLockTimeout(cause) ? Effect.succeed(deferred('active-maintenance')) : Effect.fail(cause),
    ),
  );
  return yield* maintain;
});

export function codeGraphCompactionRequiredFreeBytes(
  storage: Pick<CodeGraphActiveStorage, 'databaseBytes' | 'walBytes'>,
): number {
  const sourceBytes = storage.databaseBytes + storage.walBytes;
  const safetyMargin = Math.max(
    CODE_GRAPH_COMPACTION_MIN_SAFETY_MARGIN_BYTES,
    Math.ceil(sourceBytes * CODE_GRAPH_COMPACTION_SAFETY_MARGIN_RATIO),
  );
  const required = sourceBytes + safetyMargin;
  if (!Number.isSafeInteger(required) || required < 0) {
    throw new Error('Code graph compaction storage requirement exceeds the supported byte range.');
  }
  return required;
}

const verifyCompactionDiskHeadroom = Effect.fn('codeGraph.verifyCompactionDiskHeadroom')(function* (
  system: SystemInfoShape,
  directory: string,
  storage: Pick<CodeGraphActiveStorage, 'databaseBytes' | 'walBytes'>,
) {
  const requiredBytes = codeGraphCompactionRequiredFreeBytes(storage);
  const availableBytes = yield* system
    .availableDiskBytes(directory)
    .pipe(
      Effect.mapError(
        cause =>
          new Error(
            `Could not inspect free disk space before code graph compaction. ` +
              `Verify at least ${requiredBytes.toLocaleString()} bytes are free and retry; the database was not modified.`,
            {cause},
          ),
      ),
    );
  if (availableBytes === undefined) {
    return yield* Effect.fail(
      new Error(
        `Could not determine free disk space before code graph compaction. ` +
          `Verify at least ${requiredBytes.toLocaleString()} bytes are free and retry; the database was not modified.`,
      ),
    );
  }
  if (availableBytes < requiredBytes) {
    return yield* Effect.fail(
      new Error(
        `Code graph compaction needs ${requiredBytes.toLocaleString()} bytes free, but only ` +
          `${availableBytes.toLocaleString()} bytes are available. Free disk space and retry; the database was not modified.`,
      ),
    );
  }
});

function regularFileBytes(
  fs: FileSystem.FileSystem,
  candidate: string,
): Effect.Effect<{readonly bytes: number; readonly state: 'available'} | {readonly state: 'missing'}, Error | unknown> {
  return Effect.gen(function* () {
    if (Option.isSome(yield* fs.readLink(candidate).pipe(Effect.option))) {
      return yield* Effect.fail(new Error(`Refusing symbolic-link code graph storage path: ${candidate}`));
    }
    const info = yield* fs.stat(candidate).pipe(Effect.option);
    if (Option.isNone(info)) return {state: 'missing'} as const;
    if (info.value.type !== 'File') {
      return yield* Effect.fail(new Error(`Code graph storage path is not a regular file: ${candidate}`));
    }
    const bytes = Number(info.value.size);
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      return yield* Effect.fail(new Error(`Code graph storage size is invalid: ${candidate}`));
    }
    return {bytes, state: 'available'} as const;
  });
}

function readPageStorage(databasePath: string, attributeObjects: boolean): Effect.Effect<CodeGraphPageStorage, Error> {
  return Effect.try({
    try: () => {
      const database = new Database(databasePath, {readonly: true, strict: true});
      try {
        database.exec('PRAGMA busy_timeout = 50');
        const pageSize = pragmaNumber(database, 'page_size');
        const pageCount = pragmaNumber(database, 'page_count');
        const freelistPages = pragmaNumber(database, 'freelist_count');
        const reclaimableBytes = safeProduct(pageSize, freelistPages, 'reclaimable byte count');
        const reclaimableRatio = pageCount === 0 ? 0 : Math.min(1, freelistPages / pageCount);
        const attribution = attributeObjects
          ? readStorageAttribution(database, pageCount, pageSize, reclaimableBytes)
          : undefined;
        return {
          ...(attribution ? {attribution} : {}),
          freelistPages,
          pageCount,
          pageSize,
          reclaimableBytes,
          reclaimableRatio,
          state: 'available',
          threshold: {
            minimumReclaimableBytes: CODE_GRAPH_COMPACTION_MIN_RECLAIMABLE_BYTES,
            minimumReclaimableRatio: CODE_GRAPH_COMPACTION_MIN_RECLAIMABLE_RATIO,
            recommended:
              reclaimableBytes >= CODE_GRAPH_COMPACTION_MIN_RECLAIMABLE_BYTES &&
              reclaimableRatio >= CODE_GRAPH_COMPACTION_MIN_RECLAIMABLE_RATIO,
          },
        } satisfies CodeGraphPageStorage;
      } finally {
        database.close(false);
      }
    },
    catch: cause => new Error(`Could not inspect code graph page storage: ${errorText(cause)}`),
  });
}

function readStorageAttribution(
  database: Database,
  pageCount: number,
  pageSize: number,
  freelistBytes: number,
): CodeGraphStorageAttribution {
  const rows = database
    .query(
      `SELECT dbstat.name AS name,
              CASE
                WHEN dbstat.name = 'sqlite_schema' THEN 'internal'
                WHEN schema.type = 'index' THEN 'index'
                WHEN schema.type = 'table' THEN 'table'
                ELSE 'internal'
              END AS kind,
              SUM(dbstat.pgsize) AS bytes,
              COUNT(*) AS pages,
              SUM(SUM(dbstat.pgsize)) OVER () AS total_bytes,
              COUNT(*) OVER () AS object_count
         FROM dbstat
         LEFT JOIN sqlite_schema AS schema ON schema.name = dbstat.name
        GROUP BY dbstat.name, kind
        ORDER BY bytes DESC, dbstat.name ASC
        LIMIT ?`,
    )
    .all(CODE_GRAPH_STORAGE_ATTRIBUTION_OBJECT_LIMIT + 1) as readonly {
    readonly bytes: bigint | number;
    readonly kind: CodeGraphStorageObjectAttribution['kind'];
    readonly name: string;
    readonly object_count: bigint | number;
    readonly pages: bigint | number;
    readonly total_bytes: bigint | number;
  }[];
  const objectsTruncated = rows.length > CODE_GRAPH_STORAGE_ATTRIBUTION_OBJECT_LIMIT;
  const objects = rows.slice(0, CODE_GRAPH_STORAGE_ATTRIBUTION_OBJECT_LIMIT).map(row => ({
    bytes: safeCount(row.bytes, `storage object ${safeStorageObjectName(row.name)} bytes`),
    kind: row.kind,
    name: safeStorageObjectName(row.name),
    pages: safeCount(row.pages, `storage object ${safeStorageObjectName(row.name)} pages`),
  }));
  const attributedBytes = safeCount(rows[0]?.total_bytes ?? 0, 'attributed storage bytes');
  const objectCount = safeCount(rows[0]?.object_count ?? 0, 'attributed storage objects');
  const allocatedBytes = safeProduct(pageCount, pageSize, 'allocated storage bytes');
  return {
    allocatedBytes,
    attributedBytes,
    freelistBytes,
    objectCount,
    objects,
    objectsTruncated,
    state: 'available',
    unattributedBytes: codeGraphStorageUnattributedBytes(allocatedBytes, attributedBytes, freelistBytes),
  };
}

function safeStorageObjectName(value: string): string {
  return /^[a-zA-Z0-9_]{1,128}$/.test(value) ? value : 'unrecognized-schema-object';
}

function readCompactionReceipt(databasePath: string): Effect.Effect<CodeGraphCompactionReceipt, Error> {
  return Effect.try({
    try: () => {
      const database = new Database(databasePath, {readonly: true, strict: true});
      try {
        database.exec('PRAGMA busy_timeout = 50');
        const integrity = database.query('PRAGMA quick_check').get() as {readonly quick_check?: string} | null;
        if (integrity?.quick_check !== 'ok')
          throw new Error(`quick_check returned ${integrity?.quick_check ?? 'no row'}`);
        const schema = database.query("SELECT value FROM schema_metadata WHERE key = 'schema_version'").get() as {
          readonly value?: string;
        } | null;
        const schemaVersion = Number.parseInt(schema?.value ?? '', 10);
        if (schemaVersion !== CODE_GRAPH_SCHEMA_VERSION) {
          throw new Error(`schema version ${schema?.value ?? 'missing'} is not supported`);
        }
        const stateRows = database
          .query('SELECT state, COUNT(*) AS count FROM snapshots GROUP BY state ORDER BY state')
          .all() as readonly {readonly count: bigint | number; readonly state: CodeGraphSnapshot['state']}[];
        const snapshotStates: Record<CodeGraphSnapshot['state'], number> = {
          building: 0,
          failed: 0,
          ready: 0,
          retired: 0,
        };
        for (const row of stateRows) snapshotStates[row.state] = safeCount(row.count, `snapshot state ${row.state}`);
        const active = database.query('SELECT COUNT(*) AS count FROM active_snapshots').get() as {
          readonly count?: bigint | number;
        } | null;
        return {
          activeSnapshots: safeCount(active?.count ?? 0, 'active snapshot'),
          schemaVersion,
          snapshotStates,
        } satisfies CodeGraphCompactionReceipt;
      } finally {
        database.close(false);
      }
    },
    catch: cause => new Error(`Could not verify code graph compaction receipt: ${errorText(cause)}`),
  });
}

function vacuumDatabase(databasePath: string): Effect.Effect<void, Error> {
  return Effect.try({
    try: () => {
      const database = new Database(databasePath, {create: false, strict: true});
      try {
        database.exec('PRAGMA busy_timeout = 0');
        const before = database.query('PRAGMA wal_checkpoint(TRUNCATE)').get() as {
          readonly busy?: number;
        } | null;
        if (Number(before?.busy ?? 0) !== 0)
          throw new Error('active SQLite readers prevented the preflight checkpoint');
        database.exec('VACUUM');
        const after = database.query('PRAGMA wal_checkpoint(TRUNCATE)').get() as {
          readonly busy?: number;
        } | null;
        if (Number(after?.busy ?? 0) !== 0) throw new Error('active SQLite readers prevented the final checkpoint');
      } finally {
        database.close(false);
      }
    },
    catch: cause => new Error(`Code graph compaction failed safely: ${errorText(cause)}`),
  });
}

function pragmaNumber(database: Database, pragma: 'freelist_count' | 'page_count' | 'page_size'): number {
  const row = database.query(`PRAGMA ${pragma}`).get() as Record<string, bigint | number> | null;
  return safeCount(row?.[pragma] ?? 0, pragma);
}

function safeCount(value: bigint | number, label: string): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error(`Invalid SQLite ${label}.`);
  return count;
}

function safeProduct(left: number, right: number, label: string): number {
  const value = left * right;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid SQLite ${label}.`);
  return value;
}

function requireRegularFileIdentity(fs: FileSystem.FileSystem, candidate: string) {
  return fs.stat(candidate).pipe(
    Effect.flatMap(info =>
      Option.match(fileIdentity(info), {
        onNone: () => Effect.fail(new Error('Code graph database lacks stable identity metadata.')),
        onSome: Effect.succeed,
      }),
    ),
  );
}

function verifyRegularFileIdentity(fs: FileSystem.FileSystem, candidate: string, expected: CodeGraphFileIdentity) {
  return Effect.gen(function* () {
    if (Option.isSome(yield* fs.readLink(candidate).pipe(Effect.option))) {
      return yield* Effect.fail(new Error('Code graph database became a symbolic link before compaction.'));
    }
    const current = yield* requireRegularFileIdentity(fs, candidate);
    if (!sameFileIdentity(expected, current)) {
      return yield* Effect.fail(
        new Error('Code graph database changed before compaction; retry after current work finishes.'),
      );
    }
  });
}

function fileIdentity(info: FileSystem.File.Info): Option.Option<CodeGraphFileIdentity> {
  const birthtime = Option.getOrUndefined(info.birthtime);
  const ino = Option.getOrUndefined(info.ino);
  const modifiedAt = Option.getOrUndefined(info.mtime);
  return info.type !== 'File' || birthtime === undefined || ino === undefined || modifiedAt === undefined
    ? Option.none()
    : Option.some({
        birthtimeMilliseconds: birthtime.getTime(),
        dev: info.dev,
        ino,
        modifiedAtMilliseconds: modifiedAt.getTime(),
        size: info.size,
      });
}

function sameFileIdentity(left: CodeGraphFileIdentity, right: CodeGraphFileIdentity): boolean {
  return (
    left.birthtimeMilliseconds === right.birthtimeMilliseconds &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.modifiedAtMilliseconds === right.modifiedAtMilliseconds &&
    left.size === right.size
  );
}

function sameCompactionReceipt(left: CodeGraphCompactionReceipt, right: CodeGraphCompactionReceipt): boolean {
  return (
    left.activeSnapshots === right.activeSnapshots &&
    left.schemaVersion === right.schemaVersion &&
    left.snapshotStates.building === right.snapshotStates.building &&
    left.snapshotStates.failed === right.snapshotStates.failed &&
    left.snapshotStates.ready === right.snapshotStates.ready &&
    left.snapshotStates.retired === right.snapshotStates.retired
  );
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
