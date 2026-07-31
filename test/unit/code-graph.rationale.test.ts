import {describe, expect, test} from 'vitest';
import {augmentRationaleFacts} from '../../src/code_graph/rationale.js';
import type {CodeGraphFileFacts, CodeGraphInventoryFile, CodeGraphSymbol} from '../../src/code_graph/types.js';

describe('code graph rationale extraction', () => {
  test('promotes explicit rationale comments and design references into provenance-tagged nodes', () => {
    const content = [
      'export function retry() {',
      '  // WHY: Jitter prevents coordinated retry storms.',
      '  // See ADR-104 for the bounded delay contract.',
      '}',
    ].join('\n');
    const file: CodeGraphInventoryFile = {
      blobId: 'blob',
      content,
      contentHash: 'hash',
      language: 'typescript',
      mode: '100644',
      path: 'src/retry.ts',
      size: content.length,
      source: 'commit',
    };
    const owner = symbol('retry', 1, 4);
    const facts: CodeGraphFileFacts = {diagnostics: [], edges: [], path: file.path, symbols: [owner]};

    const result = augmentRationaleFacts(file, facts);

    expect(result.symbols.map(value => [value.kind, value.name])).toEqual(
      expect.arrayContaining([
        ['rationale', 'WHY: Jitter prevents coordinated retry storms.'],
        ['rationale', 'ADR-104'],
      ]),
    );
    expect(result.edges).toHaveLength(2);
    expect(result.edges.every(edge => edge.relation === 'documents' && edge.provenance === 'declared')).toBe(true);
    expect(result.edges.every(edge => edge.targetId === owner.id)).toBe(true);
  });

  test('does not interpret binary asset bytes as rationale', () => {
    const file: CodeGraphInventoryFile = {
      blobId: 'blob',
      bytes: new Uint8Array([0, 1, 2]),
      contentHash: 'hash',
      language: 'image',
      mode: '100644',
      path: 'diagram.png',
      size: 3,
      source: 'commit',
    };
    const facts: CodeGraphFileFacts = {diagnostics: [], edges: [], path: file.path, symbols: []};
    expect(augmentRationaleFacts(file, facts)).toBe(facts);
  });
});

function symbol(name: string, line: number, endLine: number): CodeGraphSymbol {
  return {
    contentHash: 'hash',
    exported: true,
    id: `symbol:${name}`,
    kind: 'function',
    language: 'typescript',
    name,
    path: 'src/retry.ts',
    qualifiedName: name,
    span: {column: 1, endColumn: 1, endLine, line},
  };
}
