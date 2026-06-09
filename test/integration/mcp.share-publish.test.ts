import {chmod, mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {delimiter, join} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {describe, expect, it} from 'vitest';

const sourceUri = 'viking://user/denyskashkovskyi/memories/durable/projects/foo/bar.md';
const targetUri = 'viking://user/denyskashkovskyi/memories/shared/default/durable/projects/foo/bar.md';

interface TextContent {
  readonly text: string;
  readonly type: 'text';
}

async function makeHome(root: string): Promise<string> {
  const home = join(root, 'home');
  const worktree = join(home, 'data', 'viking', 'local', 'user', 'denyskashkovskyi', 'memories', 'shared', 'default');
  const gitdir = join(home, 'share', 'teams', 'default.gitdir');
  await mkdir(worktree, {recursive: true});
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

async function makeFakeBin(root: string): Promise<string> {
  const bin = join(root, 'bin');
  await mkdir(bin, {recursive: true});
  await writeExecutable(
    join(bin, 'ov'),
    `#! /usr/bin/env node
const args = process.argv.slice(2);
const command = args[0];
const sourceUri = ${JSON.stringify(sourceUri)};
const targetUri = ${JSON.stringify(targetUri)};
if (command === 'read' && args[1] === sourceUri) {
  process.stdout.write('MEMORY\\nkind: durable\\nstatus: active\\nproject: foo\\ntopic: bar\\n\\nBody\\n');
  process.exit(0);
}
if (command === 'stat') {
  process.exit(args[1] === targetUri ? 1 : 0);
}
if (command === 'write' && args[1] === targetUri) {
  process.stdout.write('fake ov write progress that must not reach MCP stdout\\n');
  process.exit(0);
}
if (command === 'rm' && args[1] === sourceUri) {
  process.stdout.write('fake ov rm progress that must not reach MCP stdout\\n');
  process.exit(0);
}
if (command === 'mkdir') {
  process.exit(0);
}
process.stderr.write('unexpected ov command: ' + args.join(' ') + '\\n');
process.exit(1);
`,
  );
  await writeExecutable(
    join(bin, 'git'),
    `#! /usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('fetch') || args.includes('add')) {
  process.exit(0);
}
if (args.includes('rev-list')) {
  process.stdout.write('0\\n');
  process.exit(0);
}
if (args.includes('commit')) {
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
      args: [join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(repoRoot, 'src', 'mcp_server.ts')],
      command: process.execPath,
      cwd: repoRoot,
      env: {
        PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
        THREADNOTE_ACCOUNT: 'local',
        THREADNOTE_AGENT_ID: 'threadnote',
        THREADNOTE_HOME: home,
        THREADNOTE_MANIFEST: join(home, 'seed-manifest.yaml'),
        THREADNOTE_OPENVIKING_MCP_URL: 'not-a-url',
        THREADNOTE_USER: 'denyskashkovskyi',
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
    } finally {
      await client.close().catch(() => undefined);
      await rm(root, {force: true, recursive: true});
    }
    expect(stderrChunks.join('')).toContain('Threadnote local MCP adapter running');
  });
});
