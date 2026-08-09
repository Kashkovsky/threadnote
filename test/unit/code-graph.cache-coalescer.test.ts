import {it as effectIt} from '@effect/vitest';
import {Deferred, Effect, Fiber, Option} from 'effect';
import {describe, expect} from 'vitest';
import {
  CODE_GRAPH_CACHE_TRANSACTION_LIMITS,
  codeGraphFileBlobCapacityBytes,
} from '../../src/code_graph/cache_capacity.js';
import {codeGraphBlobReuseCacheKey} from '../../src/code_graph/blob_reuse.js';
import {serializeBoundedCodeGraphFact} from '../../src/code_graph/fact_budget.js';
import {cacheContentBatch, type CodeGraphCacheExtractedRow} from '../../src/code_graph/indexer.js';
import type {CodeGraphContentBatchContext} from '../../src/code_graph/inventory.js';
import type {CodeGraphLanguagePackRegistryShape} from '../../src/code_graph/languages/registry.js';
import {extractStructuredSchemaFacts} from '../../src/code_graph/languages/schemas/extractor.js';
import type {CodeGraphParserPoolShape, CodeGraphParserResult} from '../../src/code_graph/parser_worker.js';
import type {CodeGraphDirectPersistentCapacityProtector, CodeGraphStoreShape} from '../../src/code_graph/store.js';
import type {TreeSitterRuntimeShape} from '../../src/code_graph/tree_sitter/runtime.js';
import type {CodeGraphFileFacts, CodeGraphInventoryFile} from '../../src/code_graph/types.js';

interface CacheCall {
  readonly cacheIdentity: string;
  readonly facts: readonly {readonly facts: CodeGraphFileFacts; readonly json: string}[];
  readonly files: readonly CodeGraphInventoryFile[];
}

const unprotectedCacheWrite: CodeGraphDirectPersistentCapacityProtector = (_boundary, transaction) => transaction;

