import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {createHash} from '../helpers/node-crypto.js';
import {execFile} from '../helpers/node-child-process.js';
import {access, mkdir, mkdtemp, readFile, rm, writeFile} from '../helpers/node-fs-promises.js';
import {tmpdir} from '../helpers/node-os.js';
import {join} from '../helpers/node-path.js';
import {promisify} from '../helpers/node-util.js';
import {describe, expect, it} from 'vitest';

const execFilePromise = promisify(execFile);
const CLOUD_TOOL_NAMES = [
  'recall_context',
  'inspect_code_graph',
  'analyze_code_graph',
  'read_context',
  'list_context',
  'remember_context',
  'threadnote_guide',
] as const;
const CLOUD_LOCAL_TOOL_NAMES = [
  'inspect_code_graph',
  'analyze_code_graph',
  'cursor_cloud_status',
  'complete_cursor_attestation',
  'threadnote_guide',
] as const;
const gitIdentityEnvironment = {
  GIT_AUTHOR_EMAIL: 'cursor-cloud@threadnote.local',
  GIT_AUTHOR_NAME: 'Cursor Cloud Test',
  GIT_COMMITTER_EMAIL: 'cursor-cloud@threadnote.local',
  GIT_COMMITTER_NAME: 'Cursor Cloud Test',
};

