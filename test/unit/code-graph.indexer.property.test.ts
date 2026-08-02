import {describe, expect, it} from '@effect/vitest';
import * as FC from 'effect/testing/FastCheck';
import {
  addMaterializationRows,
  compactCachedFileRelationships,
  deduplicateMaterializationRelationships,
  estimatedMaterializationStorageBytes,
  factMaterializationBatches,
  materializationRowsWithStoreProgress,
  materializationStoragePlan,
  materializationStorageShortfalls,
  snapshotIdentity,
} from '../../src/code_graph/indexer.js';
import {sha256HexSync} from '../../src/crypto/sha256.js';
import {CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION} from '../../src/code_graph/store.js';
import type {CodeGraphEdge, CodeGraphMaterializationRows, CodeGraphReference} from '../../src/code_graph/types.js';

const byteCount = FC.integer({max: Number.MAX_SAFE_INTEGER, min: 0});
const materializationRowCount = FC.integer({max: 1_000_000, min: 0});
const materializationRows = FC.record({
  deduplicatedEdges: materializationRowCount,
  deduplicatedReferences: materializationRowCount,
  edges: materializationRowCount,
  lookupKeys: materializationRowCount,
  referenceCandidates: materializationRowCount,
  references: materializationRowCount,
  reexports: materializationRowCount,
  symbols: materializationRowCount,
  terms: materializationRowCount,
});

