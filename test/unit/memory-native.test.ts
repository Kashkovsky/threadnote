import {TestError} from '../helpers/test-error.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {expect, it} from '@effect/vitest';
import {Context, Effect, FileSystem, Layer, Option, Path, Scope} from 'effect';
import {describe} from 'vitest';
import {TestClock} from 'effect/testing';
import {isolatedLocalModelRuntimeLayer} from '../../src/effect/ai/isolated-local-model-runtime.js';
import {LocalModelRuntime} from '../../src/effect/ai/local-model-runtime.js';
import {captureConsole} from '../../src/effect/console.js';
import {ResourceStore} from '../../src/effect/resource-store.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {runExportPack, runForget, runImportPack, runList, runRead, runRecall, runRemember} from '../../src/memory.js';
import {BUILTIN_MODEL_MANIFESTS} from '../../src/models/builtin.js';
import {LocalModelCatalog} from '../../src/models/catalog.js';
import {selectLocalModel} from '../../src/models/selection.js';
import {LocalModelStore, type LocalModelStoreShape} from '../../src/models/store.js';
import {loadRecallIndex} from '../../src/recall/index.js';
import {prepareRecallSections} from '../../src/recall/runtime.js';
import type {RuntimeConfig} from '../../src/types.js';
import {fatalLocalModelWorkerHarness} from '../helpers/fatal-local-model-worker.js';

const generationManifest = BUILTIN_MODEL_MANIFESTS.find(candidate => candidate.role === 'generation')!;

