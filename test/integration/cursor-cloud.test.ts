import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {execFile} from '../helpers/node-child-process.js';
import {mkdir, mkdtemp, readFile, rm, writeFile} from '../helpers/node-fs-promises.js';
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
          THREADNOTE_MCP_TOOLSET: 'cursor-cloud',
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

  it('confines reads, persists durable writes to Git, and keeps handoffs local', async () => {
    const fixture = await cloudFixture();
    await bootstrap(fixture);
    try {
      await withCloudMcp(fixture, async client => {
        const tools = await client.listTools();
        expect(tools.tools.map(tool => tool.name)).toEqual(CLOUD_TOOL_NAMES);

        await expect(
          callError(client, 'read_context', {
            uri: 'threadnote://user/cloud-user/memories/durable/projects/threadnote/private.md',
          }),
        ).resolves.toContain('must stay within');
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
      });

      const remoteTree = await execFilePromise(
        'git',
        ['--git-dir', fixture.remote, 'ls-tree', '-r', '--name-only', 'main'],
        {env: {...process.env, ...gitIdentityEnvironment}},
      );
      expect(remoteTree.stdout).toContain('durable/projects/threadnote/cursor-cloud-persisted.md');
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

function runCli(args: readonly string[]) {
  return execFilePromise(process.execPath, ['src/standalone.ts', ...args], {
    cwd: process.cwd(),
    env: {...process.env, ...gitIdentityEnvironment, NO_COLOR: '1'},
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
