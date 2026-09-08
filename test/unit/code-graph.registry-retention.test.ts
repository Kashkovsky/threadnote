import {describe, expect, it} from 'vitest';
import * as FC from 'effect/testing/FastCheck';
import {sha256Digest} from '../../src/code_graph/sharing/digest.js';
import {GRAPH_SHARE_OCI_EMPTY_CONFIG_DIGEST} from '../../src/code_graph/sharing/descriptor.js';
import {graphShareRegistryRetentionRoot} from '../../src/code_graph/sharing/registry_retention.js';

describe('registry retention inventory', () => {
  it('is order independent, deduplicated and non-mutating with exact byte totals', () => {
    FC.assert(
      FC.property(
        FC.array(FC.record({id: FC.integer({min: 0, max: 300}), size: FC.integer({min: 0, max: 1_048_576})}), {
          maxLength: 60,
        }),
        input => {
          const sizes = new Map(input.map(entry => [entry.id, entry.size]));
          const entries = [...sizes].map(([id, size]) => ({digest: sha256Digest(String(id)), size}));
          const before = JSON.stringify(entries);
          const first = graphShareRegistryRetentionRoot(entries);
          const reversed = graphShareRegistryRetentionRoot([...entries].reverse().concat(entries));
          expect(reversed.bytes).toEqual(first.bytes);
          expect(first.digest).toBe(sha256Digest(first.bytes));
          expect(first.totalBytes).toBe(2 + [...sizes.values()].reduce((sum, size) => sum + size, 0));
          expect(first.entries).toHaveLength(sizes.size + 1);
          expect(first.entries.some(entry => entry.digest === GRAPH_SHARE_OCI_EMPTY_CONFIG_DIGEST)).toBe(true);
          expect(JSON.stringify(entries)).toBe(before);
        },
      ),
      {numRuns: 60},
    );
  });

  it('rejects inconsistent sizes and cumulative limits without truncating the current artifact set', () => {
    const digest = sha256Digest('entry');
    expect(() =>
      graphShareRegistryRetentionRoot([
        {digest, size: 1},
        {digest, size: 2},
      ]),
    ).toThrow();
    expect(() => graphShareRegistryRetentionRoot([{digest, size: 33 * 1_048_576}])).toThrow();
    expect(() => graphShareRegistryRetentionRoot([{digest, size: -1}])).toThrow();
    expect(() => graphShareRegistryRetentionRoot([{digest: 'invalid', size: 1}])).toThrow();
    const tooLarge = Array.from({length: 129}, (_, n) => ({digest: sha256Digest(String(n)), size: 32 * 1_048_576}));
    expect(() => graphShareRegistryRetentionRoot(tooLarge)).toThrow();
    const tooMany = Array.from({length: 16_384}, (_, n) => ({digest: sha256Digest(String(n)), size: 0}));
    expect(() => graphShareRegistryRetentionRoot(tooMany)).toThrow();
  });
});
