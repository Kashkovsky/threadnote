import {Clock, Crypto, Effect, FileSystem, Path, Ref, Semaphore} from 'effect';
import {SystemInfo} from '../effect/system.js';
import {codeGraphRepositoriesRoot, type CodeGraphLayout} from './layout.js';
import type {CodeGraphIndexSummary, CodeGraphProgress, CodeGraphSnapshot, RepositoryIdentity} from './types.js';

export const CODE_GRAPH_BUILD_STATUS_SCHEMA_VERSION = 1 as const;
export const CODE_GRAPH_BUILD_HEARTBEAT_INTERVAL_MILLISECONDS = 2_000;
export const CODE_GRAPH_BUILD_PROGRESS_WRITE_INTERVAL_MILLISECONDS = 250;
export const CODE_GRAPH_BUILD_STALE_AFTER_MILLISECONDS = 15_000;

export type CodeGraphBuildState = 'completed' | 'failed' | 'queued' | 'running';
export type CodeGraphBuildLiveness = 'abandoned' | 'active' | 'completed' | 'failed' | 'stalled';

export interface CodeGraphBuildCounters {
  readonly accepted?: number;
  readonly completed?: number;
  readonly edges?: number;
  readonly embedded?: number;
  readonly excluded?: number;
  readonly reused?: number;
  readonly skipped?: number;
  readonly symbols?: number;
  readonly total?: number;
  readonly unit?: 'files' | 'symbols';
}

export interface CodeGraphBuildStatus {
  readonly buildId: string;
  readonly counters: CodeGraphBuildCounters;
  readonly error?: {readonly summary: string};
  readonly eta?: {
    readonly confidence: 'high' | 'low' | 'medium';
    readonly remainingMilliseconds: number;
    readonly scope: 'phase';
  };
  readonly identity: {
    readonly checkoutId: string;
    readonly commit: string;
    readonly repositoryId: string;
    readonly worktreeId: string;
  };
  readonly owner: {
    readonly processId: number;
    readonly processStartIdentity?: string;
    readonly runtime: 'bun';
    readonly runtimeVersion: string;
  };
  readonly phase: CodeGraphProgress['phase'];
  readonly result?: {
    readonly dirty: boolean;
    readonly edges: number;
    readonly files: number;
    readonly snapshotId: string;
    readonly symbols: number;
  };
  readonly schemaVersion: typeof CODE_GRAPH_BUILD_STATUS_SCHEMA_VERSION;
  readonly state: CodeGraphBuildState;
  readonly subphase?: string;
  readonly timestamps: {
    readonly completedAt?: string;
    readonly heartbeatAt: string;
    readonly lastProgressAt: string;
    readonly phaseStartedAt: string;
    readonly startedAt: string;
    readonly updatedAt: string;
  };
}

export interface ObservedCodeGraphBuildStatus extends CodeGraphBuildStatus {
  readonly observation: {
    readonly heartbeatAgeMilliseconds: number;
    readonly liveness: CodeGraphBuildLiveness;
    readonly reason?: 'heartbeat-stale' | 'owner-exited' | 'pid-reused';
  };
}

export interface CodeGraphBuildReporter {
  readonly complete: (summary: CodeGraphIndexSummary) => Effect.Effect<void, never>;
  readonly completeSnapshot: (snapshot: CodeGraphSnapshot) => Effect.Effect<void, never>;
  readonly fail: (cause: unknown) => Effect.Effect<void, never>;
  readonly heartbeat: Effect.Effect<void, never>;
  readonly progress: (progress: CodeGraphProgress) => Effect.Effect<void, never>;
}

interface ReporterState {
  readonly lastCompleted?: number;
  readonly lastPersistedAtMilliseconds: number;
  readonly lastSampleAtMilliseconds?: number;
  readonly sampleCount: number;
  readonly smoothedUnitsPerMillisecond?: number;
  readonly status: CodeGraphBuildStatus;
}

interface ProcessObservation {
  readonly isRunning: boolean;
  readonly nowMilliseconds: number;
  readonly processStartIdentity?: string;
}

