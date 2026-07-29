import {Context, Effect, FileSystem, Layer, Path, Schedule, Stream, SynchronizedRef} from 'effect';
import {CodeGraphIndexer, type CodeGraphIndexerShape} from './indexer.js';

export interface CodeGraphWatchOptions {
  readonly cwd: string;
  readonly key: string;
  readonly onRefreshed?: (symbols: number, edges: number) => Effect.Effect<void>;
  readonly threadnoteHome: string;
}

export interface CodeGraphWatcherShape {
  readonly ensure: (options: CodeGraphWatchOptions) => Effect.Effect<void>;
  readonly watch: (options: CodeGraphWatchOptions) => Effect.Effect<void, unknown>;
}

export type CodeGraphWatchRun = (
  options: CodeGraphWatchOptions,
  initialRefresh: boolean,
) => Effect.Effect<void, unknown>;

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
      return yield* makeCodeGraphWatcher(run);
    }),
  );
}

export const makeCodeGraphWatcher = Effect.fn('codeGraph.makeWatcher')(function* (run: CodeGraphWatchRun) {
  const scope = yield* Effect.scope;
  const active = yield* SynchronizedRef.make(new Set<string>());
  const remove = (key: string) =>
    SynchronizedRef.update(active, current => {
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  return CodeGraphWatcher.of({
    ensure: options =>
      Effect.gen(function* () {
        const shouldStart = yield* SynchronizedRef.modify(active, current =>
          current.has(options.key)
            ? ([false, current] as const)
            : ([true, new Set([...current, options.key])] as const),
        );
        if (!shouldStart) return;
        yield* run(options, false).pipe(Effect.ensuring(remove(options.key)), Effect.forkIn(scope));
      }),
    watch: options => run(options, true),
  });
});

const watchRepository = Effect.fn('codeGraph.watchRepository')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  indexer: CodeGraphIndexerShape,
  options: CodeGraphWatchOptions,
  initialRefresh: boolean,
) {
  const index = indexer
    .index({cwd: options.cwd, threadnoteHome: options.threadnoteHome})
    .pipe(
      Effect.tap(
        summary => options.onRefreshed?.(summary.snapshot.symbolCount, summary.snapshot.edgeCount) ?? Effect.void,
      ),
    );
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