describe('code graph parser cache coalescer', () => {
  effectIt.effect(
    'coalesces 73,000 tiny rows across 128-file callbacks into 143 bounded receipts',
    () =>
      Effect.gen(function* () {
        const files = Array.from({length: 73_000}, (_, index) => cacheFile(index, 'src/alpha'));
        const harness = coalescerHarness({capacity: 128});

        for (let offset = 0; offset < files.length; offset += 128) {
          const batch = files.slice(offset, offset + 128);
          yield* harness.acceptExtracted(
            batch.map(file => extractedRow(file)),
            cacheContext(batch.length),
          );
        }
        expect(harness.calls).toHaveLength(142);
        yield* harness.flush();

        expect(harness.calls).toHaveLength(143);
        expect(harness.calls.slice(0, -1).every(call => call.files.length === 512)).toBe(true);
        expect(harness.calls.at(-1)?.files.length).toBe(296);
        expect(harness.calls.reduce((total, call) => total + call.files.length, 0)).toBe(73_000);
        expect(harness.calls[0]?.files[0]?.path).toBe('src/alpha/file-000000.ts');
        expect(harness.calls.at(-1)?.files.at(-1)?.path).toBe('src/alpha/file-072999.ts');
        assertCacheCallsBounded(harness.calls);
      }),
    30_000,
  );

  effectIt.effect('groups mixed durable/degraded identities deterministically under one global envelope', () =>
    Effect.gen(function* () {
      const files = Array.from({length: 1_025}, (_, index) =>
        cacheFile(index, index % 2 === 0 ? 'src/alpha' : 'src/beta'),
      );
      const facts = (file: CodeGraphInventoryFile): CodeGraphParserResult => ({
        degraded: Number(file.path.match(/(\d+)\.ts$/u)?.[1] ?? 0) % 5 === 0,
        facts: emptyFacts(file.path),
        parseMilliseconds: 0,
      });
      const persistenceProgress: Array<{readonly completed: number; readonly total: number}> = [];
      const first = coalescerHarness({
        capacity: 7,
        facts,
        onProgress: progress =>
          Effect.sync(() => {
            if (progress.phase === 'scanning' && progress.activity?.stage === 'persisting') {
              persistenceProgress.push({
                completed: progress.activity.batchCompleted,
                total: progress.activity.batchTotal,
              });
            }
          }),
      });
      const second = coalescerHarness({capacity: 7, facts});

      for (let offset = 0; offset < files.length; offset += 128) {
        const batch = files.slice(offset, offset + 128);
        yield* first.run(batch, cacheContext(batch.length));
        yield* second.run([...batch].reverse(), cacheContext(batch.length));
      }
      yield* first.flush();
      yield* second.flush();

      expect(cacheCallIdentity(first.calls)).toEqual(cacheCallIdentity(second.calls));
      expect(first.calls.reduce((total, call) => total + call.files.length, 0)).toBe(files.length);
      for (const call of first.calls) {
        const baseIdentities = new Set(call.files.map(file => cacheIdentityForPath(file.path)));
        const degradationStates = new Set(
          call.files.map(file => (Number(file.path.match(/(\d+)\.ts$/u)?.[1] ?? 0) % 5 === 0 ? 'degraded' : 'durable')),
        );
        expect(baseIdentities.size).toBe(1);
        expect(degradationStates.size).toBe(1);
      }
      assertCacheCallsBounded(first.calls);
      expect(persistenceProgress.length).toBe(first.calls.length * 2);
      expect(persistenceProgress.every(value => value.completed >= 0 && value.completed <= value.total)).toBe(true);
      for (let index = 0; index < persistenceProgress.length; index += 2) {
        expect(persistenceProgress[index]?.completed).toBe(0);
        expect(persistenceProgress[index + 1]?.completed).toBe(persistenceProgress[index + 1]?.total);
      }
    }),
  );

  effectIt.effect(
    'keeps an exact committed prefix when interrupted after a payload flush and converges on retry',
    () =>
      Effect.gen(function* () {
        const diagnostic = '界'.repeat(2_300_000);
        const files = Array.from({length: 5}, (_, index) => cacheFile(index, 'src/payload'));
        const secondWriterEntered = yield* Deferred.make<void>();
        const committed = new Map<string, string>();
        let writes = 0;
        const harness = coalescerHarness({
          capacity: 3,
          facts: file => ({
            degraded: false,
            facts: {...emptyFacts(file.path), diagnostics: [diagnostic]},
            parseMilliseconds: 0,
          }),
          onCache: call => {
            writes += 1;
            return writes === 1
              ? Effect.sync(() => {
                  for (let index = 0; index < call.files.length; index += 1) {
                    committed.set(call.files[index]!.path, call.facts[index]!.json);
                  }
                })
              : Deferred.succeed(secondWriterEntered, undefined).pipe(Effect.andThen(Effect.never));
          },
        });

        yield* harness.run(files, cacheContext(files.length));
        expect(harness.calls).toHaveLength(1);
        const interrupted = yield* harness.flush().pipe(Effect.ensuring(harness.discard()), Effect.forkChild);
        yield* Deferred.await(secondWriterEntered);
        yield* Fiber.interrupt(interrupted);

        expect(harness.calls).toHaveLength(2);
        expect(committed.size).toBe(harness.calls[0]!.files.length);
        expect(committed.size).toBeGreaterThan(0);
        expect(committed.size).toBeLessThan(files.length);
        assertCacheCallsBounded(harness.calls);
        yield* harness.flush();
        expect(harness.calls).toHaveLength(2);

        const retry = coalescerHarness({
          capacity: 3,
          facts: file => ({
            degraded: false,
            facts: {...emptyFacts(file.path), diagnostics: [diagnostic]},
            parseMilliseconds: 0,
          }),
          onCache: call =>
            Effect.sync(() => {
              for (let index = 0; index < call.files.length; index += 1) {
                committed.set(call.files[index]!.path, call.facts[index]!.json);
              }
            }),
        });
        yield* retry.run(files, cacheContext(files.length));
        yield* retry.flush();

        expect([...committed.keys()].sort()).toEqual(files.map(file => file.path));
        expect(retry.calls).toHaveLength(2);
        assertCacheCallsBounded(retry.calls);
      }),
    30_000,
  );

  effectIt.effect('drops heavyweight source payloads while retaining rows across inventory callbacks', () =>
    Effect.gen(function* () {
      const sharedLargeSource = new Uint8Array(8 * 1_048_576);
      const files = Array.from({length: 513}, (_, index) => ({
        ...cacheFile(index, 'src/source-memory'),
        bytes: sharedLargeSource,
        content: 'source content must not survive its extraction callback',
        size: sharedLargeSource.byteLength,
      }));
      const harness = coalescerHarness({capacity: 8});

      for (let offset = 0; offset < files.length; offset += 128) {
        const batch = files.slice(offset, offset + 128);
        yield* harness.acceptExtracted(
          batch.map(file => extractedRow(file)),
          cacheContext(batch.length),
        );
      }
      expect(harness.calls).toHaveLength(1);
      yield* harness.flush();

      expect(harness.calls).toHaveLength(2);
      expect(harness.calls.every(call => call.files.every(file => !('bytes' in file) && !('content' in file)))).toBe(
        true,
      );
      expect(harness.calls.reduce((total, call) => total + call.files.length, 0)).toBe(files.length);
    }),
  );

  effectIt.effect('flushes a committed path before accepting its dirty-overlay hash', () =>
    Effect.gen(function* () {
      const committed = {...cacheFile(1, 'src/duplicate'), contentHash: 'a'.repeat(64), source: 'commit' as const};
      const overlay = {...committed, contentHash: 'b'.repeat(64), source: 'worktree' as const};
      const harness = coalescerHarness({capacity: 2});

      yield* harness.acceptExtracted([extractedRow(committed)], cacheContext(1));
      expect(harness.calls).toEqual([]);
      yield* harness.acceptExtracted([extractedRow(overlay)], cacheContext(1));
      expect(harness.calls).toHaveLength(1);
      yield* harness.flush();

      expect(harness.calls).toHaveLength(2);
      expect(harness.calls.map(call => call.files.map(file => file.contentHash))).toEqual([
        ['a'.repeat(64)],
        ['b'.repeat(64)],
      ]);
      expect(harness.calls.every(call => call.files[0]?.path === committed.path)).toBe(true);
    }),
  );

  effectIt.effect('extracts one eligible Git blob once across committed inventory callbacks', () =>
    Effect.gen(function* () {
      const content = '{"nested":{"enabled":true},"items":[{"name":"one"}]}';
      const donor = structuredCacheFile('config/donor.json', content);
      const target = structuredCacheFile('config/copies/target.json', content);
      const reuseKey = codeGraphBlobReuseCacheKey(donor, cacheIdentityForPath(donor.path))!;
      const context = {...cacheContext(2), blobReuseCounts: new Map([[reuseKey, 2]])};
      let extractions = 0;
      const harness = coalescerHarness({
        capacity: 2,
        facts: file => {
          extractions += 1;
          return {
            degraded: false,
            facts: extractStructuredSchemaFacts(file, {packageName: Option.none(), project: Option.none()}),
            parseMilliseconds: 1,
          };
        },
      });

      yield* harness.run([donor], context);
      yield* harness.run([target], context);
      yield* harness.flush();

      expect(extractions).toBe(1);
      const cachedFacts = new Map(
        harness.calls.flatMap(call => call.facts.map(fact => [fact.facts.path, fact.facts] as const)),
      );
      expect(cachedFacts.get(donor.path)).toEqual(
        extractStructuredSchemaFacts(donor, {packageName: Option.none(), project: Option.none()}),
      );
      expect(cachedFacts.get(target.path)).toEqual(
        extractStructuredSchemaFacts(target, {packageName: Option.none(), project: Option.none()}),
      );
    }),
  );

  effectIt.effect('never reuses or publishes blob metadata for a degraded extraction', () =>
    Effect.gen(function* () {
      const content = '{"nested":{"enabled":true}}';
      const donor = structuredCacheFile('config/degraded.json', content);
      const target = structuredCacheFile('config/copies/degraded.json', content);
      const reuseKey = codeGraphBlobReuseCacheKey(donor, cacheIdentityForPath(donor.path))!;
      const context = {...cacheContext(2), blobReuseCounts: new Map([[reuseKey, 2]])};
      let extractions = 0;
      const harness = coalescerHarness({
        capacity: 2,
        facts: file => {
          extractions += 1;
          return {degraded: true, facts: emptyFacts(file.path), parseMilliseconds: 1};
        },
      });

      yield* harness.run([donor], context);
      yield* harness.run([target], context);
      yield* harness.flush();

      expect(extractions).toBe(2);
      expect(harness.calls.flatMap(call => call.files).every(file => file.blobId === '')).toBe(true);
    }),
  );

  effectIt.effect('discards an interrupted pending window without starting a cache writer', () =>
    Effect.gen(function* () {
      const thirdExtractionEntered = yield* Deferred.make<void>();
      let extractions = 0;
      const harness = coalescerHarness({
        capacity: 1,
        facts: file => {
          extractions += 1;
          const result = {
            degraded: false,
            facts: emptyFacts(file.path),
            parseMilliseconds: 0,
          } satisfies CodeGraphParserResult;
          return extractions === 3
            ? Deferred.succeed(thirdExtractionEntered, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.succeed(result);
        },
      });
      const files = Array.from({length: 3}, (_, index) => cacheFile(index, 'src/cancel'));

      const caching = yield* harness
        .run(files, cacheContext(files.length))
        .pipe(Effect.ensuring(harness.discard()), Effect.forkChild);
      yield* Deferred.await(thirdExtractionEntered);
      yield* Fiber.interrupt(caching);

      expect(extractions).toBe(3);
      expect(harness.calls).toEqual([]);
    }),
  );

  effectIt.effect('discards pending rows after a later-window failure without starting a cache writer', () =>
    Effect.gen(function* () {
      const harness = coalescerHarness({
        capacity: 1,
        onProgress: progress =>
          progress.phase === 'scanning' &&
          progress.activity?.stage === 'extracting' &&
          progress.activity.path.endsWith('000002.ts')
            ? Effect.fail(new Error('injected later-window progress failure'))
            : Effect.void,
      });
      const files = Array.from({length: 3}, (_, index) => cacheFile(index, 'src/failure'));

      const failure = yield* harness
        .run(files, cacheContext(files.length))
        .pipe(Effect.ensuring(harness.discard()), Effect.flip);

      expect(failure).toBeInstanceOf(Error);
      expect(harness.calls).toEqual([]);
    }),
  );
});

function coalescerHarness(options: {
  readonly capacity: number;
  readonly facts?: (
    file: CodeGraphInventoryFile,
  ) => CodeGraphParserResult | Effect.Effect<CodeGraphParserResult, never>;
  readonly onCache?: (call: CacheCall) => Effect.Effect<void, never>;
  readonly onProgress?: Parameters<typeof cacheContentBatch>[0]['onProgress'];
}) {
  const calls: CacheCall[] = [];
  const parserPool = {
    capacity: options.capacity,
    extract: (file: CodeGraphInventoryFile) => {
      const result = options.facts?.(file) ?? {
        degraded: false,
        facts: emptyFacts(file.path),
        parseMilliseconds: 0,
      };
      return Effect.isEffect(result) ? result : Effect.succeed(result);
    },
    trimIdle: () => Effect.void,
  } satisfies CodeGraphParserPoolShape;
  const store = {
    cacheFacts: (
      _databasePath: string,
      files: readonly CodeGraphInventoryFile[],
      facts: CacheCall['facts'],
      cacheIdentity: string,
    ) =>
      Effect.sync(() => {
        const call = {cacheIdentity, facts, files};
        calls.push(call);
        return call;
      }).pipe(Effect.flatMap(call => options.onCache?.(call) ?? Effect.void)),
  } as unknown as CodeGraphStoreShape;
  const coalescer = cacheContentBatch({
    databasePath: '/bounded/cache.sqlite',
    languagePacks: {
      cacheIdentityForPath: path => Option.some(cacheIdentityForPath(path)),
    } as CodeGraphLanguagePackRegistryShape,
    onProgress: options.onProgress,
    parserPool,
    persistentCapacityProtector: unprotectedCacheWrite,
    store,
    threadnoteHome: '/bounded/home',
    treeSitter: {} as TreeSitterRuntimeShape,
  });
  return {...coalescer, calls, run: coalescer.onContentBatch};
}

function cacheFile(index: number, directory: string): CodeGraphInventoryFile {
  const suffix = index.toString().padStart(6, '0');
  return {
    blobId: index.toString(16).padStart(40, '0'),
    contentHash: index.toString(16).padStart(64, '0'),
    language: 'typescript',
    mode: '100644',
    path: `${directory}/file-${suffix}.ts`,
    size: 1,
    source: 'commit',
  };
}

function structuredCacheFile(path: string, content: string): CodeGraphInventoryFile {
  return {
    blobId: 'a'.repeat(40),
    content,
    contentHash: 'b'.repeat(64),
    language: 'json',
    mode: '100644',
    path,
    size: Buffer.byteLength(content),
    source: 'commit',
  };
}

function cacheIdentityForPath(path: string): string {
  return path.includes('/beta/') ? 'cache-beta-v1' : 'cache-alpha-v1';
}

function emptyFacts(path: string): CodeGraphFileFacts {
  return {diagnostics: [], edges: [], path, symbols: []};
}

function extractedRow(file: CodeGraphInventoryFile): CodeGraphCacheExtractedRow {
  return {
    cacheFact: serializeBoundedCodeGraphFact(emptyFacts(file.path)),
    cacheIdentity: cacheIdentityForPath(file.path),
    degraded: false,
    file,
  };
}

function cacheContext(total: number): CodeGraphContentBatchContext {
  return {
    progress: {accepted: total, completed: total, excluded: 0, phase: 'scanning', skipped: 0, total, unit: 'files'},
    readingMilliseconds: 0,
    sourceBytes: total,
  };
}

function cacheCallIdentity(calls: readonly CacheCall[]) {
  return calls.map(call => ({cacheIdentity: call.cacheIdentity, paths: call.files.map(file => file.path)}));
}

function assertCacheCallsBounded(calls: readonly CacheCall[]) {
  for (const call of calls) {
    const payloadBytes = call.files.reduce(
      (total, file, index) =>
        total +
        codeGraphFileBlobCapacityBytes({
          contentHash: file.contentHash,
          createdAt: '1970-01-01T00:00:00.000Z',
          extractorSet: call.cacheIdentity,
          factsJson: call.facts[index]!.json,
          path: file.path,
        }),
      0,
    );
    expect(call.files.length).toBeGreaterThan(0);
    expect(call.files.length).toBeLessThanOrEqual(CODE_GRAPH_CACHE_TRANSACTION_LIMITS.rows);
    expect(payloadBytes).toBeLessThanOrEqual(CODE_GRAPH_CACHE_TRANSACTION_LIMITS.payloadBytes);
  }
}