const STATUS_DIRECTORY = 'build-status';
const STATUS_FILE_BYTES_LIMIT = 64 * 1_024;
const STATUS_HISTORY_PER_WORKTREE = 8;
const HASH_ID = /^[0-9a-f]{64}$/;
const BUILD_ID = /^[0-9a-f-]{16,64}$/;
const COMMIT_ID = /^[0-9a-f]{7,64}$/;
const VALID_PHASES = new Set<CodeGraphProgress['phase']>([
  'activating',
  'embedding',
  'materializing',
  'registering',
  'resolving',
  'scanning',
  'waiting',
]);
const VALID_STATES = new Set<CodeGraphBuildState>(['completed', 'failed', 'queued', 'running']);

export const makeCodeGraphBuildReporter = Effect.fn('codeGraph.buildStatus.makeReporter')(function* (
  identity: RepositoryIdentity,
  layout: CodeGraphLayout,
) {
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const buildId = (yield* crypto.randomUUIDv4).toLowerCase();
  const startedAtMilliseconds = yield* Clock.currentTimeMillis;
  const startedAt = new Date(startedAtMilliseconds).toISOString();
  const processStartIdentity = yield* system.processStartIdentity(system.processId);
  const file = codeGraphBuildStatusPath(path, layout, identity.worktreeId, buildId);
  let writeSequence = 0;
  const state = yield* Ref.make<ReporterState>({
    lastPersistedAtMilliseconds: 0,
    sampleCount: 0,
    status: {
      buildId,
      counters: {},
      identity: {
        checkoutId: identity.checkoutId,
        commit: identity.headCommit.slice(0, 12),
        repositoryId: identity.repositoryId,
        worktreeId: identity.worktreeId,
      },
      owner: {
        processId: system.processId,
        ...(processStartIdentity ? {processStartIdentity} : {}),
        runtime: 'bun',
        runtimeVersion: boundedText(system.runtimeVersion, 64),
      },
      phase: 'registering',
      schemaVersion: CODE_GRAPH_BUILD_STATUS_SCHEMA_VERSION,
      state: 'running',
      subphase: 'registration',
      timestamps: {
        heartbeatAt: startedAt,
        lastProgressAt: startedAt,
        phaseStartedAt: startedAt,
        startedAt,
        updatedAt: startedAt,
      },
    },
  });
  const semaphore = yield* Semaphore.make(1);
  const persist = (
    update: (current: ReporterState, now: number) => ReporterState,
    force: boolean | ((current: ReporterState) => boolean),
  ) =>
    semaphore
      .withPermit(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const current = yield* Ref.get(state);
          const shouldForce = typeof force === 'function' ? force(current) : force;
          const next = update(current, now);
          yield* Ref.set(state, next);
          if (
            !shouldForce &&
            now - next.lastPersistedAtMilliseconds < CODE_GRAPH_BUILD_PROGRESS_WRITE_INTERVAL_MILLISECONDS
          ) {
            return;
          }
          const persisted = {...next, lastPersistedAtMilliseconds: now};
          yield* Ref.set(state, persisted);
          writeSequence += 1;
          yield* writeCodeGraphBuildStatus(fs, path, file, persisted.status, writeSequence);
        }),
      )
      .pipe(Effect.catch(() => Effect.void));

  yield* persist(current => current, true);

  const complete = (snapshot: CodeGraphSnapshot, reusedFiles: number, skippedFiles: number) =>
    persist((current, now) => {
      const timestamp = new Date(now).toISOString();
      return {
        ...current,
        status: {
          ...current.status,
          counters: {
            edges: snapshot.edgeCount,
            reused: reusedFiles,
            skipped: skippedFiles,
            symbols: snapshot.symbolCount,
            total: snapshot.fileCount,
            unit: 'files',
          },
          eta: undefined,
          result: {
            dirty: snapshot.dirty,
            edges: snapshot.edgeCount,
            files: snapshot.fileCount,
            snapshotId: snapshot.id,
            symbols: snapshot.symbolCount,
          },
          state: 'completed',
          subphase: 'ready',
          timestamps: {
            ...current.status.timestamps,
            completedAt: timestamp,
            heartbeatAt: timestamp,
            lastProgressAt: timestamp,
            updatedAt: timestamp,
          },
        },
      };
    }, true).pipe(Effect.andThen(pruneCodeGraphBuildHistory(fs, path, layout, identity.worktreeId, buildId)));

  return {
    complete: summary => complete(summary.snapshot, summary.reusedFiles, summary.skippedFiles),
    completeSnapshot: snapshot => complete(snapshot, 0, 0),
    fail: cause =>
      persist((current, now) => {
        const timestamp = new Date(now).toISOString();
        return {
          ...current,
          status: {
            ...current.status,
            error: {summary: privacySafeError(cause)},
            eta: undefined,
            state: 'failed',
            subphase: 'failed',
            timestamps: {
              ...current.status.timestamps,
              completedAt: timestamp,
              heartbeatAt: timestamp,
              lastProgressAt: timestamp,
              updatedAt: timestamp,
            },
          },
        };
      }, true).pipe(Effect.andThen(pruneCodeGraphBuildHistory(fs, path, layout, identity.worktreeId, buildId))),
    heartbeat: Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep(CODE_GRAPH_BUILD_HEARTBEAT_INTERVAL_MILLISECONDS);
        const current = yield* Ref.get(state);
        if (current.status.state === 'completed' || current.status.state === 'failed') return;
        yield* persist((latest, now) => {
          const timestamp = new Date(now).toISOString();
          return {
            ...latest,
            status: {
              ...latest.status,
              timestamps: {...latest.status.timestamps, heartbeatAt: timestamp, updatedAt: timestamp},
            },
          };
        }, true);
      }
    }).pipe(Effect.catch(() => Effect.void)),
    progress: progress =>
      persist(
        (current, now) => observeProgress(current, progress, now),
        current => current.status.phase !== progress.phase || current.status.subphase !== progressSubphase(progress),
      ),
  } satisfies CodeGraphBuildReporter;
});

