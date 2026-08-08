import {mkdir, mkdtemp, rm, utimes, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {it as effectIt} from '@effect/vitest';
import {Cause, Effect, Exit, Fiber, Layer, Option, Semaphore} from 'effect';
import * as FC from 'effect/testing/FastCheck';
import {TestClock} from 'effect/testing';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const inference = vi.hoisted(() => ({rerank: vi.fn()}));

vi.mock('../../src/models/inference.js', () => ({
  rerankWithSelectedLocalModel: inference.rerank,
}));

import {ApplicationLayer} from '../../src/effect/runtime.js';
import {captureConsole} from '../../src/effect/console.js';
import {LocalModelRuntime} from '../../src/effect/ai/local-model-runtime.js';
import {runRecall} from '../../src/memory.js';
import {BUILTIN_MODEL_MANIFESTS} from '../../src/models/builtin.js';
import {LocalModelCatalog} from '../../src/models/catalog.js';
import {selectLocalModel} from '../../src/models/selection.js';
import {LocalModelStore, type LocalModelStoreShape} from '../../src/models/store.js';
import {loadRecallIndex, loadRecallIndexData} from '../../src/recall/index.js';
import {
  boundedRecallSemanticRetrieval,
  createRecallRerankerCache,
  loadRecallExpansionVocabulary,
  MCP_RECALL_SEMANTIC_RETRIEVAL_TIMEOUT_MILLISECONDS,
  prepareRecallSections,
} from '../../src/recall/runtime.js';
import type {RuntimeConfig} from '../../src/types.js';

describe('recall runtime orchestration', () => {
  const homes: string[] = [];

  beforeEach(() => {
    inference.rerank.mockReset();
    inference.rerank.mockReturnValue(Effect.succeed([0.8]));
  });

  afterEach(async () => {
    await Promise.all(homes.splice(0).map(home => rm(home, {force: true, recursive: true})));
  });

  effectIt.effect('bounds one semantic retrieval attempt and interrupts only the timed-out work', () =>
    Effect.gen(function* () {
      let interrupted = 0;
      let invocations = 0;
      const retrieval = Effect.sync(() => {
        invocations += 1;
      }).pipe(
        Effect.andThen(Effect.sleep(MCP_RECALL_SEMANTIC_RETRIEVAL_TIMEOUT_MILLISECONDS + 1)),
        Effect.as('semantic-result'),
        Effect.onInterrupt(() => Effect.sync(() => (interrupted += 1))),
      );
      const fiber = yield* boundedRecallSemanticRetrieval(retrieval).pipe(Effect.forkChild);

      yield* TestClock.adjust(MCP_RECALL_SEMANTIC_RETRIEVAL_TIMEOUT_MILLISECONDS);

      expect(yield* Fiber.join(fiber)).toEqual({status: 'timed-out'});
      expect(invocations).toBe(1);
      expect(interrupted).toBe(1);
    }),
  );

  effectIt.effect('reports the first semantic failure without retrying it', () =>
    Effect.gen(function* () {
      const firstFailure = new Error('first semantic failure');
      let invocations = 0;

      const result = yield* boundedRecallSemanticRetrieval(
        Effect.sync(() => {
          invocations += 1;
        }).pipe(Effect.andThen(Effect.fail(firstFailure))),
      );

      expect(result.status).toBe('failed');
      expect(result.status === 'failed' ? Cause.squash(result.cause) : undefined).toBe(firstFailure);
      expect(invocations).toBe(1);
    }),
  );

  effectIt.effect('preserves external semantic-retrieval cancellation', () =>
    Effect.gen(function* () {
      let invocations = 0;
      const fiber = yield* boundedRecallSemanticRetrieval(
        Effect.sync(() => {
          invocations += 1;
        }).pipe(Effect.andThen(Effect.never)),
      ).pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);

      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      expect(invocations).toBe(1);
    }),
  );

  effectIt.effect.prop(
    'returns semantic work exactly when an arbitrary delay finishes inside the total budget',
    {
      delayMilliseconds: FC.oneof(
        FC.integer({max: MCP_RECALL_SEMANTIC_RETRIEVAL_TIMEOUT_MILLISECONDS - 1, min: 0}),
        FC.integer({
          max: MCP_RECALL_SEMANTIC_RETRIEVAL_TIMEOUT_MILLISECONDS * 2,
          min: MCP_RECALL_SEMANTIC_RETRIEVAL_TIMEOUT_MILLISECONDS + 1,
        }),
      ),
    },
    ({delayMilliseconds}) =>
      Effect.gen(function* () {
        let interrupted = 0;
        let invocations = 0;
        const retrieval = Effect.sync(() => {
          invocations += 1;
        }).pipe(
          Effect.andThen(Effect.sleep(delayMilliseconds)),
          Effect.as('semantic-result'),
          Effect.onInterrupt(() => Effect.sync(() => (interrupted += 1))),
        );
        const fiber = yield* boundedRecallSemanticRetrieval(retrieval).pipe(Effect.forkChild);

        yield* TestClock.adjust(Math.max(delayMilliseconds, MCP_RECALL_SEMANTIC_RETRIEVAL_TIMEOUT_MILLISECONDS));

        const completedInsideBudget = delayMilliseconds < MCP_RECALL_SEMANTIC_RETRIEVAL_TIMEOUT_MILLISECONDS;
        expect(yield* Fiber.join(fiber)).toEqual(
          completedInsideBudget ? {status: 'completed', value: 'semantic-result'} : {status: 'timed-out'},
        );
        expect(invocations).toBe(1);
        expect(interrupted).toBe(completedInsideBudget ? 0 : 1);
      }),
    {fastCheck: {numRuns: 40}},
  );

  effectIt.effect('falls back predictably when serialized model work is contended', () =>
    Effect.gen(function* () {
      const inferencePermit = yield* Semaphore.make(1);
      let interrupted = 0;
      let invocations = 0;
      const retrievals = Array.from({length: 8}, (_unused, index) =>
        boundedRecallSemanticRetrieval(
          Effect.sync(() => {
            invocations += 1;
          }).pipe(
            Effect.andThen(inferencePermit.withPermit(Effect.sleep(4_000).pipe(Effect.as(index)))),
            Effect.onInterrupt(() => Effect.sync(() => (interrupted += 1))),
          ),
        ),
      );
      const fiber = yield* Effect.all(retrievals, {concurrency: 'unbounded'}).pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      yield* TestClock.adjust(MCP_RECALL_SEMANTIC_RETRIEVAL_TIMEOUT_MILLISECONDS);

      const results = yield* Fiber.join(fiber);
      expect(results.filter(result => result.status === 'completed')).toHaveLength(3);
      expect(results.filter(result => result.status === 'timed-out')).toHaveLength(5);
      expect(invocations).toBe(8);
      expect(interrupted).toBe(5);
      expect(yield* inferencePermit.withPermit(Effect.succeed('permit-released'))).toBe('permit-released');
    }),
  );

  it('reuses reranker scores across repeated prepare passes in one top-level recall', async () => {
    const home = await mkdtemp(join(tmpdir(), 'threadnote-recall-runtime-'));
    homes.push(home);
    const resource = join(home, 'data', 'local', 'resources', 'repos', 'threadnote', 'runtime.md');
    await mkdir(join(resource, '..'), {recursive: true});
    await writeFile(resource, '# Runtime\n\nreranker cache anchor');
    const config: RuntimeConfig = {
      account: 'local',
      agentContextHome: home,
      agentId: 'threadnote',
      manifestPath: join(home, 'seed-manifest.yaml'),
      user: 'tester',
    };
    const rerankerCache = createRecallRerankerCache();
    const prepare = () =>
      prepareRecallSections(config, {
        allowExactRescue: false,
        exactMatches: [],
        feedbackQuery: 'reranker cache anchor',
        includeInactive: false,
        limit: 5,
        passes: [],
        query: 'reranker cache anchor',
        readRecords: () => Effect.succeed([]),
        rerankerCache,
        semanticResult: Option.none(),
      });

    await Effect.runPromise(
      Effect.all([prepare(), prepare()], {concurrency: 1}).pipe(Effect.provide(ApplicationLayer)),
    );

    expect(inference.rerank).toHaveBeenCalledTimes(1);
  });

  it('drops stale semantic scores when the ranked lexical snapshot has advanced', async () => {
    const home = await mkdtemp(join(tmpdir(), 'threadnote-recall-semantic-generation-'));
    homes.push(home);
    const resource = join(home, 'data', 'local', 'resources', 'repos', 'threadnote', 'generation.md');
    await mkdir(join(resource, '..'), {recursive: true});
    await writeFile(resource, '# Generation one\n\nold semantic ranking anchor');
    const config: RuntimeConfig = {
      account: 'local',
      agentContextHome: home,
      agentId: 'threadnote',
      manifestPath: join(home, 'seed-manifest.yaml'),
      user: 'tester',
    };

    const first = await Effect.runPromise(
      loadRecallIndexData(config, {forceRefresh: true, includeInactive: false}).pipe(Effect.provide(ApplicationLayer)),
    );
    await writeFile(resource, '# Generation two\n\ncurrent lexical ranking anchor');
    const second = await Effect.runPromise(
      loadRecallIndexData(config, {forceRefresh: true, includeInactive: false}).pipe(Effect.provide(ApplicationLayer)),
    );
    expect(second.generation).not.toBe(first.generation);

    const prepared = await Effect.runPromise(
      prepareRecallSections(config, {
        allowExactRescue: false,
        exactMatches: [],
        feedbackQuery: 'ranking anchor',
        includeInactive: false,
        limit: 5,
        passes: [],
        query: 'ranking anchor',
        readRecords: () => Effect.succeed([]),
        semanticResult: Option.some({
          corpusGeneration: Option.some(first.generation),
          scores: Option.some(new Map([[first.candidates[0]!.uri, 1]])),
          warning: Option.none(),
        }),
      }).pipe(Effect.provide(ApplicationLayer)),
    );

    expect(Option.isNone(prepared.semanticResult.corpusGeneration)).toBe(true);
    expect(Option.isNone(prepared.semanticResult.scores)).toBe(true);
  });

  it('keeps top-level lexical recall available when semantic inference dies', async () => {
    const home = await mkdtemp(join(tmpdir(), 'threadnote-recall-runtime-'));
    homes.push(home);
    const resource = join(home, 'data', 'local', 'resources', 'repos', 'threadnote', 'fallback.md');
    await mkdir(join(resource, '..'), {recursive: true});
    await writeFile(resource, '# Fallback\n\nlexical-fallback-anchor survives semantic failure');
    const config: RuntimeConfig = {
      account: 'local',
      agentContextHome: home,
      agentId: 'threadnote',
      manifestPath: join(home, 'seed-manifest.yaml'),
      user: 'tester',
    };
    const embedding = BUILTIN_MODEL_MANIFESTS.find(model => model.id === 'bge-small-en-v1.5-q8')!;
    const installation = {
      bytes: embedding.size,
      installed: true,
      modelId: embedding.id,
      partialBytes: 0,
      path: join(home, 'models', 'fake.gguf'),
      verified: true,
    };
    const storeLayer = Layer.succeed(
      LocalModelStore,
      LocalModelStore.of({
        install: () => Effect.die(new Error('Unexpected install')),
        path: () => installation.path,
        remove: () => Effect.succeed(false),
        status: () => Effect.succeed(installation),
        verify: () => Effect.succeed(installation),
      } satisfies LocalModelStoreShape),
    );
    const failingRuntimeLayer = Layer.succeed(
      LocalModelRuntime,
      LocalModelRuntime.of({
        diagnostics: () => Effect.succeed({backend: 'fake', buildType: 'prebuilt', cpuMathCores: 4}),
        embedMany: () => Effect.die(new Error('synthetic semantic runtime failure')),
        generate: () => Effect.die(new Error('Unexpected generation')),
        rerank: () => Effect.die(new Error('Unexpected reranking')),
      }),
    );

    const recalled = await Effect.runPromise(
      Effect.gen(function* () {
        const catalog = yield* LocalModelCatalog;
        yield* selectLocalModel(home, catalog, 'embedding', embedding.id);
        return yield* captureConsole(
          runRecall(config, {
            inferScope: false,
            query: 'lexical-fallback-anchor',
            threshold: '0.1',
          }),
        );
      }).pipe(Effect.provide(failingRuntimeLayer), Effect.provide(storeLayer), Effect.provide(ApplicationLayer)),
    );

    expect(recalled.output).toContain('fallback.md');
    expect(recalled.output).toContain('lexical-fallback-anchor');
    expect(recalled.output).toContain('Local AI recall warning: semantic retrieval failed (SemanticRecallUnavailable)');
  });

  it('uses a complete ranked expansion vocabulary without opening the lexical index', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-expansion-ranked-'));
    homes.push(root);
    const blockedHome = join(root, 'not-a-directory');
    await writeFile(blockedHome, 'opening the lexical index would fail');
    const candidates = Array.from({length: 50}, (_unused, index) => ({
      fields: {project: 'threadnote', topic: `topic-${index}`},
      kind: 'durable' as const,
      text: `description ${index}`,
      uri: `threadnote://user/tester/memories/durable/projects/threadnote/topic-${index}.md`,
    }));

    const vocabulary = await Effect.runPromise(
      loadRecallExpansionVocabulary(
        {account: 'local', agentContextHome: blockedHome, user: 'tester'},
        {
          includeInactive: false,
          project: 'threadnote',
          rankedCandidates: candidates,
        },
      ).pipe(Effect.provide(ApplicationLayer)),
    );

    expect(vocabulary).toHaveLength(50);
    expect(vocabulary[0]).toContain('topic-0');
  });

  it('keeps ranked scope precedence and project fallback deterministic beyond the sample limit', async () => {
    const home = await mkdtemp(join(tmpdir(), 'threadnote-expansion-project-sample-'));
    homes.push(home);
    const resourcesRoot = join(home, 'data', 'local', 'resources', 'repos');
    const targetRoot = join(resourcesRoot, 'threadnote');
    const outsideRoot = join(resourcesRoot, 'outside');
    await mkdir(targetRoot, {recursive: true});
    await mkdir(outsideRoot, {recursive: true});
    const targetPaths = [join(targetRoot, 'target-old-one.md'), join(targetRoot, 'target-old-two.md')];
    await Promise.all(targetPaths.map(path => writeFile(path, `# Target\n\n${path}`)));
    await Promise.all(
      Array.from({length: 225}, (_unused, index) =>
        writeFile(join(outsideRoot, `outside-${String(index).padStart(3, '0')}.md`), `# Outside ${index}`),
      ),
    );
    const oldTimestamp = new Date('2020-01-01T00:00:00.000Z');
    await Promise.all(targetPaths.map(path => utimes(path, oldTimestamp, oldTimestamp)));
    const hiddenMemory = join(
      home,
      'data',
      'local',
      'user',
      'tester',
      'memories',
      'durable',
      'projects',
      'threadnote',
      'hidden-memory.md',
    );
    await mkdir(join(hiddenMemory, '..'), {recursive: true});
    await writeFile(
      hiddenMemory,
      [
        'MEMORY',
        'kind: durable',
        'status: active',
        'project: threadnote',
        'topic: hidden-memory-topic',
        'source_agent_client: codex',
        'timestamp: 2026-07-28T00:00:00.000Z',
        '',
        'Must remain outside the resource-only fallback scope.',
      ].join('\n'),
    );
    const config = {account: 'local', agentContextHome: home, user: 'tester'};
    await Effect.runPromise(
      loadRecallIndex(config, {forceRefresh: true, includeInactive: false}).pipe(Effect.provide(ApplicationLayer)),
    );
    const input = {
      allowedUriScopes: ['threadnote://resources/repos//#ignored'],
      includeInactive: false,
      project: 'threadnote',
      rankedCandidates: [
        {
          fields: {project: 'threadnote', topic: 'ranked-priority'},
          kind: 'durable' as const,
          text: 'ranked candidate',
          uri: 'threadnote://resources/repos/threadnote/ranked.md#heading',
        },
        {
          fields: {project: 'threadnote', topic: 'hidden-ranked'},
          kind: 'durable' as const,
          text: 'out of scope ranked candidate',
          uri: 'threadnote://user/tester/memories/durable/projects/threadnote/hidden-ranked.md',
        },
      ],
    };

    const first = await Effect.runPromise(
      loadRecallExpansionVocabulary(config, input).pipe(Effect.provide(ApplicationLayer)),
    );
    const second = await Effect.runPromise(
      loadRecallExpansionVocabulary(config, input).pipe(Effect.provide(ApplicationLayer)),
    );

    expect(second).toEqual(first);
    expect(first[0]).toContain('ranked-priority');
    expect(first.some(term => term.includes('target-old-one'))).toBe(true);
    expect(first.some(term => term.includes('target-old-two'))).toBe(true);
    expect(first.some(term => term.includes('outside-'))).toBe(false);
    expect(first.some(term => term.includes('hidden-memory-topic') || term.includes('hidden-ranked'))).toBe(false);
  });
});
