import {Clock, Deferred, Effect, Fiber, FileSystem} from 'effect';
import {afterEach, describe, expect, it} from 'vitest';
import {repairCodeGraphIndexes} from '../../src/code_graph/maintenance.js';
import {CODE_GRAPH_SCHEMA_VERSION} from '../../src/code_graph/types.js';
import {withExclusiveFileLock} from '../../src/effect/file_lock.js';
import {join, mkdir, mkdtemp, rm, writeFile} from '../helpers/effect-filesystem.js';
import {runEffect} from '../helpers/effect-runtime.js';

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
    const lockPath = join(home, 'locks', 'indexes', 'code-graph', `${checkoutId}.lock`);
    await mkdir(repositoryRoot, {recursive: true});
    await writeFile(databasePath, 'this file must never be opened while its build lock is active');
    const progress: string[] = [];

    const result = await runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
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
});
