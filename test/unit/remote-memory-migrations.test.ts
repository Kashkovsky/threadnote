import type {Sql} from 'postgres';
import {describe, expect, it} from 'vitest';
import {migrateRemoteMemoryDatabase} from '../../src/remote_memory/migrations.js';

interface FakeMigrationOptions {
  readonly conflictingChecksum?: string;
  readonly failSource?: boolean;
}

function fakeMigrationSql(options: FakeMigrationOptions = {}): {readonly events: string[]; readonly sql: Sql} {
  const events: string[] = [];
  let recordedChecksum: string | undefined;
  let checksumLookupCount = 0;

  const connection = Object.assign(
    async (parts: TemplateStringsArray, ...values: readonly unknown[]): Promise<readonly unknown[]> => {
      const query = parts.join('?');
      if (query.includes('pg_advisory_unlock')) {
        events.push('unlock');
        return [];
      }
      if (query.includes('pg_advisory_lock')) {
        events.push('lock');
        return [];
      }
      if (query.includes('SELECT checksum FROM remote_memory.schema_migrations')) {
        events.push(checksumLookupCount++ === 0 ? 'lookup' : 'verify');
        return recordedChecksum === undefined ? [] : [{checksum: recordedChecksum}];
      }
      if (query.includes('INSERT INTO remote_memory.schema_migrations')) {
        events.push('record');
        recordedChecksum = options.conflictingChecksum ?? String(values[1]);
        return [];
      }
      throw new Error(`Unexpected tagged migration query: ${query}`);
    },
    {
      release: (): void => {
        events.push('release');
      },
      unsafe: async (query: string): Promise<readonly unknown[]> => {
        if (query === 'BEGIN' || query === 'COMMIT' || query === 'ROLLBACK') {
          events.push(query.toLowerCase());
          return [];
        }
        if (query.includes('CREATE TABLE remote_memory.tenants')) {
          events.push('migration');
          if (options.failSource) throw new Error('migration source failed');
          return [];
        }
        events.push('bootstrap');
        return [];
      },
    },
  );
  const sql = {
    reserve: async () => connection,
  } as unknown as Sql;
  return {events, sql};
}

describe('remote memory PostgreSQL migrations', () => {
  it('applies and records a migration atomically on a reserved connection', async () => {
    const fixture = fakeMigrationSql();

    await migrateRemoteMemoryDatabase(fixture.sql);

    expect(fixture.events).toEqual([
      'lock',
      'bootstrap',
      'lookup',
      'begin',
      'migration',
      'record',
      'verify',
      'commit',
      'unlock',
      'release',
    ]);
  });

  it('rolls back a failed migration before unlocking and releasing the connection', async () => {
    const fixture = fakeMigrationSql({failSource: true});

    await expect(migrateRemoteMemoryDatabase(fixture.sql)).rejects.toThrow('migration source failed');

    expect(fixture.events).toEqual([
      'lock',
      'bootstrap',
      'lookup',
      'begin',
      'migration',
      'rollback',
      'unlock',
      'release',
    ]);
  });

  it('rolls back when a concurrent migration record has a different checksum', async () => {
    const fixture = fakeMigrationSql({conflictingChecksum: 'changed-after-check'});

    await expect(migrateRemoteMemoryDatabase(fixture.sql)).rejects.toMatchObject({
      code: 'service_unavailable',
      message: 'Remote memory migration 1 changed while applying.',
    });

    expect(fixture.events).toEqual([
      'lock',
      'bootstrap',
      'lookup',
      'begin',
      'migration',
      'record',
      'verify',
      'rollback',
      'unlock',
      'release',
    ]);
  });
});