export const readCodeGraphBuildStatuses = Effect.fn('codeGraph.buildStatus.readCheckout')(function* (
  layout: CodeGraphLayout,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* readBuildStatusesBelow(fs, path, path.join(layout.repositoryRoot, STATUS_DIRECTORY));
});

export const readAllCodeGraphBuildStatuses = Effect.fn('codeGraph.buildStatus.readAll')(function* (
  threadnoteHome: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = codeGraphRepositoriesRoot(path, threadnoteHome);
  if (!(yield* regularDirectory(fs, root))) return [];
  const statuses = yield* Effect.forEach(
    (yield* fs.readDirectory(root)).filter(name => HASH_ID.test(name)).sort(),
    checkoutId => readBuildStatusesBelow(fs, path, path.join(root, checkoutId, STATUS_DIRECTORY)),
    {concurrency: 8},
  );
  return statuses.flat().sort(compareObservedBuildStatus);
});

export const currentCodeGraphBuildStatus = Effect.fn('codeGraph.buildStatus.current')(function* (
  layout: CodeGraphLayout,
  worktreeId: string,
) {
  const statuses = (yield* readCodeGraphBuildStatuses(layout)).filter(
    status => status.identity.worktreeId === worktreeId,
  );
  return statuses.sort(compareObservedBuildStatus)[0];
});

export function observeCodeGraphBuildStatus(
  status: CodeGraphBuildStatus,
  observation: ProcessObservation,
): ObservedCodeGraphBuildStatus {
  const heartbeat = Date.parse(status.timestamps.heartbeatAt);
  const heartbeatAgeMilliseconds = Number.isFinite(heartbeat)
    ? Math.max(0, observation.nowMilliseconds - heartbeat)
    : Number.POSITIVE_INFINITY;
  if (status.state === 'completed') {
    return {...status, observation: {heartbeatAgeMilliseconds, liveness: 'completed'}};
  }
  if (status.state === 'failed') {
    return {...status, observation: {heartbeatAgeMilliseconds, liveness: 'failed'}};
  }
  if (!observation.isRunning) {
    return {
      ...status,
      observation: {heartbeatAgeMilliseconds, liveness: 'abandoned', reason: 'owner-exited'},
    };
  }
  if (
    status.owner.processStartIdentity &&
    observation.processStartIdentity &&
    status.owner.processStartIdentity !== observation.processStartIdentity
  ) {
    return {
      ...status,
      observation: {heartbeatAgeMilliseconds, liveness: 'abandoned', reason: 'pid-reused'},
    };
  }
  if (heartbeatAgeMilliseconds > CODE_GRAPH_BUILD_STALE_AFTER_MILLISECONDS) {
    return {
      ...status,
      observation: {heartbeatAgeMilliseconds, liveness: 'stalled', reason: 'heartbeat-stale'},
    };
  }
  return {...status, observation: {heartbeatAgeMilliseconds, liveness: 'active'}};
}

