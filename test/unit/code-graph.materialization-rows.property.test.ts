import {expect, it} from '@effect/vitest';
import * as FC from 'effect/testing/FastCheck';
import {
  codeGraphMaterializationReferenceRows,
  codeGraphMaterializationReexportRows,
  codeGraphLookupDomain,
  codeGraphMaterializationEdgeRows,
  codeGraphMaterializationSymbolLookupRows,
  codeGraphMaterializationSymbolRows,
} from '../../src/code_graph/materialization_rows.js';
import type {CodeGraphEdge, CodeGraphReference, CodeGraphSymbol} from '../../src/code_graph/types.js';

const edgeArbitrary = FC.record({
  confidence: FC.integer({max: 100, min: 0}).map(value => value / 100),
  id: FC.stringMatching(/^edge-[a-z0-9]{1,8}$/u),
  relation: FC.constantFrom('calls' as const, 'contains' as const, 'references' as const),
  sourceId: FC.option(FC.stringMatching(/^symbol-[a-z0-9]{1,8}$/u), {nil: undefined}),
  targetId: FC.option(FC.stringMatching(/^symbol-[a-z0-9]{1,8}$/u), {nil: undefined}),
});

const symbolArbitrary = FC.record({
  exported: FC.boolean(),
  id: FC.stringMatching(/^[a-z][a-z0-9]{0,8}$/u),
  lookupKeys: FC.uniqueArray(FC.stringMatching(/^[a-z][a-z0-9]{0,5}(?::[a-z]{1,6})?$/u), {maxLength: 6}),
  path: FC.stringMatching(/^src\/[a-z]{1,8}\.ts$/u),
  resolutionDomain: FC.option(FC.stringMatching(/^[a-z]{1,6}$/u), {nil: undefined}),
});

const referenceArbitrary = FC.record({
  edgeId: FC.stringMatching(/^edge-[a-z0-9]{1,8}$/u),
  exportedOnly: FC.boolean(),
  lookupTiers: FC.array(FC.array(FC.stringMatching(/^[a-z][a-z0-9]{0,5}$/u), {maxLength: 6}), {
    maxLength: 4,
  }),
  resolutionDomain: FC.stringMatching(/^[a-z]{1,8}$/u),
});

it.prop(
  'materializes lookup rows deterministically independent of unique symbol order',
  {symbols: FC.uniqueArray(symbolArbitrary, {maxLength: 24, selector: symbol => symbol.id})},
  ({symbols}) => {
    const materialized = symbols.map(codeGraphSymbol);
    const reversed = [...materialized].reverse();
    const forward = codeGraphMaterializationSymbolLookupRows(materialized);
    const reverse = codeGraphMaterializationSymbolLookupRows(reversed);
    expect(reverse).toEqual(forward);
    expect(new Set(forward.map(row => `${row.lookupKey}\0${row.symbolId}`)).size).toBe(forward.length);
    expect(
      forward.every(
        (row, index) =>
          index === 0 ||
          forward[index - 1]!.lookupKey < row.lookupKey ||
          (forward[index - 1]!.lookupKey === row.lookupKey && forward[index - 1]!.symbolId < row.symbolId),
      ),
    ).toBe(true);
    expect(codeGraphMaterializationSymbolRows(reversed)).toEqual(codeGraphMaterializationSymbolRows(materialized));
    expect(codeGraphMaterializationSymbolRows(materialized).map(row => row.id)).toEqual(
      materialized.map(symbol => symbol.id).sort(),
    );
  },
  {fastCheck: {numRuns: 100}},
);

it('derives an explicit lookup prefix before fallback domain', () => {
  expect(codeGraphLookupDomain('npm:react', 'workspace')).toBe('npm');
  expect(codeGraphLookupDomain('react', 'workspace')).toBe('workspace');
  expect(codeGraphLookupDomain('react', undefined)).toBe('generic');
});

it('encodes optional symbol columns and JSON at the SQLite boundary', () => {
  const [row] = codeGraphMaterializationSymbolRows([
    {
      ...codeGraphSymbol({exported: true, id: 'symbol', lookupKeys: ['npm:symbol'], path: 'src/symbol.ts'}),
      arity: 2,
      documentation: 'docs',
      packageName: '@scope/pkg',
      resolutionScopeId: 'scope',
      signature: '(left, right)',
    },
  ]);
  expect(row).toMatchObject({
    arity: 2,
    documentation: 'docs',
    exported: 1,
    lookupKeysJson: '["npm:symbol"]',
    packageName: '@scope/pkg',
    resolutionDomain: null,
    resolutionScopeId: 'scope',
    signature: '(left, right)',
    spanJson: '{"column":1,"endColumn":2,"endLine":1,"line":1}',
  });
});

