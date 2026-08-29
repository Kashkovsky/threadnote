import {TestError} from '../helpers/test-error.js';
import {Database} from 'bun:sqlite';
import {it as effectIt} from '@effect/vitest';
import {Deferred, Effect, Fiber, FileSystem, Option, Path, Ref} from 'effect';
import * as FC from 'effect/testing/FastCheck';
import {describe, expect} from 'vitest';
import {EmbeddingFailed} from '../../src/effect/ai/errors.js';
import {LocalModelRuntime, type LocalEmbeddingError} from '../../src/effect/ai/local-model-runtime.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {BUILTIN_MODEL_MANIFESTS} from '../../src/models/builtin.js';
import {LocalModelCatalog} from '../../src/models/catalog.js';
import {selectLocalModel} from '../../src/models/selection.js';
import {LocalModelStore, type LocalModelStoreShape} from '../../src/models/store.js';
import {expireRecallIndexValidation, loadRecallIndexData, recallIndexStatus} from '../../src/recall/index.js';
import {loadMcpRecallSemanticScoresResult} from '../../src/recall/runtime.js';
import {
  ensureVectorIndex,
  vectorIndexDatabaseFilename,
  vectorIndexGenerationReadiness,
  vectorIndexStatus,
} from '../../src/search/vector-index.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const manifest = BUILTIN_MODEL_MANIFESTS.find(model => model.id === 'bge-small-en-v1.5-q8')!;

