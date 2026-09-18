import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import {it} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {describe, expect} from 'vitest';
import {TestError} from '../helpers/test-error.js';
import {LocalModelRuntime, type LocalEmbeddingError} from '../../src/effect/ai/local-model-runtime.js';
import {ResourceStore} from '../../src/effect/resource-store.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {EffectMcpServerAdapter} from '../../src/effect/ai/mcp.js';
import {registerCompactTool} from '../../src/mcp/server/memory.js';
import {runCompact} from '../../src/memory/commands.js';
import {formatMemoryDocument} from '../../src/memory/document.js';
import {BUILTIN_MODEL_MANIFESTS} from '../../src/models/builtin.js';
import {LocalModelCatalog} from '../../src/models/catalog.js';
import {selectLocalModel} from '../../src/models/selection.js';
import {LocalModelStore, type LocalModelStoreShape} from '../../src/models/store.js';
import {loadRecallIndexData, recallIndexStatus} from '../../src/recall/index.js';
import {ensureVectorIndex, vectorIndexGenerationReadiness} from '../../src/search/vector-index.js';
import type {RuntimeConfig} from '../../src/types.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const manifest = BUILTIN_MODEL_MANIFESTS.find(model => model.id === 'bge-small-en-v1.5-q8')!;

describe('composite memory mutation recall refresh', () => {
  it.effect('restores lexical and already-built selected vector readiness after CLI and MCP compact mutations', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const runtime = fakeRuntime((inputs, dimensions) => Effect.succeed(inputs.map(() => unitVector(dimensions))));

        yield* Effect.forEach(['cli', 'mcp'] as const, surface =>
          Effect.gen(function* () {
            const home = yield* fs.makeTempDirectoryScoped({prefix: `threadnote-${surface}-compact-index-refresh-`});
            const config: RuntimeConfig = {
              account: 'local',
              agentContextHome: home,
              agentId: 'test',
              manifestPath: path.join(home, 'seed-manifest.yaml'),
              user: 'tester',
            };
            yield* fs.writeFileString(config.manifestPath, 'version: 1\nprojects: []\n');
            yield* writeCompositeFixture(config);

            const catalog = yield* LocalModelCatalog;
            yield* selectLocalModel(home, catalog, 'embedding', manifest.id);
            const initial = yield* loadRecallIndexData(config, {forceRefresh: true, includeInactive: false});
            yield* ensureVectorIndex(config, manifest, initial.candidates, {corpusGeneration: initial.generation});

            if (surface === 'cli') {
              yield* runCompact(config, {apply: true, project: 'threadnote'});
            } else {
              const result = yield* invokeCompactContext(config);
              expect(result.isError).not.toBe(true);
            }

            const refreshed = yield* recallIndexStatus(config);
            expect(refreshed.ready).toBe(true);
            expect(refreshed.generation).not.toBe(initial.generation);
            expect(yield* vectorIndexGenerationReadiness(home, manifest, refreshed.generation!)).toBe('current');
            const candidates = yield* loadRecallIndexData(config, {includeInactive: false});
            expect(candidates.candidates).toHaveLength(1);
            expect(candidates.candidates[0]?.uri).toContain('/durable/projects/threadnote/');
          }).pipe(
            Effect.provideService(LocalModelRuntime, runtime),
            Effect.provideService(LocalModelStore, installedModelStore()),
          ),
        );
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );
});

const writeCompositeFixture = Effect.fn('test.writeCompositeFixture')(function* (config: RuntimeConfig) {
  const store = yield* ResourceStore;
  const location = {account: config.account, home: config.agentContextHome, user: config.user};
  const duplicate = formatMemoryDocument(
    'MEMORY',
    {
      kind: 'durable',
      project: 'threadnote',
      sourceAgentClient: 'test',
      status: 'active',
      timestamp: '2026-09-18T00:00:00.000Z',
      topic: 'duplicate',
    },
    'Synthetic exact duplicate retained by composite compaction.',
  );
  const archived = formatMemoryDocument(
    'HANDOFF',
    {
      kind: 'handoff',
      project: 'threadnote',
      sourceAgentClient: 'test',
      status: 'active',
      timestamp: '2026-07-01T00:00:00.000Z',
      topic: 'expired-handoff',
    },
    'Status: complete. Synthetic archival candidate.',
  );
  yield* store.write(
    location,
    'threadnote://user/tester/memories/durable/projects/threadnote/duplicate-a.md',
    duplicate,
    {mode: 'create'},
  );
  yield* store.write(
    location,
    'threadnote://user/tester/memories/durable/projects/threadnote/duplicate-b.md',
    duplicate,
    {mode: 'create'},
  );
  yield* store.write(
    location,
    'threadnote://user/tester/memories/handoffs/active/threadnote/expired-handoff.md',
    archived,
    {mode: 'create'},
  );
});

function invokeCompactContext(config: RuntimeConfig): Effect.Effect<CallToolResult> {
  type CompactArguments = {
    readonly apply?: boolean;
    readonly dryRun?: boolean;
    readonly kind?: 'durable' | 'handoff' | 'incident';
    readonly project?: string;
    readonly topic?: string;
  };
  let compactContext: ((arguments_: CompactArguments) => Effect.Effect<CallToolResult>) | undefined;
  const server = {
    registerTool: (
      _name: string,
      _definition: unknown,
      handler: (arguments_: CompactArguments) => Effect.Effect<CallToolResult>,
    ) => {
      compactContext = handler;
    },
  } as unknown as EffectMcpServerAdapter;
  registerCompactTool(server, config);
  return Effect.suspend(() =>
    compactContext === undefined
      ? Effect.die(TestError.make({message: 'compact_context was not registered.'}))
      : compactContext({apply: true, dryRun: false, project: 'threadnote'}),
  );
}

function fakeRuntime(
  embed: (
    inputs: readonly string[],
    dimensions: number,
  ) => Effect.Effect<readonly (readonly number[])[], LocalEmbeddingError>,
) {
  return LocalModelRuntime.of({
    diagnostics: Effect.succeed({backend: 'fake', buildType: 'prebuilt', cpuMathCores: 4}),
    embedMany: ({inputs, manifest: requested}) => embed(inputs, requested.dimensions ?? 0),
    generate: () => Effect.die(TestError.make({message: 'Unexpected generation'})),
    rerank: () => Effect.die(TestError.make({message: 'Unexpected reranking'})),
  });
}

function installedModelStore(): LocalModelStoreShape {
  const installation = {
    bytes: manifest.size,
    installed: true,
    modelId: manifest.id,
    partialBytes: 0,
    path: '/tmp/threadnote-test-model.gguf',
    verified: true,
  };
  return LocalModelStore.of({
    install: () => Effect.die(TestError.make({message: 'Unexpected install'})),
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
