import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {classifyCodeGraphProductionRatchetScope} from '../ci/code-graph-production-ratchet-scope.js';
import {privateReleaseEvidenceFamilies} from '../ci/private-release-evidence-family.js';

const productCaptureFamily = privateReleaseEvidenceFamilies[0];
const releaseCollectionFamily = privateReleaseEvidenceFamilies[1];

const baseManifest = {
  dependencies: {effect: '4.0.0-rc.112'},
  name: 'threadnote',
  scripts: {test: 'vitest run'},
  version: '4.3.6',
};

function manifest(version: string, overrides: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({...baseManifest, ...overrides, version});
}

function shouldSkipBenchmark(
  changedPaths: readonly string[],
  before = manifest('4.3.6'),
  after = manifest('4.3.7'),
): boolean {
  return (
    classifyCodeGraphProductionRatchetScope({
      afterPackageJson: after,
      beforePackageJson: before,
      changedPaths,
    }).runBenchmark === false
  );
}

describe('code graph production ratchet diff scope', () => {
  it('skips a version-only release diff with release notes', () => {
    expect(shouldSkipBenchmark(['package.json', '.github/release-notes/v4.3.7.md'])).toBe(true);
    expect(shouldSkipBenchmark(['package.json'])).toBe(true);
    expect(
      classifyCodeGraphProductionRatchetScope({
        afterPackageJson: manifest('4.3.7'),
        beforePackageJson: manifest('4.3.6'),
        changedPaths: ['package.json'],
      }).skipReason,
    ).toBe('release-metadata-only');
  });

  it('skips unrelated evaluation-only changes, including the PR #568 path set', () => {
    expect(
      shouldSkipBenchmark([
        'src/evaluation/context-brief-citation-scale-contract.ts',
        'src/evaluation/context-brief-citation-scale-fixture.ts',
        'src/evaluation/context-brief-citation-scale.ts',
        'test/evaluation/baselines/context-brief-citations-v1/README.md',
        'test/unit/context-brief-citation-scale-benchmark.test.ts',
      ]),
    ).toBe(true);
    expect(
      classifyCodeGraphProductionRatchetScope({
        changedPaths: [
          'src/evaluation/context-brief-citation-scale-contract.ts',
          'src/evaluation/context-brief-citation-scale-fixture.ts',
          'src/evaluation/context-brief-citation-scale.ts',
          'test/evaluation/baselines/context-brief-citations-v1/README.md',
          'test/unit/context-brief-citation-scale-benchmark.test.ts',
        ],
      }).skipReason,
    ).toBe('unrelated-evaluation-only');
  });

  it('skips the governed profile for only exact private release-evidence families', () => {
    for (const family of privateReleaseEvidenceFamilies) {
      const result = classifyCodeGraphProductionRatchetScope({changedPaths: family.paths});
      expect(result).toMatchObject({runBenchmark: false, skipReason: 'private-release-evidence-only'});
    }
    for (const path of [
      'src/evaluation/threadnote-5-product-capture-adjacent.ts',
      'test/unit/evaluation.threadnote-5-product-capture-extra.test.ts',
      'unknown/private-evaluation-payload.bin',
      '',
    ]) {
      expect(shouldSkipBenchmark([...productCaptureFamily.paths, path])).toBe(false);
    }
    expect(shouldSkipBenchmark([...productCaptureFamily.paths, ...releaseCollectionFamily.paths])).toBe(false);
  });

  it('runs for dependency, script, runtime, benchmark harness, code-graph fixture, baseline, ratchet contract, lockfile, and ambiguous changes', () => {
    expect(
      shouldSkipBenchmark(
        ['package.json', '.github/release-notes/v4.3.7.md'],
        manifest('4.3.6'),
        manifest('4.3.7', {dependencies: {effect: '4.0.0-rc.1'}}),
      ),
    ).toBe(false);
    expect(
      shouldSkipBenchmark(
        ['package.json'],
        manifest('4.3.6'),
        manifest('4.3.7', {scripts: {test: 'vitest run --changed'}}),
      ),
    ).toBe(false);

    for (const path of [
      'src/code_graph/index.ts',
      'src/evaluation/benchmark.ts',
      'src/evaluation/external_evidence.ts',
      'src/evaluation/public_controls.ts',
      'src/evaluation/code-graph.ts',
      '.github/workflows/code-graph-production-ratchet.yml',
      'test/evaluation/baselines/code-graph-v1/production-ratchet-github-linux-x64.json',
      'test/evaluation/fixtures/code-graph-v1/fixture.ts',
      'test/unit/code-graph.production-ratchet-scope.property.test.ts',
      'test/unit/benchmark-workflow.test.ts',
      'bun.lock',
      '.github/release-notes/../workflows/publish.yml',
      '.github/release-notes/archive/v4.3.7.md',
      '.github/release-notes/v4.3.7.txt',
      '.github/release-notes/notes.md',
    ]) {
      expect(shouldSkipBenchmark(['package.json', '.github/release-notes/v4.3.7.md', path])).toBe(false);
    }
    expect(shouldSkipBenchmark(['.github/release-notes/v4.3.7.md'])).toBe(false);
    expect(shouldSkipBenchmark([])).toBe(false);
    for (const path of [
      'src/evaluation/new-evaluation.ts',
      'test/evaluation/baselines/new-evaluation-v1/budget.json',
      'test/evaluation/fixtures/new-evaluation-v1/fixture.json',
      'test/unit/new-evaluation.test.ts',
    ]) {
      expect(shouldSkipBenchmark([path])).toBe(false);
    }
    expect(shouldSkipBenchmark(['package.json'], '{', manifest('4.3.7'))).toBe(false);
    expect(shouldSkipBenchmark(['package.json'], manifest('4.3.7'), manifest('4.3.7'))).toBe(false);
    expect(
      classifyCodeGraphProductionRatchetScope({
        changedPaths: [undefined] as unknown as Iterable<string>,
      }).runBenchmark,
    ).toBe(true);
    expect(
      classifyCodeGraphProductionRatchetScope({
        changedPaths: undefined as unknown as Iterable<string>,
      }).runBenchmark,
    ).toBe(true);
  });

  it('compares package objects semantically while preserving nested and array ordering', () => {
    const reordered = JSON.stringify({
      version: '4.3.7',
      scripts: baseManifest.scripts,
      name: baseManifest.name,
      dependencies: baseManifest.dependencies,
    });
    expect(shouldSkipBenchmark(['package.json'], manifest('4.3.6'), reordered)).toBe(true);
    expect(
      shouldSkipBenchmark(
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
        expect(shouldSkipBenchmark(paths)).toBe(true);
        expect(shouldSkipBenchmark([...paths].reverse())).toBe(true);
        expect(shouldSkipBenchmark([...paths, ...paths])).toBe(true);
      }),
      {numRuns: 200},
    );
  });

  it('is invariant to unrelated evaluation-path order and duplicate paths', () => {
    const evaluationPaths = [
      'src/evaluation/context-brief-citation-scale-contract.ts',
      'src/evaluation/context-brief-citation-scale-fixture.ts',
      'test/evaluation/baselines/context-brief-citations-v1/README.md',
      'test/unit/context-brief-citation-scale-benchmark.test.ts',
    ];

    fc.assert(
      fc.property(fc.shuffledSubarray(evaluationPaths, {minLength: 1}), paths => {
        expect(shouldSkipBenchmark(paths, undefined, undefined)).toBe(true);
        expect(shouldSkipBenchmark([...paths].reverse(), undefined, undefined)).toBe(true);
        expect(shouldSkipBenchmark([...paths, ...paths], undefined, undefined)).toBe(true);
      }),
      {numRuns: 100},
    );
  });

  it('runs monotonically when a ratchet-relevant path is added to evaluation-only changes', () => {
    const evaluationPaths = [
      'src/evaluation/context-brief-citation-scale-contract.ts',
      'test/evaluation/baselines/context-brief-citations-v1/README.md',
      'test/unit/context-brief-citation-scale-benchmark.test.ts',
    ];
    const relevantPath = fc.constantFrom(
      'src/evaluation/benchmark.ts',
      'src/evaluation/external_evidence.ts',
      'src/evaluation/public_controls.ts',
      'src/evaluation/code-graph.ts',
      'scripts/code-graph-fixture.ts',
      'test/evaluation/baselines/code-graph-v1/production-ratchet-github-linux-x64.json',
      'test/ci/code-graph-production-ratchet-gate.ts',
    );

    fc.assert(
      fc.property(fc.shuffledSubarray(evaluationPaths, {minLength: 1}), relevantPath, (paths, path) => {
        expect(shouldSkipBenchmark(paths, undefined, undefined)).toBe(true);
        expect(shouldSkipBenchmark([...paths, path], undefined, undefined)).toBe(false);
      }),
      {numRuns: 100},
    );
  });

  it('keeps private release-evidence exemptions order/duplicate invariant and fails safe for mixed paths', () => {
    fc.assert(
      fc.property(fc.shuffledSubarray([...releaseCollectionFamily.paths], {minLength: 1}), paths => {
        expect(shouldSkipBenchmark(paths, undefined, undefined)).toBe(true);
        expect(shouldSkipBenchmark([...paths].reverse(), undefined, undefined)).toBe(true);
        expect(shouldSkipBenchmark([...paths, ...paths], undefined, undefined)).toBe(true);
        expect(shouldSkipBenchmark([...paths, ...productCaptureFamily.paths], undefined, undefined)).toBe(false);
      }),
      {numRuns: 100},
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
        expect(shouldSkipBenchmark(['package.json', '.github/release-notes/v4.3.7.md', path])).toBe(false);
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
        expect(shouldSkipBenchmark(['package.json', '.github/release-notes/v4.3.7.md'], before, after)).toBe(false);
      }),
      {numRuns: 200},
    );
  });
});
