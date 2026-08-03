import {chmod, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {delimiter, join} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {describe, expect, it} from 'vitest';

const sourceUri = 'threadnote://user/test-user/memories/durable/projects/foo/bar.md';
const targetUri = 'threadnote://user/test-user/memories/shared/default/durable/projects/foo/bar.md';

interface TextContent {
  readonly text: string;
  readonly type: 'text';
}

async function makeHome(root: string): Promise<string> {
  const home = join(root, 'home');
  const worktree = join(home, 'share', 'worktrees', 'default');
  const sourcePath = join(
    home,
    'data',
    'local',
    'user',
    'test-user',
    'memories',
    'durable',
    'projects',
    'foo',
    'bar.md',
  );
  const gitdir = join(home, 'share', 'teams', 'default.gitdir');
  await mkdir(worktree, {recursive: true});
  await mkdir(join(sourcePath, '..'), {recursive: true});
  await writeFile(
    sourcePath,
    [
      'MEMORY',
      'kind: durable',
      'status: active',
      'project: foo',
      'topic: bar',
      'source_agent_client: test',
      'timestamp: 2026-07-23T00:00:00.000Z',
      '',
      'Body',
    ].join('\n'),
  );
  await mkdir(join(home, 'share'), {recursive: true});
  await writeFile(
    join(home, 'share', 'teams.json'),
    `${JSON.stringify(
      {
        defaultTeam: 'default',
        teams: {
          default: {
            addedAt: '2026-06-08T00:00:00.000Z',
            gitdir,
            name: 'default',
            remote: 'git@example.com:team/memories.git',
            worktree,
          },
        },
        version: 1,
      },
      undefined,
      2,
    )}\n`,
  );
  return home;
}

async function writeExecutable(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, {encoding: 'utf8', mode: 0o700});
  await chmod(path, 0o700);
}

async function makeFakeBin(root: string, options: {readonly mutateSourceOnCommit?: boolean} = {}): Promise<string> {
  const bin = join(root, 'bin');
  const sourcePath = join(
    root,
    'home',
    'data',
    'local',
    'user',
    'test-user',
    'memories',
    'durable',
    'projects',
    'foo',
    'bar.md',
  );
  await mkdir(bin, {recursive: true});
  await writeExecutable(
    join(bin, 'git'),
    `#! /usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('fetch') || args.includes('add') || args.includes('ls-files')) {
  process.exit(0);
}
if (args.includes('rev-list')) {
  process.stdout.write('0\\n');
  process.exit(0);
}
if (args.includes('commit')) {
  if (${JSON.stringify(options.mutateSourceOnCommit === true)}) {
    require('node:fs').writeFileSync(
      ${JSON.stringify(sourcePath)},
      'MEMORY\\nkind: durable\\nstatus: active\\nproject: foo\\ntopic: bar\\nsource_agent_client: concurrent\\ntimestamp: 2026-07-23T01:00:00.000Z\\n\\nConcurrent newer body\\n',
    );
  }
  process.stdout.write('[main abc123] share\\n 1 file changed\\n');
  process.exit(0);
}
if (args.includes('push')) {
  process.stdout.write('pushed\\n');
  process.exit(0);
}
process.stderr.write('unexpected git command: ' + args.join(' ') + '\\n');
process.exit(1);
`,
  );
  return bin;
}

describe('Threadnote MCP share_publish', () => {
  it('does not write CLI progress to the stdio transport while publishing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-mcp-share-publish-'));
    const home = await makeHome(root);
    const fakeBin = await makeFakeBin(root);
    const repoRoot = process.cwd();
    const transport = new StdioClientTransport({
      args: [join(repoRoot, 'src', 'standalone.ts'), 'mcp-server'],
      command: process.execPath,
      cwd: repoRoot,
      env: {
        PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
        THREADNOTE_ACCOUNT: 'local',
        THREADNOTE_AGENT_ID: 'threadnote',
        THREADNOTE_HOME: home,
        THREADNOTE_MANIFEST: join(home, 'seed-manifest.yaml'),
        THREADNOTE_USER: 'test-user',
      },
      stderr: 'pipe',
    });
    const stderrChunks: string[] = [];
    transport.stderr?.on('data', chunk => stderrChunks.push(String(chunk)));
    const client = new Client({name: 'threadnote-test', version: '0.0.0'});
    try {
      await client.connect(transport);
      const result = await client.callTool(
        {
          arguments: {
            push: false,
            uri: sourceUri,
          },
          name: 'share_publish',
        },
        undefined,
        {timeout: 5000},
      );

      expect(result.isError).toBe(false);
      expect(Array.isArray(result.content)).toBe(true);
      const text = (result.content as TextContent[]).map(item => item.text).join('\n');
      expect(text).toContain(`Published ${sourceUri} -> ${targetUri}`);
      expect(text).toContain('git push skipped (push=false)');
      await expect(
        readFile(join(home, 'share', 'worktrees', 'default', 'durable', 'projects', 'foo', 'bar.md'), 'utf8'),
      ).resolves.toContain('Body');
    } finally {
      await client.close().catch(() => undefined);
      await rm(root, {force: true, recursive: true});
    }
    expect(stderrChunks.join('')).toContain('Threadnote local MCP adapter running');
  });

  it('does not delete a personal source that changes after the shared write', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-mcp-share-publish-race-'));
    const home = await makeHome(root);
    const fakeBin = await makeFakeBin(root, {mutateSourceOnCommit: true});
    const repoRoot = process.cwd();
    const sourcePath = join(
      home,
      'data',
      'local',
      'user',
      'test-user',
      'memories',
      'durable',
      'projects',
      'foo',
      'bar.md',
    );
    const transport = new StdioClientTransport({
      args: [join(repoRoot, 'src', 'standalone.ts'), 'mcp-server'],
      command: process.execPath,
      cwd: repoRoot,
      env: {
        PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
        THREADNOTE_ACCOUNT: 'local',
        THREADNOTE_AGENT_ID: 'threadnote',
        THREADNOTE_HOME: home,
        THREADNOTE_MANIFEST: join(home, 'seed-manifest.yaml'),
        THREADNOTE_USER: 'test-user',
      },
      stderr: 'pipe',
    });
    const client = new Client({name: 'threadnote-test', version: '0.0.0'});
    try {
      await client.connect(transport);
      const result = await client.callTool(
        {
          arguments: {push: false, uri: sourceUri},
          name: 'share_publish',
        },
        undefined,
        {timeout: 5000},
      );

      expect(result.isError).toBe(true);
      const text = (result.content as TextContent[]).map(item => item.text).join('\n');
      expect(text).toContain('changed while publication was in progress');
      expect(await readFile(sourcePath, 'utf8')).toContain('Concurrent newer body');
      await expect(readFile(join(root, 'source-remove-invoked'), 'utf8')).rejects.toBeDefined();
    } finally {
      await client.close().catch(() => undefined);
      await rm(root, {force: true, recursive: true});
    }
  });
});
