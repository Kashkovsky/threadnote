import {Context, Effect, FileSystem, Layer, Option, Path, Schedule, Stream, SynchronizedRef} from 'effect';
import {CodeGraphIndexer, type CodeGraphIndexerShape} from './indexer.js';
import type {CodeGraphProgress} from './types.js';

export interface CodeGraphWatchOptions {
  readonly cwd: string;
  readonly key: string;
  readonly onProgress?: (progress: CodeGraphProgress) => Effect.Effect<void>;
  readonly onRefreshed?: (symbols: number, edges: number) => Effect.Effect<void>;
  readonly threadnoteHome: string;
}

export type CodeGraphRefreshStatus =
  | {
      readonly progress?: CodeGraphProgress;
      readonly state: 'indexing';
    }
  | {
      readonly edges: number;
      readonly state: 'ready';
      readonly symbols: number;
    }
  | {
      readonly message: string;
      readonly state: 'failed';
    };

export interface CodeGraphWatcherShape {
  readonly ensure: (options: CodeGraphWatchOptions) => Effect.Effect<void>;
  readonly refresh: (options: CodeGraphWatchOptions) => Effect.Effect<void>;
  readonly status: (key: string) => Effect.Effect<Option.Option<CodeGraphRefreshStatus>>;
  readonly watch: (options: CodeGraphWatchOptions) => Effect.Effect<void, unknown>;
}

export type CodeGraphWatchRun = (
  options: CodeGraphWatchOptions,
  initialRefresh: boolean,
) => Effect.Effect<void, unknown>;

export type CodeGraphRefreshRun = (options: CodeGraphWatchOptions) => Effect.Effect<void, unknown>;

export class CodeGraphWatcher extends Context.Service<CodeGraphWatcher, CodeGraphWatcherShape>()(
  'threadnote/codeGraph/CodeGraphWatcher',
) {
  static readonly layer = Layer.effect(
    CodeGraphWatcher,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const indexer = yield* CodeGraphIndexer;
      const run = (options: CodeGraphWatchOptions, initialRefresh: boolean) =>
        watchRepository(fs, path, indexer, options, initialRefresh);
      const refresh = (options: CodeGraphWatchOptions) => indexRepository(indexer, options).pipe(Effect.asVoid);
      return yield* makeCodeGraphWatcher(run, refresh);
    }),
  );
}

export const makeCodeGraphWatcher = Effect.fn('codeGraph.makeWatcher')(function* (
  run: CodeGraphWatchRun,
  refreshRun: CodeGraphRefreshRun,
) {
  const scope = yield* Effect.scope;
  const activeWatches = yield* SynchronizedRef.make(new Set<string>());
  const activeRefreshes = yield* SynchronizedRef.make(new Set<string>());
  const refreshStatuses = yield* SynchronizedRef.make(new Map<string, CodeGraphRefreshStatus>());
  const remove = (ref: SynchronizedRef.SynchronizedRef<Set<string>>, key: string) =>
    SynchronizedRef.update(ref, current => {
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  const setStatus = (key: string, status: CodeGraphRefreshStatus) =>
    SynchronizedRef.update(refreshStatuses, current => new Map(current).set(key, status));
  const trackedRefreshOptions = (options: CodeGraphWatchOptions): CodeGraphWatchOptions => ({
    ...options,
    onProgress: progress =>
      setStatus(options.key, {progress, state: 'indexing'}).pipe(
        Effect.andThen(options.onProgress?.(progress) ?? Effect.void),
      ),
    onRefreshed: (symbols, edges) =>
      setStatus(options.key, {edges, state: 'ready', symbols}).pipe(
        Effect.andThen(options.onRefreshed?.(symbols, edges) ?? Effect.void),
      ),
  });
  return CodeGraphWatcher.of({
    ensure: options =>
      Effect.gen(function* () {
        const shouldStart = yield* SynchronizedRef.modify(activeWatches, current =>
          current.has(options.key)
            ? ([false, current] as const)
            : ([true, new Set([...current, options.key])] as const),
        );
        if (!shouldStart) return;
        yield* run(options, false).pipe(Effect.ensuring(remove(activeWatches, options.key)), Effect.forkIn(scope));
      }),
    refresh: options =>
      Effect.gen(function* () {
        const shouldStart = yield* SynchronizedRef.modify(activeRefreshes, current =>
          current.has(options.key)
            ? ([false, current] as const)
            : ([true, new Set([...current, options.key])] as const),
        );
        if (!shouldStart) return;
        yield* setStatus(options.key, {state: 'indexing'});
        yield* refreshRun(trackedRefreshOptions(options)).pipe(
          Effect.catchCause(cause =>
            setStatus(options.key, {message: String(cause), state: 'failed'}).pipe(
              Effect.andThen(
                Effect.logWarning(`Code graph background refresh failed for ${options.cwd}: ${String(cause)}`),
              ),
            ),
          ),
          Effect.ensuring(remove(activeRefreshes, options.key)),
          Effect.forkIn(scope),
        );
      }),
    status: key =>
      SynchronizedRef.get(refreshStatuses).pipe(Effect.map(current => Option.fromUndefinedOr(current.get(key)))),
    watch: options => run(options, true),
  });
});

const indexRepository = (indexer: CodeGraphIndexerShape, options: CodeGraphWatchOptions) =>
  indexer
    .index({
      cwd: options.cwd,
      onProgress: options.onProgress,
      threadnoteHome: options.threadnoteHome,
    })
    .pipe(
      Effect.tap(
        summary => options.onRefreshed?.(summary.snapshot.symbolCount, summary.snapshot.edgeCount) ?? Effect.void,
      ),
    );

const watchRepository = Effect.fn('codeGraph.watchRepository')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  indexer: CodeGraphIndexerShape,
  options: CodeGraphWatchOptions,
  initialRefresh: boolean,
) {
  const index = indexRepository(indexer, options);
  if (initialRefresh) yield* index;
  const refresh = index.pipe(
    Effect.catchCause(cause =>
      Effect.logWarning(`Code graph session refresh failed for ${options.cwd}: ${String(cause)}`),
    ),
  );
  const changes = fs.watch(options.cwd).pipe(
    Stream.filter(event => relevantWatchPath(path, options.cwd, event.path)),
    Stream.debounce('750 millis'),
    Stream.map(() => undefined),
    Stream.catchCause(cause =>
      Stream.fromEffect(Effect.logWarning(`Code graph filesystem watch failed for ${options.cwd}: ${String(cause)}`)),
    ),
  );
  const reconciliation = Stream.fromSchedule(Schedule.spaced('5 minutes')).pipe(Stream.map(() => undefined));
  yield* Stream.merge(changes, reconciliation).pipe(Stream.runForEach(() => refresh));
});

function relevantWatchPath(path: Path.Path, cwd: string, eventPath: string): boolean {
  const absolute = path.isAbsolute(eventPath) ? eventPath : path.join(cwd, eventPath);
  const relative = path.relative(cwd, absolute);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return false;
  }
  const segments = relative.split(path.sep);
  return !segments.some(
    segment => segment.startsWith('.') && segment !== '.gitignore' && segment !== '.threadnoteignore',
  );
}
