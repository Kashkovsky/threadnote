import {fcEffectProp} from '../helpers/fast-check-property.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import * as FC from 'fast-check';
import {Cause, Effect, Exit, Fiber, FileSystem, Layer} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect, it} from 'vitest';
import {SystemInfo} from '../../src/effect/system.js';
import {GenerationFailed} from '../../src/effect/ai/errors.js';
import {
  LocalModelRuntime,
  type LocalGenerationRequest,
  type LocalModelRuntimeShape,
} from '../../src/effect/ai/local-model-runtime.js';
import {BUILTIN_MODEL_MANIFESTS} from '../../src/models/builtin.js';
import {LocalModelCatalog} from '../../src/models/catalog.js';
import {selectLocalModel} from '../../src/models/selection.js';
import {LocalModelStore} from '../../src/models/store.js';
import {
  boundedRecallCandidateSelection,
  boundedRecallExpansionScopes,
  expandRecallQueryEffect,
  expandWeakRecallQueryEffect,
  isLoopbackAiEndpoint,
  limitRecallRewritesForConfidence,
  mergeRecallRewritesForConfidence,
  normalizeRecallCandidateSelection,
  normalizeRecallRewrites,
  NATIVE_RECALL_TIMEOUT_MILLISECONDS,
  RecallCandidateSelector,
  RECALL_SELECTION_TIMEOUT_MILLISECONDS,
  recallHybridMinimumScore,
  RecallQueryExpander,
  selectRecallCandidatesEffect,
  selectExpandedRecallCandidatesEffect,
  shouldExpandRecall,
} from '../../src/effect/ai/recall.js';
import {recallScoreThresholdPolicy, validatedRecallScoreThreshold} from '../../src/utils.js';

const generationManifest = BUILTIN_MODEL_MANIFESTS.find(model => model.id === 'gemma-4-e4b-it-q4')!;
const modelPlatformLayer = Layer.merge(BunServices.layer, LocalModelCatalog.layer([generationManifest]));
const absentNativeModelLayer = Layer.mergeAll(
  modelPlatformLayer,
  Layer.succeed(LocalModelStore, fakeModelStore('/unused', false)),
  Layer.succeed(
    LocalModelRuntime,
    fakeModelRuntime(() => Effect.die(new Error('An absent generation model must not load the worker.'))),
  ),
);

