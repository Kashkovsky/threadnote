import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import {Effect, FileSystem, Option, Path, PlatformError} from 'effect';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import {sha256HexSync} from '../crypto/sha256.js';
import {isFileLockTimeout, withExclusiveFileLock} from '../effect/file_lock.js';
import {codeGraphVectorWriteLockPath} from './layout.js';

const VECTOR_DATABASE_VERSION = 2;
const VECTOR_DATABASE_NAME = `vectors-v${VECTOR_DATABASE_VERSION}.sqlite`;
const VECTOR_DATABASE_LIMIT = 32;
const VECTOR_DIRECTORY_ENTRY_LIMIT = 64;
const MODEL_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const HASH_ID = /^[0-9a-f]{64}$/;

export type CodeGraphVectorCleanupWarningCode =
  | 'vector-inventory-truncated'
  | 'vector-inventory-unavailable'
  | 'vector-inventory-unsafe'
  | 'vector-store-busy'
  | 'vector-store-unreadable';

export interface CodeGraphVectorCleanupWarning {
  readonly code: CodeGraphVectorCleanupWarningCode;
  readonly message: string;
  readonly occurrences: number;
  readonly retryable: boolean;
}

export interface CodeGraphVectorPointerCleanupResult {
  readonly databasesInspected: number;
  readonly databasesProcessed: number;
  readonly pointersRemoved: number;
  readonly warnings: readonly CodeGraphVectorCleanupWarning[];
}

interface VectorDatabaseCandidate {
  readonly databasePath: string;
  readonly fileIdentity: VectorDatabaseFileIdentity;
  readonly modelKey: string;
  readonly modelRoot: string;
  readonly vectorRoot: string;
}

interface VectorDatabaseFileIdentity {
  readonly dev: number;
  readonly ino?: string;
}

interface VectorDatabaseInventory {
  readonly candidates: readonly VectorDatabaseCandidate[];
  readonly truncated: boolean;
  readonly unsafeEntries: number;
}

/**
 * Remove only the selected worktree pointer when it still joins a generation
 * for the expected graph snapshot. Generation reclamation remains deferred so
 * this foreground action never cascades through a large vector table.
 */