function observeProgress(current: ReporterState, progress: CodeGraphProgress, now: number): ReporterState {
  const timestamp = new Date(now).toISOString();
  const phaseChanged = current.status.phase !== progress.phase;
  const measured = measuredProgress(progress);
  const previousCompleted = phaseChanged ? undefined : current.lastCompleted;
  const previousAt = phaseChanged ? undefined : current.lastSampleAtMilliseconds;
  let rate = phaseChanged ? undefined : current.smoothedUnitsPerMillisecond;
  let sampleCount = phaseChanged ? 0 : current.sampleCount;
  if (measured && previousCompleted !== undefined && previousAt !== undefined && now > previousAt) {
    const delta = measured.completed - previousCompleted;
    if (delta > 0) {
      const observed = delta / (now - previousAt);
      rate = rate === undefined ? observed : rate * 0.65 + observed * 0.35;
      sampleCount += 1;
    }
  }
  const remaining = measured && rate && rate > 0 ? Math.max(0, measured.total - measured.completed) / rate : undefined;
  const eta =
    remaining === undefined || sampleCount < 2
      ? undefined
      : {
          confidence: sampleCount >= 6 ? ('high' as const) : sampleCount >= 3 ? ('medium' as const) : ('low' as const),
          remainingMilliseconds: Math.ceil(remaining / 1_000) * 1_000,
          scope: 'phase' as const,
        };
  return {
    ...current,
    lastCompleted: measured?.completed,
    lastSampleAtMilliseconds: measured ? now : undefined,
    sampleCount,
    smoothedUnitsPerMillisecond: rate,
    status: {
      ...current.status,
      counters: progressCounters(progress),
      eta,
      phase: progress.phase,
      state: progress.phase === 'waiting' ? 'queued' : 'running',
      subphase: progressSubphase(progress),
      timestamps: {
        ...current.status.timestamps,
        heartbeatAt: timestamp,
        lastProgressAt: timestamp,
        phaseStartedAt: phaseChanged ? timestamp : current.status.timestamps.phaseStartedAt,
        updatedAt: timestamp,
      },
    },
  };
}

function progressSubphase(progress: CodeGraphProgress): string {
  if ('subphase' in progress && typeof progress.subphase === 'string') return boundedText(progress.subphase, 64);
  switch (progress.phase) {
    case 'activating':
      return 'snapshot';
    case 'embedding':
      return 'vectors';
    case 'materializing':
      return 'facts';
    case 'registering':
      return 'registration';
    case 'scanning':
      return 'inventory';
    case 'waiting':
      return 'repository-lock';
  }
}

function progressCounters(progress: CodeGraphProgress): CodeGraphBuildCounters {
  switch (progress.phase) {
    case 'scanning':
      return {
        accepted: progress.accepted,
        completed: progress.completed,
        excluded: progress.excluded,
        skipped: progress.skipped,
        total: progress.total,
        unit: progress.unit,
      };
    case 'materializing':
      return {
        completed: progress.completed,
        reused: progress.reused,
        total: progress.total,
        unit: progress.unit,
      };
    case 'resolving':
      return progress.subphase === 'complete' ? {edges: progress.edges, symbols: progress.symbols} : {};
    case 'embedding':
      return {
        completed: progress.completed,
        embedded: progress.embedded,
        reused: progress.reused,
        total: progress.total,
        unit: progress.unit,
      };
    default:
      return {};
  }
}

function measuredProgress(
  progress: CodeGraphProgress,
): {readonly completed: number; readonly total: number} | undefined {
  if (progress.phase === 'scanning' || progress.phase === 'materializing' || progress.phase === 'embedding') {
    return {completed: progress.completed, total: progress.total};
  }
  return undefined;
}

function codeGraphBuildStatusPath(
  path: Path.Path,
  layout: CodeGraphLayout,
  worktreeId: string,
  buildId: string,
): string {
  if (!HASH_ID.test(worktreeId) || !BUILD_ID.test(buildId)) throw new Error('Code graph build identity is invalid.');
  return path.join(layout.repositoryRoot, STATUS_DIRECTORY, worktreeId, `${buildId}.json`);
}

