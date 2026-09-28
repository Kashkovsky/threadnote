import {TestCommandExecutorLayer} from '../helpers/system-layer.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path, Result} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {describe, expect} from 'vitest';
import {
  observeCodeGraphAdmissionEnvironment,
  recordCodeGraphSnapshotAdmission,
} from '@threadnote/graph/admission_freshness';
import {CodeGraphLanguagePackRegistry, createCodeGraphLanguagePackRegistry} from '@threadnote/graph/languages/registry';
import {codeGraphLayout} from '@threadnote/graph/layout';
import {codeGraphSnapshotRuntimeCurrent} from '@threadnote/graph/query/snapshot_runtime';
import {CodeGraphStore} from '@threadnote/graph/store';

import {parseContextBriefCitationScaleBudgetV1} from '@threadnote/threadnote/evaluation/context-brief-citation-scale-contract';
import {prepareContextBriefCitationScaleRepositories} from '@threadnote/threadnote/evaluation/context-brief-citation-scale-fixture';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {makeIdempotentFixtureTempDirectoryScoped} from '@threadnote/testing/fixture-temp-directory';

const budget = parseContextBriefCitationScaleBudgetV1(
  JSON.parse(
    await Bun.file(
      new URL('../evaluation/baselines/context-brief-citations-v1/scale-budgets.json', import.meta.url),
    ).text(),
  ),
);
const systemLayer = TestSystemInfoLayer;
const commandLayer = TestCommandExecutorLayer.pipe(Layer.provide(systemLayer));
const platformLayer = Layer.mergeAll(systemLayer, commandLayer).pipe(Layer.provideMerge(BunServices.layer));
const storeLayer = CodeGraphStore.layer.pipe(Layer.provideMerge(platformLayer));
const fixtureLayer = Layer.mergeAll(
  storeLayer,
  Layer.succeed(CodeGraphLanguagePackRegistry, createCodeGraphLanguagePackRegistry([])),
);

describe('Context Brief prebuilt scale fixture admission', () => {
  fcEffectProp(
    effectIt,
    'publishes current evidence, requires its receipt, and binds it to the observed policy',
    {suffix: fc.nat(100_000)},
    ({suffix}) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const store = yield* CodeGraphStore;
        const packs = yield* CodeGraphLanguagePackRegistry;
        const root = yield* makeIdempotentFixtureTempDirectoryScoped(fs, 'threadnote-scale-admission-');
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

  effectIt.effect('cleans up idempotently when the scale admission fixture root disappears before finalization', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* makeIdempotentFixtureTempDirectoryScoped(fs, 'threadnote-scale-admission-cleanup-');
      const home = path.join(root, 'home');
      yield* prepareContextBriefCitationScaleRepositories(fs, path, home, root, budget.profiles[0], 1);

      yield* fs.remove(root, {force: true, recursive: true});

      expect(yield* fs.exists(root)).toBe(false);
    }).pipe(provideTestLayer(fixtureLayer), TestClock.withLive),
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
