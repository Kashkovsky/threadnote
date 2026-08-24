import {Database} from 'bun:sqlite';
import {expect, it} from '@effect/vitest';
import {codeGraphPackageMoniker} from '../../src/code_graph/cross_repository/monikers.js';
import {
  commitCodeGraphMaterializationSpoolBatch,
  configureCodeGraphMaterializationSpoolDatabase,
  initializeCodeGraphMaterializationSpoolDatabase,
  sealCodeGraphMaterializationSpool,
  sortCodeGraphMaterializationSpoolSurfaces,
} from '../../src/code_graph/materialization_spool.js';
import {
  appendCodeGraphMaterializationSpoolFactBatch,
  prepareCodeGraphMaterializationSpoolFactBatch,
} from '../../src/code_graph/materialization_spool_writer.js';
import type {CodeGraphEdge, CodeGraphReference, CodeGraphSymbol} from '../../src/code_graph/types.js';

it('appends every canonical fact surface under the exact durable batch receipt', () => {
  const database = new Database(':memory:', {strict: true});
  const symbol: CodeGraphSymbol = {
    contentHash: 'a'.repeat(64),
    exported: true,
    id: 'symbol-source',
    kind: 'function',
    language: 'typescript',
    lookupKeys: ['typescript:name:source', 'generic:source'],
    name: 'source',
    path: 'src/source.ts',
    qualifiedName: 'source',
    span: {column: 1, endColumn: 2, endLine: 1, line: 1},
  };
  const directEdge = edge('edge-direct', 'calls');
  const referenceEdge = edge('edge-reference', 'reexports');
  const reference: CodeGraphReference = {
    aliasLookupKeys: ['typescript:path:src%2Fsource.ts:name:local'],
    edgeId: referenceEdge.id,
    evidencePath: referenceEdge.evidencePath,
    evidenceSpan: referenceEdge.evidenceSpan,
    exportedOnly: true,
    lookupTiers: [['typescript:path:src%2Ftarget.ts:name:imported']],
    provenance: referenceEdge.provenance,
    relation: referenceEdge.relation,
    resolutionDomain: 'typescript',
    sourceId: referenceEdge.sourceId,
    sourceName: referenceEdge.sourceName,
    targetName: referenceEdge.targetName,
  };
  const prepared = prepareCodeGraphMaterializationSpoolFactBatch({
    directEdges: [directEdge],
    monikers: [
      codeGraphPackageMoniker({
        componentId: `cgp_${'1'.repeat(32)}`,
        evidence: {path: 'package.json', span: {column: 1, endColumn: 2, endLine: 1, line: 1}},
        packageName: '@scope/source',
        role: 'export',
      }),
    ],
    referenceEdges: new Map([[referenceEdge.id, referenceEdge]]),
    references: [reference],
    symbols: [symbol],
    termsBySymbol: new Map([
      [
        symbol,
        [
          ['shared', 1],
          ['source', 5],
        ],
      ],
    ]),
  });
  try {
    configureCodeGraphMaterializationSpoolDatabase(database);
    initializeCodeGraphMaterializationSpoolDatabase(database, {
      checkoutId: 'a'.repeat(64),
      extractorSet: 'extractor-v1',
      graphContentId: `cgc_${'b'.repeat(40)}`,
      repositoryId: 'c'.repeat(64),
      snapshotId: `cgsn_${'d'.repeat(40)}-direct`,
    });
    expect(
      commitCodeGraphMaterializationSpoolBatch(
        database,
        {batchId: 'e'.repeat(64), batchIndex: 0, factBytes: 100, rowCount: prepared.rowCount, sourceBytes: 200},
        () => appendCodeGraphMaterializationSpoolFactBatch(database, prepared),
      ),
    ).toBe('appended');
    expect(prepared.rowCount).toBe(9);
    expect(rawSurfaceCounts(database)).toEqual({
      edges: 1,
      lookup: 2,
      monikers: 1,
      references: 1,
      reexports: 1,
      symbol_terms: 2,
      symbols: 1,
    });
    sealCodeGraphMaterializationSpool(database, 1);
    sortCodeGraphMaterializationSpoolSurfaces(database);
    expect(
      database.prepare('SELECT lookup_key, symbol_id FROM materialization_ordered_lookup ORDER BY rowid').all(),
    ).toEqual([
      {lookup_key: 'generic:source', symbol_id: 'symbol-source'},
      {lookup_key: 'typescript:name:source', symbol_id: 'symbol-source'},
    ]);
    expect(
      database.prepare('SELECT candidate_count, lookup_tiers_json FROM materialization_ordered_references').get(),
    ).toEqual({candidate_count: 1, lookup_tiers_json: '[["typescript:path:src%2Ftarget.ts:name:imported"]]'});
  } finally {
    database.close();
  }
});

function edge(id: string, relation: CodeGraphEdge['relation']): CodeGraphEdge {
  return {
    confidence: 0.75,
    evidencePath: 'src/source.ts',
    evidenceSpan: {column: 1, endColumn: 2, endLine: 1, line: 1},
    id,
    provenance: 'syntactic',
    relation,
    sourceId: 'symbol-source',
    sourceName: 'source',
    targetName: 'target',
  };
}

function rawSurfaceCounts(database: Database): Readonly<Record<string, number>> {
  return Object.fromEntries(
    ['edges', 'lookup', 'monikers', 'references', 'reexports', 'symbol_terms', 'symbols'].map(surface => [
      surface,
      Number(
        (
          database.prepare(`SELECT COUNT(*) AS count FROM materialization_raw_${surface}`).get() as {
            readonly count: number;
          }
        ).count,
      ),
    ]),
  );
}