function writeCodeGraphBuildStatus(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  file: string,
  status: CodeGraphBuildStatus,
  sequence: number,
) {
  return Effect.gen(function* () {
    const directory = path.dirname(file);
    yield* ensurePrivateRegularDirectory(fs, path, directory);
    if ((yield* fs.readLink(file).pipe(Effect.option))._tag === 'Some') {
      return yield* Effect.fail(new Error('Code graph build status path is a symbolic link.'));
    }
    const temporary = path.join(directory, `.${status.buildId}.${sequence}.tmp`);
    const content = `${JSON.stringify(status)}\n`;
    if (new TextEncoder().encode(content).byteLength > STATUS_FILE_BYTES_LIMIT) {
      return yield* Effect.fail(new Error('Code graph build status exceeded its bounded sidecar size.'));
    }
    yield* fs.writeFileString(temporary, content, {flag: 'wx', mode: 0o600});
    yield* fs
      .rename(temporary, file)
      .pipe(Effect.onError(() => fs.remove(temporary, {force: true}).pipe(Effect.catch(() => Effect.void))));
  });
}

function ensurePrivateRegularDirectory(fs: FileSystem.FileSystem, path: Path.Path, directory: string) {
  return Effect.gen(function* () {
    const parent = path.dirname(directory);
    yield* fs.makeDirectory(parent, {recursive: true, mode: 0o700});
    if ((yield* fs.readLink(parent).pipe(Effect.option))._tag === 'Some') {
      return yield* Effect.fail(new Error('Code graph build status parent is a symbolic link.'));
    }
    yield* fs.makeDirectory(directory, {recursive: true, mode: 0o700});
    if ((yield* fs.readLink(directory).pipe(Effect.option))._tag === 'Some') {
      return yield* Effect.fail(new Error('Code graph build status directory is a symbolic link.'));
    }
  });
}

function readBuildStatusesBelow(fs: FileSystem.FileSystem, path: Path.Path, root: string) {
  return Effect.gen(function* () {
    if (!(yield* regularDirectory(fs, root))) return [];
    const worktrees = (yield* fs.readDirectory(root)).filter(name => HASH_ID.test(name)).sort();
    const groups = yield* Effect.forEach(
      worktrees,
      worktreeId => readWorktreeStatuses(fs, path, path.join(root, worktreeId)),
      {concurrency: 8},
    );
    return groups.flat().sort(compareObservedBuildStatus);
  }).pipe(Effect.catch(() => Effect.succeed([] as readonly ObservedCodeGraphBuildStatus[])));
}

function readWorktreeStatuses(fs: FileSystem.FileSystem, path: Path.Path, directory: string) {
  return Effect.gen(function* () {
    if (!(yield* regularDirectory(fs, directory))) return [];
    const files = (yield* fs.readDirectory(directory))
      .filter(name => BUILD_ID.test(name.slice(0, -5)) && name.endsWith('.json'))
      .sort();
    const statuses = yield* Effect.forEach(files, name => readStatusFile(fs, path.join(directory, name)), {
      concurrency: 8,
    });
    return statuses.filter((status): status is ObservedCodeGraphBuildStatus => status !== undefined);
  });
}

function readStatusFile(fs: FileSystem.FileSystem, file: string) {
  return Effect.gen(function* () {
    if ((yield* fs.readLink(file).pipe(Effect.option))._tag === 'Some') return undefined;
    const info = yield* fs.stat(file);
    if (info.type !== 'File' || Number(info.size) > STATUS_FILE_BYTES_LIMIT) return undefined;
    const parsed = parseCodeGraphBuildStatus(JSON.parse(yield* fs.readFileString(file)));
    if (!parsed) return undefined;
    const nowMilliseconds = yield* Clock.currentTimeMillis;
    if (parsed.state === 'completed' || parsed.state === 'failed') {
      return observeCodeGraphBuildStatus(parsed, {isRunning: false, nowMilliseconds});
    }
    const system = yield* SystemInfo;
    const isRunning = system.isProcessRunning(parsed.owner.processId);
    const processStartIdentity = isRunning ? yield* system.processStartIdentity(parsed.owner.processId) : undefined;
    return observeCodeGraphBuildStatus(parsed, {
      isRunning,
      nowMilliseconds,
      processStartIdentity,
    });
  }).pipe(Effect.catch(() => Effect.succeed(undefined)));
}

