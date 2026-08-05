import {describe, expect, it} from '@effect/vitest';
import * as FC from 'effect/testing/FastCheck';
import {codeGraphIndexEnsuresVectors} from '../../src/code_graph/indexer.js';

describe('codeGraphIndexEnsuresVectors', () => {
  it('defaults explicit graph index to ensuring vectors', () => {
    expect(codeGraphIndexEnsuresVectors({})).toBe(true);
    expect(codeGraphIndexEnsuresVectors({ensureVectors: true})).toBe(true);
    expect(codeGraphIndexEnsuresVectors({ensureVectors: false})).toBe(false);
  });

  it.prop(
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
