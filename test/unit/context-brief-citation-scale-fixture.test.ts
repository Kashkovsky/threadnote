import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path, Result} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {describe, expect} from 'vitest';
import {
  observeCodeGraphAdmissionEnvironment,
  recordCodeGraphSnapshotAdmission,
} from '../../src/code_graph/admission_freshness.js';
import {
  CodeGraphLanguagePackRegistry,
  createCodeGraphLanguagePackRegistry,
} from '../../src/code_graph/languages/registry.js';
import {codeGraphLayout} from '../../src/code_graph/layout.js';
import {codeGraphSnapshotRuntimeCurrent} from '../../src/code_graph/query_snapshot_runtime.js';
import {CodeGraphStore} from '../../src/code_graph/store.js';
import {CommandExecutor} from '../../src/effect/command.js';
import {SystemInfo} from '../../src/effect/system.js';
import {parseContextBriefCitationScaleBudgetV1} from '../../src/evaluation/context-brief-citation-scale-contract.js';
import {prepareContextBriefCitationScaleRepositories} from '../../src/evaluation/context-brief-citation-scale-fixture.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const budget = parseContextBriefCitationScaleBudgetV1(
  JSON.parse(
    await Bun.file(
      new URL('../evaluation/baselines/context-brief-citations-v1/scale-budgets.json', import.meta.url),
    ).text(),
  ),
);
const systemLayer = SystemInfo.layer;
const commandLayer = CommandExecutor.layer.pipe(Layer.provide(systemLayer));
const platformLayer = Layer.mergeAll(systemLayer, commandLayer).pipe(Layer.provideMerge(BunServices.layer));
const storeLayer = CodeGraphStore.layer.pipe(Layer.provideMerge(platformLayer));
const fixtureLayer = Layer.mergeAll(
  storeLayer,
  Layer.succeed(CodeGraphLanguagePackRegistry, createCodeGraphLanguagePackRegistry([])),
);

describe('Context Brief prebuilt scale fixture admission', () => {
  effectIt.effect.prop(
    'publishes current evidence, requires its receipt, and binds it to the observed policy',
    {suffix: fc.nat(100_000)},
    ({suffix}) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const store = yield* CodeGraphStore;
        const packs = yield* CodeGraphLanguagePackRegistry;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-scale-admission-'});
        const home = path.join(root, 'home');
        const [repository] = yield* prepareContextBriefCitationScaleRepositories(
          fs,
          path,
          home,
          root,
          budget.profiles[0],
          1,
        );
        const identity = repository.status.identity;
        const snapshot = (yield* store.readySnapshot(repository.databasePath, identity.worktreeId))!;
        const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
        const current = () =>
          codeGraphSnapshotRuntimeCurrent(store, repository.databasePath, snapshot, packs, {layout, identity});
        expect(snapshot.id).toBe(repository.snapshotId);
        expect(yield* current()).toBe(true);
        yield* fs.remove(path.join(layout.repositoryRoot, 'admission'), {recursive: true});
        expect(yield* current()).toBe(false);
        yield* recordCodeGraphSnapshotAdmission(
          layout,
          snapshot,
          yield* observeCodeGraphAdmissionEnvironment(identity),
          packs,
          false,
        );
        expect(yield* current()).toBe(true);
        const exclude = path.join(repository.root, '.git', 'info', 'exclude');
        const original = yield* fs.readFileString(exclude);
        yield* fs.writeFileString(exclude, `excluded-${suffix}.ts\n`);
        expect(yield* current()).toBe(false);
        yield* fs.writeFileString(exclude, original);
        expect(yield* current()).toBe(true);
      }).pipe(provideTestLayer(fixtureLayer), TestClock.withLive),
    {fastCheck: {numRuns: 8}},
  );

  effectIt.effect('rejects admission policy changes during snapshot publication', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const store = yield* CodeGraphStore;
      const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-scale-admission-race-'});
      const home = path.join(root, 'home');
      const changingStore = CodeGraphStore.of({
        ...store,
        promote: (databasePath, identity, snapshotId, options) =>
          store
            .promote(databasePath, identity, snapshotId, options)
            .pipe(
              Effect.tap(() =>
                fs
                  .writeFileString(
                    path.join(identity.repoRoot, '.git', 'info', 'exclude'),
                    'changed-during-publication.ts\n',
                  )
                  .pipe(Effect.orDie),
              ),
            ),
      });
      const result = yield* prepareContextBriefCitationScaleRepositories(
        fs,
        path,
        home,
        root,
        budget.profiles[0],
        1,
      ).pipe(Effect.provideService(CodeGraphStore, changingStore), Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) expect(result.failure.message).toContain('admission policy changed');
    }).pipe(provideTestLayer(fixtureLayer), TestClock.withLive),
  );
});