describe('MCP recall background vector refresh', () => {
  effectIt.effect.prop(
    'returns promptly and single-flights every bounded number of concurrent refreshes for one canonical home',
    {callers: FC.integer({max: 24, min: 2})},
    ({callers}) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-mcp-recall-refresh-'});
          const config = {account: 'local', agentContextHome: home, user: 'tester'};
          const resource = path.join(home, 'data', 'local', 'resources', 'repos', 'threadnote', 'refresh.md');
          const uri = 'threadnote://resources/repos/threadnote/refresh.md';
          yield* fs.makeDirectory(path.dirname(resource), {recursive: true});
          yield* fs.writeFileString(resource, '# Refresh\n\nOriginal semantic content.\n');

          const calls = yield* Ref.make(0);
          const refreshStarted = yield* Deferred.make<void>();
          const releaseRefresh = yield* Deferred.make<void>();
          const requestsCompleted = yield* Deferred.make<void>();
          const runtime = fakeRuntime((inputs, dimensions) =>
            Ref.updateAndGet(calls, count => count + 1).pipe(
              Effect.flatMap(call =>
                call === 2
                  ? Deferred.succeed(refreshStarted, undefined).pipe(Effect.andThen(Deferred.await(releaseRefresh)))
                  : Effect.void,
              ),
              Effect.as(inputs.map(() => unitVector(dimensions))),
            ),
          );
          const store = installedModelStore(home);

          yield* Effect.gen(function* () {
            const catalog = yield* LocalModelCatalog;
            yield* selectLocalModel(home, catalog, 'embedding', manifest.id);
            const initial = yield* loadRecallIndexData(config, {forceRefresh: true, includeInactive: false});
            yield* ensureVectorIndex(config, manifest, initial.candidates, {corpusGeneration: initial.generation});

            yield* fs.writeFileString(resource, '# Refresh\n\nChanged semantic content.\n');
            yield* expireRecallIndexValidation(home, false, [uri]);
            expect(yield* recallIndexStatus(config)).toMatchObject({
              ready: false,
              reason: 'canonical documents changed; run `threadnote repair`',
            });

            const requests = yield* Effect.all(
              Array.from({length: callers}, () =>
                loadMcpRecallSemanticScoresResult(config, 'changed semantic content', 5),
              ),
              {concurrency: 'unbounded'},
            ).pipe(Effect.ensuring(Deferred.succeed(requestsCompleted, undefined)), Effect.forkChild);
            yield* Deferred.await(refreshStarted);
            yield* Effect.forEach(Array.from({length: 20}), () => Effect.yieldNow, {discard: true});
            expect(Option.isSome(yield* Deferred.poll(requestsCompleted))).toBe(true);
            const results = yield* Fiber.join(requests);
            expect(results).toHaveLength(callers);
            expect(results.every(result => result.status === 'unavailable')).toBe(true);
            expect(
              results.every(result => Option.getOrUndefined(result.result.warning)?.includes('background refresh')),
            ).toBe(true);
            expect(
              results.every(result => Option.getOrUndefined(result.result.warning)?.includes('without waiting')),
            ).toBe(true);
            expect(
              results.every(
                result =>
                  new TextEncoder().encode(Option.getOrUndefined(result.result.warning) ?? '').byteLength <= 180,
              ),
            ).toBe(true);
            expect(yield* Ref.get(calls)).toBe(2);

            yield* Deferred.succeed(releaseRefresh, undefined);
            const refreshedGeneration = yield* awaitRefreshedRecallReadiness(config, initial.generation);
            expect(yield* vectorIndexGenerationReadiness(home, manifest, refreshedGeneration)).toBe('current');
            expect((yield* recallIndexStatus(config)).ready).toBe(true);
            const available = yield* loadMcpRecallSemanticScoresResult(config, 'changed semantic content', 5);
            expect(available.status).toBe('available');
          }).pipe(
            Effect.provideService(LocalModelRuntime, runtime),
            Effect.provideService(LocalModelStore, store),
            Effect.ensuring(Deferred.succeed(releaseRefresh, undefined)),
          );
        }),
      ).pipe(provideTestLayer(ApplicationLayer)),
    {fastCheck: {numRuns: 8}},
  );

  effectIt.effect('builds missing lexical and vector indexes after a non-blocking first-use request', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-mcp-recall-first-use-'});
        const config = {account: 'local', agentContextHome: home, user: 'tester'};
        const resource = path.join(home, 'data', 'local', 'resources', 'repos', 'threadnote', 'first-use.md');
        yield* fs.makeDirectory(path.dirname(resource), {recursive: true});
        yield* fs.writeFileString(resource, '# First use\n\nFirst-use semantic content.\n');
        const calls = yield* Ref.make(0);
        const runtime = fakeRuntime((inputs, dimensions) =>
          Ref.update(calls, count => count + 1).pipe(Effect.as(inputs.map(() => unitVector(dimensions)))),
        );

        yield* Effect.gen(function* () {
          const catalog = yield* LocalModelCatalog;
          yield* selectLocalModel(home, catalog, 'embedding', manifest.id);
          expect(yield* recallIndexStatus(config)).toMatchObject({
            ready: false,
            reason: 'not built; run `threadnote repair`',
          });

          const first = yield* loadMcpRecallSemanticScoresResult(config, 'first-use semantic content', 5);
          expect(first.status).toBe('unavailable');
          expect(Option.getOrUndefined(first.result.warning)).toContain('background refresh');
          const generation = yield* awaitRefreshedRecallReadiness(config);
          expect(yield* vectorIndexGenerationReadiness(home, manifest, generation)).toBe('current');

          const second = yield* loadMcpRecallSemanticScoresResult(config, 'first-use semantic content', 5);
          expect(second.status).toBe('available');
          expect(yield* Ref.get(calls)).toBeGreaterThanOrEqual(2);
        }).pipe(
          Effect.provideService(LocalModelRuntime, runtime),
          Effect.provideService(LocalModelStore, installedModelStore(home)),
        );
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('clears failed single-flight state so a later request retries', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-mcp-recall-retry-'});
        const config = {account: 'local', agentContextHome: home, user: 'tester'};
        const resource = path.join(home, 'data', 'local', 'resources', 'repos', 'threadnote', 'retry.md');
        yield* fs.makeDirectory(path.dirname(resource), {recursive: true});
        yield* fs.writeFileString(resource, '# Retry\n\nRetry semantic content.\n');
        const index = yield* loadRecallIndexData(config, {forceRefresh: true, includeInactive: false});

        const calls = yield* Ref.make(0);
        const firstAttempted = yield* Deferred.make<void>();
        const runtime = fakeRuntime((inputs, dimensions) =>
          Ref.updateAndGet(calls, count => count + 1).pipe(
            Effect.flatMap(call =>
              call === 1
                ? Deferred.succeed(firstAttempted, undefined).pipe(
                    Effect.andThen(
                      Effect.fail(
                        new EmbeddingFailed({
                          cause: new TestError('synthetic background refresh failure'),
                          message: 'Synthetic background refresh failure.',
                          modelId: manifest.id,
                        }),
                      ),
                    ),
                  )
                : Effect.succeed(inputs.map(() => unitVector(dimensions))),
            ),
          ),
        );

        yield* Effect.gen(function* () {
          const catalog = yield* LocalModelCatalog;
          yield* selectLocalModel(home, catalog, 'embedding', manifest.id);
          const first = yield* loadMcpRecallSemanticScoresResult(config, 'retry semantic content', 5);
          expect(first.status).toBe('unavailable');
          yield* Deferred.await(firstAttempted);
          yield* Effect.forEach(Array.from({length: 20}), () => Effect.yieldNow, {discard: true});

          let second = yield* loadMcpRecallSemanticScoresResult(config, 'retry semantic content', 5);
          for (let attempt = 0; attempt < 20 && (yield* Ref.get(calls)) < 2; attempt += 1) {
            yield* Effect.yieldNow;
            second = yield* loadMcpRecallSemanticScoresResult(config, 'retry semantic content', 5);
          }
          expect(second.status).toBe('unavailable');
          expect(yield* awaitVectorReadiness(home, index.generation, 'current')).toBe('current');
          expect(yield* Ref.get(calls)).toBe(2);
        }).pipe(
          Effect.provideService(LocalModelRuntime, runtime),
          Effect.provideService(LocalModelStore, installedModelStore(home)),
        );
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('leaves corrupt vector rows untouched and never schedules repair', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-mcp-recall-corrupt-'});
        const config = {account: 'local', agentContextHome: home, user: 'tester'};
        const resource = path.join(home, 'data', 'local', 'resources', 'repos', 'threadnote', 'corrupt.md');
        yield* fs.makeDirectory(path.dirname(resource), {recursive: true});
        yield* fs.writeFileString(resource, '# Corrupt\n\nCorrupt semantic content.\n');
        const calls = yield* Ref.make(0);
        const runtime = fakeRuntime((inputs, dimensions) =>
          Ref.update(calls, count => count + 1).pipe(Effect.as(inputs.map(() => unitVector(dimensions)))),
        );

        yield* Effect.gen(function* () {
          const catalog = yield* LocalModelCatalog;
          yield* selectLocalModel(home, catalog, 'embedding', manifest.id);
          const index = yield* loadRecallIndexData(config, {forceRefresh: true, includeInactive: false});
          yield* ensureVectorIndex(config, manifest, index.candidates, {corpusGeneration: index.generation});
          const databasePath = path.join(home, 'indexes', 'vectors', manifest.id, vectorIndexDatabaseFilename());
          yield* Effect.sync(() => {
            const database = new Database(databasePath);
            try {
              database.exec('UPDATE vector_values SET vector = zeroblob(4)');
            } finally {
              database.close();
            }
          });

          const result = yield* loadMcpRecallSemanticScoresResult(config, 'corrupt semantic content', 5);
          expect(result.status).toBe('failed');
          expect(Option.getOrUndefined(result.result.warning)).toContain('deterministic lexical recall continued');
          yield* Effect.forEach(Array.from({length: 50}), () => Effect.yieldNow, {discard: true});
          expect(yield* Ref.get(calls)).toBe(2);
          expect((yield* vectorIndexStatus(home, manifest)).ready).toBe(false);
          expect(
            yield* Effect.sync(() => {
              const database = new Database(databasePath, {readonly: true});
              try {
                return database.query('SELECT length(vector) AS bytes FROM vector_values').get();
              } finally {
                database.close();
              }
            }),
          ).toEqual({bytes: 4});
        }).pipe(
          Effect.provideService(LocalModelRuntime, runtime),
          Effect.provideService(LocalModelStore, installedModelStore(home)),
        );
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );
});

