import {mkdir, rm, writeFile} from '../helpers/node-fs-promises.js';
import {dirname, join} from '../helpers/node-path.js';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import type {Sql, TransactionSql} from 'postgres';
import {formatRemoteMemoryUri} from '../../src/memory_domain/address.js';
import {formatMemoryDocument} from '../../src/memory/document.js';
import type {RemoteRememberInputV1} from '../../src/memory_domain/contracts.js';
import type {AuthorizedRemotePrincipal, RemoteMemoryScope} from '../../src/remote_memory/authorization.js';
import {GitCanonicalMemoryStore, gitCanonicalSharePath} from '../../src/remote_memory/git_canonical_store.js';
import type {OAuthPrincipalClaims} from '../../src/remote_memory/oauth.js';
import {PostgresRemoteControlPlane} from '../../src/remote_memory/postgres_control_plane.js';
import {PostgresRemoteMemoryRepository} from '../../src/remote_memory/postgres_repository.js';
import {RemoteMemoryIndexer} from '../../src/remote_memory/indexer.js';
import {
  cloneGitShareWorktree,
  createGitShareWorktreeFixture,
  git,
  type GitShareWorktreeFixture,
} from '../helpers/git-share-worktree.js';
import {
  createRemoteMemoryPostgresFixture,
  type RemoteMemoryPostgresFixture,
} from '../helpers/remote-memory-postgres.js';

const TEST_DATABASE_URL = process.env.THREADNOTE_TEST_POSTGRES_URL;
const postgresDescribe = TEST_DATABASE_URL ? describe.sequential : describe.skip;
const ISSUER = 'https://identity.git-composer.test';
const PROJECT = 'threadnote';
const TENANT = 'tenant-git';
const SHARE = 'share-git';
const PRINCIPAL = 'principal-git';
const ALL_SCOPES = [
  'memory:read',
  'memory:write:durable',
  'memory:write:handoff',
] as const satisfies readonly RemoteMemoryScope[];

