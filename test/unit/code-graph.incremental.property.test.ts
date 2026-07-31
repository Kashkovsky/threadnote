import {describe, expect, it} from '@effect/vitest';
import * as FC from 'effect/testing/FastCheck';
import {hasSameCodeGraphResolutionSurface} from '../../src/code_graph/indexer.js';
import type {CodeGraphSymbol} from '../../src/code_graph/types.js';

const optionalText = FC.oneof(FC.constant(undefined), FC.string({maxLength: 24}));
const optionalArity = FC.oneof(FC.constant(undefined), FC.integer({max: 32, min: 0}));

const symbolArbitrary = FC.record({
  arity: optionalArity,
  contentHash: FC.string({maxLength: 24}),
  documentation: optionalText,
  exported: FC.boolean(),
  id: FC.string({maxLength: 24}),
  kind: FC.string({maxLength: 24}),
  language: FC.string({maxLength: 24}),
  lookupKeys: FC.array(FC.string({maxLength: 24}), {maxLength: 6}),
  name: FC.string({maxLength: 24}),
  packageName: optionalText,
  path: FC.string({maxLength: 48}),
  qualifiedName: FC.string({maxLength: 48}),
  resolutionDomain: optionalText,
  resolutionScopeId: optionalText,
  signature: optionalText,
  span: FC.record({
    column: FC.integer({max: 500, min: 1}),
    endColumn: FC.integer({max: 500, min: 1}),
    endLine: FC.integer({max: 500, min: 1}),
    line: FC.integer({max: 500, min: 1}),
  }),
}).map(
  value =>
    ({
      ...(value.arity === undefined ? {} : {arity: value.arity}),
      contentHash: value.contentHash,
      ...(value.documentation === undefined ? {} : {documentation: value.documentation}),
      exported: value.exported,
      id: value.id,
      kind: value.kind,
      language: value.language,
      lookupKeys: value.lookupKeys,
      name: value.name,
      ...(value.packageName === undefined ? {} : {packageName: value.packageName}),
      path: value.path,
      qualifiedName: value.qualifiedName,
      ...(value.resolutionDomain === undefined ? {} : {resolutionDomain: value.resolutionDomain}),
      ...(value.resolutionScopeId === undefined ? {} : {resolutionScopeId: value.resolutionScopeId}),
      ...(value.signature === undefined ? {} : {signature: value.signature}),
      span: value.span,
    }) satisfies CodeGraphSymbol,
);

describe('code graph incremental-overlay properties', () => {
  it.prop(
    'accepts body-only metadata changes but rejects every declaration and lookup surface mutation',
    {symbol: symbolArbitrary},
    ({symbol}) => {
      const bodyOnly: CodeGraphSymbol = {
        ...symbol,
        contentHash: `changed:${symbol.contentHash}`,
        documentation: `changed:${symbol.documentation ?? ''}`,
        span: {...symbol.span, endLine: symbol.span.endLine + 1},
      };
      expect(hasSameCodeGraphResolutionSurface([symbol], [bodyOnly])).toBe(true);

      const mutations: readonly CodeGraphSymbol[] = [
        {...symbol, arity: symbol.arity === undefined ? 0 : symbol.arity + 1},
        {...symbol, exported: !symbol.exported},
        {...symbol, id: `changed:${symbol.id}`},
        {...symbol, kind: `changed:${symbol.kind}`},
        {...symbol, language: `changed:${symbol.language}`},
        {...symbol, lookupKeys: [...(symbol.lookupKeys ?? []), '__changed_lookup__']},
        {...symbol, name: `changed:${symbol.name}`},
        {...symbol, packageName: changedOptional(symbol.packageName)},
        {...symbol, path: `changed/${symbol.path}`},
        {...symbol, qualifiedName: `changed:${symbol.qualifiedName}`},
        {...symbol, resolutionDomain: changedOptional(symbol.resolutionDomain)},
        {...symbol, resolutionScopeId: changedOptional(symbol.resolutionScopeId)},
        {...symbol, signature: changedOptional(symbol.signature)},
      ];
      expect(mutations.every(mutated => !hasSameCodeGraphResolutionSurface([symbol], [mutated]))).toBe(true);
    },
    {fastCheck: {numRuns: 250}},
  );

  it.prop(
    'is independent of symbol materialization order while still requiring the exact symbol set',
    {symbols: FC.array(symbolArbitrary, {maxLength: 12, minLength: 1})},
    ({symbols}) => {
      const unique = symbols.map((symbol, index) => ({...symbol, id: `symbol-${index}:${symbol.id}`}));
      expect(hasSameCodeGraphResolutionSurface(unique, [...unique].reverse())).toBe(true);
      expect(hasSameCodeGraphResolutionSurface(unique, unique.slice(1))).toBe(false);
    },
    {fastCheck: {numRuns: 150}},
  );

  it.prop(
    'fails closed when either resolution surface contains duplicate symbol IDs',
    {symbol: symbolArbitrary},
    ({symbol}) => {
      const changedDuplicate: CodeGraphSymbol = {
        ...symbol,
        name: `changed:${symbol.name}`,
      };
      const uniquePeer: CodeGraphSymbol = {
        ...symbol,
        id: `peer:${symbol.id}`,
      };

      expect(hasSameCodeGraphResolutionSurface([symbol, changedDuplicate], [changedDuplicate, changedDuplicate])).toBe(
        false,
      );
      expect(hasSameCodeGraphResolutionSurface([symbol, symbol], [symbol, uniquePeer])).toBe(false);
      expect(hasSameCodeGraphResolutionSurface([symbol, uniquePeer], [symbol, symbol])).toBe(false);
      expect(hasSameCodeGraphResolutionSurface([symbol, symbol], [symbol, symbol])).toBe(false);
    },
    {fastCheck: {numRuns: 150}},
  );
});

function changedOptional(value: string | undefined): string {
  return `changed:${value ?? ''}`;
}
