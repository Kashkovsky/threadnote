import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {sha256HexSync} from '../../src/crypto/sha256.js';
import {
  codeGraphContentIdentity,
  createCodeGraphContentIdentityAccumulator,
} from '../../src/code_graph/graph_identity.js';
import {codeGraphInventorySha256Hex} from '../../src/code_graph/inventory_identity.js';
import {compareCodeUnits} from '../../src/code_graph/ordering.js';

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

  it('matches bounded streaming graph identity across UTF-16 and UTF-8 order boundaries', () => {
    const path = fc
      .array(fc.constantFrom('a', 'z', '\ud7ff', '\ue000', '\uffff', '🙂', '𐀀'), {maxLength: 12, minLength: 1})
      .map(parts => `src/${parts.join('')}.ts`);
    fc.assert(
      fc.property(fc.uniqueArray(path, {maxLength: 100}), paths => {
        const files = paths.map((value, index) => ({
          contentHash: sha256HexSync(`content-${index}`),
          language: 'typescript',
          mode: '100644',
          path: value,
        }));
        const accumulator = createCodeGraphContentIdentityAccumulator('extractor-set');
        for (const file of [...files].sort((left, right) => compareCodeUnits(left.path, right.path))) {
          accumulator.update(file);
        }
        expect(accumulator.digest()).toBe(codeGraphContentIdentity('extractor-set', [...files].reverse()));
      }),
      {numRuns: 100},
    );
  });
});
