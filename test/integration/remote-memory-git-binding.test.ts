import {rm} from '../helpers/node-fs-promises.js';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import type {AuthorizedRemotePrincipal} from '../../src/remote_memory/authorization.js';
import {GitCanonicalMemoryStore} from '../../src/remote_memory/git_canonical_store.js';
import {PostgresRemoteControlPlane} from '../../src/remote_memory/postgres_control_plane.js';
import {PostgresRemoteMemoryRepository} from '../../src/remote_memory/postgres_repository.js';
import {RemoteMemoryIndexer} from '../../src/remote_memory/indexer.js';
import {RemoteHandoffRetentionWorker} from '../../src/remote_memory/handoff_retention.js';
import {createGitShareWorktreeFixture, type GitShareWorktreeFixture} from '../helpers/git-share-worktree.js';
import {
  createRemoteMemoryPostgresFixture,
  type RemoteMemoryPostgresFixture,
} from '../helpers/remote-memory-postgres.js';

const databaseUrl = process.env.THREADNOTE_TEST_POSTGRES_URL;
const postgresDescribe = databaseUrl ? describe.sequential : describe.skip;
const binding = {tenantId: 'tenant-owner', shareId: 'share-owner'};
const scopes = [
  binding,
  {tenantId: 'tenant-owner', shareId: 'share-sibling'},
  {tenantId: 'tenant-other', shareId: 'share-other'},
];
const capabilities = ['memory:read', 'memory:write:durable', 'memory:write:handoff'] as const;
const issuer = 'https://identity.binding.test';

postgresDescribe('organization Git deployment binding', () => {
  let fixture: RemoteMemoryPostgresFixture;
  let gitFixture: GitShareWorktreeFixture;
  let gitStore: GitCanonicalMemoryStore;
  let repository: PostgresRemoteMemoryRepository;
  const principals: AuthorizedRemotePrincipal[] = [];

  beforeAll(async () => {
    if (!databaseUrl) throw new Error('THREADNOTE_TEST_POSTGRES_URL is required.');
    fixture = await createRemoteMemoryPostgresFixture(databaseUrl);
    gitFixture = await createGitShareWorktreeFixture('threadnote-git-binding-');
    for (const scope of scopes) {
      await new PostgresRemoteControlPlane(fixture.migratorSql).provision({
        ...scope,
        principalId: `member-${scope.shareId}`,
        issuer,
        subject: `subject-${scope.shareId}`,
        displayName: 'Binding fixture',
        region: 'test',
        policyVersion: 'v1',
        projects: ['fixture'],
        allowedProjects: ['fixture'],
        capabilities,
        cursorAttestationRequired: false,
        featureFlags: [
          'remote_memory_ga',
          'remote_memory_read',
          'remote_memory_durable_write',
          'remote_memory_handoff_write',
        ],
      });
      const principal = await new PostgresRemoteControlPlane(fixture.sql).authorize(
        {
          issuer,
          subject: `subject-${scope.shareId}`,
          scopes: new Set(capabilities),
        },
        scope.shareId,
      );
      if (!principal) throw new Error('Fixture authorization failed.');
      principals.push(principal);
    }
    gitStore = new GitCanonicalMemoryStore({binding, worktree: gitFixture.worktree});
    repository = new PostgresRemoteMemoryRepository(fixture.sql, {gitStore});
  });

  afterAll(async () => {
    await fixture?.dispose();
    if (gitFixture) await rm(gitFixture.root, {recursive: true, force: true});
  });

  it('requires an explicit binding before a Git store can serve organization memory', () => {
    const unbound = new GitCanonicalMemoryStore({worktree: gitFixture.worktree});
    expect(() => new PostgresRemoteMemoryRepository(fixture.sql, {gitStore: unbound})).toThrow('binding');
    expect(() => new RemoteMemoryIndexer(fixture.sql, unbound)).toThrow('binding');
    expect(() => new RemoteHandoffRetentionWorker(fixture.sql, {gitStore: unbound})).toThrow('binding');
  });

  it('ingests one Git repository only into its bound tenant and share', async () => {
    await gitStore.commit({
      path: 'durable/projects/fixture/owned.md',
      content: 'Owned fixture memory.',
      message: 'fixture',
    });
    expect(await repository.ingestActiveGitShares('binding-ingest')).toMatchObject({ingested: 1});
    const databaseReader = new PostgresRemoteMemoryRepository(fixture.sql);
    for (const principal of principals) {
      const result = await databaseReader.list(principal, {limit: 10, project: 'fixture'}, 'binding-list');
      expect(result.entries).toHaveLength(principal.shareId === binding.shareId ? 1 : 0);
    }
  });

  it('rejects every repository entry point for an authorized but unrelated share', async () => {
    for (const principal of principals.slice(1)) {
      const uri = `threadnote://share/${principal.shareId}/durable/projects/fixture/owned.md`;
      const operations = [
        () => repository.status(principal, 'foreign-status'),
        () => repository.list(principal, {limit: 10}, 'foreign-list'),
        () => repository.read(principal, {version: 1, uri}, 'foreign-read'),
        () => repository.recall(principal, {version: 1, query: 'fixture', project: 'fixture'}, 'foreign-recall'),
        () => repository.ingestGitShare(principal, 'foreign-ingest'),
        () =>
          repository.remember(
            principal,
            {
              version: 1,
              kind: 'durable',
              project: 'fixture',
              topic: 'foreign',
              text: 'Must not land.',
              operationId: 'foreign-write',
            },
            'foreign-write',
          ),
        () =>
          repository.transitionHandoff(
            principal,
            {uri, baseRevision: 'foreign', operation: 'archive', operationId: 'foreign-transition'},
            'foreign-transition',
          ),
      ];
      for (const operation of operations) await expect(operation()).rejects.toMatchObject({code: 'forbidden'});
    }
  });

  it('does not project or expire another share through the bound workers', async () => {
    const databaseRepository = new PostgresRemoteMemoryRepository(fixture.sql);
    const now = new Date();
    for (const principal of principals.slice(1)) {
      await databaseRepository.remember(
        principal,
        {
          version: 1,
          kind: 'handoff',
          project: 'fixture',
          topic: 'foreign-worker',
          text: 'Foreign handoff.',
          operationId: 'foreign-worker',
          lifecycle: {expiresAt: new Date(now.getTime() + 60_000).toISOString()},
        },
        'foreign-worker',
        undefined,
        now,
      );
    }
    await new RemoteMemoryIndexer(fixture.sql, gitStore).runPass({ingest: false, batchSize: 64});
    await new RemoteHandoffRetentionWorker(fixture.sql, {gitStore}).runPass(64, new Date(now.getTime() + 120_000));
    for (const principal of principals.slice(1)) {
      const records = await databaseRepository.list(principal, {limit: 10, project: 'fixture'}, 'foreign-check');
      expect(records.entries).toHaveLength(1);
      expect(records.entries[0]?.status).toBe('active');
      const status = await databaseRepository.status(principal, 'foreign-status');
      expect(status.receipt.indexedGeneration).toBe(0);
    }
  });
});
