import postgres from 'postgres';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import * as FC from 'effect/testing/FastCheck';
import {
  createRemoteMemoryPostgresFixture,
  type RemoteMemoryPostgresFixture,
} from '../helpers/remote-memory-postgres.js';
import {assertRemoteMemoryRuntimePrivileges} from '../../src/remote_memory/runtime_privileges.js';
import {PostgresRemoteMemoryOperatorAdapter} from '../../src/remote_memory/operator_postgres.js';

const databaseUrl = process.env.THREADNOTE_TEST_POSTGRES_URL;
const postgresDescribe = databaseUrl ? describe.sequential : describe.skip;
const excessGrants = [
  'UPDATE (status) ON remote_memory.shares',
  'SELECT ON remote_memory.audit_events',
  'UPDATE ON remote_memory.share_grants',
  'DELETE ON remote_memory.memory_revisions',
  'TRUNCATE ON remote_memory.memory_heads',
  'INSERT ON remote_memory.external_identities',
] as const;

postgresDescribe('remote runtime database privilege preflight', () => {
  let fixture: RemoteMemoryPostgresFixture;
  let admin: ReturnType<typeof postgres>;
  beforeAll(async () => {
    fixture = await createRemoteMemoryPostgresFixture(databaseUrl!);
    admin = postgres(databaseUrl!, {max: 1, onnotice: () => undefined});
    const grants = (await Bun.file('deploy/remote-memory/grants/001-runtime.sql').text())
      .replace(/^\\set .*$/gm, '')
      .replaceAll('threadnote_remote_runtime', fixture.runtimeRoleName);
    await fixture.migratorSql.unsafe(grants);
  });
  afterAll(async () => {
    await admin?.end({timeout: 5});
    await fixture?.dispose();
  });

  it('accepts the deployed table/column allowlist and reports every applied migration', async () => {
    await expect(assertRemoteMemoryRuntimePrivileges(fixture.sql)).resolves.toBeUndefined();
    const receipt = await new PostgresRemoteMemoryOperatorAdapter(fixture.migratorSql).migrateSchema();
    expect(receipt.readyVersions).toEqual([1, 2]);
  });

  it('rejects the schema owner and the bootstrap superuser', async () => {
    await expect(assertRemoteMemoryRuntimePrivileges(fixture.migratorSql)).rejects.toMatchObject({
      code: 'service_unavailable',
    });
    await expect(assertRemoteMemoryRuntimePrivileges(admin)).rejects.toMatchObject({code: 'service_unavailable'});
  });

  it.each(['role', 'session_authorization', 'overridden-user'])(
    'rejects privileged authentication hidden by %s',
    async disguise => {
      const url = new URL(databaseUrl!);
      url.pathname = `/${fixture.databaseName}`;
      if (disguise === 'overridden-user') {
        url.searchParams.set('user', decodeURIComponent(url.username));
        url.username = fixture.runtimeRoleName;
      }
      url.searchParams.set('role', fixture.runtimeRoleName);
      const disguised = postgres(url.toString(), {max: 1, onnotice: () => undefined});
      try {
        if (disguise !== 'role') await disguised.unsafe(`SET SESSION AUTHORIZATION ${fixture.runtimeRoleName}`);
        const [identity] = await disguised`SELECT current_user AS name, session_user AS session_name`;
        expect(identity.name).toBe(fixture.runtimeRoleName);
        if (disguise !== 'role') expect(identity.session_name).toBe(fixture.runtimeRoleName);
        await expect(assertRemoteMemoryRuntimePrivileges(disguised)).rejects.toMatchObject({
          code: 'service_unavailable',
        });
      } finally {
        await disguised.end({timeout: 5});
      }
    },
  );

  it.each(['SET', 'ALTER SYSTEM'])('rejects %s parameter authority', async privilege => {
    try {
      await admin.unsafe(`GRANT ${privilege} ON PARAMETER session_replication_role TO ${fixture.runtimeRoleName}`);
      await expect(assertRemoteMemoryRuntimePrivileges(fixture.sql)).rejects.toMatchObject({
        code: 'service_unavailable',
      });
    } finally {
      await admin.unsafe(`REVOKE ${privilege} ON PARAMETER session_replication_role FROM ${fixture.runtimeRoleName}`);
    }
    await expect(assertRemoteMemoryRuntimePrivileges(fixture.sql)).resolves.toBeUndefined();
  });

  it('rejects a trigger-disabling role default even without a parameter grant', async () => {
    let unsafe: ReturnType<typeof postgres> | undefined;
    try {
      await admin.unsafe(`ALTER ROLE ${fixture.runtimeRoleName} SET session_replication_role = replica`);
      unsafe = postgres(fixture.runtimeDatabaseUrl, {max: 1, onnotice: () => undefined});
      const [setting] = await unsafe`SELECT current_setting('session_replication_role') AS value`;
      expect(setting.value).toBe('replica');
      await expect(assertRemoteMemoryRuntimePrivileges(unsafe)).rejects.toMatchObject({code: 'service_unavailable'});
    } finally {
      await unsafe?.end({timeout: 5});
      await admin.unsafe(`ALTER ROLE ${fixture.runtimeRoleName} RESET session_replication_role`);
    }
  });

  it('rejects missing write permissions before accepting traffic', async () => {
    try {
      await fixture.migratorSql.unsafe(
        `REVOKE INSERT ON remote_memory.memory_revisions FROM ${fixture.runtimeRoleName}`,
      );
      await expect(assertRemoteMemoryRuntimePrivileges(fixture.sql)).rejects.toMatchObject({
        code: 'service_unavailable',
      });
    } finally {
      await fixture.migratorSql.unsafe(`GRANT INSERT ON remote_memory.memory_revisions TO ${fixture.runtimeRoleName}`);
    }
  });

  it('rejects every bounded combination of excess runtime grants', async () => {
    await FC.assert(
      FC.asyncProperty(FC.uniqueArray(FC.constantFrom(...excessGrants), {minLength: 1, maxLength: 3}), async grants => {
        try {
          for (const grant of grants) await fixture.migratorSql.unsafe(`GRANT ${grant} TO ${fixture.runtimeRoleName}`);
          await expect(assertRemoteMemoryRuntimePrivileges(fixture.sql)).rejects.toMatchObject({
            code: 'service_unavailable',
          });
        } finally {
          for (const grant of grants)
            await fixture.migratorSql.unsafe(`REVOKE ${grant} FROM ${fixture.runtimeRoleName}`);
        }
        await expect(assertRemoteMemoryRuntimePrivileges(fixture.sql)).resolves.toBeUndefined();
      }),
      {numRuns: 10},
    );
  });

  it.each(['CREATEROLE', 'CREATEDB', 'BYPASSRLS', 'REPLICATION'])('rejects runtime %s authority', async attribute => {
    try {
      await admin.unsafe(`ALTER ROLE ${fixture.runtimeRoleName} ${attribute}`);
      await expect(assertRemoteMemoryRuntimePrivileges(fixture.sql)).rejects.toMatchObject({
        code: 'service_unavailable',
      });
    } finally {
      await admin.unsafe(`ALTER ROLE ${fixture.runtimeRoleName} NO${attribute}`);
    }
  });

  it.each(['pg_write_all_data', 'pg_read_all_data', 'pg_read_server_files'])(
    'rejects a role it can assume: %s',
    async role => {
      try {
        await admin.unsafe(`GRANT ${role} TO ${fixture.runtimeRoleName} WITH INHERIT FALSE, SET TRUE`);
        await expect(assertRemoteMemoryRuntimePrivileges(fixture.sql)).rejects.toMatchObject({
          code: 'service_unavailable',
        });
      } finally {
        await admin.unsafe(`REVOKE ${role} FROM ${fixture.runtimeRoleName}`);
      }
    },
  );

  it('rejects delegation of an otherwise allowed column privilege', async () => {
    try {
      await fixture.migratorSql.unsafe(
        `GRANT UPDATE (share_generation) ON remote_memory.shares TO ${fixture.runtimeRoleName} WITH GRANT OPTION`,
      );
      await expect(assertRemoteMemoryRuntimePrivileges(fixture.sql)).rejects.toMatchObject({
        code: 'service_unavailable',
      });
    } finally {
      await fixture.migratorSql.unsafe(
        `REVOKE GRANT OPTION FOR UPDATE (share_generation) ON remote_memory.shares FROM ${fixture.runtimeRoleName}`,
      );
    }
  });
});
