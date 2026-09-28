import {fcProp} from '@threadnote/testing/fast-check-property';
import {describe, expect, it} from '@effect/vitest';
import * as FC from 'fast-check';
import {codeGraphIndexEnsuresVectors} from '@threadnote/graph/indexer';

describe('codeGraphIndexEnsuresVectors', () => {
  it('defaults explicit graph index to ensuring vectors', () => {
    expect(codeGraphIndexEnsuresVectors({})).toBe(true);
    expect(codeGraphIndexEnsuresVectors({ensureVectors: true})).toBe(true);
    expect(codeGraphIndexEnsuresVectors({ensureVectors: false})).toBe(false);
  });

  fcProp(
    it,
    'treats only explicit false as skip-vectors for inspect refresh',
    {
      ensureVectors: FC.option(FC.boolean(), {nil: undefined}),
    },
    ({ensureVectors}) => {
      expect(codeGraphIndexEnsuresVectors({ensureVectors})).toBe(ensureVectors !== false);
    },
    {fastCheck: {numRuns: 100}},
  );
});
