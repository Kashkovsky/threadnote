import {describe, expect, it} from 'vitest';
import {rm} from '../helpers/node-fs-promises.js';
import {createGitShareWorktreeFixture} from '../helpers/git-share-worktree.js';
import {createRemoteMemoryPostgresFixture} from '../helpers/remote-memory-postgres.js';
import {GitCanonicalMemoryStore} from '../../src/remote_memory/git_canonical_store.js';
import {PostgresRemoteControlPlane} from '../../src/remote_memory/postgres_control_plane.js';
import {PostgresRemoteMemoryRepository} from '../../src/remote_memory/postgres_repository.js';
import {RemoteMemoryIndexer} from '../../src/remote_memory/indexer.js';

const DATABASE = process.env.THREADNOTE_TEST_POSTGRES_URL;
const postgresDescribe = DATABASE ? describe : describe.skip;

async function fixture() {
  const database = await createRemoteMemoryPostgresFixture(DATABASE!);
  const git = await createGitShareWorktreeFixture();
  const operator = new PostgresRemoteControlPlane(database.migratorSql);
  const input = {
    tenantId: 'authority',
    shareId: 'authority-share',
    principalId: 'member',
    issuer: 'https://authority.test',
    subject: 'member',
    displayName: 'Authority test',
    region: 'test',
    policyVersion: 'v1',
    capabilities: ['memory:read', 'memory:write:durable'] as const,
    allowedProjects: ['restricted'],
    projects: ['restricted'],
    cursorAttestationRequired: false,
    featureFlags: ['remote_memory_read', 'remote_memory_durable_write', 'remote_memory_ga'] as const,
  };
  await operator.provision(input);
  const store = new GitCanonicalMemoryStore({
    binding: {tenantId: input.tenantId, shareId: input.shareId},
    worktree: git.worktree,
  });
  const repository = new PostgresRemoteMemoryRepository(database.sql, {gitStore: store});
  return {
    database,
    git,
    input,
    operator,
    repository,
    store,
    dispose: async () => {
      await database.dispose();
      await rm(git.root, {recursive: true, force: true});
    },
  };
}

postgresDescribe('Git ingest system authority', () => {
  it('keeps readiness failed until a failed Git ingest actually recovers', async () => {
    const f = await fixture();
    try {
      const indexer = new RemoteMemoryIndexer(f.database.sql, f.store);
      const setStatus = async (status: 'active' | 'revoked') =>
        f.database.migratorSql.begin(async tx => {
          await tx`SELECT set_config('threadnote.tenant_id', ${f.input.tenantId}, true)`;
          await tx`UPDATE remote_memory.share_grants SET status = ${status} WHERE principal_id LIKE 'system:git-ingest:%'`;
        });
      const health = async () =>
        (
          await f.database.sql<
            {failure_class: string | null}[]
          >`SELECT failure_class FROM remote_memory.worker_health WHERE worker_name = 'indexer'`
        )[0]?.failure_class;
      await setStatus('revoked');
      expect(await indexer.runPass()).toEqual({failed: 1, processed: 0});
      expect(await health()).toBe('git_ingest_failed');
      await indexer.runPass({ingest: false});
      expect(await health()).toBe('git_ingest_failed');
      await setStatus('active');
      await indexer.runPass({ingest: false});
      expect(await health()).toBe('git_ingest_failed');
      expect(await indexer.runPass()).toEqual({failed: 0, processed: 0});
      expect(await health()).toBeNull();
    } finally {
      await f.dispose();
    }
  });

  it('rejects HTTP body replacement that would erase metadata from Git', async () => {
    const f = await fixture();
    try {
      const path = 'durable/projects/restricted/rich.md';
      const content =
        'MEMORY\nkind: durable\nstatus: active\nproject: restricted\ntopic: rich\nkeywords: retained-keyword\n\nRetain the original body.';
      const committed = await f.store.commit({path, content, message: 'Rich Git memory'});
      await f.repository.ingestActiveGitShares('rich-ingest');
      const principal = await new PostgresRemoteControlPlane(f.database.sql).authorize(
        {issuer: f.input.issuer, subject: f.input.subject, scopes: new Set(f.input.capabilities)},
        f.input.shareId,
      );
      if (!principal) throw new Error('Fixture principal missing');
      const uri = `threadnote://share/${f.input.shareId}/memories/durable/restricted/rich.md`;
      const original = await f.repository.read(principal, {version: 1, uri}, 'read-rich');
      await expect(
        f.repository.remember(
          principal,
          {
            version: 1,
            kind: 'durable',
            project: 'restricted',
            topic: 'rich',
            text: 'Changed body',
            operationId: 'replace-rich',
            baseRevision: original.receipt.revision,
          },
          'replace-rich',
        ),
      ).rejects.toMatchObject({code: 'invalid_request', details: {reason: 'unsupported_remote_metadata'}});
      expect((await f.store.listCanonicalPaths()).find(entry => entry.gitPath === path)?.gitCommit).toBe(
        committed.gitCommit,
      );
      expect(await f.store.read({commit: committed.gitCommit, path})).toBe(content);
    } finally {
      await f.dispose();
    }
  });

  it('projects canonical Git independently of member order, scopes, and revocation', async () => {
    const f = await fixture();
    try {
      for (const member of ['aaa-member', 'zzz-member']) {
        await f.operator.provision({...f.input, principalId: member, subject: member});
      }
      for (const phase of ['active', 'revoked']) {
        if (phase === 'revoked')
          await f.database.migratorSql.begin(async tx => {
            await tx`SELECT set_config('threadnote.tenant_id', ${f.input.tenantId}, true)`;
            await tx`UPDATE remote_memory.tenant_memberships SET status = 'revoked' WHERE principal_id NOT LIKE 'system:%'`;
          });
        await f.store.commit({
          path: `durable/projects/canonical/${phase}.md`,
          content: `Canonical ${phase} body.`,
          message: 'Git authority fixture',
        });
        expect((await f.repository.ingestActiveGitShares(`ingest-${phase}`)).ingested).toBe(1);
      }
      const actors = await f.database.migratorSql.begin(async tx => {
        await tx`SELECT set_config('threadnote.tenant_id', ${f.input.tenantId}, true)`;
        return tx<{oauth_principal_id: string}[]>`SELECT oauth_principal_id FROM remote_memory.memory_revisions`;
      });
      expect(actors).toHaveLength(2);
      for (const actor of actors) expect(actor.oauth_principal_id).toMatch(/^system:git-ingest:/u);
    } finally {
      await f.dispose();
    }
  });

  it('fails closed when the provisioned ingest identity is missing or revoked', async () => {
    const f = await fixture();
    try {
      await f.database.migratorSql.begin(async tx => {
        await tx`SELECT set_config('threadnote.tenant_id', ${f.input.tenantId}, true)`;
        await tx`UPDATE remote_memory.share_grants SET status = 'revoked' WHERE principal_id LIKE 'system:git-ingest:%'`;
      });
      await expect(f.repository.ingestActiveGitShares('revoked-system')).rejects.toMatchObject({
        code: 'service_unavailable',
        details: {reason: 'git_ingest_identity_unavailable'},
      });
      await f.operator.provision(f.input);
      await expect(f.repository.ingestActiveGitShares('still-revoked')).rejects.toMatchObject({
        code: 'service_unavailable',
      });
    } finally {
      await f.dispose();
    }
  });
});
