import fc from 'fast-check';
import {expect, it} from 'vitest';
import {bazelSourceLabel, packageExportPatterns, packageOwner} from '../declaration-paths.mjs';

const covers = (pattern: string, file: string) =>
  pattern.endsWith('/**') ? file.startsWith(pattern.slice(0, -2)) : pattern === file;

it('collapses package files to stable top-level export patterns', () => {
  expect(
    packageExportPatterns(['test/unit/example.test.ts', 'src/nested/value.ts', 'package.json', 'src/index.ts']),
  ).toEqual(['package.json', 'src/**', 'test/**']);
});

it('covers every declared file without making nested additions expand the BUILD declaration', () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(
        fc.tuple(
          fc.constantFrom('src', 'test', 'assets', 'public'),
          fc.array(fc.stringMatching(/^[a-z][a-z0-9-]{0,7}$/), {minLength: 1, maxLength: 3}),
        ),
        {maxLength: 20, selector: value => value.join('/')},
      ),
      entries => {
        const files = entries.map(([root, parts]) => `${root}/${parts.join('/')}.ts`);
        const patterns = packageExportPatterns(files);
        expect(files.every(file => patterns.some(pattern => covers(pattern, file)))).toBe(true);
        expect(packageExportPatterns([...files, 'src/new/deep/file.ts'])).toEqual(
          packageExportPatterns([...files, 'src/existing.ts']),
        );
      },
    ),
    {numRuns: 50},
  );
});

it('uses the nearest hand-written Bazel package for generated source labels', () => {
  const packageRoots = ['infra', 'infra/telemetry-gateway', 'infra/telemetry-gateway/internal/budget'];
  const file = 'infra/telemetry-gateway/internal/budget/state.go';
  expect(packageOwner(file, [...packageRoots].reverse())).toBe('infra/telemetry-gateway/internal/budget');
  expect(bazelSourceLabel(file, packageRoots)).toBe('//infra/telemetry-gateway/internal/budget:state.go');
  expect(bazelSourceLabel('README.md', packageRoots)).toBe('//:README.md');
});
