import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path} from 'effect';
import * as FC from 'effect/testing/FastCheck';
import {TestClock} from 'effect/testing';
import {SystemInfo} from '../../src/effect/system.js';
import {expireRecallIndexValidation, loadRecallIndexData} from '../../src/recall/index.js';
import {recallIndexForegroundRefreshRequired} from '../../src/recall/index_freshness.js';

const RecallIndexTestLayer = Layer.merge(BunServices.layer, SystemInfo.layer);

describe('recall index foreground freshness', () => {
  effectIt.effect.prop(
    'requires refresh exactly for force, initialization, integrity, or generation changes',
    {
      canonicalGeneration: FC.string({maxLength: 48}),
      forceRefresh: FC.boolean(),
      generation: FC.string({maxLength: 48}),
      initialized: FC.boolean(),
      integrityCurrent: FC.boolean(),
    },
    ({canonicalGeneration, forceRefresh, generation, initialized, integrityCurrent}) =>
      Effect.sync(() => {
        const markerCurrent = recallIndexForegroundRefreshRequired({
          forceRefresh,
          initialized,
          integrityCurrent,
          observedCanonicalMutationGeneration: canonicalGeneration,
          observedStaleGeneration: generation,
          persistedCanonicalMutationGeneration: canonicalGeneration,
          persistedStaleGeneration: generation,
        });
        const changed = recallIndexForegroundRefreshRequired({
          forceRefresh: false,
          initialized: true,
          integrityCurrent: true,
          observedCanonicalMutationGeneration: canonicalGeneration,
          observedStaleGeneration: `${generation}:changed`,
          persistedCanonicalMutationGeneration: canonicalGeneration,
          persistedStaleGeneration: generation,
        });
        const canonicalChanged = recallIndexForegroundRefreshRequired({
          forceRefresh: false,
          initialized: true,
          integrityCurrent: true,
          observedCanonicalMutationGeneration: `${canonicalGeneration}:changed`,
          observedStaleGeneration: generation,
          persistedCanonicalMutationGeneration: canonicalGeneration,
          persistedStaleGeneration: generation,
        });

        expect(markerCurrent).toBe(forceRefresh || !initialized || !integrityCurrent);
        expect(changed).toBe(true);
        expect(canonicalChanged).toBe(true);
      }),
    {fastCheck: {numRuns: 100}},
  );

  effectIt.layer(RecallIndexTestLayer)(layerIt => {
    layerIt.effect('does not rescan an unchanged corpus after the former validation interval', () =>
      withRecallHome((home, fs, path) =>
        Effect.gen(function* () {
          const resourceRoot = path.join(home, 'data', 'local', 'resources', 'repos', 'threadnote');
          const resourcePath = path.join(resourceRoot, 'contract.md');
          const config = {account: 'local', agentContextHome: home, user: 'freshness-user'};
          yield* fs.makeDirectory(resourceRoot, {recursive: true});
          yield* fs.writeFileString(resourcePath, '# Contract\n\nfirst-version-anchor\n');
          yield* loadRecallIndexData(config, {forceRefresh: true, includeInactive: false});

          yield* fs.writeFileString(resourcePath, '# Contract\n\nsecond-version-anchor\n');
          yield* TestClock.adjust('31 seconds');
          const foregroundProgress: string[] = [];
          const cached = yield* loadRecallIndexData(config, {
            includeInactive: false,
            onProgress: progress =>
              Effect.sync(() => {
                foregroundProgress.push(progress.phase);
              }),
            query: 'first-version-anchor',
          });

          expect(foregroundProgress).toEqual([]);
          expect(cached.candidates[0]?.text).toContain('first-version-anchor');

          yield* expireRecallIndexValidation(home, false, ['threadnote://resources/repos/threadnote/contract.md']);
          const refreshed = yield* loadRecallIndexData(config, {
            includeInactive: false,
            query: 'second-version-anchor',
          });
          expect(refreshed.candidates[0]?.text).toContain('second-version-anchor');
        }),
      ),
    );
  });
});

function withRecallHome<A, E, R>(
  use: (home: string, fs: FileSystem.FileSystem, path: Path.Path) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectory({prefix: 'threadnote-recall-freshness-'});
    return yield* use(home, fs, path).pipe(
      Effect.ensuring(fs.remove(home, {force: true, recursive: true}).pipe(Effect.catch(() => Effect.void))),
    );
  });
}
