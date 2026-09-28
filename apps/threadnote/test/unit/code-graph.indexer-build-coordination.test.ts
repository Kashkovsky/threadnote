import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Fiber, Path, Ref} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {buildOwnedCleanSnapshot} from '@threadnote/graph/indexer/build';
import {measureCodeGraphAttribution} from '@threadnote/graph/indexer/build_coordination';
import type {CodeGraphIndexResourceGate} from '@threadnote/graph/indexer/types';
import {codeGraphLayout} from '@threadnote/graph/layout';
import type {CodeGraphStoreShape} from '@threadnote/graph/store';
import type {CodeGraphLanguagePackRegistryShape} from '@threadnote/graph/languages/registry';
import type {RepositoryIdentity} from '@threadnote/graph/types';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {provideTestLayer} from '../helpers/effect-layer.js';

describe('indexer build coordination wiring', () => {
  effectIt.effect('starts attribution timing after preparation admission wait', () =>
    Effect.gen(function* () {
      const preparationGate: CodeGraphIndexResourceGate = effect =>
        Effect.sleep('100 millis').pipe(Effect.andThen(effect));
      const fiber = yield* measureCodeGraphAttribution(
        preparationGate,
        Effect.sleep('25 millis').pipe(Effect.as('attributed')),
      ).pipe(Effect.forkChild({startImmediately: true}));
      yield* TestClock.adjust('125 millis');
      expect(yield* Fiber.join(fiber)).toEqual([25, 'attributed']);
    }),
  );

  effectIt.effect('forwards clean direct builds through the prepared budget and scoped preparation gates', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-clean-build-coordination-'});
      const identity: RepositoryIdentity = {
        caseMode: 'sensitive',
        checkoutId: 'a'.repeat(64),
        displayName: 'fixture',
        gitCommonDirectory: path.join(home, '.git'),
        headCommit: 'b'.repeat(40),
        objectFormat: 'sha1',
        repoRoot: home,
        repositoryId: 'c'.repeat(64),
        worktreeId: 'd'.repeat(64),
      };
      const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
      yield* fs.makeDirectory(layout.repositoryRoot, {recursive: true});
      const events = yield* Ref.make<string[]>([]);
      const stopped = new Error('stop after coordination');
      const store = {
        claimPersistentBuild: () => Effect.succeed('owner-token'),
        resumableForcedBuild: () => Effect.void,
      } as unknown as CodeGraphStoreShape;
      const languagePacks = {
        activeCacheIdentities: () => [],
        activeDerivationIdentities: () => [],
        discoverWorkspace: () => Effect.fail(stopped),
      } as unknown as CodeGraphLanguagePackRegistryShape;
      const exit = yield* Effect.exit(
        buildOwnedCleanSnapshot({
          buildOwner: {processId: process.pid} as never,
          capacityProtection: {} as never,
          embedding: {} as never,
          ensureVectors: false,
          existing: undefined,
          fallbackSnapshotId: `cgsn_${'e'.repeat(40)}-direct`,
          force: true,
          fs,
          identity,
          inventory: {
            committedFiles: [],
            committedParsedFiles: 0,
            dirty: false,
            files: [],
            parsedFiles: 0,
            skipped: 0,
          },
          languagePacks,
          legacyBuildAdmission: effect =>
            Ref.update(events, values => [...values, 'legacy']).pipe(Effect.andThen(effect)),
          layout,
          logicalSnapshotId: `cgsn_${'f'.repeat(40)}`,
          preparationGate: effect =>
            Ref.update(events, values => [...values, 'preparation']).pipe(Effect.andThen(effect)),
          preparedSpoolBudgetGate: (_bytes, _snapshotId, effect) =>
            Ref.update(events, values => [...values, 'budget']).pipe(Effect.andThen(effect)),
          startedAt: 0,
          store,
          threadnoteHome: home,
        }),
      );
      expect(exit._tag).toBe('Failure');
      expect(yield* Ref.get(events)).toEqual(['budget', 'preparation']);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );
});
