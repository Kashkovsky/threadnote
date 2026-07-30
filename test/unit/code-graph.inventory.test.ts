import {describe, expect, it} from 'vitest';
import {
  acceptsRepositoryPath,
  assertInventoryFileBudget,
  parseGitTree,
  parseNameStatus,
} from '../../src/code_graph/inventory.js';

describe('native code graph inventory policy', () => {
  it('prunes every hidden, generated, vendor, and explicitly ignored directory before blob reads', () => {
    const ignore = 'fixtures/**\n!fixtures/keep.ts\n';

    expect(acceptsRepositoryPath('src/index.ts', 128, 1024, ignore)).toBe(true);
    expect(acceptsRepositoryPath('.nx/cache/project.ts', 128, 1024, ignore)).toBe(false);
    expect(acceptsRepositoryPath('packages/.cache/result.ts', 128, 1024, ignore)).toBe(false);
    expect(acceptsRepositoryPath('packages/app/node_modules/library/index.ts', 128, 1024, ignore)).toBe(false);
    expect(acceptsRepositoryPath('dist/generated.ts', 128, 1024, ignore)).toBe(false);
    expect(acceptsRepositoryPath('fixtures/drop.ts', 128, 1024, ignore)).toBe(false);
    expect(acceptsRepositoryPath('fixtures/keep.ts', 128, 1024, ignore)).toBe(true);
    expect(acceptsRepositoryPath('src/oversized.ts', 1025, 1024, ignore)).toBe(false);
    expect(acceptsRepositoryPath('../outside.ts', 128, 1024, ignore)).toBe(false);
  });

  it('accepts only ordinary blob records and handles byte-safe rename/delete overlays', () => {
    const tree = [
      '100644 blob aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 42\tsrc/a.ts',
      '120000 blob bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 12\tsrc/link.ts',
      '160000 commit cccccccccccccccccccccccccccccccccccccccc -\tvendor/submodule',
      '',
    ].join('\0');
    expect(parseGitTree(tree)).toEqual([
      {
        blobId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        mode: '100644',
        path: 'src/a.ts',
        size: 42,
      },
    ]);

    const status = parseNameStatus(
      ['R100', 'src/old.ts', 'src/new.ts', 'D', 'src/deleted.ts', 'M', 'src/a.ts', 'A', 'src/added.ts', ''].join('\0'),
    );
    expect([...status.added]).toEqual(['src/added.ts']);
    expect([...status.changed].sort()).toEqual(['src/a.ts', 'src/added.ts', 'src/new.ts']);
    expect([...status.deleted].sort()).toEqual(['src/deleted.ts', 'src/old.ts']);
  });

  it('preserves literal POSIX backslashes instead of collapsing distinct Git paths', () => {
    const tree = [
      '100644 blob aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 42\tsrc/a.ts',
      '100644 blob bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 43\tsrc\\\\a.ts',
      '',
    ].join('\0');

    expect(parseGitTree(tree).map(entry => entry.path)).toEqual(['src/a.ts', 'src\\\\a.ts']);
    expect(parseNameStatus(['M', 'src\\\\a.ts', ''].join('\0')).changed).toEqual(new Set(['src\\\\a.ts']));
  });

  it('does not reject a repository because eligible source bytes exceed the former aggregate cap', () => {
    const entries = Array.from({length: 200}, () => ({size: 1_048_576}));

    expect(() => assertInventoryFileBudget(entries, {maximumFiles: 50_000})).not.toThrow();
    expect(() => assertInventoryFileBudget(entries, {maximumFiles: 199})).toThrow(
      'Repository has 200 eligible files; limit is 199.',
    );
  });
});
