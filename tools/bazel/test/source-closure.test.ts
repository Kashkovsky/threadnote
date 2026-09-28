import fc from 'fast-check';
import {expect, it} from 'vitest';
import {collectSourceClosure, sourceImports} from '../source-closure.mjs';

const collect = (files: Record<string, string>, entries = ['src/0.ts'], workspaces = new Map()) =>
  collectSourceClosure(entries, {
    read: (path: string) => files[path],
    exists: (path: string) => path in files,
    workspaces,
  });

it('follows source additions, removals, and changed import edges', () => {
  const files = {'src/0.ts': 'export const first = 1;', 'src/1.ts': 'export const second = 2;'};
  expect(collect(files).files).toEqual(['src/0.ts']);
  files['src/0.ts'] = 'export {second} from "./1.js";';
  expect(collect(files).files).toEqual(['src/0.ts', 'src/1.ts']);
  expect(() => collect({'src/0.ts': files['src/0.ts']})).toThrow('Unresolved source input');
  expect(sourceImports('file.ts', 'const text = "import fake from \'bad\'"; import good from "good";')).toEqual([
    'good',
  ]);
});

it('resolves explicit private exports and rejects missing exports', () => {
  const workspace = {path: 'packages/domain', manifest: {exports: {'./value': './src/value.ts'}}};
  const files = {
    'src/0.ts': 'import {value} from "@threadnote/domain/value";',
    'packages/domain/src/value.ts': 'export const value = 1;',
    'packages/domain/package.json': '{}',
  };
  expect(collect(files, ['src/0.ts'], new Map([['@threadnote/domain', workspace]])).files).toEqual([
    'packages/domain/package.json',
    'packages/domain/src/value.ts',
    'src/0.ts',
  ]);
  expect(() =>
    collect(
      {...files, 'src/0.ts': 'import "@threadnote/domain/missing";'},
      ['src/0.ts'],
      new Map([['@threadnote/domain', workspace]]),
    ),
  ).toThrow('workspace export');
});

it('matches a bounded graph model and ignores input enumeration order', () => {
  fc.assert(
    fc.property(
      fc.array(fc.tuple(fc.integer({min: 0, max: 7}), fc.integer({min: 0, max: 7})), {maxLength: 24}),
      edges => {
        const files = Object.fromEntries(
          Array.from({length: 8}, (_, node) => [
            `src/${node}.ts`,
            edges
              .filter(([from]) => from === node)
              .map(([, to]) => `import "./${to}.js";`)
              .join('\n'),
          ]),
        );
        const reachable = new Set([0]);
        for (let count = 0; count < 8; count++)
          for (const [from, to] of edges) if (reachable.has(from)) reachable.add(to);
        const expected = [...reachable].map(node => `src/${node}.ts`).sort();
        expect(collect(files).files).toEqual(expected);
        expect(collect(Object.fromEntries(Object.entries(files).reverse())).files).toEqual(expected);
      },
    ),
    {numRuns: 50},
  );
});