describe('native memory workflow', () => {
  it.effect('stores canonical memory when optional enrichment repeatedly crashes its native child', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const scope = yield* Scope.Scope;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-native-enrichment-crash-'});
        const manifestPath = path.join(home, 'seed-manifest.yaml');
        yield* fs.writeFileString(manifestPath, 'version: 1\nprojects: []\n');
        const config: RuntimeConfig = {
          account: 'local',
          agentContextHome: home,
          agentId: 'threadnote',
          manifestPath,
          user: 'tester',
        };
        const catalog = yield* LocalModelCatalog;
        yield* selectLocalModel(home, catalog, 'generation', generationManifest.id);

        const fatalWorker = fatalLocalModelWorkerHarness();
        const isolatedContext = yield* Layer.buildWithScope(
          isolatedLocalModelRuntimeLayer({
            idleTimeoutMs: 0,
            requestDeadlineMs: 2_000,
            spawnWorker: fatalWorker.spawnWorker,
          }),
          scope,
        );
        const isolatedRuntime = Context.get(isolatedContext, LocalModelRuntime);
        const modelPath = path.join(home, 'models', 'synthetic-generation.gguf');
        const installation = {
          bytes: generationManifest.size,
          installed: true,
          modelId: generationManifest.id,
          partialBytes: 0,
          path: modelPath,
          verified: true,
        };
        const modelStore = LocalModelStore.of({
          install: () => Effect.die(new TestError('Unexpected model install')),
          path: () => modelPath,
          remove: () => Effect.die(new TestError('Unexpected model removal')),
          status: () => Effect.succeed(installation),
          verify: () => Effect.die(new TestError('Unexpected model verification')),
        } satisfies LocalModelStoreShape);

        const remembered = yield* captureConsole(
          runRemember(config, {
            kind: 'durable',
            project: 'threadnote',
            sourceAgentClient: 'test',
            text: 'Canonical memory survives a fatal optional enrichment worker.',
            topic: 'fatal-enrichment-containment',
          }).pipe(
            Effect.provideService(LocalModelRuntime, isolatedRuntime),
            Effect.provideService(LocalModelStore, modelStore),
          ),
        );

        const canonicalPath = path.join(
          home,
          'data',
          'local',
          'user',
          'tester',
          'memories',
          'durable',
          'projects',
          'threadnote',
          'fatal-enrichment-containment.md',
        );
        expect(yield* fs.exists(canonicalPath)).toBe(true);
        expect(yield* fs.readFileString(canonicalPath)).toContain(
          'Canonical memory survives a fatal optional enrichment worker.',
        );
        expect(remembered.output).toContain('Local AI memory enrichment skipped:');
        expect(remembered.output).toContain('Stored memory:');
        expect(fatalWorker.spawnCount()).toBe(2);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('stores, reads, lists, recalls, and forgets in the owned canonical store', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-native-memory-'});
        const manifestPath = path.join(home, 'seed-manifest.yaml');
        yield* fs.writeFileString(manifestPath, 'version: 1\nprojects: []\n');
        const config: RuntimeConfig = {
          account: 'local',
          agentContextHome: home,
          agentId: 'threadnote',
          manifestPath,
          user: 'tester',
        };
        yield* TestClock.setTime(Date.now());
        const uri = 'threadnote://user/tester/memories/durable/projects/threadnote/lease-recovery.md';

        yield* runRemember(config, {
          kind: 'durable',
          project: 'threadnote',
          sourceAgentClient: 'test',
          text: 'QX7 lease recovery resumes a worker after three missed heartbeats.',
          topic: 'lease-recovery',
        });

        const read = yield* captureConsole(runRead(config, uri, {}));
        expect(read.output).toContain('QX7 lease recovery');

        const list = yield* captureConsole(
          runList(config, 'threadnote://user/tester/memories/durable/projects/threadnote', {recursive: true}),
        );
        expect(list.output).toContain(uri);

        const indexed = yield* loadRecallIndex(config, {
          forceRefresh: true,
          includeInactive: false,
          query: 'QX7 missed heartbeat lease recovery',
        });
        expect(indexed.map(candidate => candidate.uri)).toContain(uri);

        const recall = yield* captureConsole(
          runRecall(config, {
            inferScope: false,
            query: 'QX7 missed heartbeat lease recovery',
          }),
        );
        expect(recall.output).toContain(uri);
        expect(recall.output).not.toContain('background service');

        yield* runForget(config, uri, {});
        expect(
          yield* fs.exists(
            path.join(
              home,
              'data',
              'local',
              'user',
              'tester',
              'memories',
              'durable',
              'projects',
              'threadnote',
              'lease-recovery.md',
            ),
          ),
        ).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('previews and recursively forgets an exact shared team subtree while preserving siblings', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-native-forget-subtree-'});
        const manifestPath = path.join(home, 'seed-manifest.yaml');
        yield* fs.writeFileString(manifestPath, 'version: 1\nprojects: []\n');
        const config: RuntimeConfig = {
          account: 'local',
          agentContextHome: home,
          agentId: 'threadnote',
          manifestPath,
          user: 'tester',
        };
        const store = yield* ResourceStore;
        const location = {account: config.account, home: config.agentContextHome, user: config.user};
        const retired = 'threadnote://user/tester/memories/shared/retired';
        const nested = `${retired}/durable/projects/app/memory.md`;
        const sibling = 'threadnote://user/tester/memories/shared/active/durable/projects/app/memory.md';
        yield* store.write(location, nested, 'retired', {mode: 'create'});
        yield* store.write(location, sibling, 'active', {mode: 'create'});

        const preview = yield* captureConsole(runForget(config, retired, {dryRun: true}));
        expect(preview.output).toContain(`Would remove native resource subtree: ${retired}`);
        expect(yield* store.read(location, nested)).toBe('retired');

        yield* runForget(config, retired, {});

        expect(Option.isNone(yield* Effect.option(store.stat(location, retired)))).toBe(true);
        expect(yield* store.read(location, sibling)).toBe('active');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('rejects anchored and broad collection targets before forget mutation', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-native-forget-guard-'});
        const manifestPath = path.join(home, 'seed-manifest.yaml');
        yield* fs.writeFileString(manifestPath, 'version: 1\nprojects: []\n');
        const config: RuntimeConfig = {
          account: 'local',
          agentContextHome: home,
          agentId: 'threadnote',
          manifestPath,
          user: 'tester',
        };

        const collectionFailure = yield* Effect.flip(
          runForget(config, 'threadnote://user/tester/memories/shared', {dryRun: true}),
        );
        expect(String(collectionFailure)).toContain('collection root');

        const resourceCollectionFailure = yield* Effect.flip(
          runForget(config, 'threadnote://resources/repos', {dryRun: true}),
        );
        expect(String(resourceCollectionFailure)).toContain('collection root');

        const anchorFailure = yield* Effect.flip(
          runForget(config, 'threadnote://user/tester/memories/durable/note.md#section', {dryRun: true}),
        );
        expect(String(anchorFailure)).toContain('anchored resource');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('uses the SQLite exact index for a production no-hit recall instead of canonical grep scans', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-native-no-hit-'});
        const manifestPath = path.join(home, 'seed-manifest.yaml');
        yield* fs.writeFileString(manifestPath, 'version: 1\nprojects: []\n');
        const config: RuntimeConfig = {
          account: 'local',
          agentContextHome: home,
          agentId: 'threadnote',
          manifestPath,
          user: 'tester',
        };
        const memoryRoot = path.join(
          home,
          'data',
          'local',
          'user',
          'tester',
          'memories',
          'durable',
          'projects',
          'threadnote',
        );
        yield* fs.makeDirectory(memoryRoot, {recursive: true});
        yield* Effect.forEach(
          Array.from({length: 100}, (_unused, index) => index),
          index =>
            fs.writeFileString(
              path.join(memoryRoot, `memory-${index}.md`),
              `# Memory ${index}\n\nA deterministic unrelated corpus entry ${index}.`,
            ),
          {concurrency: 16, discard: true},
        );
        yield* loadRecallIndex(config, {includeInactive: false, query: 'deterministic'});

        const store = yield* ResourceStore;
        let grepManyCalls = 0;
        const instrumentedStore = ResourceStore.of({
          ...store,
          grepMany: () =>
            Effect.sync(() => {
              grepManyCalls += 1;
              return [];
            }),
        });
        yield* captureConsole(
          runRecall(config, {
            inferScope: false,
            query: 'NOHIT-908172635',
          }),
        ).pipe(Effect.provideService(ResourceStore, instrumentedStore));

        expect(grepManyCalls).toBe(0);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('does not advertise dangling referenced-context pointers', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-native-references-'});
        const manifestPath = path.join(home, 'seed-manifest.yaml');
        yield* fs.writeFileString(manifestPath, 'version: 1\nprojects: []\n');
        const config: RuntimeConfig = {
          account: 'local',
          agentContextHome: home,
          agentId: 'threadnote',
          manifestPath,
          user: 'tester',
        };
        const memoryRoot = path.join(
          home,
          'data',
          'local',
          'user',
          'tester',
          'memories',
          'durable',
          'projects',
          'threadnote',
        );
        const sourceUri = 'threadnote://user/tester/memories/durable/projects/threadnote/reference-source.md';
        const existingUri = 'threadnote://user/tester/memories/durable/projects/threadnote/existing-target.md';
        const missingUri = 'threadnote://user/tester/memories/durable/projects/threadnote/missing-target.md';
        yield* fs.makeDirectory(memoryRoot, {recursive: true});
        yield* fs.writeFileString(
          path.join(memoryRoot, 'reference-source.md'),
          [
            'MEMORY',
            'kind: durable',
            'status: active',
            'project: threadnote',
            'topic: reference-source',
            'source_agent_client: test',
            'timestamp: 2026-07-30T00:00:00.000Z',
            `references: ${existingUri}`,
            `references: ${missingUri}`,
            '',
            '# Reference source',
            '',
            'DANGLING-REFERENCE-908172635 belongs only to the surfaced source.',
          ].join('\n'),
        );
        yield* fs.writeFileString(
          path.join(memoryRoot, 'existing-target.md'),
          [
            'MEMORY',
            'kind: durable',
            'status: active',
            'project: threadnote',
            'topic: existing-target',
            'source_agent_client: test',
            'timestamp: 2026-07-30T00:00:00.000Z',
            '',
            '# Existing target',
            '',
            'Readable prior design context.',
          ].join('\n'),
        );
        yield* loadRecallIndex(config, {
          forceRefresh: true,
          includeInactive: false,
          query: 'DANGLING-REFERENCE-908172635',
        });

        const recalled = yield* captureConsole(
          runRecall(config, {
            inferScope: false,
            query: 'DANGLING-REFERENCE-908172635',
            threshold: '0.1',
          }),
        );

        expect(recalled.output).toContain(sourceUri);
        expect(recalled.output).toContain(existingUri);
        expect(recalled.output).not.toContain(missingUri);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('round-trips the default pack root into the current user memories namespace', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-native-pack-'});
        const sourceHome = path.join(root, 'source');
        const targetHome = path.join(root, 'target');
        const packPath = path.join(root, 'memories.threadnote-pack.json');
        yield* fs.makeDirectory(sourceHome, {recursive: true});
        yield* fs.makeDirectory(targetHome, {recursive: true});
        const sourceConfig: RuntimeConfig = {
          account: 'local',
          agentContextHome: sourceHome,
          agentId: 'threadnote',
          manifestPath: path.join(sourceHome, 'seed-manifest.yaml'),
          user: 'source-user',
        };
        const targetConfig: RuntimeConfig = {
          ...sourceConfig,
          agentContextHome: targetHome,
          manifestPath: path.join(targetHome, 'seed-manifest.yaml'),
          user: 'target-user',
        };
        yield* TestClock.setTime(Date.now());
        yield* runRemember(sourceConfig, {
          kind: 'durable',
          project: 'threadnote',
          sourceAgentClient: 'test',
          text: 'Pack round-trip preserves the memories root.',
          topic: 'pack-root',
        });

        yield* runExportPack(sourceConfig, {path: packPath});
        yield* runImportPack(targetConfig, {path: packPath});

        const importedUri = 'threadnote://user/target-user/memories/durable/projects/threadnote/pack-root.md';
        expect((yield* captureConsole(runRead(targetConfig, importedUri, {}))).output).toContain(
          'Pack round-trip preserves',
        );
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('retains preferred project-scope candidates alongside the global fallback', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-preferred-recall-scope-'});
        const globalRoot = path.join(home, 'data', 'local', 'resources', 'repos', 'alpha');
        const scopedRoot = path.join(home, 'data', 'local', 'resources', 'repos', 'zeta');
        yield* fs.makeDirectory(globalRoot, {recursive: true});
        yield* fs.makeDirectory(scopedRoot, {recursive: true});
        yield* Effect.forEach(
          Array.from({length: 140}, (_, index) => index),
          index =>
            fs.writeFileString(
              path.join(globalRoot, `${String(index).padStart(3, '0')}.md`),
              `# Global ${index}\n\ncommon recall term`,
            ),
          {concurrency: 16},
        );
        yield* fs.writeFileString(path.join(scopedRoot, 'target.md'), '# Scoped target\n\ncommon recall term');
        const config: RuntimeConfig = {
          account: 'local',
          agentContextHome: home,
          agentId: 'threadnote',
          manifestPath: path.join(home, 'seed-manifest.yaml'),
          user: 'tester',
        };

        const result = yield* prepareRecallSections(config, {
          allowExactRescue: false,
          exactMatches: [],
          feedbackQuery: 'common recall term',
          includeInactive: false,
          limit: 5,
          passes: [],
          preferredUriScopes: ['threadnote://resources/repos/zeta'],
          query: 'common recall term',
          readRecords: () => Effect.succeed([]),
          semanticResult: Option.none(),
        });

        expect(result.expansionCandidates.map(candidate => candidate.uri)).toContain(
          'threadnote://resources/repos/zeta/target.md',
        );
        expect(result.expansionCandidates.some(candidate => candidate.uri.includes('/repos/alpha/'))).toBe(true);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );
});