describe('Cursor Cloud integration', () => {
  it('prints deterministic Dashboard configuration and idempotently bootstraps a writable share', async () => {
    const fixture = await cloudFixture();
    try {
      const firstConfig = await runCli([
        'cloud',
        'cursor',
        'config',
        '--home',
        fixture.home,
        '--team',
        'engineering',
        '--user',
        'cloud-user',
        '--agent-id',
        'cloud-agent',
      ]);
      const secondConfig = await runCli([
        'cloud',
        'cursor',
        'config',
        '--home',
        fixture.home,
        '--team',
        'engineering',
        '--user',
        'cloud-user',
        '--agent-id',
        'cloud-agent',
      ]);
      expect(secondConfig.stdout).toBe(firstConfig.stdout);
      expect(JSON.parse(firstConfig.stdout)).toMatchObject({
        args: ['-lc', 'exec "$HOME/.local/bin/threadnote-mcp-server"'],
        command: '/bin/sh',
        env: {
          THREADNOTE_CURSOR_CLOUD_TEAM: 'engineering',
          THREADNOTE_MCP_TOOLSET: 'cursor-cloud-git-beta',
          THREADNOTE_USER: 'cloud-user',
        },
        type: 'stdio',
      });

      const first = await bootstrap(fixture);
      const before = await readFile(join(fixture.home, 'share', 'teams.json'), 'utf8');
      const second = await bootstrap(fixture);
      const after = await readFile(join(fixture.home, 'share', 'teams.json'), 'utf8');
      expect(first.stdout).toContain(
        'Cursor Cloud memory root: threadnote://user/cloud-user/memories/shared/engineering/',
      );
      expect(second.stdout).toContain('already configured read-write; reusing it');
      expect(after).toBe(before);
      expect(JSON.parse(after)).toMatchObject({
        defaultTeam: 'engineering',
        teams: {engineering: {name: 'engineering', remote: fixture.remote}},
      });

      const verified = await runCli([
        'cloud',
        'cursor',
        'verify',
        '--home',
        fixture.home,
        '--team',
        'engineering',
        '--user',
        'cloud-user',
        '--agent-id',
        'cloud-agent',
        '--cwd',
        process.cwd(),
        '--json',
      ]);
      expect(JSON.parse(verified.stdout)).toMatchObject({
        memoryRoot: 'threadnote://user/cloud-user/memories/shared/engineering',
        profile: 'shared-read-write',
        status: 'ok',
      });
    } finally {
      await rm(fixture.root, {force: true, recursive: true});
    }
  });

  it('renders and idempotently prepares remote-hybrid mode without a memory checkout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-cursor-cloud-hybrid-'));
    const home = join(root, 'home');
    const endpoint = 'https://memory.threadnote.io/mcp';
    const shareId = 'share-engineering';
    try {
      await expect(
        runCli(['cloud', 'cursor', 'config', '--home', home, '--mode', 'remote-hybrid', '--endpoint', endpoint]),
      ).rejects.toMatchObject({stderr: expect.stringContaining('requires --share-id')});

      const config = await runCli([
        'cloud',
        'cursor',
        'config',
        '--home',
        home,
        '--mode',
        'remote-hybrid',
        '--endpoint',
        endpoint,
        '--share-id',
        shareId,
        '--user',
        'cloud-user',
        '--agent-id',
        'cloud-agent',
      ]);
      expect(JSON.parse(config.stdout)).toMatchObject({
        mcpServers: {
          'threadnote-local': {
            args: ['-lc', 'exec "$HOME/.local/bin/threadnote-mcp-server"'],
            command: '/bin/sh',
            env: {
              THREADNOTE_CURSOR_MEMORY_ENDPOINT: endpoint,
              THREADNOTE_CURSOR_MEMORY_SHARE_ID: shareId,
              THREADNOTE_MCP_TOOLSET: 'cursor-cloud-local',
            },
            type: 'stdio',
          },
          'threadnote-memory': {headers: {'threadnote-share-id': shareId}, url: endpoint},
        },
      });
      expect(Object.keys(JSON.parse(config.stdout).mcpServers['threadnote-memory'].headers)).toEqual([
        'threadnote-share-id',
      ]);

      const bootstrapArguments = [
        'cloud',
        'cursor',
        'bootstrap',
        '--home',
        home,
        '--mode',
        'remote-hybrid',
        '--endpoint',
        endpoint,
        '--share-id',
        shareId,
        '--cwd',
        process.cwd(),
      ] as const;
      const first = await runCli(bootstrapArguments);
      const second = await runCli(bootstrapArguments);
      expect(first.stdout).toContain('no local Git memory share was configured');
      expect(second.stdout).toBe(first.stdout);
      await expect(access(join(home, 'share', 'teams.json'))).rejects.toMatchObject({code: 'ENOENT'});

      const verified = await runCli([
        'cloud',
        'cursor',
        'verify',
        '--home',
        home,
        '--mode',
        'remote-hybrid',
        '--endpoint',
        endpoint,
        '--share-id',
        shareId,
        '--cwd',
        process.cwd(),
        '--json',
      ]);
      expect(JSON.parse(verified.stdout)).toMatchObject({
        endpoint,
        localMemoryFallback: 'disabled',
        mode: 'remote-hybrid',
        shareId,
        status: 'ok',
      });

      await expect(
        runCli(
          [
            'cloud',
            'cursor',
            'verify',
            '--home',
            home,
            '--mode',
            'remote-hybrid',
            '--endpoint',
            endpoint,
            '--share-id',
            shareId,
            '--cwd',
            process.cwd(),
            '--json',
          ],
          {THREADNOTE_CURSOR_MEMORY_SHARE_ID: 'share-other'},
        ),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining('verification failed'),
        stdout: expect.stringContaining('"status":"fail"'),
      });

      await withLocalMcp(home, endpoint, shareId, async client => {
        const tools = await client.listTools();
        expect(tools.tools.map(tool => tool.name)).toEqual(CLOUD_LOCAL_TOOL_NAMES);
        expect(tools.tools.map(tool => tool.name)).not.toContain('recall_context');
        expect((await client.listResourceTemplates()).resourceTemplates).toEqual([]);

        const status = await client.callTool({
          arguments: {callerCwd: process.cwd()},
          name: 'cursor_cloud_status',
        });
        expect(status.isError).not.toBe(true);
        expect(status.structuredContent).toMatchObject({
          localMemoryFallback: 'disabled',
          shareId,
          status: 'ok',
        });

        await expect(
          callError(client, 'complete_cursor_attestation', {
            audience: 'https://memory.threadnote.io/attest/cursor',
            challengeId: 'challenge_123',
            completionUrl: 'https://attacker.example/complete',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            nonce: 'nonce_1234567890',
          }),
        ).resolves.toContain('must match the configured remote memory service');
      });
    } finally {
      await rm(root, {force: true, recursive: true});
    }
  });

  it('confines reads, persists durable writes to Git, and keeps handoffs local', async () => {
    const fixture = await cloudFixture();
    await bootstrap(fixture);
    try {
      const privateSentinel = 'CURSOR_CLOUD_RELOCATION_PRIVATE_SENTINEL';
      const privateUri =
        'threadnote://user/cloud-user/memories/durable/projects/threadnote/relocation-private-target.md';
      const formerSharedUri =
        'threadnote://user/cloud-user/memories/shared/engineering/durable/projects/threadnote/relocation-former-shared.md';
      await runCli(
        [
          'remember',
          '--home',
          fixture.home,
          '--kind',
          'durable',
          '--project',
          'threadnote',
          '--topic',
          'relocation-private-target',
          '--text',
          privateSentinel,
        ],
        {THREADNOTE_USER: 'cloud-user'},
      );
      const privatePath = join(
        fixture.home,
        'data',
        'local',
        'user',
        'cloud-user',
        'memories',
        'durable',
        'projects',
        'threadnote',
        'relocation-private-target.md',
      );
      const privateContent = await readFile(privatePath, 'utf8');
      const memoryId = /^memory_id: (tn_[A-Za-z0-9_-]+)$/mu.exec(privateContent)?.[1];
      expect(memoryId).toBeDefined();
      const receiptRoot = join(
        fixture.home,
        'data',
        'local',
        'user',
        'cloud-user',
        'private',
        'memory-relocations',
        'v1',
      );
      await mkdir(receiptRoot, {recursive: true, mode: 0o700});
      await writeFile(
        join(receiptRoot, `${createHash('sha256').update(formerSharedUri).digest('hex')}.json`),
        `${JSON.stringify({
          fromUri: formerSharedUri,
          memoryId,
          toUri: privateUri,
          type: 'threadnote-memory-relocation',
          version: 1,
          visibility: 'private-local',
        })}\n`,
        {mode: 0o600},
      );

      await withCloudMcp(fixture, async client => {
        const tools = await client.listTools();
        expect(tools.tools.map(tool => tool.name)).toEqual(CLOUD_TOOL_NAMES);

        await expect(
          callError(client, 'read_context', {
            uri: 'threadnote://user/cloud-user/memories/durable/projects/threadnote/private.md',
          }),
        ).resolves.toContain('must stay within');
        const privateAlias = `threadnote://memory/${memoryId}`;
        const aliasReadError = await callError(client, 'read_context', {uri: privateAlias});
        expect(aliasReadError).toContain('does not resolve inside the authorized active corpus');
        expect(aliasReadError).not.toContain(privateSentinel);
        await expect(client.readResource({uri: privateAlias})).rejects.toThrow(
          'does not resolve inside the authorized active corpus',
        );
        const relocatedReadError = await callError(client, 'read_context', {uri: formerSharedUri});
        expect(relocatedReadError).toContain('relocated uri must stay within');
        expect(relocatedReadError).not.toContain(privateSentinel);
        await expect(client.readResource({uri: formerSharedUri})).rejects.toThrow(
          'relocated resource is outside the active Cursor Cloud memory scope',
        );
        await expect(
          callError(client, 'inspect_code_graph', {
            callerCwd: process.cwd(),
            operation: 'query',
            query: 'memory scope',
            workset: 'all-repositories',
          }),
        ).resolves.toContain('workset operations are unavailable');
        await expect(
          callError(client, 'remember_context', {
            kind: 'preference',
            text: 'Do not persist this cloud preference.',
          }),
        ).resolves.toContain('durable shared memories and transient local handoffs');

        const handoff = await callText(client, 'remember_context', {
          kind: 'handoff',
          project: 'threadnote',
          text: 'Transient cloud checkout handoff.',
          topic: 'cursor-cloud-transient',
        });
        expect(handoff).toContain(
          'Stored memory: threadnote://user/cloud-user/memories/handoffs/active/threadnote/cursor-cloud-transient.md',
        );

        const sharedCitationWithoutReadyGraph = await client.callTool({
          arguments: {
            callerCwd: process.cwd(),
            codeRefs: ['src/types.ts'],
            kind: 'durable',
            project: 'threadnote',
            text: 'Shared memory must not publish before its requested citation is current.',
            topic: 'cursor-cloud-strict-citation',
          },
          name: 'remember_context',
        });
        expect(sharedCitationWithoutReadyGraph.isError).toBe(true);
        expect(sharedCitationWithoutReadyGraph.structuredContent).toMatchObject({
          retryable: true,
          state: 'blocked',
          type: 'memory-code-citation-write-recovery',
          writeApplied: false,
        });
        expect(JSON.stringify(sharedCitationWithoutReadyGraph)).toContain('No memory was written');
        await expect(
          access(
            join(
              fixture.home,
              'data',
              'local',
              'user',
              'cloud-user',
              'memories',
              'shared',
              'engineering',
              'durable',
              'projects',
              'threadnote',
              'cursor-cloud-strict-citation.md',
            ),
          ),
        ).rejects.toMatchObject({code: 'ENOENT'});
        await expect(
          access(join(fixture.home, 'data', 'local', 'user', 'cloud-user', 'private', 'deferred-code-anchors', 'v1')),
        ).rejects.toMatchObject({code: 'ENOENT'});

        const durable = await client.callTool({
          arguments: {
            kind: 'durable',
            project: 'threadnote',
            text: 'Cursor Cloud durable memory persisted through the designated share.',
            topic: 'cursor-cloud-persisted',
          },
          name: 'remember_context',
        });
        expect(durable.isError).not.toBe(true);
        expect(durable.structuredContent).toMatchObject({
          memoryUri:
            'threadnote://user/cloud-user/memories/shared/engineering/durable/projects/threadnote/cursor-cloud-persisted.md',
          persistence: 'shared-git-pushed',
        });
        const read = await callText(client, 'read_context', {
          uri: 'threadnote://user/cloud-user/memories/shared/engineering/durable/projects/threadnote/cursor-cloud-persisted.md',
        });
        expect(read).toContain('Cursor Cloud durable memory persisted through the designated share.');
        const targetMemoryId = /^memory_id: (tn_[A-Za-z0-9_-]+)$/mu.exec(read)?.[1];
        expect(targetMemoryId).toBeDefined();

        const relationSource = await client.callTool({
          arguments: {
            kind: 'durable',
            project: 'threadnote',
            relations: [
              {
                type: 'depends_on',
                uri: 'threadnote://user/cloud-user/memories/shared/engineering/durable/projects/threadnote/cursor-cloud-persisted.md',
              },
            ],
            text: 'This shared workflow explicitly depends on the persisted contract.',
            topic: 'cursor-cloud-relation-source',
          },
          name: 'remember_context',
        });
        expect(relationSource.isError, JSON.stringify(relationSource)).not.toBe(true);
        const relationRead = await callText(client, 'read_context', {
          uri: 'threadnote://user/cloud-user/memories/shared/engineering/durable/projects/threadnote/cursor-cloud-relation-source.md',
        });
        expect(relationRead).toContain(`relation: depends_on threadnote://memory/${targetMemoryId}`);

        const canonicalOutside = await callError(client, 'remember_context', {
          kind: 'durable',
          relations: [{type: 'references', uri: privateUri}],
          text: 'This cross-scope relation must not be stored.',
          topic: 'cursor-cloud-canonical-outside',
        });
        expect(canonicalOutside).toContain('authorized memory scope');
        expect(canonicalOutside).not.toContain(privateSentinel);
        const aliasOutside = await callError(client, 'remember_context', {
          kind: 'durable',
          relations: [{type: 'references', uri: privateAlias}],
          text: 'This cross-scope alias must not be stored.',
          topic: 'cursor-cloud-alias-outside',
        });
        expect(aliasOutside).toContain('does not resolve inside the authorized active corpus');
        expect(aliasOutside).not.toContain(privateSentinel);
      });

      const remoteTree = await execFilePromise(
        'git',
        ['--git-dir', fixture.remote, 'ls-tree', '-r', '--name-only', 'main'],
        {env: {...process.env, ...gitIdentityEnvironment}},
      );
      expect(remoteTree.stdout).toContain('durable/projects/threadnote/cursor-cloud-persisted.md');
      expect(remoteTree.stdout).toContain('durable/projects/threadnote/cursor-cloud-relation-source.md');
      expect(remoteTree.stdout).not.toContain('handoffs/');
    } finally {
      await rm(fixture.root, {force: true, recursive: true});
    }
  });
});