it.prop(
  'materializes direct edge rows independent of unique edge order',
  {edges: FC.uniqueArray(edgeArbitrary, {maxLength: 24, selector: edge => edge.id})},
  ({edges}) => {
    const materialized = edges.map(edge => ({
      ...edge,
      evidencePath: 'src/source.ts',
      evidenceSpan: {column: 1, endColumn: 2, endLine: 1, line: 1},
      provenance: 'resolved' as const,
      sourceName: 'source',
      targetName: 'target',
    }));
    const forward = codeGraphMaterializationEdgeRows(materialized);
    expect(codeGraphMaterializationEdgeRows([...materialized].reverse())).toEqual(forward);
    expect(forward.map(row => row.id)).toEqual(materialized.map(edge => edge.id).sort());
    expect(forward.every(row => row.evidenceSpanJson === '{"column":1,"endColumn":2,"endLine":1,"line":1}')).toBe(true);
  },
  {fastCheck: {numRuns: 100}},
);

it.prop(
  'materializes unresolved references independent of unique input order',
  {references: FC.uniqueArray(referenceArbitrary, {maxLength: 24, selector: reference => reference.edgeId})},
  ({references}) => {
    const materialized = references.map(reference => codeGraphReference(reference));
    const edges = materialized.map(reference => referenceEdge(reference));
    const forward = codeGraphMaterializationReferenceRows(materialized, new Map(edges.map(edge => [edge.id, edge])));
    const reverse = codeGraphMaterializationReferenceRows(
      [...materialized].reverse(),
      new Map([...edges].reverse().map(edge => [edge.id, edge])),
    );
    expect(reverse).toEqual(forward);
    expect(forward.map(row => row.edgeId)).toEqual(materialized.map(reference => reference.edgeId).sort());
    for (const row of forward) {
      const tiers = JSON.parse(row.lookupTiersJson) as readonly (readonly string[])[];
      expect(row.candidateCount).toBe(tiers.reduce((total, tier) => total + tier.length, 0));
      expect(row.candidatePayloadBytes).toBe(new TextEncoder().encode(row.lookupTiersJson).byteLength);
      expect(tiers.every(tier => new Set(tier).size === tier.length)).toBe(true);
    }
  },
  {fastCheck: {numRuns: 100}},
);

it('deduplicates and orders canonical TypeScript re-export rows', () => {
  const reference = codeGraphReference({
    edgeId: 'edge-reexport',
    exportedOnly: true,
    lookupTiers: [['typescript:path:src%2Ftarget.ts:name:zeta', 'typescript:path:src%2Ftarget.ts:name:alpha']],
    resolutionDomain: 'typescript',
  });
  const reexport = {
    ...reference,
    aliasLookupKeys: ['typescript:path:src%2Fsource.ts:name:local'],
    evidencePath: 'src/source.ts',
    relation: 'reexports' as const,
  };
  expect(codeGraphMaterializationReexportRows([reexport, reexport])).toEqual([
    {importedName: 'alpha', localName: 'local', sourcePath: 'src/source.ts', targetPath: 'src/target.ts'},
    {importedName: 'zeta', localName: 'local', sourcePath: 'src/source.ts', targetPath: 'src/target.ts'},
  ]);
});

function codeGraphSymbol(input: {
  readonly exported: boolean;
  readonly id: string;
  readonly lookupKeys: readonly string[];
  readonly path: string;
  readonly resolutionDomain?: string;
}): CodeGraphSymbol {
  return {
    ...input,
    contentHash: 'a'.repeat(64),
    kind: 'function',
    language: 'typescript',
    name: input.id,
    qualifiedName: input.id,
    span: {column: 1, endColumn: 2, endLine: 1, line: 1},
  };
}

function codeGraphReference(input: {
  readonly edgeId: string;
  readonly exportedOnly: boolean;
  readonly lookupTiers: readonly (readonly string[])[];
  readonly resolutionDomain: string;
}): CodeGraphReference {
  return {
    ...input,
    evidencePath: 'src/source.ts',
    evidenceSpan: {column: 1, endColumn: 2, endLine: 1, line: 1},
    provenance: 'syntactic',
    relation: 'references',
    sourceName: 'source',
    targetName: 'target',
  };
}

function referenceEdge(reference: CodeGraphReference): CodeGraphEdge {
  return {
    confidence: 0.75,
    evidencePath: reference.evidencePath,
    evidenceSpan: reference.evidenceSpan,
    id: reference.edgeId,
    provenance: reference.provenance,
    relation: reference.relation,
    sourceId: reference.sourceId,
    sourceName: reference.sourceName,
    targetName: reference.targetName,
  };
}