describe('Effect AI recall expansion', () => {
  it('only expands weak deterministic recalls', () => {
    expect(shouldExpandRecall({level: 'no_answer'})).toBe(true);
    expect(shouldExpandRecall({level: 'low'})).toBe(true);
    expect(shouldExpandRecall({level: 'medium'})).toBe(true);
    expect(shouldExpandRecall({level: 'high'})).toBe(false);
    expect(shouldExpandRecall(undefined)).toBe(false);
  });

  it('keeps at most two unique, bounded rewrites and drops the original query', () => {
    expect(
      normalizeRecallRewrites('where is the QX7 lease handled', [
        ' QX7 worker lease coordinator ',
        'where is the QX7 lease handled',
        'qx7 worker lease coordinator',
        'heartbeat renewal configuration',
        'ignored third rewrite',
        'x'.repeat(700),
      ]),
    ).toEqual(['QX7 worker lease coordinator', 'heartbeat renewal configuration']);
  });

  it('drops locally grounded rewrites that ignore the supplied project vocabulary', () => {
    expect(
      normalizeRecallRewrites(
        'How do preview builds get upgraded?',
        [
          'upgrade-preview-builds-threadnote',
          'beta-update-channel prerelease upgrades',
          'release-process :: stable release workflow',
        ],
        ['beta-update-channel :: beta update and prerelease contract', 'release-process :: stable release workflow'],
      ),
    ).toEqual(['beta-update-channel', 'release-process']);
  });

  it('does not accept a vocabulary term embedded in a different word', () => {
    expect(normalizeRecallRewrites('share behavior', ['shared repository'], ['share'])).toEqual([]);
  });

  it('uses only the first search scope for expansion', () => {
    expect(
      boundedRecallExpansionScopes([
        undefined,
        'threadnote://user/me/memories/durable/projects/threadnote',
        undefined,
        'threadnote://resources/repos/threadnote',
        'threadnote://resources/repos/atlas-cache',
      ]),
    ).toEqual([undefined]);
  });

  it('uses one rewrite for medium confidence and two for weaker recall', () => {
    const rewrites = ['first', 'second'];
    expect(limitRecallRewritesForConfidence({level: 'medium'}, rewrites)).toEqual(['first']);
    expect(limitRecallRewritesForConfidence({level: 'low'}, rewrites)).toEqual(rewrites);
    expect(limitRecallRewritesForConfidence({level: 'no_answer'}, rewrites)).toEqual(rewrites);
    expect(mergeRecallRewritesForConfidence({level: 'low'}, ['grounded'], [' Grounded ', 'fallback'])).toEqual([
      'grounded',
      'fallback',
    ]);
  });

  it('uses the resolved default, environment, or explicit threshold without a hidden hybrid override', () => {
    expect(recallHybridMinimumScore(0.3)).toBe(0.3);
    expect(recallHybridMinimumScore(0.45)).toBe(0.45);
    expect(recallHybridMinimumScore(0.9)).toBe(0.9);
  });

  it('validates explicit recall thresholds on the same 0-1 scale', () => {
    expect(validatedRecallScoreThreshold(' 0.45 ', '--threshold')).toBe('0.45');
    expect(() => validatedRecallScoreThreshold('NaN', '--threshold')).toThrow(
      '--threshold must be a number from 0 to 1',
    );
    expect(() => validatedRecallScoreThreshold('1.1', '--threshold')).toThrow(
      '--threshold must be a number from 0 to 1',
    );
  });

  effectIt.effect('honors a valid environment threshold and rejects an invalid one', () =>
    Effect.gen(function* () {
      const system = yield* SystemInfo;
      const configuredSystem = SystemInfo.of({
        ...system,
        environment: () => ({...system.environment(), THREADNOTE_RECALL_THRESHOLD: '0.67'}),
      });
      expect(yield* recallScoreThresholdPolicy().pipe(Effect.provideService(SystemInfo, configuredSystem))).toEqual({
        source: 'environment',
        value: '0.67',
      });

      const invalidSystem = SystemInfo.of({
        ...system,
        environment: () => ({...system.environment(), THREADNOTE_RECALL_THRESHOLD: 'not-a-number'}),
      });
      const error = yield* recallScoreThresholdPolicy().pipe(
        Effect.provideService(SystemInfo, invalidSystem),
        Effect.flip,
      );
      expect(error.message).toContain('THREADNOTE_RECALL_THRESHOLD must be a number from 0 to 1');
    }).pipe(provideTestLayer(SystemInfo.layer)),
  );

  it('only treats explicit loopback Effect AI endpoints as local', () => {
    expect(isLoopbackAiEndpoint('http://127.0.0.1:8081/v1')).toBe(true);
    expect(isLoopbackAiEndpoint('http://localhost:11434/v1')).toBe(true);
    expect(isLoopbackAiEndpoint('https://models.example.com/v1')).toBe(false);
    expect(isLoopbackAiEndpoint(undefined)).toBe(false);
  });

  it('keeps only known, unique candidate IDs and supports a confident empty selection', () => {
    const candidates = [
      {id: 'c1', summary: 'first', uri: 'threadnote://first'},
      {id: 'c2', summary: 'second', uri: 'threadnote://second'},
    ];
    expect(
      normalizeRecallCandidateSelection({candidateIds: ['c2', 'unknown', 'c2'], relevant: true}, candidates),
    ).toEqual(['c2']);
    expect(normalizeRecallCandidateSelection({candidateIds: [], relevant: false}, candidates)).toEqual([]);
    expect(() => normalizeRecallCandidateSelection({candidateIds: ['unknown'], relevant: true}, candidates)).toThrow(
      'no known candidate IDs',
    );
    const manyCandidates = Array.from({length: 12}, (_unused, index) => ({
      id: `c${index + 1}`,
      summary: `candidate ${index + 1}`,
      uri: `threadnote://candidate-${index + 1}`,
    }));
    expect(
      normalizeRecallCandidateSelection(
        {candidateIds: manyCandidates.map(candidate => candidate.id), relevant: true},
        manyCandidates,
      ),
    ).toHaveLength(8);
  });

  it('never admits model-proposed candidate IDs outside the supplied shortlist', () => {
    const candidates = Array.from({length: 10}, (_unused, index) => ({
      id: `c${index}`,
      summary: `candidate ${index}`,
      uri: `threadnote://candidate-${index}`,
    }));
    const allowed = new Set(candidates.map(candidate => candidate.id));
    FC.assert(
      FC.property(FC.boolean(), FC.array(FC.integer({min: 0, max: 20}), {maxLength: 18}), (relevant, indexes) => {
        const candidateIds = indexes.map(index => `c${index}`);
        const hasKnownId = candidateIds.some(id => allowed.has(id));
        if (relevant && !hasKnownId) {
          expect(() => normalizeRecallCandidateSelection({candidateIds, relevant}, candidates)).toThrow();
          return;
        }
        const selected = normalizeRecallCandidateSelection({candidateIds, relevant}, candidates);
        expect(selected.length).toBeLessThanOrEqual(8);
        expect(new Set(selected).size).toBe(selected.length);
        expect(selected.every(id => allowed.has(id))).toBe(true);
        if (!relevant) expect(selected).toEqual([]);
      }),
      {numRuns: 80},
    );
  });

  effectIt.effect('keeps application code provider-independent', () =>
    expandRecallQueryEffect({project: 'threadnote', query: 'how do beta updates differ'}).pipe(
      provideTestLayer(
        Layer.succeed(RecallQueryExpander, {
          expand: ({query}) => Effect.succeed([`rewrite:${query}`]),
        }),
      ),
      Effect.tap(rewrites => Effect.sync(() => expect(rewrites).toEqual(['rewrite:how do beta updates differ']))),
    ),
  );

  effectIt.effect('keeps candidate selection provider-independent', () =>
    selectRecallCandidatesEffect({
      candidates: [{id: 'c1', summary: 'release channel', uri: 'threadnote://release'}],
      query: 'preview release updates',
    }).pipe(
      provideTestLayer(
        Layer.succeed(RecallCandidateSelector, {
          select: () => Effect.succeed(['c1']),
        }),
      ),
      Effect.tap(selected => Effect.sync(() => expect(selected).toEqual(['c1']))),
    ),
  );

  effectIt.effect('does not auto-load an optional generation model for ordinary recall', () =>
    Effect.gen(function* () {
      expect(
        yield* expandWeakRecallQueryEffect(
          {confidence: {level: 'no_answer'}, query: 'missing memory'},
          {agentContextHome: '/unused'},
          undefined,
        ),
      ).toEqual([]);
      expect(
        yield* selectExpandedRecallCandidatesEffect(
          {
            candidates: [{id: 'c1', summary: 'candidate', uri: 'threadnote://candidate'}],
            query: 'missing memory',
          },
          {agentContextHome: '/unused'},
          undefined,
        ),
      ).toBeUndefined();
    }).pipe(provideTestLayer(absentNativeModelLayer)),
  );

  effectIt.effect('uses the selected native generation model for bounded weak-recall rewrites and candidate IDs', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-native-recall-'});
        const catalog = yield* LocalModelCatalog;
        yield* selectLocalModel(home, catalog, 'generation', generationManifest.id);
        const requests: LocalGenerationRequest[] = [];
        const runtime = fakeModelRuntime(request =>
          Effect.sync(() => {
            requests.push(request);
            return request.prompt.includes('Select every candidate')
              ? {candidateIds: ['c2', 'unknown', 'c2'], relevant: true}
              : {queries: ['beta-update-channel prerelease upgrades', 'unrelated new topic']};
          }),
        );
        const candidates = [
          {id: 'c1', summary: 'stable release', uri: 'threadnote://stable'},
          {id: 'c2', summary: 'preview channel', uri: 'threadnote://preview'},
        ];
        yield* Effect.gen(function* () {
          expect(
            yield* expandWeakRecallQueryEffect(
              {
                confidence: {level: 'medium'},
                project: 'threadnote',
                query: 'How do preview builds get upgraded?',
                vocabulary: ['beta-update-channel :: preview build update contract'],
              },
              {agentContextHome: home},
              undefined,
            ),
          ).toEqual(['beta-update-channel']);
          expect(
            yield* selectExpandedRecallCandidatesEffect(
              {candidates, query: 'How do preview builds get upgraded?'},
              {agentContextHome: home},
              undefined,
            ),
          ).toEqual(['c2']);
          expect(
            yield* expandWeakRecallQueryEffect(
              {confidence: {level: 'high'}, query: 'already answered'},
              {agentContextHome: home},
              undefined,
            ),
          ).toEqual([]);
        }).pipe(
          Effect.provideService(LocalModelStore, fakeModelStore(home, true)),
          Effect.provideService(LocalModelRuntime, runtime),
        );
        expect(requests).toHaveLength(2);
        expect(requests.every(request => request.manifest.id === generationManifest.id && request.seed === 0)).toBe(
          true,
        );
        expect(requests[0].jsonSchema).toHaveProperty('properties.queries');
        expect(requests[1].jsonSchema).toHaveProperty('properties.candidateIds');
      }),
    ).pipe(provideTestLayer(modelPlatformLayer)),
  );

  effectIt.effect('leaves weak recall unchanged when a selected model is not installed', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-native-recall-absent-'});
        const catalog = yield* LocalModelCatalog;
        yield* selectLocalModel(home, catalog, 'generation', generationManifest.id);
        const runtime = fakeModelRuntime(() =>
          Effect.die(new Error('An uninstalled generation model must not load the worker.')),
        );
        expect(
          yield* expandWeakRecallQueryEffect(
            {confidence: {level: 'no_answer'}, query: 'missing memory'},
            {agentContextHome: home},
            undefined,
          ).pipe(
            Effect.provideService(LocalModelStore, fakeModelStore(home, false)),
            Effect.provideService(LocalModelRuntime, runtime),
          ),
        ).toEqual([]);
        expect(
          yield* selectExpandedRecallCandidatesEffect(
            {candidates: [{id: 'c1', summary: 'candidate', uri: 'threadnote://candidate'}], query: 'missing memory'},
            {agentContextHome: home},
            undefined,
          ).pipe(
            Effect.provideService(LocalModelStore, fakeModelStore(home, false)),
            Effect.provideService(LocalModelRuntime, runtime),
          ),
        ).toBeUndefined();
      }),
    ).pipe(provideTestLayer(modelPlatformLayer)),
  );

  effectIt.effect('fails open on unusable native shortlist output', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-native-recall-invalid-'});
        const catalog = yield* LocalModelCatalog;
        yield* selectLocalModel(home, catalog, 'generation', generationManifest.id);
        const selection = yield* selectExpandedRecallCandidatesEffect(
          {candidates: [{id: 'c1', summary: 'candidate', uri: 'threadnote://candidate'}], query: 'missing memory'},
          {agentContextHome: home},
          undefined,
        ).pipe(
          Effect.provideService(LocalModelStore, fakeModelStore(home, true)),
          Effect.provideService(
            LocalModelRuntime,
            fakeModelRuntime(() => Effect.succeed({candidateIds: ['unknown'], relevant: true})),
          ),
        );
        expect(selection).toBeUndefined();
      }),
    ).pipe(provideTestLayer(modelPlatformLayer)),
  );

  effectIt.effect('fails open when native generation itself fails', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-native-recall-failure-'});
        const catalog = yield* LocalModelCatalog;
        yield* selectLocalModel(home, catalog, 'generation', generationManifest.id);
        const runtime = fakeModelRuntime(() =>
          Effect.fail(
            GenerationFailed.make({
              cause: new Error('synthetic native failure'),
              message: 'Synthetic native generation failure.',
              modelId: generationManifest.id,
            }),
          ),
        );
        expect(
          yield* expandWeakRecallQueryEffect(
            {confidence: {level: 'no_answer'}, query: 'missing memory'},
            {agentContextHome: home},
            undefined,
          ).pipe(
            Effect.provideService(LocalModelStore, fakeModelStore(home, true)),
            Effect.provideService(LocalModelRuntime, runtime),
          ),
        ).toEqual([]);
        expect(
          yield* selectExpandedRecallCandidatesEffect(
            {candidates: [{id: 'c1', summary: 'candidate', uri: 'threadnote://candidate'}], query: 'missing memory'},
            {agentContextHome: home},
            undefined,
          ).pipe(
            Effect.provideService(LocalModelStore, fakeModelStore(home, true)),
            Effect.provideService(LocalModelRuntime, runtime),
          ),
        ).toBeUndefined();
      }),
    ).pipe(provideTestLayer(modelPlatformLayer)),
  );

  effectIt.effect('bounds the actual candidate selection and invokes it only once', () =>
    Effect.gen(function* () {
      let interrupted = 0;
      let invocations = 0;
      const selection = Effect.sync(() => {
        invocations += 1;
      }).pipe(
        Effect.andThen(Effect.sleep(RECALL_SELECTION_TIMEOUT_MILLISECONDS + 1)),
        Effect.as(['c1'] as const),
        Effect.onInterrupt(() => Effect.sync(() => (interrupted += 1))),
      );
      const fiber = yield* boundedRecallCandidateSelection(selection).pipe(Effect.forkChild);

      yield* TestClock.adjust(RECALL_SELECTION_TIMEOUT_MILLISECONDS);

      expect(yield* Fiber.join(fiber)).toBeUndefined();
      expect(invocations).toBe(1);
      expect(interrupted).toBe(1);
    }),
  );

  effectIt.effect('gives cold native generation a longer but still bounded selection window', () =>
    Effect.gen(function* () {
      const completed = yield* boundedRecallCandidateSelection(
        Effect.sleep(RECALL_SELECTION_TIMEOUT_MILLISECONDS + 1).pipe(Effect.as(['c1'] as const)),
        NATIVE_RECALL_TIMEOUT_MILLISECONDS,
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust(RECALL_SELECTION_TIMEOUT_MILLISECONDS + 1);
      expect(yield* Fiber.join(completed)).toEqual(['c1']);

      let interrupted = 0;
      const stalled = yield* boundedRecallCandidateSelection(
        Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => (interrupted += 1)))),
        NATIVE_RECALL_TIMEOUT_MILLISECONDS,
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust(NATIVE_RECALL_TIMEOUT_MILLISECONDS);
      expect(yield* Fiber.join(stalled)).toBeUndefined();
      expect(interrupted).toBe(1);
    }),
  );

  effectIt.effect('preserves external cancellation instead of treating it as a selection timeout', () =>
    Effect.gen(function* () {
      let invocations = 0;
      const selection = Effect.sync(() => {
        invocations += 1;
      }).pipe(Effect.andThen(Effect.never));
      const fiber = yield* boundedRecallCandidateSelection(selection).pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);

      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      expect(invocations).toBe(1);
    }),
  );

  fcEffectProp(
    effectIt,
    'returns a candidate selection exactly when arbitrary work finishes inside the budget',
    {
      delayMilliseconds: FC.oneof(
        FC.integer({max: RECALL_SELECTION_TIMEOUT_MILLISECONDS - 1, min: 0}),
        FC.integer({
          max: RECALL_SELECTION_TIMEOUT_MILLISECONDS * 2,
          min: RECALL_SELECTION_TIMEOUT_MILLISECONDS + 1,
        }),
      ),
    },
    ({delayMilliseconds}) =>
      Effect.gen(function* () {
        let interrupted = 0;
        let invocations = 0;
        const selection = Effect.sync(() => {
          invocations += 1;
        }).pipe(
          Effect.andThen(Effect.sleep(delayMilliseconds)),
          Effect.as(['c1'] as const),
          Effect.onInterrupt(() => Effect.sync(() => (interrupted += 1))),
        );
        const fiber = yield* boundedRecallCandidateSelection(selection).pipe(Effect.forkChild);

        yield* TestClock.adjust(Math.max(delayMilliseconds, RECALL_SELECTION_TIMEOUT_MILLISECONDS));

        const completedInsideBudget = delayMilliseconds < RECALL_SELECTION_TIMEOUT_MILLISECONDS;
        expect(yield* Fiber.join(fiber)).toEqual(completedInsideBudget ? ['c1'] : undefined);
        expect(invocations).toBe(1);
        expect(interrupted).toBe(completedInsideBudget ? 0 : 1);
      }),
    {fastCheck: {numRuns: 40}},
  );
});

function fakeModelStore(home: string, installed: boolean) {
  const installation = {
    bytes: installed ? generationManifest.size : 0,
    installed,
    modelId: generationManifest.id,
    partialBytes: 0,
    path: `${home}/models/gemma.gguf`,
    verified: installed,
  };
  return LocalModelStore.of({
    install: () => Effect.die(new Error('Unexpected model installation.')),
    path: () => installation.path,
    remove: () => Effect.die(new Error('Unexpected model removal.')),
    status: () => Effect.succeed(installation),
    verify: () => Effect.succeed(installation),
  });
}

function fakeModelRuntime(generate: LocalModelRuntimeShape['generate']) {
  return LocalModelRuntime.of({
    diagnostics: Effect.succeed({backend: 'fake', buildType: 'prebuilt', cpuMathCores: 4}),
    embedMany: () => Effect.die(new Error('Unexpected embedding.')),
    generate,
    rerank: () => Effect.die(new Error('Unexpected reranking.')),
  });
}