interface CloudFixture {
  readonly home: string;
  readonly remote: string;
  readonly root: string;
}

async function cloudFixture(): Promise<CloudFixture> {
  const root = await mkdtemp(join(tmpdir(), 'threadnote-cursor-cloud-'));
  const remote = join(root, 'memory-share.git');
  const source = join(root, 'seed');
  const home = join(root, 'home');
  await mkdir(source, {recursive: true});
  await execFilePromise('git', ['init', '--bare', '--initial-branch=main', remote], {
    env: {...process.env, ...gitIdentityEnvironment},
  });
  await execFilePromise('git', ['-C', source, 'init', '--initial-branch=main'], {
    env: {...process.env, ...gitIdentityEnvironment},
  });
  await writeFile(join(source, 'README.md'), '# Cursor Cloud memory share\n');
  await execFilePromise('git', ['-C', source, 'add', 'README.md'], {
    env: {...process.env, ...gitIdentityEnvironment},
  });
  await execFilePromise('git', ['-C', source, 'commit', '-m', 'seed memory share'], {
    env: {...process.env, ...gitIdentityEnvironment},
  });
  await execFilePromise('git', ['-C', source, 'remote', 'add', 'origin', remote], {
    env: {...process.env, ...gitIdentityEnvironment},
  });
  await execFilePromise('git', ['-C', source, 'push', '-u', 'origin', 'main'], {
    env: {...process.env, ...gitIdentityEnvironment},
  });
  return {home, remote, root};
}

