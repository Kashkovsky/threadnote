import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {normalizeCliArguments} from '../../src/effect/cli.js';

describe('CLI argument normalization properties', () => {
  it('leaves globally ambiguous option spellings for the selected command parser', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('--replace', '--status'),
        fc.string({minLength: 1, maxLength: 40}).map(value => `--${value}`),
        (ambiguousFlag, followingFlag) => {
          expect(normalizeCliArguments([ambiguousFlag, followingFlag])).toEqual([ambiguousFlag, followingFlag]);
        },
      ),
      {numRuns: 100},
    );
  });
});
