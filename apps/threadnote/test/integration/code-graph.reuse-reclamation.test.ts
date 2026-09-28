import {describe, expect, it as effectIt} from '@effect/vitest';
import {Context, Deferred, Effect, Fiber, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {CommandExecutor} from '@threadnote/platform/command';
import {CodeGraphIndexer, type CodeGraphIndexOptions} from '@threadnote/graph/indexer';
import {CodeGraphStore, type CodeGraphStoreShape} from '@threadnote/graph/store';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {provideTestLayer} from '../helpers/effect-layer.js';

type Cleanup = {readonly mode: string; readonly retained: readonly string[]; readonly scopeId?: string};
type Event =
  | {readonly type: 'cleanup'; readonly cleanup: Cleanup}
  | {readonly type: 'claim' | 'alias' | 'incremental'; readonly snapshotId?: string};

describe('application indexer reclamation policy', () => {
  for (const scoped of [false, true]) {
    effectIt.effect(`preserves cleanup policy for an already-ready ${scoped ? 'scoped' : 'full'} snapshot`, () =>
      withFixture(fixture =>
        Effect.gen(function* () {
          const options = scoped
            ? {
                ...fixture.options,
                project: {
                  uri: 'threadnote://resources/repos/fixture',
                  graph: {closure: 'dependencies' as const, roots: ['packages/a']},
                },
              }
            : fixture.options;
          const baseline = yield* fixture.indexer.index(options);
          expect(fixture.events[0]).toMatchObject({
            cleanup: {mode: 'required', scopeId: baseline.snapshot.scopeId},
          });
          fixture.events.length = 0;
          const warm = yield* fixture.indexer.index(options);
          expect(warm.snapshot.id).toBe(baseline.snapshot.id);
          expect(warm.materialization?.mode).toBe('reused-snapshot');
          expect(fixture.events).toEqual(
            scoped ? [] : [{type: 'cleanup', cleanup: {mode: 'deferred', retained: [], scopeId: undefined}}],
          );
          if (scoped) expect(baseline.snapshot.scopeId).toMatch(/^code-graph-scope:/u);
        }),
      ),
    );
  }

  effectIt.effect('drains before clean alias, clean incremental, forced full, and dirty direct publication', () =>
    withFixture(fixture =>
      Effect.gen(function* () {
        yield* fixture.indexer.index(fixture.options);
        fixture.events.length = 0;
        yield* fixture.git(['commit', '--allow-empty', '-qm', 'graph-equivalent commit']);
        const alias = yield* fixture.indexer.index(fixture.options);
        expect(alias.materialization?.mode).toBe('reused-snapshot');
        expect(fixture.events.map(event => event.type)).toEqual(['cleanup', 'alias']);
        expect(fixture.events[0]).toMatchObject({cleanup: {mode: 'required'}});

        fixture.events.length = 0;
        yield* fixture.changeSource('committedChange');
        yield* fixture.git(['commit', '-am', 'change one source', '-q']);
        const incremental = yield* fixture.indexer.index(fixture.options);
        expect(incremental.materialization?.mode).toBe('incremental-clean');
        expect(fixture.events.map(event => event.type)).toEqual(['cleanup', 'incremental']);
        expect(fixture.events[0]).toMatchObject({cleanup: {mode: 'required'}});

        fixture.events.length = 0;
        const forced = yield* fixture.indexer.index({...fixture.options, force: true});
        expect(forced.materialization?.mode).toBe('full');
        expect(fixture.events.map(event => event.type)).toEqual(['cleanup', 'claim']);
        expect(fixture.events[0]).toMatchObject({cleanup: {mode: 'required', retained: [forced.snapshot.id]}});

        fixture.events.length = 0;
        yield* fixture.changeSource('dirtyChange');
        const dirty = yield* fixture.indexer.index({...fixture.options, incrementalOverlay: false});
        expect(dirty.materialization?.mode).toBe('full');
        expect(fixture.events.map(event => event.type)).toEqual(['cleanup', 'claim']);
        expect(fixture.events[0]).toMatchObject({cleanup: {mode: 'required', retained: [dirty.snapshot.id]}});

        fixture.events.length = 0;
        yield* fixture.git(['commit', '-am', 'commit exact dirty graph', '-q']);
        const committedDirty = yield* fixture.indexer.index(fixture.options);
        expect(committedDirty.materialization?.mode).toBe('reused-snapshot');
        expect(committedDirty.snapshot.baseSnapshotId).toBe(dirty.snapshot.id);
        expect(fixture.events.map(event => event.type)).toEqual(['cleanup', 'alias']);
        expect(fixture.events[0]).toMatchObject({cleanup: {mode: 'required'}});
      }),
    ),
  );

  effectIt.effect('makes bounded cleanup progress when a concurrent builder already completed the target', () =>
    withFixture(fixture =>
      Effect.gen(function* () {
        yield* fixture.changeSource('concurrentDirty');
        const scanning = yield* Deferred.make<void>();
        const releaseOwner = yield* Deferred.make<void>();
        const waiting = yield* Deferred.make<void>();
        let held = false;
        const owner = yield* fixture.indexer
          .index({
            ...fixture.options,
            incrementalOverlay: false,
            onProgress: progress => {
              if (held || progress.phase !== 'scanning') return Effect.void;
              held = true;
              return Deferred.succeed(scanning, undefined).pipe(Effect.andThen(Deferred.await(releaseOwner)));
            },
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(scanning);
        const waiter = yield* fixture.indexer
          .index({
            ...fixture.options,
            incrementalOverlay: false,
            onProgress: progress =>
              progress.phase === 'waiting' && progress.reason === 'request-lock'
                ? Deferred.succeed(waiting, undefined).pipe(Effect.asVoid)
                : Effect.void,
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(waiting);
        yield* Deferred.succeed(releaseOwner, undefined);
        const built = yield* Fiber.join(owner);
        const reused = yield* Fiber.join(waiter);
        expect(reused.snapshot.id).toBe(built.snapshot.id);
        expect(reused.materialization?.mode).toBe('reused-snapshot');
        expect(fixture.events.map(event => event.type)).toEqual(['cleanup', 'claim', 'cleanup']);
        expect(fixture.events.at(-1)).toEqual({
          type: 'cleanup',
          cleanup: {mode: 'deferred', retained: [], scopeId: undefined},
        });
      }),
    ),
  );
});

const withFixture = Effect.fn(function* <A, E, R>(
  use: (fixture: {
    readonly indexer: CodeGraphIndexer['Service'];
    readonly options: CodeGraphIndexOptions;
    readonly events: Event[];
    readonly changeSource: (name: string) => Effect.Effect<void, unknown>;
    readonly git: (args: readonly string[]) => Effect.Effect<void, unknown>;
  }) => Effect.Effect<A, E, R>,
) {
  return yield* Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const command = yield* CommandExecutor;
    const store = yield* CodeGraphStore;
    const temporary = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-reuse-policy-'});
    const root = path.join(temporary, 'repository');
    const sourceDirectory = path.join(root, 'packages', 'a');
    yield* fs.makeDirectory(sourceDirectory, {recursive: true});
    yield* fs.writeFileString(
      path.join(root, 'package.json'),
      JSON.stringify({name: 'fixture', private: true, workspaces: ['packages/*']}),
    );
    yield* fs.writeFileString(
      path.join(sourceDirectory, 'package.json'),
      JSON.stringify({name: '@fixture/a', type: 'module'}),
    );
    for (let index = 0; index < 12; index += 1) {
      yield* fs.writeFileString(
        path.join(sourceDirectory, `file-${index}.ts`),
        `export function original${index}() { return ${index}; }\n`,
      );
    }
    const git = (args: readonly string[]) => command.execute('git', ['-C', root, ...args]).pipe(Effect.asVoid);
    yield* git(['init', '-q']);
    yield* git(['config', 'user.name', 'Fixture']);
    yield* git(['config', 'user.email', 'fixture@example.test']);
    yield* git(['add', '.']);
    yield* git(['commit', '-qm', 'initial']);
    const events: Event[] = [];
    const instrumented: CodeGraphStoreShape = {
      ...store,
      retireIncompleteWorktreeSnapshots: (...args) =>
        Effect.sync(() => {
          events.push({
            type: 'cleanup',
            cleanup: {mode: args[5]?.cleanupMode ?? 'required', retained: [...args[3]], scopeId: args[5]?.scopeId},
          });
        }).pipe(Effect.andThen(store.retireIncompleteWorktreeSnapshots(...args))),
      claimPersistentBuild: (...args) =>
        Effect.sync(() => {
          events.push({type: 'claim', snapshotId: args[2].id});
        }).pipe(Effect.andThen(store.claimPersistentBuild(...args))),
      activateCleanSnapshotAlias: (...args) =>
        Effect.sync(() => {
          events.push({type: 'alias', snapshotId: args[2].id});
        }).pipe(Effect.andThen(store.activateCleanSnapshotAlias!(...args))),
      preparePersistedIncrementalActivation: (...args) =>
        Effect.sync(() => {
          events.push({type: 'incremental'});
        }).pipe(Effect.andThen(store.preparePersistedIncrementalActivation(...args))),
    };
    const context = yield* Layer.build(
      Layer.fresh(CodeGraphIndexer.layer).pipe(Layer.provide(Layer.succeed(CodeGraphStore, instrumented))),
    );
    return yield* use({
      indexer: Context.get(context, CodeGraphIndexer),
      options: {
        cwd: root,
        threadnoteHome: path.join(temporary, 'home'),
        ensureVectors: false,
        diskCapacityAvailableBytes: () => Effect.succeed(Number.MAX_SAFE_INTEGER),
      },
      events,
      git,
      changeSource: name =>
        fs.writeFileString(path.join(sourceDirectory, 'file-0.ts'), `export function ${name}() { return 42; }\n`),
    });
  }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive);
});
