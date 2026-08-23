import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {reusableCleanBaseSlicePaths} from '../../src/code_graph/store_queries.js';

describe('code graph persisted-base slice bounds', () => {
  it('canonicalizes every bounded unique path set without changing membership', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc
            .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789_-/'.split('')), {
              maxLength: 80,
              minLength: 1,
            })
            .map(parts => parts.join(''))
            .filter(path => path.split('/').every(segment => segment.length > 0)),
          {maxLength: 200, minLength: 1},
        ),
        paths => {
          const canonical = reusableCleanBaseSlicePaths(paths);
          expect(canonical).toBeDefined();
          if (canonical === undefined) throw new Error('Expected a bounded canonical path set.');
          expect(new Set(canonical)).toEqual(new Set(paths));
          expect(canonical).toEqual([...canonical].sort());
          expect(reusableCleanBaseSlicePaths([...paths].reverse())).toEqual(canonical);
        },
      ),
      {numRuns: 250},
    );
  });

  it('fails closed for duplicate, empty, oversized, or NUL-containing requests', () => {
    expect(reusableCleanBaseSlicePaths([])).toBeUndefined();
    expect(reusableCleanBaseSlicePaths(['src/a.ts', 'src/a.ts'])).toBeUndefined();
    expect(reusableCleanBaseSlicePaths(['src/a\0.ts'])).toBeUndefined();
    expect(reusableCleanBaseSlicePaths(['/src/a.ts'])).toBeUndefined();
    expect(reusableCleanBaseSlicePaths(['src/../a.ts'])).toBeUndefined();
    expect(reusableCleanBaseSlicePaths(['src\\a.ts'])).toBeUndefined();
    expect(reusableCleanBaseSlicePaths(['x'.repeat(4_097)])).toBeUndefined();
    expect(reusableCleanBaseSlicePaths(Array.from({length: 201}, (_, index) => `src/${index}.ts`))).toBeUndefined();
  });
});
