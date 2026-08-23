import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {CODE_GRAPH_CACHE_TRANSACTION_LIMITS} from '../../src/code_graph/cache_capacity.js';
import {codeGraphCacheWritePages, sameMaterializedShardWriteIds} from '../../src/code_graph/store_cache.js';

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
});