function bootstrap(fixture: CloudFixture) {
  return runCli([
    'cloud',
    'cursor',
    'bootstrap',
    '--home',
    fixture.home,
    '--remote',
    fixture.remote,
    '--team',
    'engineering',
    '--user',
    'cloud-user',
    '--agent-id',
    'cloud-agent',
  ]);
}

function runCli(args: readonly string[], environment: Readonly<Record<string, string>> = {}) {
  return execFilePromise(process.execPath, ['src/standalone.ts', ...args], {
    cwd: process.cwd(),
    env: {...process.env, ...gitIdentityEnvironment, ...environment, NO_COLOR: '1'},
  });
}

async function withCloudMcp<T>(fixture: CloudFixture, use: (client: Client) => Promise<T>): Promise<T> {
  const transport = new StdioClientTransport({
    args: [join(process.cwd(), 'src', 'standalone.ts'), 'mcp-server'],
    command: process.execPath,
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...gitIdentityEnvironment,
      THREADNOTE_ACCOUNT: 'local',
      THREADNOTE_AGENT_ID: 'cloud-agent',
      THREADNOTE_CURSOR_CLOUD_TEAM: 'engineering',
      THREADNOTE_HOME: fixture.home,
      THREADNOTE_MANIFEST: join(fixture.home, 'seed-manifest.yaml'),
      THREADNOTE_MCP_TOOLSET: 'cursor-cloud',
      THREADNOTE_USER: 'cloud-user',
    } as Record<string, string>,
    stderr: 'pipe',
  });
  const client = new Client({name: 'threadnote-cursor-cloud-test', version: '0.0.0'});
  try {
    await client.connect(transport);
    return await use(client);
  } finally {
    await client.close();
  }
}

