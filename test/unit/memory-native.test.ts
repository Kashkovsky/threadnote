import {TestError} from '../helpers/test-error.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {expect, it} from '@effect/vitest';
import {Context, Deferred, Effect, Fiber, FileSystem, Layer, Option, Path, Scope} from 'effect';
import {describe} from 'vitest';
import {TestClock} from 'effect/testing';
import {isolatedLocalModelRuntimeLayer} from '../../src/effect/ai/isolated-local-model-runtime.js';
import {LocalModelRuntime} from '../../src/effect/ai/local-model-runtime.js';
import {captureConsole} from '../../src/effect/console.js';
import {withMemoryUriLocks} from '../../src/effect/memory_lock.js';
import {ResourceStore} from '../../src/effect/resource-store.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {
  runArchive,
  runCompact,
  runExportPack,
  runForget,
  runImportPack,
  runList,
  runRead,
  runRecall,
  runRemember,
} from '../../src/memory.js';
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

  it.effect('rolls back an archive copy when its source changes during the archive write', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-native-archive-race-'});
        const config: RuntimeConfig = {
          account: 'local',
          agentContextHome: home,
          agentId: 'threadnote',
          manifestPath: path.join(home, 'seed-manifest.yaml'),
          user: 'tester',
        };
        const store = yield* ResourceStore;
        const location = {account: config.account, home: config.agentContextHome, user: config.user};
        const sourceUri = 'threadnote://user/tester/memories/handoffs/active/threadnote/archive-race.md';
        const original = [
          'HANDOFF',
          'kind: handoff',
          'status: active',
          'project: threadnote',
          'topic: archive-race',
          'source_agent_client: test',
          'timestamp: 2026-07-01T00:00:00.000Z',
          '',
          'Original archive candidate.',
        ].join('\n');
        const changed = `${original}\n\nConcurrent source update.`;
        yield* store.write(location, sourceUri, original, {mode: 'create'});

        let sourceChanged = false;
        const racingStore = ResourceStore.of({
          ...store,
          write: (writeLocation, writeUri, content, options) =>
            store.write(writeLocation, writeUri, content, options).pipe(
              Effect.tap(() => {
                if (sourceChanged || !writeUri.includes('/handoffs/archived/')) return Effect.void;
                sourceChanged = true;
                return store.write(location, sourceUri, changed, {mode: 'replace'}).pipe(Effect.asVoid);
              }),
            ),
        });

        const failure = yield* Effect.flip(
          runArchive(config, sourceUri, {
            expectedContent: original,
            kind: 'handoff',
            project: 'threadnote',
            topic: 'archive-race',
          }).pipe(Effect.provideService(ResourceStore, racingStore)),
        );

        expect(String(failure)).toContain('archived copy was rolled back');
        expect(yield* store.read(location, sourceUri)).toBe(changed);
        const archived = yield* store
          .list(location, 'threadnote://user/tester/memories/handoffs/archived/threadnote')
          .pipe(Effect.catchTag('ResourceNotFound', () => Effect.succeed([])));
        expect(archived).toEqual([]);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('keeps concurrent compact updates independent without a shared scratch file', () =>
    TestClock.withLive(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-native-compact-concurrency-'});
          const config: RuntimeConfig = {
            account: 'local',
            agentContextHome: home,
            agentId: 'threadnote',
            manifestPath: path.join(home, 'seed-manifest.yaml'),
            user: 'tester',
          };
          const store = yield* ResourceStore;
          const location = {account: config.account, home: config.agentContextHome, user: config.user};
          const projects = ['alpha', 'beta'] as const;
          const uris = projects.map(project => ({
            copy: `threadnote://user/tester/memories/durable/projects/${project}/threadnote-copy.md`,
            stable: `threadnote://user/tester/memories/durable/projects/${project}/contract.md`,
          }));
          for (const [index, project] of projects.entries()) {
            const content = [
              'MEMORY',
              'kind: durable',
              'status: active',
              `project: ${project}`,
              'topic: contract',
              'source_agent_client: test',
              'timestamp: 2026-08-20T00:00:00.000Z',
              '',
              `Contract for ${project}.`,
            ].join('\n');
            yield* store.write(location, uris[index]!.stable, content, {mode: 'create'});
            yield* store.write(location, uris[index]!.copy, content, {mode: 'create'});
          }

          let sharedScratchWrites = 0;
          const observedFileSystem = FileSystem.FileSystem.of({
            ...fs,
            writeFileString: (target, content, options) => {
              if (target.endsWith('/compact-memory-update.txt')) sharedScratchWrites += 1;
              return fs.writeFileString(target, content, options);
            },
          });
          yield* Effect.all(
            projects.map(project => captureConsole(runCompact(config, {apply: true, project}))),
            {concurrency: 'unbounded'},
          ).pipe(Effect.provideService(FileSystem.FileSystem, observedFileSystem));

          expect(sharedScratchWrites).toBe(0);
          for (const pair of uris) {
            const kept = yield* store.read(location, pair.stable);
            expect(kept).toContain(`- ${pair.stable}`);
            expect(kept).toContain(`- ${pair.copy}`);
            expect(Option.isNone(yield* Effect.option(store.stat(location, pair.copy)))).toBe(true);
          }
        }),
      ),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('preserves the unchanged duplicate when the survivor is removed or mutated during compact apply', () =>
    TestClock.withLive(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-native-compact-survivor-race-'});
          const store = yield* ResourceStore;

          for (const race of ['mutate', 'remove'] as const) {
            const home = path.join(root, race);
            const config: RuntimeConfig = {
              account: 'local',
              agentContextHome: home,
              agentId: 'threadnote',
              manifestPath: path.join(home, 'seed-manifest.yaml'),
              user: 'tester',
            };
            const location = {account: config.account, home: config.agentContextHome, user: config.user};
            const survivorUri = `threadnote://user/tester/memories/durable/projects/${race}/contract.md`;
            const duplicateUri = `threadnote://user/tester/memories/durable/projects/${race}/threadnote-copy.md`;
            const original = [
              'MEMORY',
              'kind: durable',
              'status: active',
              `project: ${race}`,
              'topic: contract',
              'source_agent_client: test',
              'timestamp: 2026-08-20T00:00:00.000Z',
              '',
              `Stable ${race} contract.`,
            ].join('\n');
            const concurrentContent = `${original}\n\nConcurrent survivor mutation.`;
            yield* store.write(location, survivorUri, original, {mode: 'create'});
            yield* store.write(location, duplicateUri, original, {mode: 'create'});

            let raced = false;
            const racingStore = ResourceStore.of({
              ...store,
              write: (writeLocation, writeUri, content, options) =>
                store.write(writeLocation, writeUri, content, options).pipe(
                  Effect.tap(() => {
                    if (raced || writeUri !== survivorUri) return Effect.void;
                    raced = true;
                    return race === 'remove'
                      ? store.remove(location, survivorUri)
                      : store.write(location, survivorUri, concurrentContent, {mode: 'replace'}).pipe(Effect.asVoid);
                  }),
                ),
            });

            const failure = yield* Effect.flip(
              captureConsole(runCompact(config, {apply: true, project: race})).pipe(
                Effect.provideService(ResourceStore, racingStore),
              ),
            );

            expect(raced).toBe(true);
            expect(String(failure)).toContain('survivor changed during its hygiene update');
            expect(String(failure)).toContain('exact duplicate was preserved');
            expect(yield* store.read(location, duplicateUri)).toBe(original);
            if (race === 'remove') {
              expect(Option.isNone(yield* Effect.option(store.stat(location, survivorUri)))).toBe(true);
            } else {
              expect(yield* store.read(location, survivorUri)).toBe(concurrentContent);
            }
          }
        }),
      ),
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

  it.effect('holds every managed pack destination lock before importing any memory', () =>
    TestClock.withLive(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-native-pack-locks-'});
          const packPath = path.join(home, 'memories.threadnote-pack.json');
          const config: RuntimeConfig = {
            account: 'local',
            agentContextHome: home,
            agentId: 'threadnote',
            manifestPath: path.join(home, 'seed-manifest.yaml'),
            user: 'tester',
          };
          yield* fs.writeFileString(
            packPath,
            JSON.stringify({
              resources: [
                {content: 'first imported memory', relativeUri: 'first.md'},
                {content: 'second imported memory', relativeUri: 'second.md'},
              ],
              sourceUri: 'threadnote://user/source/memories/durable/projects/threadnote',
              version: 1,
            }),
          );
          const firstUri = 'threadnote://user/tester/memories/durable/projects/threadnote/first.md';
          const secondUri = 'threadnote://user/tester/memories/durable/projects/threadnote/second.md';
          const acquired = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const owner = yield* withMemoryUriLocks(
            fs,
            home,
            [secondUri],
            Deferred.succeed(acquired, undefined).pipe(Effect.andThen(Deferred.await(release))),
          ).pipe(Effect.forkScoped);
          yield* Deferred.await(acquired);

          yield* Effect.gen(function* () {
            const importCompleted = yield* Deferred.make<void>();
            const importer = yield* runImportPack(config, {path: packPath}).pipe(
              Effect.ensuring(Deferred.succeed(importCompleted, undefined)),
              Effect.forkScoped,
            );
            yield* Effect.sleep(100);
            expect(yield* Deferred.isDone(importCompleted)).toBe(false);
            const store = yield* ResourceStore;
            const location = {account: config.account, home, user: config.user};
            expect(Option.isNone(yield* store.stat(location, firstUri).pipe(Effect.option))).toBe(true);
            expect(Option.isNone(yield* store.stat(location, secondUri).pipe(Effect.option))).toBe(true);

            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(importer);
            expect(yield* store.read(location, firstUri)).toBe('first imported memory');
            expect(yield* store.read(location, secondUri)).toBe('second imported memory');
          }).pipe(
            Effect.ensuring(
              Deferred.succeed(release, undefined).pipe(Effect.andThen(Fiber.await(owner)), Effect.asVoid),
            ),
          );
        }),
      ),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('imports resource-only packs without creating managed-memory URI locks', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-native-resource-pack-'});
        const packPath = path.join(home, 'resources.threadnote-pack.json');
        const config: RuntimeConfig = {
          account: 'local',
          agentContextHome: home,
          agentId: 'threadnote',
          manifestPath: path.join(home, 'seed-manifest.yaml'),
          user: 'tester',
        };
        yield* fs.writeFileString(
          packPath,
          JSON.stringify({
            resources: [{content: 'portable resource', relativeUri: 'guide.md'}],
            sourceUri: 'threadnote://resources/source',
            version: 1,
          }),
        );

        yield* runImportPack(config, {path: packPath, targetUri: 'threadnote://resources/imported'});

        expect(yield* fs.exists(path.join(home, 'threadnote', 'memory-locks'))).toBe(false);
        const store = yield* ResourceStore;
        expect(
          yield* store.read(
            {account: config.account, home, user: config.user},
            'threadnote://resources/imported/guide.md',
          ),
        ).toBe('portable resource');
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
