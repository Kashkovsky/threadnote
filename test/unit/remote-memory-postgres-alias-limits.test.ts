import type {Sql} from 'postgres';
import {describe, expect, it} from 'vitest';
import {PostgresRemoteMemoryOperatorAdapter} from '../../src/remote_memory/operator_postgres.js';
import type {RemoteMemoryPortableRecordV1} from '../../src/remote_memory/portability.js';

describe('remote memory PostgreSQL alias admission limits', () => {
  // applyGitBetaImport is a Promise adapter boundary; the test deliberately
  // supplies a direct, runtime-forged caller and proves rejection precedes SQL.
  it('bounds nested alias shapes, counts, and aggregate bytes before database access', async () => {
    let sqlCalls = 0;
    const sql = (() => {
      sqlCalls += 1;
      throw new Error('SQL must not run for rejected input.');
    }) as unknown as Sql;
    const adapter = new PostgresRemoteMemoryOperatorAdapter(sql);

    await expect(adapter.applyGitBetaImport(input([record('shape', 'not-an-array' as never)]))).rejects.toThrow(
      'invalid record shape',
    );
    await expect(
      adapter.applyGitBetaImport(
        input([
          record(
            'per-record',
            Array.from({length: 17}, (_, index) => `a-${index}`),
          ),
        ]),
      ),
    ).rejects.toThrow('alias count limit');
    const unreadOversizedAliases = new Proxy(
      Array.from({length: 17}, () => 'unread'),
      {
        get(target, property, receiver) {
          if (typeof property === 'string' && /^\d+$/u.test(property)) {
            throw new Error('oversized alias elements must not be inspected');
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );
    await expect(adapter.applyGitBetaImport(input([record('ordered-count', unreadOversizedAliases)]))).rejects.toThrow(
      'alias count limit',
    );
    await expect(
      adapter.applyGitBetaImport(input([record('ordered-bytes', [`alias-${'a'.repeat(4097)}`])])),
    ).rejects.toThrow('alias is too long');
    await expect(
      adapter.applyGitBetaImport(
        input(
          Array.from({length: 626}, (_, recordIndex) =>
            record(
              `total-${recordIndex}`,
              Array.from({length: 16}, (_, aliasIndex) => `alias-${recordIndex}-${aliasIndex}`),
            ),
          ),
        ),
      ),
    ).rejects.toThrow('total alias count limit');
    await expect(
      adapter.applyGitBetaImport(
        input(
          Array.from({length: 44}, (_, recordIndex) =>
            record(
              `bytes-${recordIndex}`,
              Array.from({length: 16}, (_, aliasIndex) => `${recordIndex}-${aliasIndex}-${'€'.repeat(4_080)}`),
            ),
          ),
        ),
      ),
    ).rejects.toThrow('total alias size limit');

    expect(sqlCalls).toBe(0);
  });
});

function input(records: readonly RemoteMemoryPortableRecordV1[]) {
  return {
    aliasCompatibilityEndsAt: new Date(Date.now() + 86_400_000).toISOString(),
    planDigest: 'a'.repeat(64),
    planId: `tnmi_${'b'.repeat(32)}`,
    records,
    shareId: 'share-1',
  };
}

function record(topic: string, aliases: readonly string[]): RemoteMemoryPortableRecordV1 {
  return {
    aliases,
    canonicalContent: '',
    contentHash: 'c'.repeat(64),
    kind: 'durable',
    project: 'threadnote',
    topic,
    uri: `threadnote://remote/share-1/memories/durable/projects/threadnote/${topic}.md`,
    version: 1,
  };
}
