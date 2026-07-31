import {describe, expect, it} from 'vitest';
import {
  acceptsRepositoryPath,
  parseGitTree,
  parseNameStatus,
  shouldOmitCorpusContent,
} from '../../src/code_graph/inventory.js';
import {CORPUS_EXTRACTION_SOURCE_BYTES_LIMIT} from '../../src/code_graph/languages/corpus/policy.js';

describe('native code graph inventory policy', () => {
  it('prunes every hidden, generated, vendor, and explicitly ignored directory before blob reads', () => {
    const ignore = 'fixtures/**\n!fixtures/keep.ts\n';

    expect(acceptsRepositoryPath('src/index.ts', ignore)).toBe(true);
    expect(acceptsRepositoryPath('.nx/cache/project.ts', ignore)).toBe(false);
    expect(acceptsRepositoryPath('packages/.cache/result.ts', ignore)).toBe(false);
    expect(acceptsRepositoryPath('packages/app/node_modules/library/index.ts', ignore)).toBe(false);
    expect(acceptsRepositoryPath('dist/generated.ts', ignore)).toBe(false);
    expect(acceptsRepositoryPath('fixtures/drop.ts', ignore)).toBe(false);
    expect(acceptsRepositoryPath('fixtures/keep.ts', ignore)).toBe(true);
    expect(acceptsRepositoryPath('../outside.ts', ignore)).toBe(false);
  });

  it('lets manifest-declared modules override only their matching broad prune prefix', () => {
    expect(acceptsRepositoryPath('pods/src/main/kotlin/Service.kt')).toBe(false);
    expect(acceptsRepositoryPath('pods/src/main/kotlin/Service.kt', '', ['pods'])).toBe(true);
    expect(acceptsRepositoryPath('apps/pods/src/main/java/Service.java', '', ['apps/pods'])).toBe(true);
    expect(acceptsRepositoryPath('pods/build/generated/Generated.kt', '', ['pods'])).toBe(false);
    expect(acceptsRepositoryPath('pods/src/main/kotlin/Service.kt', 'pods/**', ['pods'])).toBe(false);
    expect(acceptsRepositoryPath('Pods/Headers/Generated.h')).toBe(false);
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

  it('does not reject eligible source paths based on individual file size', () => {
    expect(acceptsRepositoryPath('src/generated-but-tracked.ts')).toBe(true);
    expect(shouldOmitCorpusContent('src/generated-but-tracked.ts', Number.MAX_SAFE_INTEGER)).toBe(false);
    expect(shouldOmitCorpusContent('recordings/architecture.mp4', CORPUS_EXTRACTION_SOURCE_BYTES_LIMIT + 1)).toBe(true);
  });

  it('accepts every bundled language and workspace manifest through the generated registry', () => {
    for (const path of [
      'src/service.ts',
      'src/service.tsx',
      'src/service.java',
      'src/service.kt',
      'Sources/App/Service.swift',
      'pom.xml',
      'settings.gradle.kts',
      'apps/mobile/build.gradle',
      'Package.swift',
      'App.xcodeproj/project.pbxproj',
    ]) {
      expect(acceptsRepositoryPath(path), path).toBe(true);
    }
    expect(acceptsRepositoryPath('src/readme.txt')).toBe(true);
    expect(acceptsRepositoryPath('src/archive.bin')).toBe(false);
  });
});