export function parseCodeGraphBuildStatus(value: unknown): CodeGraphBuildStatus | undefined {
  if (!isRecord(value) || value.schemaVersion !== CODE_GRAPH_BUILD_STATUS_SCHEMA_VERSION) return undefined;
  if (!isText(value.buildId, 64) || !BUILD_ID.test(value.buildId)) return undefined;
  if (!isRecord(value.identity) || !isRecord(value.owner) || !isRecord(value.timestamps)) return undefined;
  if (
    !isHash(value.identity.repositoryId) ||
    !isHash(value.identity.checkoutId) ||
    !isHash(value.identity.worktreeId) ||
    !isText(value.identity.commit, 64) ||
    !COMMIT_ID.test(value.identity.commit) ||
    !Number.isSafeInteger(value.owner.processId) ||
    Number(value.owner.processId) <= 0 ||
    value.owner.runtime !== 'bun' ||
    !isText(value.owner.runtimeVersion, 64) ||
    !VALID_PHASES.has(value.phase as CodeGraphProgress['phase']) ||
    !VALID_STATES.has(value.state as CodeGraphBuildState)
  ) {
    return undefined;
  }
  const timestamps = value.timestamps;
  if (
    !isTimestamp(timestamps.startedAt) ||
    !isTimestamp(timestamps.phaseStartedAt) ||
    !isTimestamp(timestamps.lastProgressAt) ||
    !isTimestamp(timestamps.heartbeatAt) ||
    !isTimestamp(timestamps.updatedAt) ||
    (timestamps.completedAt !== undefined && !isTimestamp(timestamps.completedAt))
  ) {
    return undefined;
  }
  const counters = parseCounters(value.counters);
  if (!counters) return undefined;
  const ownerStart = value.owner.processStartIdentity;
  if (ownerStart !== undefined && !isText(ownerStart, 256)) return undefined;
  const subphase = value.subphase;
  if (subphase !== undefined && !isText(subphase, 64)) return undefined;
  const error = parseError(value.error);
  if (value.error !== undefined && !error) return undefined;
  const eta = parseEta(value.eta);
  if (value.eta !== undefined && !eta) return undefined;
  const result = parseResult(value.result);
  if (value.result !== undefined && !result) return undefined;
  return {
    buildId: value.buildId,
    counters,
    ...(error ? {error} : {}),
    ...(eta ? {eta} : {}),
    identity: {
      checkoutId: value.identity.checkoutId,
      commit: value.identity.commit,
      repositoryId: value.identity.repositoryId,
      worktreeId: value.identity.worktreeId,
    },
    owner: {
      processId: Number(value.owner.processId),
      ...(ownerStart ? {processStartIdentity: ownerStart} : {}),
      runtime: 'bun',
      runtimeVersion: value.owner.runtimeVersion,
    },
    phase: value.phase as CodeGraphProgress['phase'],
    ...(result ? {result} : {}),
    schemaVersion: CODE_GRAPH_BUILD_STATUS_SCHEMA_VERSION,
    state: value.state as CodeGraphBuildState,
    ...(subphase ? {subphase} : {}),
    timestamps: {
      ...(timestamps.completedAt ? {completedAt: timestamps.completedAt} : {}),
      heartbeatAt: timestamps.heartbeatAt,
      lastProgressAt: timestamps.lastProgressAt,
      phaseStartedAt: timestamps.phaseStartedAt,
      startedAt: timestamps.startedAt,
      updatedAt: timestamps.updatedAt,
    },
  };
}

function parseCounters(value: unknown): CodeGraphBuildCounters | undefined {
  if (!isRecord(value)) return undefined;
  const keys = [
    'accepted',
    'completed',
    'edges',
    'embedded',
    'excluded',
    'reused',
    'skipped',
    'symbols',
    'total',
  ] as const;
  for (const key of keys) {
    const counter = value[key];
    if (counter !== undefined && (!Number.isSafeInteger(counter) || Number(counter) < 0)) return undefined;
  }
  if (value.unit !== undefined && value.unit !== 'files' && value.unit !== 'symbols') return undefined;
  return Object.fromEntries(
    [...keys, 'unit' as const].flatMap(key => (value[key] === undefined ? [] : [[key, value[key]]])),
  ) as CodeGraphBuildCounters;
}

