import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Effect, Layer} from 'effect';
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
import {createRecallRerankerCache, prepareRecallSections} from '../../src/recall/runtime.js';
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
        semanticScores: null,
      });

    await Effect.runPromise(
      Effect.all([prepare(), prepare()], {concurrency: 1}).pipe(Effect.provide(ApplicationLayer)),
    );

    expect(inference.rerank).toHaveBeenCalledTimes(1);
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
  });
});