describe('code graph indexer properties', () => {
  it('includes the compact lexical format in deterministic snapshot identity', () => {
    const identity = {headCommit: 'a'.repeat(40), repositoryId: 'b'.repeat(64), worktreeId: 'c'.repeat(64)};
    const files = [{contentHash: 'd'.repeat(64), path: 'src/index.ts', source: 'commit'}];
    const extractorSet = 'extractor-set';
    const inventory = `${files[0]!.path}\0${files[0]!.contentHash}\0${files[0]!.source}`;
    const expected = sha256HexSync(
      `snapshot-v2\nlexical-storage:${CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION}\n${identity.repositoryId}\nshared-commit\n${identity.headCommit}\nclean\n${extractorSet}\n${inventory}`,
    ).slice(0, 40);

    expect(snapshotIdentity(identity, false, extractorSet, files)).toBe(`cgsn_${expected}`);
  });

  it('splits high-density low-source-byte facts before one SQLite writer transaction becomes pathological', () => {
    const files = Array.from({length: 7}, (_, index) => ({path: `src/dense-${index}.ts`, size: 32}));
    const factBytes = new Map(files.map(file => [file.path, 4 * 1_048_576]));
    const batches = factMaterializationBatches(files, factBytes);

    expect(batches.map(batch => batch.length)).toEqual([2, 2, 2, 1]);
    expect(
      batches.every(batch => batch.reduce((total, file) => total + factBytes.get(file.path)!, 0) <= 8 * 1_048_576),
    ).toBe(true);
    expect(factMaterializationBatches(files, factBytes)).toEqual(batches);
  });

  it('keeps a non-empty batch estimate at a zero-row SQLite stage boundary', () => {
    const estimated = {lookupKeys: 111_666, symbols: 5_669};

    expect(
      materializationRowsWithStoreProgress(estimated, {
        chunkRows: 0,
        elapsedMilliseconds: 0,
        rowsCompleted: 0,
        stage: 'symbols',
      }),
    ).toEqual(estimated);
    expect(
      materializationRowsWithStoreProgress(estimated, {
        chunkRows: 1_000,
        elapsedMilliseconds: 1,
        rowsCompleted: 1_000,
        stage: 'symbols',
      }),
    ).toEqual({lookupKeys: 111_666, symbols: 1_000});
  });

  it.prop(
    'combines every materialization row counter associatively without dropping a category',
    {first: materializationRows, second: materializationRows, third: materializationRows},
    ({first, second, third}) => {
      const leftAssociated = addMaterializationRows(addMaterializationRows(first, second), third);
      const rightAssociated = addMaterializationRows(first, addMaterializationRows(second, third));
      const keys = Object.keys(first) as ReadonlyArray<keyof CodeGraphMaterializationRows>;

      expect(leftAssociated).toEqual(rightAssociated);
      for (const key of keys) {
        expect(leftAssociated[key]).toBe((first[key] ?? 0) + (second[key] ?? 0) + (third[key] ?? 0));
      }
    },
    {fastCheck: {numRuns: 250}},
  );

  it.prop(
    'keeps every disk-estimate component finite, safe, and internally bounded',
    {cachedFactBytes: FC.option(byteCount, {nil: undefined}), sourceBytes: byteCount},
    ({cachedFactBytes, sourceBytes}) => {
      const estimate = estimatedMaterializationStorageBytes(cachedFactBytes, sourceBytes);
      const values = [
        estimate.estimatedConcurrentBuildBytes,
        estimate.estimatedDurableSnapshotBytes,
        estimate.estimatedJournalBytes,
        estimate.estimatedRequiredBytes,
        estimate.estimatedTemporaryDatabaseBytes,
      ];

      expect(values.every(value => Number.isSafeInteger(value) && value >= 0)).toBe(true);
      expect(estimate.estimatedRequiredBytes).toBeGreaterThanOrEqual(estimate.estimatedConcurrentBuildBytes);
      expect(estimate.estimateBasis).toBe(
        cachedFactBytes === undefined ? 'source-bytes-fallback' : 'cached-fact-bytes',
      );
    },
    {fastCheck: {numRuns: 250}},
  );

  it.prop(
    'never decreases a component when the selected estimate basis grows',
    {left: byteCount, right: byteCount},
    ({left, right}) => {
      const lower = estimatedMaterializationStorageBytes(Math.min(left, right), 0);
      const upper = estimatedMaterializationStorageBytes(Math.max(left, right), 0);

      expect(upper.estimatedTemporaryDatabaseBytes).toBeGreaterThanOrEqual(lower.estimatedTemporaryDatabaseBytes);
      expect(upper.estimatedDurableSnapshotBytes).toBeGreaterThanOrEqual(lower.estimatedDurableSnapshotBytes);
      expect(upper.estimatedJournalBytes).toBeGreaterThanOrEqual(lower.estimatedJournalBytes);
      expect(upper.estimatedConcurrentBuildBytes).toBeGreaterThanOrEqual(lower.estimatedConcurrentBuildBytes);
      expect(upper.estimatedRequiredBytes).toBeGreaterThanOrEqual(lower.estimatedRequiredBytes);
    },
    {fastCheck: {numRuns: 250}},
  );

  it('labels an explicit final-attribution storage estimate without changing its byte arithmetic', () => {
    const cached = estimatedMaterializationStorageBytes(2_000_000, 1, 'direct-persistent');
    const attributed = estimatedMaterializationStorageBytes(2_000_000, 1, 'direct-persistent', 'final-fact-bytes');

    expect(attributed).toEqual({...cached, estimateBasis: 'final-fact-bytes'});
  });

  it.prop(
    'plans direct snapshots without charging their durable WAL to the TEMP filesystem',
    {durableAvailableBytes: byteCount, factBytes: byteCount, temporaryAvailableBytes: byteCount},
    ({durableAvailableBytes, factBytes, temporaryAvailableBytes}) => {
      const direct = estimatedMaterializationStorageBytes(factBytes, 0, 'direct-persistent');
      const staged = estimatedMaterializationStorageBytes(factBytes, 0, 'temporary-staged');
      const plan = materializationStoragePlan(direct, {
        durableAvailableBytes,
        filesystemsShared: false,
        temporaryAvailableBytes,
      });

      expect(direct.estimatedTemporaryDatabaseBytes).toBeLessThanOrEqual(staged.estimatedTemporaryDatabaseBytes);
      expect(plan.estimatedTemporaryFilesystemRequiredBytes).toBe(direct.estimatedTemporaryDatabaseBytes * 2);
      expect(plan.estimatedDurableFilesystemRequiredBytes).toBe(
        Math.min(Number.MAX_SAFE_INTEGER, (direct.estimatedDurableSnapshotBytes + direct.estimatedJournalBytes) * 2),
      );
    },
    {fastCheck: {numRuns: 250}},
  );

  it.prop(
    'assesses independently mounted TEMP and durable storage against their own headroom',
    {
      durableAvailableBytes: byteCount,
      factBytes: byteCount,
      temporaryAvailableBytes: byteCount,
    },
    ({durableAvailableBytes, factBytes, temporaryAvailableBytes}) => {
      const plan = materializationStoragePlan(estimatedMaterializationStorageBytes(factBytes, 0), {
        durableAvailableBytes,
        filesystemsShared: false,
        temporaryAvailableBytes,
      });
      const shortfalls = materializationStorageShortfalls(plan);

      expect(shortfalls.includes('durable')).toBe(durableAvailableBytes < plan.estimatedDurableFilesystemRequiredBytes);
      expect(shortfalls.includes('temporary')).toBe(
        temporaryAvailableBytes < plan.estimatedTemporaryFilesystemRequiredBytes,
      );
      expect(shortfalls.includes('shared')).toBe(false);
      expect(plan.availableBytes).toBeUndefined();
    },
    {fastCheck: {numRuns: 250}},
  );

  it.prop(
    'coalesces shared TEMP and durable storage into one conservative filesystem check',
    {durableAvailableBytes: byteCount, factBytes: byteCount, temporaryAvailableBytes: byteCount},
    ({durableAvailableBytes, factBytes, temporaryAvailableBytes}) => {
      const plan = materializationStoragePlan(estimatedMaterializationStorageBytes(factBytes, 0), {
        durableAvailableBytes,
        filesystemsShared: true,
        temporaryAvailableBytes,
      });
      const availableBytes = Math.min(durableAvailableBytes, temporaryAvailableBytes);
      const shortfalls = materializationStorageShortfalls(plan);

      expect(plan.availableBytes).toBe(availableBytes);
      expect(shortfalls).toEqual(availableBytes < plan.estimatedRequiredBytes ? ['shared'] : []);
    },
    {fastCheck: {numRuns: 250}},
  );

  it.prop(
    'compacts parser-cache relationships idempotently without changing attribution winner semantics',
    {ids: FC.array(FC.integer({max: 30, min: 0}), {maxLength: 300})},
    ({ids}) => {
      const edges = ids.map((id, index) => relationshipEdge(String(id), index));
      const references = ids.map((id, index) => relationshipReference(String(id), index));
      const facts = {
        diagnostics: [],
        edges,
        path: 'src/repeated.ts',
        references,
        symbols: [],
      } as const;
      const compacted = compactCachedFileRelationships(facts);
      const repeated = compactCachedFileRelationships(compacted);
      const uniqueIds = new Set(ids.map(String));

      expect(compacted.edges.map(edge => edge.id)).toEqual([...uniqueIds]);
      expect(compacted.references?.map(reference => reference.edgeId)).toEqual([...uniqueIds]);
      expect(repeated).toEqual(compacted);
      for (const id of uniqueIds) {
        expect(compacted.edges.find(edge => edge.id === id)).toBe(edges.find(edge => edge.id === id));
        expect(compacted.references?.find(reference => reference.edgeId === id)).toBe(
          references.filter(reference => reference.edgeId === id).at(-1),
        );
      }
    },
    {fastCheck: {numRuns: 250}},
  );

  it.prop(
    'deduplicates repeated relationship primary keys stably and idempotently before strict staging',
    {ids: FC.array(FC.integer({max: 30, min: 0}), {maxLength: 300})},
    ({ids}) => {
      const edges = ids.map((id, index) => relationshipEdge(String(id), index));
      const references = ids.map((id, index) => relationshipReference(String(id), index));
      const deduplicated = deduplicateMaterializationRelationships(edges, references);
      const repeated = deduplicateMaterializationRelationships(deduplicated.edges, deduplicated.references);
      const uniqueIds = new Set(ids.map(String));

      expect(deduplicated.edges.map(edge => edge.id)).toEqual([...uniqueIds]);
      expect(deduplicated.references.map(reference => reference.edgeId)).toEqual([...uniqueIds]);
      expect(deduplicated.duplicateEdges).toBe(ids.length - uniqueIds.size);
      expect(deduplicated.duplicateReferences).toBe(ids.length - uniqueIds.size);
      expect(repeated).toEqual({
        duplicateEdges: 0,
        duplicateReferences: 0,
        edges: deduplicated.edges,
        references: deduplicated.references,
      });
      for (const id of uniqueIds) {
        expect(deduplicated.edges.find(edge => edge.id === id)).toBe(edges.find(edge => edge.id === id));
        expect(deduplicated.references.find(reference => reference.edgeId === id)).toBe(
          references.filter(reference => reference.edgeId === id).at(-1),
        );
      }
    },
    {fastCheck: {numRuns: 250}},
  );
});

function relationshipEdge(id: string, line: number): CodeGraphEdge {
  return {
    confidence: 1,
    evidencePath: 'src/repeated.ts',
    evidenceSpan: {column: 1, endColumn: 2, endLine: line + 1, line: line + 1},
    id,
    provenance: 'syntactic',
    relation: 'calls',
    sourceName: 'caller',
    targetName: 'target',
  };
}

function relationshipReference(edgeId: string, line: number): CodeGraphReference {
  return {
    edgeId,
    evidencePath: 'src/repeated.ts',
    evidenceSpan: {column: 1, endColumn: 2, endLine: line + 1, line: line + 1},
    lookupTiers: [[`typescript:name:target-${edgeId}`]],
    provenance: 'syntactic',
    relation: 'calls',
    resolutionDomain: 'typescript',
    sourceName: 'caller',
    targetName: 'target',
  };
}