export const cleanupCodeGraphVectorPointers = Effect.fn('codeGraph.cleanupVectorPointers')(function* (
  threadnoteHome: string,
  checkoutId: string,
  worktreeId: string,
  expectedSnapshotId: string,
) {
  if (!HASH_ID.test(checkoutId) || !HASH_ID.test(worktreeId) || !validSnapshotId(expectedSnapshotId)) {
    return yield* Effect.fail(new Error('Code graph vector cleanup target is invalid.'));
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const warnings = new Map<CodeGraphVectorCleanupWarningCode, number>();
  const inventory = yield* inspectVectorDatabases(fs, path, threadnoteHome, checkoutId).pipe(
    Effect.match({
      onFailure: () => undefined,
      onSuccess: value => value,
    }),
  );
  if (inventory === undefined) {
    incrementWarning(warnings, 'vector-inventory-unavailable');
    return vectorCleanupResult(0, 0, 0, warnings);
  }
  if (inventory.truncated) incrementWarning(warnings, 'vector-inventory-truncated');
  if (inventory.unsafeEntries > 0) incrementWarning(warnings, 'vector-inventory-unsafe', inventory.unsafeEntries);

  let processed = 0;
  let removed = 0;
  for (const candidate of inventory.candidates) {
    const outcome = yield* withExclusiveFileLock(
      fs,
      codeGraphVectorWriteLockPath(path, threadnoteHome, checkoutId, candidate.modelKey),
      {
        retryIntervalMilliseconds: 1,
        staleAfterMilliseconds: 120_000,
        waitTimeoutMilliseconds: 0,
      },
      validateVectorDatabaseCandidate(fs, path, candidate).pipe(
        Effect.andThen(removeExpectedVectorPointer(fs, path, candidate, worktreeId, expectedSnapshotId)),
      ),
    ).pipe(
      Effect.match({
        onFailure: cause => (isFileLockTimeout(cause) ? ({state: 'busy'} as const) : ({state: 'unreadable'} as const)),
        onSuccess: pointerCount => ({pointerCount, state: 'processed' as const}),
      }),
    );
    if (outcome.state === 'busy') {
      incrementWarning(warnings, 'vector-store-busy');
      continue;
    }
    if (outcome.state === 'unreadable') {
      incrementWarning(warnings, 'vector-store-unreadable');
      continue;
    }
    processed += 1;
    removed += outcome.pointerCount;
  }
  return vectorCleanupResult(inventory.candidates.length, processed, removed, warnings);
});

function inspectVectorDatabases(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  threadnoteHome: string,
  checkoutId: string,
): Effect.Effect<VectorDatabaseInventory, unknown> {
  return Effect.gen(function* () {
    const canonicalVectorRoot = yield* inspectCanonicalVectorRoot(fs, path, threadnoteHome, checkoutId);
    if (canonicalVectorRoot === undefined) return {candidates: [], truncated: false, unsafeEntries: 0};
    const entries = yield* fs.readDirectory(canonicalVectorRoot);
    if (entries.length > VECTOR_DIRECTORY_ENTRY_LIMIT) {
      return {candidates: [], truncated: true, unsafeEntries: 0};
    }
    const names = entries.sort();
    const candidates: VectorDatabaseCandidate[] = [];
    let unsafeEntries = 0;
    let truncated = false;
    for (const name of names) {
      if (!MODEL_ID.test(name)) {
        unsafeEntries += 1;
        continue;
      }
      if (candidates.length >= VECTOR_DATABASE_LIMIT) {
        truncated = true;
        continue;
      }
      const modelRoot = path.join(canonicalVectorRoot, name);
      if (Option.isSome(yield* fs.readLink(modelRoot).pipe(Effect.option))) {
        unsafeEntries += 1;
        continue;
      }
      const modelInfo = yield* fs.stat(modelRoot).pipe(Effect.option);
      if (Option.isNone(modelInfo) || modelInfo.value.type !== 'Directory') {
        unsafeEntries += 1;
        continue;
      }
      const canonicalModelRoot = yield* fs.realPath(modelRoot).pipe(Effect.option);
      if (
        Option.isNone(canonicalModelRoot) ||
        path.dirname(canonicalModelRoot.value) !== canonicalVectorRoot ||
        path.basename(canonicalModelRoot.value) !== name
      ) {
        unsafeEntries += 1;
        continue;
      }
      const databasePath = path.join(canonicalModelRoot.value, VECTOR_DATABASE_NAME);
      if (Option.isSome(yield* fs.readLink(databasePath).pipe(Effect.option))) {
        unsafeEntries += 1;
        continue;
      }
      const databaseInfo = yield* fs.stat(databasePath).pipe(Effect.option);
      if (Option.isNone(databaseInfo)) continue;
      if (databaseInfo.value.type !== 'File') {
        unsafeEntries += 1;
        continue;
      }
      candidates.push({
        databasePath,
        fileIdentity: vectorDatabaseFileIdentity(databaseInfo.value),
        modelKey: sha256HexSync(name),
        modelRoot: canonicalModelRoot.value,
        vectorRoot: canonicalVectorRoot,
      });
    }
    return {candidates, truncated, unsafeEntries};
  });
}

const inspectCanonicalVectorRoot = Effect.fn('codeGraph.inspectCanonicalVectorRoot')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  threadnoteHome: string,
  checkoutId: string,
) {
  if (Option.isSome(yield* fs.readLink(threadnoteHome).pipe(Effect.option))) {
    return yield* Effect.fail(new Error('Threadnote home is a symbolic link.'));
  }
  const homeInfo = yield* optionalVectorFileInfo(fs, threadnoteHome);
  if (Option.isNone(homeInfo)) return undefined;
  if (homeInfo.value.type !== 'Directory') return yield* Effect.fail(new Error('Threadnote home is invalid.'));
  let current = yield* fs.realPath(threadnoteHome);
  for (const segment of ['indexes', 'code-graph', 'repositories', checkoutId, 'vectors']) {
    const candidate = path.join(current, segment);
    if (Option.isSome(yield* fs.readLink(candidate).pipe(Effect.option))) {
      return yield* Effect.fail(new Error('Code graph vector containment contains a symbolic link.'));
    }
    const info = yield* optionalVectorFileInfo(fs, candidate);
    if (Option.isNone(info)) return undefined;
    if (info.value.type !== 'Directory') {
      return yield* Effect.fail(new Error('Code graph vector containment has an invalid entry type.'));
    }
    const canonical = yield* fs.realPath(candidate);
    if (canonical !== candidate || path.dirname(canonical) !== current || path.basename(canonical) !== segment) {
      return yield* Effect.fail(new Error('Code graph vector root escaped its derived-store containment.'));
    }
    current = canonical;
  }
  return current;
});

