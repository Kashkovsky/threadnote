import {describe, expect, it} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {inventoryRepository, previewCodeGraphInventory} from '../../src/code_graph/inventory.js';
import {resolveRepositoryIdentity} from '../../src/code_graph/repository.js';
import {runCommandEffect} from '../../src/effect/command.js';
import {StandaloneBrokerLayer} from '../../src/effect/runtime.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

describe('portable Git ignore matching', () => {
  it.effect.prop(
    'keeps committed inventory and preview invariant under the local Git case setting',
    {suffix: fc.array(fc.constantFrom(...'abcdef'), {maxLength: 6}).map(chars => chars.join(''))},
    ({suffix}) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-inventory-case-'});
        yield* fs.makeDirectory(path.join(root, 'src'));
        const admitted = `src/Value${suffix}.ts`;
        const excluded = `src/ignored${suffix}.ts`;
        yield* fs.writeFileString(path.join(root, 'src/always.ts'), 'export const always = true;\n');
        yield* fs.writeFileString(path.join(root, admitted), 'export const value = 1;\n');
        yield* fs.writeFileString(path.join(root, excluded), 'export const ignored = 2;\n');
        yield* fs.writeFileString(path.join(root, '.gitignore'), `${admitted.toLowerCase()}\n${excluded}\n`);
        yield* git(root, ['init', '-q']);
        yield* git(root, ['add', '-f', admitted, excluded, 'src/always.ts', '.gitignore']);
        yield* git(root, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);
        const observations = [];
        for (const mode of ['false', 'true']) {
          yield* git(root, ['config', 'core.ignorecase', mode]);
          const identity = yield* resolveRepositoryIdentity(root);
          const inventory = yield* inventoryRepository(identity);
          const preview = yield* previewCodeGraphInventory(identity, {includeOverlay: false});
          expect(inventory.dirty).toBe(false);
          expect(inventory.files.map(file => file.path)).toEqual([admitted, 'src/always.ts']);
          expect((yield* git(root, ['config', '--get', 'core.ignorecase'])).stdout.trim()).toBe(mode);
          expect((yield* git(root, ['status', '--porcelain'])).stdout).toBe('');
          observations.push({
            files: inventory.files,
            skipped: inventory.skipped,
            groups: preview.groups,
            totals: preview.totals,
          });
        }
        expect(observations[1]).toEqual(observations[0]);
      }).pipe(provideTestLayer(StandaloneBrokerLayer), TestClock.withLive),
    {fastCheck: {numRuns: 12}},
  );
});

function git(repo: string, args: readonly string[]) {
  return runCommandEffect('git', ['-C', repo, ...args]);
}
