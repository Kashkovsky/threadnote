import {Effect, FileSystem, Path} from 'effect';
import type {DoctorCheck} from '../types.js';
import {withExclusiveFileLock} from '../effect/file_lock.js';
import {codeGraphMaintenanceLockPath, codeGraphRepositoriesRoot} from './layout.js';
import {withCodeGraphMaintenanceIntent} from './maintenance_gate.js';
import {CodeGraphStore} from './store.js';
import {CODE_GRAPH_SCHEMA_VERSION} from './types.js';

export interface CodeGraphRepairSummary {
  readonly databases: number;
  readonly discarded: number;
  readonly removedIncompleteSnapshots: number;
  readonly removedTemporaryFiles: number;
}

export interface CodeGraphRepairCompletion {
  readonly doctorCheck: DoctorCheck;
  readonly summary: CodeGraphRepairSummary;
}

export interface CodeGraphMaintenanceProgress {
  readonly current: number;
  readonly phase: 'checking' | 'cleaning-snapshots' | 'cleaning-vectors' | 'discarding';
  readonly snapshots?: number;
  readonly total: number;
}

type CodeGraphProgressHandler = (progress: CodeGraphMaintenanceProgress) => Effect.Effect<void, unknown>;
type CodeGraphRepairCompletionHandler<R> = (
  completion: CodeGraphRepairCompletion,
) => Effect.Effect<void, unknown, R>;

export const codeGraphDoctorCheck = Effect.fn('codeGraph.doctorCheck')(function* (
  threadnoteHome: string,
  onProgress?: CodeGraphProgressHandler,
  precomputed?: DoctorCheck,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const store = yield* CodeGraphStore;
  if (precomputed) return precomputed;
  const databases = yield* codeGraphDatabasePaths(threadnoteHome);
  if (databases.length === 0) {
    return {
      detail: 'no repository graph built yet; `threadnote graph query` builds one lazily',
      name: 'native code graph',
      status: 'ok',
    } satisfies DoctorCheck;
  }
  let ready = 0;
  let incomplete = 0;
  let unhealthy = 0;
  for (const [index, database] of databases.entries()) {
    yield* onProgress?.({current: index + 1, phase: 'checking', total: databases.length}) ?? Effect.void;
    const health = yield* withDatabaseLock(
      fs,
      path,
      threadnoteHome,
      database,
      store.diagnose(database).pipe(Effect.option),
    );
    if (health._tag === 'None' || health.value?.integrity !== 'ok') {
      unhealthy += 1;
      continue;
    }
    ready += health.value.readySnapshots;
    incomplete += health.value.buildingSnapshots + health.value.failedSnapshots;
  }
  return codeGraphDoctorResult(databases.length, ready, incomplete, unhealthy);
});

export const repairCodeGraphIndexes = Effect.fn('codeGraph.repairIndexes')(function* <R = never>(
  threadnoteHome: string,
  dryRun: boolean,
  onProgress?: CodeGraphProgressHandler,
  onComplete?: CodeGraphRepairCompletionHandler<R>,
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
        let discarded = 0;
        let removedIncompleteSnapshots = 0;
        let removedTemporaryFiles = 0;
        let readySnapshots = 0;
        for (const [index, database] of databases.entries()) {
          const progress = (input: Omit<CodeGraphMaintenanceProgress, 'current' | 'total'>) =>
            onProgress?.({current: index + 1, total: databases.length, ...input}) ?? Effect.void;
          yield* progress({phase: 'checking'});
          yield* withDatabaseLock(
            fs,
            path,
            threadnoteHome,
            database,
            Effect.gen(function* () {
              const repositoryRoot = path.dirname(database);
              const diagnosed = yield* store.diagnose(database).pipe(Effect.option);
              if (diagnosed._tag === 'None' || diagnosed.value?.integrity !== 'ok') {
                discarded += 1;
                yield* progress({phase: 'discarding'});
                if (!dryRun) yield* fs.remove(repositoryRoot, {force: true, recursive: true});
                return;
              }
              const incomplete = diagnosed.value.buildingSnapshots + diagnosed.value.failedSnapshots;
              readySnapshots += diagnosed.value.readySnapshots;
              removedIncompleteSnapshots += incomplete;
              if (incomplete > 0) {
                yield* progress({phase: 'cleaning-snapshots', snapshots: incomplete});
                if (!dryRun) yield* store.repair(database);
              }
              yield* progress({phase: 'cleaning-vectors'});
              removedTemporaryFiles += yield* cleanTemporaryVectorFiles(
                fs,
                path,
                path.join(repositoryRoot, 'vectors'),
                dryRun,
              );
            }),
          );
        }
        const currentDatabases = yield* codeGraphDatabasePaths(threadnoteHome);
        const summary = {
          databases: databases.length,
          discarded,
          removedIncompleteSnapshots,
          removedTemporaryFiles,
        } satisfies CodeGraphRepairSummary;
        yield* onComplete?.({
          doctorCheck: codeGraphDoctorResult(
            currentDatabases.length,
            readySnapshots,
            dryRun ? removedIncompleteSnapshots : 0,
            dryRun ? discarded : 0,
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
): DoctorCheck {
  if (databases === 0) {
    return {
      detail: 'no repository graph built yet; `threadnote graph query` builds one lazily',
      name: 'native code graph',
      status: 'ok',
    };
  }
  return {
    detail:
      `${databases} database(s); ${readySnapshots} ready snapshot(s); ${incompleteSnapshots} incomplete snapshot(s)` +
      (unhealthyDatabases > 0 ? `; ${unhealthyDatabases} database(s) need a disposable rebuild` : ''),
    name: 'native code graph',
    status: unhealthyDatabases > 0 ? 'fail' : incompleteSnapshots > 0 ? 'warn' : 'ok',
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
            repositoryLockPath(path, threadnoteHome, repositoryId),
            CODE_GRAPH_LOCK_OPTIONS,
            fs.remove(repositoryRoot, {force: true, recursive: true}),
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
) {
  const repositoryId = path.basename(path.dirname(database));
  return withExclusiveFileLock(
    fs,
    repositoryLockPath(path, threadnoteHome, repositoryId),
    CODE_GRAPH_LOCK_OPTIONS,
    effect,
  );
}

function repositoryLockPath(path: Path.Path, threadnoteHome: string, repositoryId: string): string {
  if (!/^[0-9a-f]{64}$/.test(repositoryId)) throw new Error('Code graph repository identity is invalid.');
  return path.join(threadnoteHome, 'locks', 'indexes', 'code-graph', `${repositoryId}.lock`);
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