const validateVectorDatabaseCandidate = Effect.fn('codeGraph.validateVectorDatabaseCandidate')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  candidate: VectorDatabaseCandidate,
) {
  if (
    Option.isSome(yield* fs.readLink(candidate.vectorRoot).pipe(Effect.option)) ||
    Option.isSome(yield* fs.readLink(candidate.modelRoot).pipe(Effect.option)) ||
    Option.isSome(yield* fs.readLink(candidate.databasePath).pipe(Effect.option))
  ) {
    return yield* Effect.fail(new Error('Code graph vector cleanup target became a symbolic link.'));
  }
  const [vectorInfo, modelInfo, databaseInfo] = yield* Effect.all(
    [fs.stat(candidate.vectorRoot), fs.stat(candidate.modelRoot), fs.stat(candidate.databasePath)],
    {concurrency: 1},
  );
  if (vectorInfo.type !== 'Directory' || modelInfo.type !== 'Directory' || databaseInfo.type !== 'File') {
    return yield* Effect.fail(new Error('Code graph vector cleanup target changed type.'));
  }
  if (!sameVectorDatabaseFileIdentity(candidate.fileIdentity, vectorDatabaseFileIdentity(databaseInfo))) {
    return yield* Effect.fail(new Error('Code graph vector cleanup target changed identity.'));
  }
  const [canonicalVectorRoot, canonicalModelRoot, canonicalDatabasePath] = yield* Effect.all(
    [fs.realPath(candidate.vectorRoot), fs.realPath(candidate.modelRoot), fs.realPath(candidate.databasePath)],
    {concurrency: 1},
  );
  if (
    canonicalVectorRoot !== candidate.vectorRoot ||
    canonicalModelRoot !== candidate.modelRoot ||
    canonicalDatabasePath !== candidate.databasePath ||
    path.dirname(canonicalModelRoot) !== canonicalVectorRoot ||
    path.dirname(canonicalDatabasePath) !== canonicalModelRoot
  ) {
    return yield* Effect.fail(new Error('Code graph vector cleanup target escaped its derived-store root.'));
  }
});