function fakeRuntime(
  embed: (
    inputs: readonly string[],
    dimensions: number,
  ) => Effect.Effect<readonly (readonly number[])[], LocalEmbeddingError>,
) {
  return LocalModelRuntime.of({
    diagnostics: Effect.succeed({backend: 'fake', buildType: 'prebuilt', cpuMathCores: 4}),
    embedMany: ({inputs, manifest: requested}) => embed(inputs, requested.dimensions ?? 0),
    generate: () => Effect.die(new TestError('Unexpected generation')),
    rerank: () => Effect.die(new TestError('Unexpected reranking')),
  });
}

function installedModelStore(home: string): LocalModelStoreShape {
  const installation = {
    bytes: manifest.size,
    installed: true,
    modelId: manifest.id,
    partialBytes: 0,
    path: `${home}/models/fake.gguf`,
    verified: true,
  };
  return LocalModelStore.of({
    install: () => Effect.die(new TestError('Unexpected install')),
    path: () => installation.path,
    remove: () => Effect.succeed(false),
    status: () => Effect.succeed(installation),
    verify: () => Effect.succeed(installation),
  });
}

function unitVector(dimensions: number): readonly number[] {
  const vector = new Array<number>(dimensions).fill(0);
  vector[0] = 1;
  return vector;
}

const awaitVectorReadiness = Effect.fn('test.awaitVectorReadiness')(function* (
  home: string,
  generation: string,
  expected: 'current',
) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const readiness = yield* vectorIndexGenerationReadiness(home, manifest, generation);
    if (readiness === expected) return readiness;
    yield* Effect.yieldNow;
  }
  return yield* vectorIndexGenerationReadiness(home, manifest, generation);
});

const awaitRefreshedRecallReadiness = Effect.fn('test.awaitRefreshedRecallReadiness')(function* (
  config: {readonly account: string; readonly agentContextHome: string; readonly user: string},
  previousGeneration?: string,
) {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const status = yield* recallIndexStatus(config);
    if (status.ready && status.generation && status.generation !== previousGeneration) {
      const readiness = yield* vectorIndexGenerationReadiness(config.agentContextHome, manifest, status.generation);
      if (readiness === 'current') return status.generation;
    }
    yield* Effect.yieldNow;
  }
  throw new TestError('Background refresh did not produce current lexical and vector indexes.');
});