postgresDescribe('git-backed remote memory composer', () => {
  let fixture: RemoteMemoryPostgresFixture;
  let gitFixture: GitShareWorktreeFixture;
  let repository: PostgresRemoteMemoryRepository;
  let indexer: RemoteMemoryIndexer;
  let principal: AuthorizedRemotePrincipal;

  beforeAll(async () => {
    if (!TEST_DATABASE_URL) throw new Error('THREADNOTE_TEST_POSTGRES_URL is required.');
    fixture = await createRemoteMemoryPostgresFixture(TEST_DATABASE_URL);
    gitFixture = await createGitShareWorktreeFixture('threadnote-git-composer-');
    const operator = new PostgresRemoteControlPlane(fixture.migratorSql);
    await operator.provision({
      allowedProjects: [PROJECT],
      capabilities: ALL_SCOPES,
      cursorAttestationRequired: false,
      cursorSubjects: ['user:9001'],
      displayName: 'Git composer share',
      featureFlags: [
        'remote_memory_read',
        'remote_memory_durable_write',
        'remote_memory_handoff_write',
        'remote_memory_ga',
      ],
      issuer: ISSUER,
      policyVersion: 'policy-v1',
      principalId: PRINCIPAL,
      projects: [PROJECT],
      region: 'test-region',
      repositoryBindings: {[PROJECT]: ['https://github.com/example/threadnote-git.git']},
      shareId: SHARE,
      subject: 'subject-git',
      tenantId: TENANT,
    });
    const gitStore = new GitCanonicalMemoryStore({worktree: gitFixture.worktree});
    repository = new PostgresRemoteMemoryRepository(fixture.sql, {gitStore});
    indexer = new RemoteMemoryIndexer(fixture.sql, gitStore);
    const authorized = await new PostgresRemoteControlPlane(fixture.sql).authorize(claims(), SHARE);
    if (!authorized) throw new Error('Git composer fixture authorization failed.');
    principal = authorized;
  });

  afterAll(async () => {
    await fixture?.dispose();
    if (gitFixture) await rm(gitFixture.root, {force: true, recursive: true});
  });

  it('writes a cloud remember to git without storing a postgres canonical body', async () => {
    const created = await repository.remember(
      principal,
      rememberInput({operationId: 'git-create', text: 'Composer wrote this for the laptop.', topic: 'git-roundtrip'}),
      'request-git-create',
    );
    const read = await repository.read(principal, {uri: created.uri!, version: 1}, 'request-git-read');
    expect(read.content).toContain('Composer wrote this for the laptop.');
    const stored = await withTenant(
      fixture.sql,
      TENANT,
      transaction =>
        transaction<{git_commit: string | null; git_path: string | null; markdown_body: string}[]>`
        SELECT markdown_body, git_commit, git_path
        FROM remote_memory.memory_revisions
        WHERE id = ${created.revision!}
      `,
    );
    expect(stored).toEqual([
      {
        git_commit: expect.stringMatching(/^[0-9a-f]{40,64}$/u),
        git_path: gitCanonicalSharePath('durable', PROJECT, 'git-roundtrip'),
        markdown_body: '',
      },
    ]);
    const pointer = stored[0];
    expect(pointer).toBeDefined();
    const laptop = join(gitFixture.root, 'laptop');
    await cloneGitShareWorktree(gitFixture.remote, laptop);
    expect(await git(['show', `HEAD:${pointer.git_path}`], laptop)).toBe(read.content);
  });

  it('rejects one of two concurrent composer writes and keeps a single winner', async () => {
    const created = await repository.remember(
      principal,
      rememberInput({
        operationId: 'git-concurrent-base',
        text: 'Concurrent base body.',
        topic: 'git-concurrent',
      }),
      'request-git-concurrent-base',
    );
    const contenders = await Promise.allSettled([
      repository.remember(
        principal,
        rememberInput({
          baseRevision: created.revision,
          operationId: 'git-contender-a',
          text: 'Alpha overlayneedle from composer.',
          topic: 'git-concurrent',
        }),
        'request-git-contender-a',
      ),
      repository.remember(
        principal,
        rememberInput({
          baseRevision: created.revision,
          operationId: 'git-contender-b',
          text: 'Beta overlayneedle from composer.',
          topic: 'git-concurrent',
        }),
        'request-git-contender-b',
      ),
    ]);
    const winner = contenders.find(result => result.status === 'fulfilled');
    const loser = contenders.find(result => result.status === 'rejected');
    expect(winner?.status).toBe('fulfilled');
    expect(loser?.status).toBe('rejected');
    if (loser?.status !== 'rejected') throw new Error('expected a rejected concurrent remember');
    expect(loser.reason).toMatchObject({code: 'conflict'});
    const read = await repository.read(principal, {uri: created.uri!, version: 1}, 'request-git-concurrent-read');
    expect(
      read.content.includes('Alpha overlayneedle from composer.') ||
        read.content.includes('Beta overlayneedle from composer.'),
    ).toBe(true);
    expect(await indexer.runPass({batchSize: 8})).toMatchObject({failed: 0});
    const recalled = await repository.recall(
      principal,
      {project: PROJECT, query: 'overlayneedle', version: 1},
      'request-git-recall',
    );
    expect(recalled.results.some(result => result.topic === 'git-concurrent')).toBe(true);
  });

  it('indexes a laptop git publish without copying the body into postgres', async () => {
    const topic = 'laptop-publish';
    const path = gitCanonicalSharePath('durable', PROJECT, topic);
    const laptop = join(gitFixture.root, 'laptop-writer');
    await cloneGitShareWorktree(gitFixture.remote, laptop);
    const content = formatMemoryDocument(
      'MEMORY',
      {
        kind: 'durable',
        project: PROJECT,
        sourceAgentClient: 'share',
        status: 'active',
        timestamp: '2026-09-04T12:00:00.000Z',
        topic,
        visibility: 'shared',
      },
      'Laptop share publish reached the composer.',
    );
    const target = join(laptop, ...path.split('/'));
    await mkdir(dirname(target), {recursive: true});
    await writeFile(target, content, 'utf8');
    await git(['add', '--', path], laptop);
    await git(['commit', '-m', 'laptop publish'], laptop);
    await git(['push', 'origin', 'main'], laptop);

    const otherPath = gitCanonicalSharePath('durable', 'other-project', 'ignored');
    const otherTarget = join(laptop, ...otherPath.split('/'));
    await mkdir(dirname(otherTarget), {recursive: true});
    await writeFile(
      otherTarget,
      formatMemoryDocument(
        'MEMORY',
        {
          kind: 'durable',
          project: 'other-project',
          sourceAgentClient: 'share',
          status: 'active',
          timestamp: '2026-09-04T12:00:00.000Z',
          topic: 'ignored',
          visibility: 'shared',
        },
        'Unauthorized project must be skipped.',
      ),
      'utf8',
    );
    await git(['add', '--', otherPath], laptop);
    await git(['commit', '-m', 'unauthorized project'], laptop);
    await git(['push', 'origin', 'main'], laptop);

    expect(await indexer.runPass({batchSize: 8})).toMatchObject({failed: 0});
    const uri = formatRemoteMemoryUri({kind: 'durable', project: PROJECT, shareId: SHARE, topic});
    const read = await repository.read(principal, {uri, version: 1}, 'request-git-ingest-read');
    expect(read.content).toContain('Laptop share publish reached the composer.');
    const stored = await withTenant(
      fixture.sql,
      TENANT,
      transaction =>
        transaction<{markdown_body: string; topic: string}[]>`
        SELECT r.markdown_body, h.topic FROM remote_memory.memory_revisions r
        JOIN remote_memory.memory_heads h
          ON h.tenant_id = r.tenant_id AND h.share_id = r.share_id AND h.current_revision_id = r.id
        WHERE h.topic = ${topic} OR h.topic = 'ignored'
        ORDER BY h.topic
      `,
    );
    expect(stored).toEqual([{markdown_body: '', topic}]);
  });

  it('does not resurrect a terminal handoff during git ingest', async () => {
    const created = await repository.remember(
      principal,
      {
        kind: 'handoff',
        operationId: 'git-expired-handoff',
        project: PROJECT,
        text: 'Active handoff body.',
        topic: 'git-expired',
        version: 1,
      },
      'request-git-expired-create',
    );
    const archived = await repository.transitionHandoff(
      principal,
      {
        baseRevision: created.revision!,
        operation: 'archive',
        operationId: 'git-expired-archive',
        uri: created.uri!,
      },
      'request-git-expired-archive',
    );
    expect(archived.revision).toBeTruthy();
    const path = gitCanonicalSharePath('handoff', PROJECT, 'git-expired');
    const laptop = join(gitFixture.root, 'laptop-expired');
    await cloneGitShareWorktree(gitFixture.remote, laptop);
    const target = join(laptop, ...path.split('/'));
    await mkdir(dirname(target), {recursive: true});
    await writeFile(
      target,
      formatMemoryDocument(
        'HANDOFF',
        {
          kind: 'handoff',
          project: PROJECT,
          sourceAgentClient: 'share',
          status: 'active',
          timestamp: '2026-09-04T12:00:00.000Z',
          topic: 'git-expired',
          visibility: 'shared',
        },
        'Should not resurrect expired handoff.',
      ),
      'utf8',
    );
    await git(['add', '--', path], laptop);
    await git(['commit', '-m', 'resurrect expired'], laptop);
    await git(['push', 'origin', 'main'], laptop);
    expect(await indexer.runPass({batchSize: 8})).toMatchObject({failed: 0});
    const read = await repository.read(principal, {uri: created.uri!, version: 1}, 'request-git-expired-read');
    expect(read.status).toBe('archived');
    expect(read.content).toContain('Active handoff body.');
  });
});

function claims(): OAuthPrincipalClaims {
  return {issuer: ISSUER, scopes: new Set(ALL_SCOPES), subject: 'subject-git'};
}

function rememberInput(input: {
  readonly baseRevision?: string;
  readonly operationId: string;
  readonly text: string;
  readonly topic: string;
}): RemoteRememberInputV1 {
  return {
    ...(input.baseRevision ? {baseRevision: input.baseRevision} : {}),
    kind: 'durable',
    operationId: input.operationId,
    project: PROJECT,
    text: input.text,
    topic: input.topic,
    version: 1,
  };
}

async function withTenant<A>(sql: Sql, tenantId: string, use: (transaction: TransactionSql) => Promise<A>): Promise<A> {
  return (await sql.begin(async transaction => {
    await transaction`SELECT set_config('threadnote.tenant_id', ${tenantId}, true)`;
    return use(transaction);
  })) as A;
}
