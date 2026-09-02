import fc from 'fast-check';
import {unzlibSync, zlibSync} from 'fflate';
import {describe, expect, it} from 'vitest';
import {
  CODE_GRAPH_STORED_FACT_CODEC,
  decodeStoredCodeGraphFact,
  encodeStoredCodeGraphFact,
} from '../../src/code_graph/fact_storage.js';
import {serializeBoundedCodeGraphFact} from '../../src/code_graph/fact_budget.js';
import {sha256HexSync} from '../../src/crypto/sha256.js';
import type {CodeGraphFileFacts} from '../../src/code_graph/types.js';

const factEncoder = new TextEncoder();
const factDecoder = new TextDecoder();

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

const repositoryTextArbitrary = fc
  .array(fc.integer({max: 0x9f, min: 0}), {maxLength: 64, minLength: 1})
  .map(codeUnits => String.fromCharCode(...codeUnits));

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

  it('preserves the zlib-base64-v1 format across legacy and native codec implementations', () => {
    const facts: CodeGraphFileFacts = {
      diagnostics: Array.from({length: 400}, () => 'repetitive compatibility diagnostic'),
      edges: [],
      path: 'src/compatibility.ts',
      symbols: [],
    };
    const bounded = serializeBoundedCodeGraphFact(facts);
    const stored = encodeStoredCodeGraphFact(bounded);
    const nativeEnvelope = JSON.parse(stored.json) as {
      readonly codec: string;
      readonly path: string;
      readonly pathOccurrences: number;
      readonly payload: string;
      readonly rawBytes: number;
      readonly sha256: string;
    };
    const legacyDecoded = unzlibSync(Buffer.from(nativeEnvelope.payload, 'base64'), {
      out: new Uint8Array(bounded.bytes),
    });
    expect(factDecoder.decode(legacyDecoded)).toBe(bounded.json);

    const raw = factEncoder.encode(bounded.json);
    const legacyEnvelope = {
      ...nativeEnvelope,
      payload: Buffer.from(zlibSync(raw, {level: 3})).toString('base64'),
      rawBytes: raw.byteLength,
      sha256: sha256HexSync(raw),
    };
    expect(decodeStoredCodeGraphFact(JSON.stringify(legacyEnvelope), facts.path).facts).toEqual(facts);
  });

  it('round-trips bounded repository text while keeping presentation sanitization separate', () => {
    fc.assert(
      fc.property(repositoryTextArbitrary, repositoryText => {
        const span = {column: 1, endColumn: 2, endLine: 1, line: 1};
        const facts: CodeGraphFileFacts = {
          derivationInputs: {
            rationale: [{documentation: '', line: 1, marker: 'test', name: repositoryText}],
          },
          diagnostics: [repositoryText],
          edges: [
            {
              confidence: 1,
              evidencePath: 'docs/control.md',
              evidenceSpan: span,
              id: 'edge-control',
              provenance: 'syntactic',
              relation: 'contains',
              sourceId: 'symbol-control',
              sourceName: repositoryText,
              targetName: repositoryText,
            },
          ],
          path: 'docs/control.md',
          references: [
            {
              aliasLookupKeys: [repositoryText],
              edgeId: 'edge-control',
              evidencePath: 'docs/control.md',
              evidenceSpan: span,
              lookupTiers: [[repositoryText]],
              provenance: 'syntactic',
              relation: 'contains',
              resolutionDomain: 'document',
              sourceId: 'symbol-control',
              sourceName: repositoryText,
              targetName: repositoryText,
            },
          ],
          symbols: [
            {
              contentHash: '0'.repeat(64),
              exported: true,
              id: 'symbol-control',
              kind: 'heading',
              language: 'markdown',
              lookupKeys: [repositoryText],
              name: repositoryText,
              packageName: repositoryText,
              path: 'docs/control.md',
              qualifiedName: repositoryText,
              span,
            },
          ],
        };

        const bounded = serializeBoundedCodeGraphFact(facts);
        expect(decodeStoredCodeGraphFact(bounded.json, facts.path).facts).toEqual(facts);
      }),
      {numRuns: 50},
    );
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
    expect(() => decodeStoredCodeGraphFact(JSON.stringify({...envelope, rawBytes: 1_024}))).toThrow();
    expect(() =>
      decodeStoredCodeGraphFact(JSON.stringify({...envelope, payload: `${envelope.payload as string}\n`})),
    ).toThrow(/malformed|base64/);
  });

  it('rejects malformed nested fact shapes at both persistence and decode boundaries', () => {
    fc.assert(
      fc.property(fc.integer({max: 7, min: 0}), mutation => {
        const facts = richFacts();
        const candidate = structuredClone(facts) as unknown as Record<string, unknown>;
        const symbols = candidate.symbols as Array<Record<string, unknown>>;
        const edges = candidate.edges as Array<Record<string, unknown>>;
        const references = candidate.references as Array<Record<string, unknown>>;
        switch (mutation) {
          case 0:
            symbols[0].unexpected = true;
            break;
          case 1:
            symbols[0].span = {...(symbols[0].span as object), line: 0};
            break;
          case 2:
            edges[0].confidence = 2;
            break;
          case 3:
            edges[0].relation = 'future-relation';
            break;
          case 4:
            references[0].lookupTiers = [['valid'], [1]];
            break;
          case 5:
            references[0].evidencePath = '../escape.ts';
            break;
          case 6:
            candidate.derivationInputs = {rationale: [{documentation: '', line: -1, marker: 'why', name: 'x'}]};
            break;
          case 7:
            candidate.derivationInputs = {rationale: [{documentation: '', line: 1, marker: 'why', name: ''}]};
            break;
        }
        expect(() => serializeBoundedCodeGraphFact(candidate as unknown as CodeGraphFileFacts)).toThrow();
        expect(() => decodeStoredCodeGraphFact(JSON.stringify(candidate))).toThrow();
      }),
      {numRuns: 50},
    );
  });
});

function richFacts(): CodeGraphFileFacts {
  const span = {column: 1, endColumn: 2, endLine: 1, line: 1};
  return {
    diagnostics: [],
    edges: [
      {
        confidence: 1,
        evidencePath: 'src/rich.ts',
        evidenceSpan: span,
        id: 'edge-1',
        provenance: 'syntactic',
        relation: 'calls',
        sourceId: 'symbol-1',
        sourceName: 'source',
        targetName: 'target',
      },
    ],
    path: 'src/rich.ts',
    references: [
      {
        edgeId: 'edge-1',
        evidencePath: 'src/rich.ts',
        evidenceSpan: span,
        lookupTiers: [['typescript:name:target']],
        provenance: 'syntactic',
        relation: 'calls',
        resolutionDomain: 'typescript',
        sourceId: 'symbol-1',
        sourceName: 'source',
        targetName: 'target',
      },
    ],
    symbols: [
      {
        contentHash: '0'.repeat(64),
        exported: true,
        id: 'symbol-1',
        kind: 'function',
        language: 'typescript',
        name: 'source',
        path: 'src/rich.ts',
        qualifiedName: 'source',
        span,
      },
    ],
  };
}