function removeExpectedVectorPointer(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  candidate: VectorDatabaseCandidate,
  worktreeId: string,
  expectedSnapshotId: string,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      // The connection is open before this generator starts. Revalidate the
      // exact contained inode before the first statement, closing the
      // validation/open swap window without mutating a replacement target.
      yield* validateVectorDatabaseCandidate(fs, path, candidate);
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe('PRAGMA busy_timeout = 0');
      const versions = yield* sql.unsafe<{readonly user_version: number}>('PRAGMA user_version');
      if (Number(versions[0]?.user_version ?? 0) !== VECTOR_DATABASE_VERSION) {
        return yield* Effect.fail(new Error('Code graph vector database version is unsupported.'));
      }
      const tables = yield* sql.unsafe<{readonly name: string}>(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN ('vector_generations', 'vector_pointers')
         ORDER BY name`,
      );
      if (tables.map(row => row.name).join(',') !== 'vector_generations,vector_pointers') {
        return yield* Effect.fail(new Error('Code graph vector database schema is incomplete.'));
      }
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql.unsafe(
            `DELETE FROM vector_pointers
             WHERE worktree_id = ?
               AND EXISTS (
                 SELECT 1 FROM vector_generations AS generation
                 WHERE generation.generation = vector_pointers.generation
                   AND generation.snapshot_id = ?
               )`,
            [worktreeId, expectedSnapshotId],
          );
          const changes = yield* sql.unsafe<{readonly count: number}>('SELECT changes() AS count');
          return Math.max(0, Number(changes[0]?.count ?? 0));
        }),
      );
    }).pipe(
      Effect.provide(
        SqliteClient.layer({
          create: false,
          disableWAL: true,
          filename: candidate.databasePath,
          readwrite: true,
        }),
      ),
    ),
  );
}

function vectorDatabaseFileIdentity(info: FileSystem.File.Info): VectorDatabaseFileIdentity {
  const ino = Option.getOrUndefined(info.ino);
  return {dev: info.dev, ...(ino === undefined ? {} : {ino: String(ino)})};
}

function sameVectorDatabaseFileIdentity(
  expected: VectorDatabaseFileIdentity,
  observed: VectorDatabaseFileIdentity,
): boolean {
  return expected.dev === observed.dev && (expected.ino === undefined || expected.ino === observed.ino);
}

function optionalVectorFileInfo(fs: FileSystem.FileSystem, candidate: string) {
  return fs.stat(candidate).pipe(
    Effect.map(Option.some),
    Effect.catch(error =>
      error instanceof PlatformError.PlatformError && error.reason._tag === 'NotFound'
        ? Effect.succeed(Option.none<FileSystem.File.Info>())
        : Effect.fail(error),
    ),
  );
}

function vectorCleanupResult(
  databasesInspected: number,
  databasesProcessed: number,
  pointersRemoved: number,
  warningCounts: ReadonlyMap<CodeGraphVectorCleanupWarningCode, number>,
): CodeGraphVectorPointerCleanupResult {
  const warnings = [...warningCounts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([code, occurrences]) => ({
      code,
      message: vectorCleanupWarningMessage(code),
      occurrences,
      retryable: code !== 'vector-inventory-truncated' && code !== 'vector-inventory-unsafe',
    }));
  return {databasesInspected, databasesProcessed, pointersRemoved, warnings};
}

function incrementWarning(
  warnings: Map<CodeGraphVectorCleanupWarningCode, number>,
  code: CodeGraphVectorCleanupWarningCode,
  occurrences = 1,
): void {
  warnings.set(code, (warnings.get(code) ?? 0) + occurrences);
}

function vectorCleanupWarningMessage(code: CodeGraphVectorCleanupWarningCode): string {
  switch (code) {
    case 'vector-inventory-truncated':
      return 'Vector cleanup reached its bounded database limit; remaining stores require routine maintenance.';
    case 'vector-inventory-unavailable':
      return 'Vector cleanup could not inspect the derived-store inventory; rerun the command.';
    case 'vector-inventory-unsafe':
      return 'Vector cleanup preserved one or more unsafe derived-store entries for manual inspection.';
    case 'vector-store-busy':
      return 'A vector store is busy; rerun the command to retry residual cleanup.';
    case 'vector-store-unreadable':
      return 'A vector store is unreadable; repair it and rerun the command.';
  }
}

function validSnapshotId(snapshotId: string): boolean {
  return snapshotId.length > 0 && snapshotId.length <= 1_024 && !snapshotId.includes('\0');
}
