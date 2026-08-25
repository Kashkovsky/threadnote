import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {CODE_GRAPH_CACHE_TRANSACTION_LIMITS} from '../../src/code_graph/cache_capacity.js';
import {
  codeGraphCacheWritePages,
  prepareMaterializedShardCacheBatchChunks,
  sameMaterializedShardWriteIds,
} from '../../src/code_graph/store_cache.js';
import type {CodeGraphMaterializedShardCacheBatch} from '../../src/code_graph/store_models.js';

const shardId = fc.stringMatching(/^cgfs_[a-f0-9]{1,40}$/u);

describe('materialized shard batched write properties', () => {
  it('partitions without loss, mutation, or oversized SQLite statements', () => {
    fc.assert(
      fc.property(fc.uniqueArray(shardId, {maxLength: 1_200}), ids => {
        const before = [...ids];
        const pages = codeGraphCacheWritePages(ids);

        expect(pages.flat()).toEqual(ids);
        expect(pages).toHaveLength(Math.ceil(ids.length / CODE_GRAPH_CACHE_TRANSACTION_LIMITS.rows));
        expect(pages.every(page => page.length > 0 && page.length <= CODE_GRAPH_CACHE_TRANSACTION_LIMITS.rows)).toBe(
          true,
        );
        expect(ids).toEqual(before);
      }),
      {numRuns: 150},
    );
  });

  it('accepts every exact RETURNING permutation and rejects partial or ambiguous identity sets', () => {
    fc.assert(
      fc.property(fc.uniqueArray(shardId, {maxLength: CODE_GRAPH_CACHE_TRANSACTION_LIMITS.rows, minLength: 1}), ids => {
        expect(sameMaterializedShardWriteIds(ids, [...ids].reverse())).toBe(true);
        expect(sameMaterializedShardWriteIds(ids, ids.slice(1))).toBe(false);
        if (ids.length > 1) {
          expect(sameMaterializedShardWriteIds(ids, [...ids.slice(0, -1), ids[0]!])).toBe(false);
          expect(sameMaterializedShardWriteIds([...ids.slice(0, -1), ids[0]!], ids)).toBe(false);
        }
      }),
      {numRuns: 150},
    );
  });

  it('replans logical attribution batches losslessly into deterministic bounded transactions', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({max: 128, min: 1}), {maxLength: 8, minLength: 1}), batchSizes => {
        let nextFile = 0;
        const batches: CodeGraphMaterializedShardCacheBatch[] = batchSizes.map((batchSize, batchIndex) => {
          const files = Array.from({length: batchSize}, () => {
            const index = nextFile;
            nextFile += 1;
            const path = `src/file-${index.toString().padStart(4, '0')}.ts`;
            return {
              blobId: index.toString(16).padStart(40, '0'),
              contentHash: index.toString(16).padStart(64, '0'),
              language: 'typescript',
              mode: '100644',
              path,
              size: index,
              source: 'commit' as const,
            };
          });
          return {
            derivationIdentity: `derivation-${batchIndex}`,
            extractorSet: 'property-extractors',
            facts: files.map(file => ({diagnostics: [], edges: [], path: file.path, symbols: []})),
            files,
          };
        });
        const inputPaths = batches.flatMap(batch => batch.files.map(file => file.path));

        const chunks = prepareMaterializedShardCacheBatchChunks(batches, '2026-08-23T00:00:00.000Z');

        expect(chunks.flatMap(chunk => chunk.rows.map(row => row.key))).toEqual(inputPaths);
        expect(
          chunks.every(
            chunk =>
              chunk.rows.length > 0 &&
              chunk.rows.length <= CODE_GRAPH_CACHE_TRANSACTION_LIMITS.rows &&
              chunk.boundary.rowCount === chunk.rows.length &&
              chunk.boundary.finalFactBytes === chunk.rows.reduce((total, row) => total + row.payloadBytes, 0) &&
              chunk.boundary.finalFactBytes <= CODE_GRAPH_CACHE_TRANSACTION_LIMITS.payloadBytes,
          ),
        ).toBe(true);
        expect(batches.flatMap(batch => batch.files.map(file => file.path))).toEqual(inputPaths);
        expect(prepareMaterializedShardCacheBatchChunks(batches, '2026-08-23T00:00:00.000Z')).toEqual(chunks);
      }),
      {numRuns: 75},
    );
  });
});
