import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import * as FC from 'effect/testing/FastCheck';
import {
  codeGraphSnapshotAdmissionCurrent,
  recordCodeGraphSnapshotAdmission,
} from '../../src/code_graph/admission_freshness.js';
import {codeGraphBuildRequestKey} from '../../src/code_graph/indexer_build.js';
import {BUILTIN_LANGUAGE_PACK_REGISTRY} from '../../src/code_graph/languages/registry.js';
import {codeGraphLayout} from '../../src/code_graph/layout.js';
import type {CodeGraphSnapshot} from '../../src/code_graph/types.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

describe('snapshot admission cache', () => {
  it.effect.prop(
    'binds current evidence to exactly one snapshot and environment per worktree',
    {
      dirty: FC.boolean(),
      layered: FC.boolean(),
      suffix: FC.integer({min: 1, max: 100_000}),
    },
    ({dirty, layered, suffix}) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-admission-cache-'});
        const layout = codeGraphLayout(path, home, 'c'.repeat(64), 'd'.repeat(64));
        const snapshot: CodeGraphSnapshot = {
          ...(layered ? {baseSnapshotId: `cgsn_${'0'.repeat(40)}`} : {}),
          commit: 'e'.repeat(40),
          dirty,
          edgeCount: 0,
          extractorSet: 'f'.repeat(64),
          fileCount: 1,
          id: `cgsn_${suffix.toString(16).padStart(40, '0')}`,
          repositoryId: 'a'.repeat(64),
          state: 'ready',
          symbolCount: 1,
          worktreeId: layout.worktreeId,
        };
        const packs = BUILTIN_LANGUAGE_PACK_REGISTRY;
        const first = '1'.repeat(64),
          second = '2'.repeat(64);
        expect(yield* codeGraphSnapshotAdmissionCurrent(layout, snapshot, first, packs)).toBe(false);
        yield* recordCodeGraphSnapshotAdmission(layout, snapshot, first, packs, false);
        expect(yield* codeGraphSnapshotAdmissionCurrent(layout, snapshot, first, packs)).toBe(true);
        expect(yield* codeGraphSnapshotAdmissionCurrent(layout, snapshot, second, packs)).toBe(false);
        if (!dirty) {
          const overlay = {...snapshot, dirty: true, id: `${snapshot.id}-dirty`};
          yield* recordCodeGraphSnapshotAdmission(layout, overlay, first, packs, false);
          expect(yield* codeGraphSnapshotAdmissionCurrent(layout, snapshot, first, packs)).toBe(false);
          expect(yield* codeGraphSnapshotAdmissionCurrent(layout, snapshot, first, packs, true)).toBe(true);
          expect(yield* codeGraphSnapshotAdmissionCurrent(layout, snapshot, second, packs, true)).toBe(false);
          yield* recordCodeGraphSnapshotAdmission(layout, snapshot, first, packs, false, {cleanOnly: true});
          expect(yield* codeGraphSnapshotAdmissionCurrent(layout, overlay, first, packs)).toBe(true);
          expect(yield* codeGraphSnapshotAdmissionCurrent(layout, snapshot, first, packs)).toBe(false);
          const rejected = yield* recordCodeGraphSnapshotAdmission(layout, overlay, first, packs, false, {
            cleanOnly: true,
          }).pipe(Effect.flip);
          expect(rejected).toMatchObject({_tag: 'CodeGraphAdmissionError'});
          expect(yield* codeGraphSnapshotAdmissionCurrent(layout, overlay, first, packs)).toBe(true);
          yield* recordCodeGraphSnapshotAdmission(layout, snapshot, first, packs, false);
        }
        const replacement = {...snapshot, id: `${snapshot.id}-next`};
        expect(yield* codeGraphSnapshotAdmissionCurrent(layout, replacement, first, packs)).toBe(false);
        expect(
          yield* codeGraphSnapshotAdmissionCurrent(layout, {...snapshot, repositoryId: 'b'.repeat(64)}, first, packs),
        ).toBe(false);
        yield* recordCodeGraphSnapshotAdmission(layout, replacement, second, packs, true);
        expect(yield* codeGraphSnapshotAdmissionCurrent(layout, snapshot, first, packs)).toBe(false);
        expect(yield* codeGraphSnapshotAdmissionCurrent(layout, replacement, second, packs)).toBe(true);
        const target = path.join(layout.repositoryRoot, 'admission', `${layout.worktreeId}.json`);
        for (const broken of ['{"version":', ' '.repeat(4_097)]) {
          yield* fs.writeFileString(target, broken);
          expect(yield* codeGraphSnapshotAdmissionCurrent(layout, replacement, second, packs)).toBe(false);
        }
      }).pipe(provideTestLayer(BunServices.layer)),
    {fastCheck: {numRuns: 20}},
  );

  it.prop(
    'deduplicates only build requests with the same policy environment',
    {
      suffix: FC.integer({min: 0, max: 1_000_000}),
      dirty: FC.boolean(),
    },
    ({suffix, dirty}) => {
      const identity = {
        checkoutId: 'c'.repeat(64),
        headCommit: 'e'.repeat(40),
        repositoryId: 'a'.repeat(64),
        worktreeId: 'd'.repeat(64),
      };
      const environment = suffix.toString(16).padStart(64, '0');
      const changed = (suffix + 1).toString(16).padStart(64, '0');
      const key = (value: string) =>
        codeGraphBuildRequestKey(
          identity,
          {dirty, fingerprint: 'overlay'},
          BUILTIN_LANGUAGE_PACK_REGISTRY,
          undefined,
          false,
          value,
        );
      expect(key(environment)).toBe(key(environment));
      expect(key(environment)).not.toBe(key(changed));
    },
    {fastCheck: {numRuns: 100}},
  );
});
