import {expect, it} from '@effect/vitest';
import * as FC from 'effect/testing/FastCheck';
import {
  codeGraphLookupDomain,
  codeGraphMaterializationSymbolLookupRows,
  codeGraphMaterializationSymbolRows,
} from '../../src/code_graph/materialization_rows.js';
import type {CodeGraphSymbol} from '../../src/code_graph/types.js';

const symbolArbitrary = FC.record({
  exported: FC.boolean(),
  id: FC.stringMatching(/^[a-z][a-z0-9]{0,8}$/u),
  lookupKeys: FC.uniqueArray(FC.stringMatching(/^[a-z][a-z0-9]{0,5}(?::[a-z]{1,6})?$/u), {maxLength: 6}),
  path: FC.stringMatching(/^src\/[a-z]{1,8}\.ts$/u),
  resolutionDomain: FC.option(FC.stringMatching(/^[a-z]{1,6}$/u), {nil: undefined}),
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