function parseError(value: unknown): CodeGraphBuildStatus['error'] | undefined {
  return isRecord(value) && isText(value.summary, 300) ? {summary: value.summary} : undefined;
}

function parseEta(value: unknown): CodeGraphBuildStatus['eta'] | undefined {
  return isRecord(value) &&
    value.scope === 'phase' &&
    ['high', 'low', 'medium'].includes(String(value.confidence)) &&
    Number.isSafeInteger(value.remainingMilliseconds) &&
    Number(value.remainingMilliseconds) >= 0
    ? {
        confidence: value.confidence as 'high' | 'low' | 'medium',
        remainingMilliseconds: Number(value.remainingMilliseconds),
        scope: 'phase',
      }
    : undefined;
}

function parseResult(value: unknown): CodeGraphBuildStatus['result'] | undefined {
  if (!isRecord(value) || typeof value.dirty !== 'boolean' || !isText(value.snapshotId, 128)) return undefined;
  for (const key of ['edges', 'files', 'symbols'] as const) {
    if (!Number.isSafeInteger(value[key]) || Number(value[key]) < 0) return undefined;
  }
  return {
    dirty: value.dirty,
    edges: Number(value.edges),
    files: Number(value.files),
    snapshotId: value.snapshotId,
    symbols: Number(value.symbols),
  };
}

function pruneCodeGraphBuildHistory(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  layout: CodeGraphLayout,
  worktreeId: string,
  currentBuildId: string,
) {
  return Effect.gen(function* () {
    const directory = path.dirname(codeGraphBuildStatusPath(path, layout, worktreeId, currentBuildId));
    if (!(yield* regularDirectory(fs, directory))) return;
    const candidates = yield* Effect.forEach(
      (yield* fs.readDirectory(directory)).filter(name => name.endsWith('.json')),
      name =>
        Effect.gen(function* () {
          const file = path.join(directory, name);
          const info = yield* fs.stat(file);
          return {file, modifiedAt: info.mtime._tag === 'Some' ? info.mtime.value.getTime() : 0};
        }).pipe(Effect.option),
      {concurrency: 4},
    );
    const removable = candidates
      .flatMap(candidate => (candidate._tag === 'Some' ? [candidate.value] : []))
      .sort((left, right) => right.modifiedAt - left.modifiedAt)
      .slice(STATUS_HISTORY_PER_WORKTREE);
    yield* Effect.forEach(removable, candidate => fs.remove(candidate.file, {force: true}), {
      concurrency: 1,
      discard: true,
    });
  }).pipe(Effect.catch(() => Effect.void));
}

function regularDirectory(fs: FileSystem.FileSystem, directory: string) {
  return Effect.gen(function* () {
    if (!(yield* fs.exists(directory))) return false;
    if ((yield* fs.readLink(directory).pipe(Effect.option))._tag === 'Some') return false;
    return (yield* fs.stat(directory)).type === 'Directory';
  }).pipe(Effect.catch(() => Effect.succeed(false)));
}

function compareObservedBuildStatus(left: ObservedCodeGraphBuildStatus, right: ObservedCodeGraphBuildStatus): number {
  const priority = (status: ObservedCodeGraphBuildStatus) =>
    status.observation.liveness === 'active'
      ? status.state === 'running'
        ? 0
        : 1
      : status.observation.liveness === 'stalled' || status.observation.liveness === 'abandoned'
        ? 2
        : 3;
  return (
    priority(left) - priority(right) || Date.parse(right.timestamps.updatedAt) - Date.parse(left.timestamps.updatedAt)
  );
}

function privacySafeError(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause);
  return boundedText(
    raw
      .replaceAll(/(?:[A-Za-z]:[\\/]|\/)(?:[^\s'"`<>]|\\ )+/g, '<local-path>')
      .replaceAll(/\s+/g, ' ')
      .trim() || 'Code graph build failed.',
    300,
  );
}

function boundedText(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, Math.max(0, maximum - 1))}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && HASH_ID.test(value);
}

function isText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\p{Cc}]/u.test(value);
}

function isTimestamp(value: unknown): value is string {
  return isText(value, 64) && Number.isFinite(Date.parse(value));
}
