import {describe, expect, it} from '@effect/vitest';
import fc from 'fast-check';
import {
  CODE_GRAPH_CACHE_TRANSACTION_LIMITS,
  codeGraphFileBlobCapacityBytes,
  codeGraphMaterializedShardCapacityBytes,
  planCodeGraphCacheCapacityChunks,
} from '../../src/code_graph/cache_capacity.js';

describe('code graph persistent cache capacity planning', () => {
  it.prop(
    'counts exact SQLite UTF-8 payload bytes for cache rows',
    {
      values: fc.array(fc.integer({max: 0xffff, min: 0}), {maxLength: 80}),
    },
    ({values}) => {
      const unicode = String.fromCharCode(...values);
      const encoder = new TextEncoder();
      const fields = {
        blobId: `blob-${unicode}`,
        contentHash: `hash-${unicode}`,
        createdAt: '2026-08-09T00:00:00.000Z',
        derivationIdentity: `derivation-${unicode}`,
        extractorSet: `extractor-${unicode}`,
        factsJson: JSON.stringify({path: unicode}),
        id: `cgfs_${unicode}`,
        lastUsedAt: '2026-08-09T00:00:00.000Z',
        path: `packages/${unicode}.ts`,
        reuseClass: `reuse-${unicode}`,
      };
      const independent = (...parts: readonly string[]) =>
        parts.reduce((total, part) => total + encoder.encode(part).byteLength, 0);

      expect(codeGraphFileBlobCapacityBytes(fields)).toBe(
        independent(
          fields.blobId,
          fields.contentHash,
          fields.extractorSet,
          fields.path,
          fields.factsJson,
          fields.createdAt,
          fields.reuseClass,
          fields.extractorSet,
          fields.path,
          fields.contentHash,
          fields.blobId,
          fields.reuseClass,
        ),
      );
      expect(codeGraphMaterializedShardCapacityBytes(fields)).toBe(
        independent(
          fields.id,
          fields.contentHash,
          fields.extractorSet,
          fields.derivationIdentity,
          fields.path,
          fields.factsJson,
          fields.createdAt,
          fields.lastUsedAt,
        ),
      );
    },
    {fastCheck: {numRuns: 300}},
  );

  it.prop(
    'canonically partitions cache mutations by both row and payload ceilings',
    {
      rows: fc.array(fc.integer({max: 512 * 1_024, min: 1}), {maxLength: 1_500}).map(payloads =>
        payloads.map((payloadBytes, index) => ({
          key: `row-${index.toString().padStart(4, '0')}`,
          payloadBytes,
        })),
      ),
    },
    ({rows}) => {
      const operation = 'cache code graph file facts' as const;
      const planned = planCodeGraphCacheCapacityChunks(operation, rows);
      const reversed = planCodeGraphCacheCapacityChunks(operation, [...rows].reverse());
      const canonical = [...rows].sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));

      expect(planned).toEqual(reversed);
      expect(planned.flatMap(chunk => chunk.rows)).toEqual(canonical);
      for (const chunk of planned) {
        expect(chunk.rows.length).toBeGreaterThan(0);
        expect(chunk.boundary.rowCount).toBe(chunk.rows.length);
        expect(chunk.boundary.rowCount).toBeLessThanOrEqual(CODE_GRAPH_CACHE_TRANSACTION_LIMITS.rows);
        expect(chunk.boundary.finalFactBytes).toBe(chunk.rows.reduce((total, row) => total + row.payloadBytes, 0));
        expect(chunk.boundary.finalFactBytes).toBeLessThanOrEqual(CODE_GRAPH_CACHE_TRANSACTION_LIMITS.payloadBytes);
      }
    },
    {fastCheck: {numRuns: 100}},
  );

  it('keeps a 73k small-row cache plan to the exact 143-transaction structural ceiling', () => {
    const chunks = planCodeGraphCacheCapacityChunks(
      'cache code graph file facts',
      Array.from({length: 73_000}, (_, index) => ({
        key: `src/file-${index.toString().padStart(5, '0')}.ts`,
        payloadBytes: 256,
      })),
    );

    expect(chunks).toHaveLength(143);
    expect(chunks.slice(0, -1).every(chunk => chunk.boundary.rowCount === 512)).toBe(true);
    expect(chunks.at(-1)?.boundary.rowCount).toBe(296);
  });

  it('rejects an oversized singleton without returning a transaction plan', () => {
    expect(() =>
      planCodeGraphCacheCapacityChunks('cache materialized code graph file shards', [
        {key: 'oversized', payloadBytes: CODE_GRAPH_CACHE_TRANSACTION_LIMITS.payloadBytes + 1},
      ]),
    ).toThrow(/payload ceiling/u);
  });
});
