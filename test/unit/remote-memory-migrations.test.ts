import type {Sql} from 'postgres';
import {describe, expect, it} from 'vitest';
import * as FC from 'effect/testing/FastCheck';
import {dirname, join} from '../helpers/node-path.js';
import {migrateRemoteMemoryDatabase, standaloneMigrationFilePath} from '../../src/remote_memory/migrations.js';

interface FakeMigrationOptions {
  readonly conflictingChecksum?: string;
  readonly failSource?: boolean;
}

const appliedMigrationCycle = ['lookup', 'begin', 'migration', 'record', 'verify', 'commit'] as const;

function fakeMigrationSql(options: FakeMigrationOptions = {}): {readonly events: string[]; readonly sql: Sql} {
  const events: string[] = [];
  const recordedChecksums = new Map<number, string>();
  const checksumLookups = new Map<number, number>();
  let appliedBootstrap = false;

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
        const version = Number(values[0]);
        const lookups = checksumLookups.get(version) ?? 0;
        checksumLookups.set(version, lookups + 1);
        events.push(lookups === 0 ? 'lookup' : 'verify');
        const checksum = recordedChecksums.get(version);
        return checksum === undefined ? [] : [{checksum}];
      }
      if (query.includes('INSERT INTO remote_memory.schema_migrations')) {
        events.push('record');
        recordedChecksums.set(Number(values[0]), options.conflictingChecksum ?? String(values[1]));
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
        if (!appliedBootstrap) {
          appliedBootstrap = true;
          events.push('bootstrap');
          return [];
        }
        events.push('migration');
        if (options.failSource) throw new Error('migration source failed');
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
      ...appliedMigrationCycle,
      ...appliedMigrationCycle,
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

  it('resolves standalone migrations beside the compiled executable instead of bunfs', () => {
    const executableRoot = FC.array(FC.stringMatching(/^[a-z][a-z0-9-]{0,12}$/u), {minLength: 1, maxLength: 4});
    const migrationName = FC.constantFrom('001_initial.sql', '002_git_canonical_pointers.sql');
    FC.assert(
      FC.property(executableRoot, migrationName, (segments, name) => {
        const executablePath = join('/', ...segments, 'threadnote');
        const resolved = standaloneMigrationFilePath(executablePath, name);
        expect(resolved).toBe(join(dirname(executablePath), 'remote-memory', 'migrations', name));
        expect(resolved).not.toContain('bunfs');
      }),
    );
    expect(() => standaloneMigrationFilePath('/opt/threadnote/threadnote', '../001_initial.sql')).toThrow(
      'migration file name is invalid',
    );
  });
});
