import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {sha256HexSync} from '../../src/crypto/sha256.js';
import {codeGraphInventorySha256Hex} from '../../src/code_graph/inventory_identity.js';

describe('code graph inventory identity', () => {
  it('matches the canonical one-shot digest for arbitrary ordering and Unicode without mutating input', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            contentHash: fc.string({maxLength: 32}),
            path: fc.string({maxLength: 64}),
            source: fc.string({maxLength: 16}),
          }),
          {maxLength: 200},
        ),
        fc.string({maxLength: 64}),
        (files, prefix) => {
          const before = files.map(file => ({...file}));
          const line = (file: (typeof files)[number]) => `${file.path}\0${file.contentHash}\0${file.source}`;
          const canonicalRows = files.map(line).sort();

          expect(codeGraphInventorySha256Hex(prefix, files, line)).toBe(
            sha256HexSync(`${prefix}${canonicalRows.join('\n')}`),
          );
          expect(files).toEqual(before);
        },
      ),
      {numRuns: 150},
    );
  });
});
