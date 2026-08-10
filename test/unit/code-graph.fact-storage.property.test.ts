import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  CODE_GRAPH_STORED_FACT_CODEC,
  decodeStoredCodeGraphFact,
  encodeStoredCodeGraphFact,
} from '../../src/code_graph/fact_storage.js';
import {serializeBoundedCodeGraphFact} from '../../src/code_graph/fact_budget.js';
import type {CodeGraphFileFacts} from '../../src/code_graph/types.js';

const pathArbitrary = fc
  .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789_-'.split('')), {maxLength: 30, minLength: 1})
  .map(value => `src/${value.join('')}.ts`);

const factArbitrary = fc
  .record({
    diagnostics: fc.array(fc.string({maxLength: 120}), {maxLength: 20}),
    path: pathArbitrary,
  })
  .map(({diagnostics, path}): CodeGraphFileFacts => ({
    diagnostics,
    edges: [],
    path,
    symbols: [],
  }));

describe('compact code graph fact storage', () => {
  it('round-trips legacy and compact rows deterministically without mutating facts', () => {
    fc.assert(
      fc.property(factArbitrary, facts => {
        const before = JSON.stringify(facts);
        const bounded = serializeBoundedCodeGraphFact(facts);
        const first = encodeStoredCodeGraphFact(bounded);
        const second = encodeStoredCodeGraphFact(bounded);

        expect(second).toEqual(first);
        expect(decodeStoredCodeGraphFact(first.json, facts.path).facts).toEqual(facts);
        expect(decodeStoredCodeGraphFact(bounded.json, facts.path).facts).toEqual(facts);
        expect(JSON.stringify(facts)).toBe(before);
      }),
      {numRuns: 200},
    );
  });

  it('uses a path-visible compact envelope only when it materially reduces repetitive facts', () => {
    const facts: CodeGraphFileFacts = {
      diagnostics: Array.from({length: 400}, () => 'repetitive privacy-safe parser diagnostic'),
      edges: [],
      path: 'src/large.ts',
      symbols: [],
    };
    const bounded = serializeBoundedCodeGraphFact(facts);
    const stored = encodeStoredCodeGraphFact(bounded);
    const envelope = JSON.parse(stored.json) as {readonly codec: string; readonly path: string};

    expect(stored.codec).toBe(CODE_GRAPH_STORED_FACT_CODEC);
    expect(stored.storedBytes).toBeLessThan(bounded.bytes / 2);
    expect(envelope).toMatchObject({codec: CODE_GRAPH_STORED_FACT_CODEC, path: facts.path});
    expect(decodeStoredCodeGraphFact(stored.json, facts.path).facts).toEqual(facts);
  });

  it('rejects corrupt, non-canonical, or path-mismatched envelopes', () => {
    const facts = serializeBoundedCodeGraphFact({
      diagnostics: Array.from({length: 200}, () => 'compress me'),
      edges: [],
      path: 'src/corrupt.ts',
      symbols: [],
    });
    const stored = encodeStoredCodeGraphFact(facts);
    const envelope = JSON.parse(stored.json) as Record<string, unknown>;
    expect(stored.codec).toBe(CODE_GRAPH_STORED_FACT_CODEC);
    expect(() => decodeStoredCodeGraphFact(stored.json, 'src/other.ts')).toThrow(/path/);
    expect(() => decodeStoredCodeGraphFact(JSON.stringify({...envelope, sha256: '0'.repeat(64)}))).toThrow(/integrity/);
    expect(() =>
      decodeStoredCodeGraphFact(JSON.stringify({...envelope, payload: `${envelope.payload as string}\n`})),
    ).toThrow(/malformed|base64/);
  });
});
