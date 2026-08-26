import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {classifyCodeGraphProductionRatchetScope} from '../ci/code-graph-production-ratchet-scope.js';

const baseManifest = {
  dependencies: {effect: '4.0.0-beta.102'},
  name: 'threadnote',
  scripts: {test: 'vitest run'},
  version: '4.3.6',
};

function manifest(version: string, overrides: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({...baseManifest, ...overrides, version});
}

function isReleaseOnly(
  changedPaths: readonly string[],
  before = manifest('4.3.6'),
  after = manifest('4.3.7'),
): boolean {
  return classifyCodeGraphProductionRatchetScope({
    afterPackageJson: after,
    beforePackageJson: before,
    changedPaths,
  }).releaseMetadataOnly;
}

describe('code graph production ratchet diff scope', () => {
  it('skips a version-only release diff with release notes', () => {
    expect(isReleaseOnly(['package.json', '.github/release-notes/v4.3.7.md'])).toBe(true);
    expect(isReleaseOnly(['package.json'])).toBe(true);
  });

  it('runs for dependency, script, source, workflow, baseline, lockfile, and ambiguous changes', () => {
    expect(
      isReleaseOnly(
        ['package.json', '.github/release-notes/v4.3.7.md'],
        manifest('4.3.6'),
        manifest('4.3.7', {dependencies: {effect: '4.0.0-rc.1'}}),
      ),
    ).toBe(false);
    expect(
      isReleaseOnly(['package.json'], manifest('4.3.6'), manifest('4.3.7', {scripts: {test: 'vitest run --changed'}})),
    ).toBe(false);

    for (const path of [
      'src/code_graph/index.ts',
      '.github/workflows/code-graph-production-ratchet.yml',
      'test/evaluation/baselines/code-graph-v1/production-ratchet-github-linux-x64.json',
      'bun.lock',
      '.github/release-notes/../workflows/publish.yml',
      '.github/release-notes/archive/v4.3.7.md',
      '.github/release-notes/v4.3.7.txt',
      '.github/release-notes/notes.md',
    ]) {
      expect(isReleaseOnly(['package.json', '.github/release-notes/v4.3.7.md', path])).toBe(false);
    }
    expect(isReleaseOnly(['.github/release-notes/v4.3.7.md'])).toBe(false);
    expect(isReleaseOnly([])).toBe(false);
    expect(isReleaseOnly(['package.json'], '{', manifest('4.3.7'))).toBe(false);
    expect(isReleaseOnly(['package.json'], manifest('4.3.7'), manifest('4.3.7'))).toBe(false);
  });

  it('compares package objects semantically while preserving nested and array ordering', () => {
    const reordered = JSON.stringify({
      version: '4.3.7',
      scripts: baseManifest.scripts,
      name: baseManifest.name,
      dependencies: baseManifest.dependencies,
    });
    expect(isReleaseOnly(['package.json'], manifest('4.3.6'), reordered)).toBe(true);
    expect(
      isReleaseOnly(
        ['package.json'],
        JSON.stringify({...baseManifest, files: ['dist', 'assets']}),
        JSON.stringify({...baseManifest, files: ['assets', 'dist'], version: '4.3.7'}),
      ),
    ).toBe(false);
  });

  it('is invariant to release-note order and duplicate paths', () => {
    fc.assert(
      fc.property(fc.array(fc.stringMatching(/^[a-z0-9][a-z0-9.-]{0,24}$/u), {maxLength: 12}), versions => {
        const paths = ['package.json', ...versions.map(version => `.github/release-notes/v${version}.md`)];
        expect(isReleaseOnly(paths)).toBe(true);
        expect(isReleaseOnly([...paths].reverse())).toBe(true);
        expect(isReleaseOnly([...paths, ...paths])).toBe(true);
      }),
      {numRuns: 200},
    );
  });

  it('never skips after adding a path outside the release-note directory', () => {
    const repositoryPath = fc
      .tuple(
        fc.constantFrom('src', 'scripts', 'test', '.github/workflows', 'website'),
        fc.stringMatching(/^[a-z][a-z0-9_-]{0,20}$/u),
      )
      .map(([directory, name]) => `${directory}/${name}.ts`);

    fc.assert(
      fc.property(repositoryPath, path => {
        expect(isReleaseOnly(['package.json', '.github/release-notes/v4.3.7.md', path])).toBe(false);
      }),
      {numRuns: 200},
    );
  });

  it('never skips when any non-version package field changes', () => {
    const field = fc
      .stringMatching(/^[a-z][a-z0-9_-]{0,16}$/u)
      .filter(value => value !== 'name' && value !== 'version');
    const changedValues = fc
      .tuple(fc.jsonValue(), fc.jsonValue())
      .filter(([before, after]) => JSON.stringify(before) !== JSON.stringify(after));

    fc.assert(
      fc.property(field, changedValues, (key, [beforeValue, afterValue]) => {
        const before = JSON.stringify({...baseManifest, [key]: beforeValue});
        const after = JSON.stringify({...baseManifest, [key]: afterValue, version: '4.3.7'});
        expect(isReleaseOnly(['package.json', '.github/release-notes/v4.3.7.md'], before, after)).toBe(false);
      }),
      {numRuns: 200},
    );
  });
});