async function withLocalMcp<T>(
  home: string,
  endpoint: string,
  shareId: string,
  use: (client: Client) => Promise<T>,
): Promise<T> {
  const transport = new StdioClientTransport({
    args: [join(process.cwd(), 'src', 'standalone.ts'), 'mcp-server'],
    command: process.execPath,
    cwd: process.cwd(),
    env: {
      ...process.env,
      THREADNOTE_ACCOUNT: 'local',
      THREADNOTE_AGENT_ID: 'cloud-agent',
      THREADNOTE_CURSOR_MEMORY_ENDPOINT: endpoint,
      THREADNOTE_CURSOR_MEMORY_SHARE_ID: shareId,
      THREADNOTE_HOME: home,
      THREADNOTE_MANIFEST: join(home, 'seed-manifest.yaml'),
      THREADNOTE_MCP_TOOLSET: 'cursor-cloud-local',
      THREADNOTE_USER: 'cloud-user',
    } as Record<string, string>,
    stderr: 'pipe',
  });
  const client = new Client({name: 'threadnote-cursor-cloud-local-test', version: '0.0.0'});
  try {
    await client.connect(transport);
    return await use(client);
  } finally {
    await client.close();
  }
}

async function callText(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({arguments: args, name});
  return (result.content as Array<{text?: string; type: string}>)
    .filter(content => content.type === 'text')
    .map(content => content.text ?? '')
    .join('\n');
}

async function callError(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({arguments: args, name});
  expect(result.isError).toBe(true);
  return (result.content as Array<{text?: string; type: string}>).map(content => content.text ?? '').join('\n');
}
