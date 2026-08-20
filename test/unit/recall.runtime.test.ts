import {TestError} from '../helpers/test-error.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {mkdir, mkdtemp, rm, utimes, writeFile} from '../helpers/node-fs-promises.js';
import {tmpdir} from '../helpers/node-os.js';
import {join} from '../helpers/node-path.js';
import {it as effectIt} from '@effect/vitest';
import {Cause, Effect, Exit, Fiber, Layer, Option, Semaphore} from 'effect';
import * as FC from 'effect/testing/FastCheck';
import {TestClock} from 'effect/testing';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
const inference = vi.hoisted(() => ({
  rerank: vi.fn(),
}));
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
import {loadRecallIndex, loadRecallIndexData, recallIndexDatabaseFilename} from '../../src/recall/index.js';
import {buildRecallTopicalCorpusStatistics} from '../../src/recall/rank.js';
import {
  boundedRecallSemanticRetrieval,
  createRecallRerankerCache,
  loadRecallExpansionVocabulary,
  mergeRecallIndexCandidates,
  mergePrioritizedRecallIndexCandidates,
  MCP_RECALL_SEMANTIC_RETRIEVAL_TIMEOUT_MILLISECONDS,
  prepareRecallSections,
  prioritizeWorkspaceRecallCandidates,
} from '../../src/recall/runtime.js';
import type {RuntimeConfig} from '../../src/types.js';
import {buildRecallSections} from '../../src/utils.js';
describe('recall runtime orchestration', () => {
  const homes: string[] = [];
  beforeEach(() => {
    inference.rerank.mockReset();
    inference.rerank.mockReturnValue(Effect.succeed([0.8]));
  });
  afterEach(async () => {
    await Promise.all(
      homes.splice(0).map(home =>
        rm(home, {
          force: true,
          recursive: true,
        }),
      ),
    );
  });
  it('preserves a global identity conflict when an earlier scoped lane retained the same URI', () => {
    const scoped = {
      fields: {project: 'threadnote', topic: 'identity-conflict'},
      memoryId: 'tn_identity_conflict',
      text: 'Identity conflict target.',
      uri: 'threadnote://user/test/memories/durable/projects/threadnote/identity-conflict.md',
    };

    expect(mergeRecallIndexCandidates([[scoped], [{...scoped, identityConflict: true}]])).toEqual([
      {...scoped, identityConflict: true},
    ]);
  });
  it('keeps a topical repo-wide result ahead of more than one rank window of scope-only candidates', () => {
    const relevant = {
      fields: {project: 'monorepo', title: 'Search checkout retry contract', topic: 'checkout-retry'},
      text: 'Search checkout retry contract uses bounded attempts.',
      uri: 'threadnote://user/test/memories/durable/projects/monorepo/repo-wide.md',
    };
    const scopeOnly = Array.from({length: 150}, (_unused, index) => ({
      fields: {
        project: 'monorepo',
        title: `Unrelated package note ${index}`,
        topic: `unrelated-${index}`,
        workspaceScope: 'apps/search',
      },
      text: 'Unrelated package-local operational note.',
      uri: `threadnote://user/test/memories/durable/projects/monorepo/scope-${String(index).padStart(3, '0')}.md`,
    }));
    const candidates = mergePrioritizedRecallIndexCandidates([[relevant]], [scopeOnly]);

    expect(candidates[0]?.uri).toBe(relevant.uri);
    expect(buildRecallTopicalCorpusStatistics(candidates).documentFrequency.search).toBe(1);
    const sections = buildRecallSections([], [], 5, {
      indexedCandidates: candidates,
      project: 'monorepo',
      query: 'search checkout retry contract',
      workspaceScope: 'apps/search',
    });
    expect(sections.ranked.map(hit => hit.uri)).toEqual([relevant.uri]);
  });
  it('reserves bounded admission for a current-package match beyond a full topical window', () => {
    const siblingCandidates = Array.from({length: 125}, (_unused, index) => ({
      fields: {
        project: 'monorepo',
        title: 'Checkout retry contract',
        topic: 'checkout-retry',
        workspaceScope: `apps/sibling-${index}`,
      },
      text: 'Checkout retry contract uses bounded attempts.',
      uri: `threadnote://user/test/memories/durable/projects/monorepo/sibling-${String(index).padStart(3, '0')}.md`,
    }));
    const currentPackage = {
      fields: {
        project: 'monorepo',
        title: 'Checkout retry contract',
        topic: 'checkout-retry',
        workspaceScope: 'apps/search',
      },
      text: 'Checkout retry contract uses bounded attempts.',
      uri: 'threadnote://user/test/memories/durable/projects/monorepo/current-package.md',
    };
    const localIrrelevant = Array.from({length: 20}, (_unused, index) => ({
      fields: {
        project: 'monorepo',
        title: `Unrelated local note ${index}`,
        topic: `unrelated-local-${index}`,
        workspaceScope: 'apps/search',
      },
      text: 'Unrelated package-local operational note.',
      uri: `threadnote://user/test/memories/durable/projects/monorepo/local-${String(index).padStart(3, '0')}.md`,
    }));
    const supplementalPool = [...localIrrelevant, currentPackage];
    const prioritizedWorkspace = prioritizeWorkspaceRecallCandidates('checkout retry contract', supplementalPool, {
      project: 'monorepo',
      workspaceScope: 'apps/search',
    });
    const candidates = mergePrioritizedRecallIndexCandidates(
      [[...siblingCandidates, currentPackage]],
      [prioritizedWorkspace],
      {admissionLimit: 100, supplementalReserve: 10},
    );

    expect(supplementalPool.indexOf(currentPackage)).toBeGreaterThan(16);
    expect(prioritizedWorkspace[0]?.uri).toBe(currentPackage.uri);
    expect(candidates.slice(0, 100).map(candidate => candidate.uri)).toContain(currentPackage.uri);
    const sections = buildRecallSections([], [], 5, {
      indexedCandidates: candidates,
      project: 'monorepo',
      query: 'checkout retry contract',
      workspaceScope: 'apps/search',
    });
    expect(sections.ranked[0]?.uri).toBe(currentPackage.uri);
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
      expect(yield* Fiber.join(fiber)).toEqual({
        status: 'timed-out',
      });
      expect(invocations).toBe(1);
      expect(interrupted).toBe(1);
    }),
  );
  effectIt.effect('reports the first semantic failure without retrying it', () =>
    Effect.gen(function* () {
      const firstFailure = new TestError('first semantic failure');
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
        FC.integer({
          max: MCP_RECALL_SEMANTIC_RETRIEVAL_TIMEOUT_MILLISECONDS - 1,
          min: 0,
        }),
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
          completedInsideBudget
            ? {
                status: 'completed',
                value: 'semantic-result',
              }
            : {
                status: 'timed-out',
              },
        );
        expect(invocations).toBe(1);
        expect(interrupted).toBe(completedInsideBudget ? 0 : 1);
      }),
    {
      fastCheck: {
        numRuns: 40,
      },
    },
  );
  effectIt.effect('falls back predictably when serialized model work is contended', () =>
    Effect.gen(function* () {
      const inferencePermit = yield* Semaphore.make(1);
      let interrupted = 0;
      let invocations = 0;
      const retrievals = Array.from(
        {
          length: 8,
        },
        (_unused, index) =>
          boundedRecallSemanticRetrieval(
            Effect.sync(() => {
              invocations += 1;
            }).pipe(
              Effect.andThen(inferencePermit.withPermit(Effect.sleep(4_000).pipe(Effect.as(index)))),
              Effect.onInterrupt(() => Effect.sync(() => (interrupted += 1))),
            ),
          ),
      );
      const fiber = yield* Effect.all(retrievals, {
        concurrency: 'unbounded',
      }).pipe(Effect.forkChild);
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
  effectIt.effect('reuses reranker scores across repeated prepare passes in one top-level recall', () =>
    Effect.gen(function* () {
      const home = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-recall-runtime-')));
      homes.push(home);
      const resource = join(home, 'data', 'local', 'resources', 'repos', 'threadnote', 'runtime.md');
      yield* Effect.promise(() =>
        mkdir(join(resource, '..'), {
          recursive: true,
        }),
      );
      yield* Effect.promise(() => writeFile(resource, '# Runtime\n\nreranker cache anchor'));
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
      yield* Effect.all([prepare(), prepare()], {
        concurrency: 1,
      }).pipe(provideTestLayer(ApplicationLayer));
      expect(inference.rerank).toHaveBeenCalledTimes(1);
    }),
  );
  effectIt.effect('drops stale semantic scores when the ranked lexical snapshot has advanced', () =>
    Effect.gen(function* () {
      const home = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-recall-semantic-generation-')));
      homes.push(home);
      const resource = join(home, 'data', 'local', 'resources', 'repos', 'threadnote', 'generation.md');
      yield* Effect.promise(() =>
        mkdir(join(resource, '..'), {
          recursive: true,
        }),
      );
      yield* Effect.promise(() => writeFile(resource, '# Generation one\n\nold semantic ranking anchor'));
      const config: RuntimeConfig = {
        account: 'local',
        agentContextHome: home,
        agentId: 'threadnote',
        manifestPath: join(home, 'seed-manifest.yaml'),
        user: 'tester',
      };
      const first = yield* loadRecallIndexData(config, {
        forceRefresh: true,
        includeInactive: false,
      }).pipe(provideTestLayer(ApplicationLayer));
      yield* Effect.promise(() => writeFile(resource, '# Generation two\n\ncurrent lexical ranking anchor'));
      const second = yield* loadRecallIndexData(config, {
        forceRefresh: true,
        includeInactive: false,
      }).pipe(provideTestLayer(ApplicationLayer));
      expect(second.generation).not.toBe(first.generation);
      const prepared = yield* prepareRecallSections(config, {
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
      }).pipe(provideTestLayer(ApplicationLayer));
      expect(Option.isNone(prepared.semanticResult.corpusGeneration)).toBe(true);
      expect(Option.isNone(prepared.semanticResult.scores)).toBe(true);
    }),
  );
  effectIt.effect('keeps top-level lexical recall available when semantic inference dies', () =>
    Effect.gen(function* () {
      const home = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-recall-runtime-')));
      homes.push(home);
      const resource = join(home, 'data', 'local', 'resources', 'repos', 'threadnote', 'fallback.md');
      yield* Effect.promise(() =>
        mkdir(join(resource, '..'), {
          recursive: true,
        }),
      );
      yield* Effect.promise(() =>
        writeFile(resource, '# Fallback\n\nlexical-fallback-anchor survives semantic failure'),
      );
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
          install: () => Effect.die(new TestError('Unexpected install')),
          path: () => installation.path,
          remove: () => Effect.succeed(false),
          status: () => Effect.succeed(installation),
          verify: () => Effect.succeed(installation),
        } satisfies LocalModelStoreShape),
      );
      const failingRuntimeLayer = Layer.succeed(
        LocalModelRuntime,
        LocalModelRuntime.of({
          diagnostics: Effect.succeed({
            backend: 'fake',
            buildType: 'prebuilt',
            cpuMathCores: 4,
          }),
          embedMany: () => Effect.die(new TestError('synthetic semantic runtime failure')),
          generate: () => Effect.die(new TestError('Unexpected generation')),
          rerank: () => Effect.die(new TestError('Unexpected reranking')),
        }),
      );
      const recalled = yield* Effect.gen(function* () {
        const catalog = yield* LocalModelCatalog;
        yield* selectLocalModel(home, catalog, 'embedding', embedding.id);
        return yield* captureConsole(
          runRecall(config, {
            inferScope: false,
            query: 'lexical-fallback-anchor',
            threshold: '0.1',
          }),
        );
      }).pipe(provideTestLayer(failingRuntimeLayer), provideTestLayer(storeLayer), provideTestLayer(ApplicationLayer));
      expect(recalled.output).toContain('fallback.md');
      expect(recalled.output).toContain('lexical-fallback-anchor');
      expect(recalled.output).toContain(
        'Local AI recall warning: semantic retrieval failed (SemanticRecallUnavailable)',
      );
    }),
  );
  effectIt.effect('preserves fallback hits and reports a real persistent lexical recovery failure', () =>
    Effect.gen(function* () {
      const home = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-recall-index-warning-')));
      homes.push(home);
      const lexicalRoot = join(home, 'indexes', 'lexical');
      yield* Effect.promise(() => mkdir(lexicalRoot, {recursive: true}));
      yield* Effect.promise(() =>
        writeFile(join(lexicalRoot, recallIndexDatabaseFilename(false)), 'not a sqlite database'),
      );
      yield* Effect.promise(() => writeFile(join(lexicalRoot, 'generations'), 'blocks index recovery'));
      const fallbackUri = 'threadnote://user/tester/memories/durable/projects/threadnote/file-fallback.md';
      const prepared = yield* prepareRecallSections(
        {
          account: 'local',
          agentContextHome: home,
          user: 'tester',
        },
        {
          allowExactRescue: false,
          exactMatches: [],
          feedbackQuery: 'file fallback anchor',
          includeInactive: false,
          limit: 5,
          passes: [
            [
              {
                category: 'memories',
                contextType: 'memory',
                score: 1,
                snippet: 'File fallback anchor remains available.',
                uri: fallbackUri,
              },
            ],
          ],
          query: 'file fallback anchor',
          readRecords: () => Effect.succeed([]),
          semanticResult: Option.none(),
        },
      ).pipe(provideTestLayer(ApplicationLayer));

      expect(prepared.ranked.map(hit => hit.uri)).toContain(fallbackUri);
      expect(prepared.operationalWarnings).toEqual([expect.objectContaining({code: 'lexical_index_unavailable'})]);
    }),
  );
  effectIt.effect('surfaces one CLI warning when exact and ranked lexical recovery both fail', () =>
    Effect.gen(function* () {
      const home = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-recall-cli-index-warning-')));
      homes.push(home);
      const lexicalRoot = join(home, 'indexes', 'lexical');
      yield* Effect.promise(() => mkdir(lexicalRoot, {recursive: true}));
      yield* Effect.promise(() =>
        writeFile(join(lexicalRoot, recallIndexDatabaseFilename(false)), 'not a sqlite database'),
      );
      yield* Effect.promise(() => writeFile(join(lexicalRoot, 'generations'), 'blocks index recovery'));
      const recalled = yield* captureConsole(
        runRecall(
          {
            account: 'local',
            agentContextHome: home,
            agentId: 'threadnote',
            manifestPath: join(home, 'seed-manifest.yaml'),
            user: 'tester',
          },
          {
            inferScope: false,
            query: 'degraded lexical exact anchor 7788',
            threshold: '0.1',
          },
        ),
      ).pipe(provideTestLayer(ApplicationLayer));

      expect(recalled.output.match(/Recall index warning:/g)).toHaveLength(1);
      expect(recalled.output).toContain('could not be read or recovered');
      expect(recalled.output).toContain('threadnote doctor --dry-run');
    }),
  );
  effectIt.effect('uses a complete ranked expansion vocabulary without opening the lexical index', () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-expansion-ranked-')));
      homes.push(root);
      const blockedHome = join(root, 'not-a-directory');
      yield* Effect.promise(() => writeFile(blockedHome, 'opening the lexical index would fail'));
      const candidates = Array.from(
        {
          length: 50,
        },
        (_unused, index) => ({
          fields: {
            project: 'threadnote',
            topic: `topic-${index}`,
          },
          kind: 'durable' as const,
          text: `description ${index}`,
          uri: `threadnote://user/tester/memories/durable/projects/threadnote/topic-${index}.md`,
        }),
      );
      const vocabulary = yield* loadRecallExpansionVocabulary(
        {
          account: 'local',
          agentContextHome: blockedHome,
          user: 'tester',
        },
        {
          includeInactive: false,
          project: 'threadnote',
          rankedCandidates: candidates,
        },
      ).pipe(provideTestLayer(ApplicationLayer));
      expect(vocabulary).toHaveLength(50);
      expect(vocabulary[0]).toContain('topic-0');
    }),
  );
  effectIt.effect('keeps ranked scope precedence and project fallback deterministic beyond the sample limit', () =>
    Effect.gen(function* () {
      const home = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-expansion-project-sample-')));
      homes.push(home);
      const resourcesRoot = join(home, 'data', 'local', 'resources', 'repos');
      const targetRoot = join(resourcesRoot, 'threadnote');
      const outsideRoot = join(resourcesRoot, 'outside');
      yield* Effect.promise(() =>
        mkdir(targetRoot, {
          recursive: true,
        }),
      );
      yield* Effect.promise(() =>
        mkdir(outsideRoot, {
          recursive: true,
        }),
      );
      const targetPaths = [join(targetRoot, 'target-old-one.md'), join(targetRoot, 'target-old-two.md')];
      yield* Effect.promise(() => Promise.all(targetPaths.map(path => writeFile(path, `# Target\n\n${path}`))));
      yield* Effect.promise(() =>
        Promise.all(
          Array.from(
            {
              length: 225,
            },
            (_unused, index) =>
              writeFile(join(outsideRoot, `outside-${String(index).padStart(3, '0')}.md`), `# Outside ${index}`),
          ),
        ),
      );
      const oldTimestamp = new Date('2020-01-01T00:00:00.000Z');
      yield* Effect.promise(() => Promise.all(targetPaths.map(path => utimes(path, oldTimestamp, oldTimestamp))));
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
      yield* Effect.promise(() =>
        mkdir(join(hiddenMemory, '..'), {
          recursive: true,
        }),
      );
      yield* Effect.promise(() =>
        writeFile(
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
        ),
      );
      const config = {
        account: 'local',
        agentContextHome: home,
        user: 'tester',
      };
      yield* loadRecallIndex(config, {
        forceRefresh: true,
        includeInactive: false,
      }).pipe(provideTestLayer(ApplicationLayer));
      const input = {
        allowedUriScopes: ['threadnote://resources/repos//#ignored'],
        includeInactive: false,
        project: 'threadnote',
        rankedCandidates: [
          {
            fields: {
              project: 'threadnote',
              topic: 'ranked-priority',
            },
            kind: 'durable' as const,
            text: 'ranked candidate',
            uri: 'threadnote://resources/repos/threadnote/ranked.md#heading',
          },
          {
            fields: {
              project: 'threadnote',
              topic: 'hidden-ranked',
            },
            kind: 'durable' as const,
            text: 'out of scope ranked candidate',
            uri: 'threadnote://user/tester/memories/durable/projects/threadnote/hidden-ranked.md',
          },
        ],
      };
      const first = yield* loadRecallExpansionVocabulary(config, input).pipe(provideTestLayer(ApplicationLayer));
      const second = yield* loadRecallExpansionVocabulary(config, input).pipe(provideTestLayer(ApplicationLayer));
      expect(second).toEqual(first);
      expect(first[0]).toContain('ranked-priority');
      expect(first.some(term => term.includes('target-old-one'))).toBe(true);
      expect(first.some(term => term.includes('target-old-two'))).toBe(true);
      expect(first.some(term => term.includes('outside-'))).toBe(false);
      expect(first.some(term => term.includes('hidden-memory-topic') || term.includes('hidden-ranked'))).toBe(false);
    }),
  );
});
