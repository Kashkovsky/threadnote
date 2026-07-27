import {mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

const execute = promisify(execFile);
const root = process.cwd();
const cli = join(root, 'bin', 'threadnote.cjs');
const coreEmbeddingModelId = 'bge-small-en-v1.5-q8';
let home: string;
let temporaryRoot: string;
let userHome: string;
let installedModelPath: string;
let installedModelModifiedAt: number;
let initialVectorGeneration: string;
let installOutput: string;
let installedFiles: string[];

beforeAll(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'threadnote-native-e2e-'));
  home = join(temporaryRoot, 'threadnote-home');
  userHome = join(temporaryRoot, 'user-home');
  await mkdir(join(home, 'cache'), {recursive: true});
  await mkdir(userHome, {recursive: true});
  await writeFile(join(home, 'cache', 'recall-index-v6.json'), '{"legacy":true}\n', 'utf8');
  installOutput = await runCli(['install']);
  installedFiles = await readdir(home, {recursive: true});
  const selection = JSON.parse(await readFile(join(home, 'models', 'selection.json'), 'utf8')) as {
    readonly roles?: {readonly embedding?: string};
  };
  expect(selection.roles?.embedding).toBe(coreEmbeddingModelId);
  const receipt = JSON.parse(
    await readFile(join(home, 'models', 'embedding', coreEmbeddingModelId, 'manifest.json'), 'utf8'),
  ) as {readonly sha256: string; readonly size: number};
  installedModelPath = join(home, 'models', 'embedding', coreEmbeddingModelId, `${receipt.sha256}.gguf`);
  const installedModel = await stat(installedModelPath);
  expect(installedModel.size).toBe(receipt.size);
  installedModelModifiedAt = installedModel.mtimeMs;
  initialVectorGeneration = await activeVectorGeneration();
  const longContext = Array.from(
    {length: 900},
    (_, index) => `QZ9-long-context-token-${String(index).padStart(4, '0')}`,
  ).join(' ');
  await runCli([
    'remember',
    '--kind',
    'durable',
    '--project',
    'threadnote',
    '--topic',
    'native-e2e',
    '--text',
    `QZ9 native recall survives without a background service.\n\n${longContext}`,
  ]);
});

afterAll(async () => {
  await rm(temporaryRoot, {force: true, recursive: true});
});

describe('built self-contained distribution', () => {
  it('initializes core lexical and vector recall without server or interpreter artifacts', async () => {
    expect(installOutput).toContain('Install complete');
    expect(installOutput).toContain(`${coreEmbeddingModelId}: core embedding model verified`);
    expect(installedFiles).toContain('layout.json');
    expect(installedFiles).toContain(join('indexes', 'lexical', 'active-v1.sqlite'));
    expect(installedFiles).toContain(join('indexes', 'vectors', coreEmbeddingModelId, 'active.json'));
    expect(installedFiles).not.toContain(join('cache', 'recall-index-v6.json'));
    expect(installedFiles.some(file => /\.py$|server\.pid|server\.lock|ov\.conf/i.test(file))).toBe(false);
  });

  it('stores memory, refreshes the vector generation, and recalls through built launchers', async () => {
    const recall = await runCli(['recall', '--query', 'QZ9 native recall background service']);
    expect(recall).toContain('native-e2e.md');
    const refreshedVectorGeneration = await activeVectorGeneration();
    expect(refreshedVectorGeneration).not.toBe(initialVectorGeneration);
    await expect(
      stat(
        join(home, 'indexes', 'vectors', coreEmbeddingModelId, 'generations', refreshedVectorGeneration, 'vectors.bin'),
      ),
    ).resolves.toMatchObject({size: expect.any(Number)});
    const canonical = join(
      home,
      'data',
      'local',
      'user',
      'e2e-user',
      'memories',
      'durable',
      'projects',
      'threadnote',
      'native-e2e.md',
    );
    await expect(readFile(canonical, 'utf8')).resolves.toContain('QZ9 native recall');
  });

  it('preserves the installed core model and current indexes on repeat install', async () => {
    const vectorGeneration = await activeVectorGeneration();
    const output = await runCli(['install']);
    expect(output).toContain(`${coreEmbeddingModelId}: core embedding model verified`);
    expect((await stat(installedModelPath)).mtimeMs).toBe(installedModelModifiedAt);
    expect(await activeVectorGeneration()).toBe(vectorGeneration);
  });

  it('reports lexical, embedding, vector, MCP, and instruction checks through doctor', async () => {
    const output = await runCli(['doctor']);
    expect(output).toMatch(/OK\s+lexical recall index:/);
    expect(output).toMatch(new RegExp(`OK\\s+embedding model: ${coreEmbeddingModelId}`));
    expect(output).toMatch(/OK\s+vector recall index:/);
    expect(output).toMatch(/(?:OK|WARN)\s+.*MCP/i);
    expect(output).toMatch(/OK\s+codex user instructions:/);
  });

  it('seeds Windows path guidance while pruning generated and implicit hidden trees', async () => {
    const repo = join(temporaryRoot, 'seed-windows-repo');
    await mkdir(join(repo, 'node_modules', 'dependency'), {recursive: true});
    await mkdir(join(repo, '.nx', 'cache'), {recursive: true});
    await mkdir(join(repo, '.private'), {recursive: true});
    await mkdir(join(repo, '.claude'), {recursive: true});
    await writeFile(
      join(repo, 'CLAUDE.md'),
      'Bash uses `/c/Users/developer/project`; macOS checkout `/Users/developer/project`.\n',
      'utf8',
    );
    await writeFile(join(repo, 'node_modules', 'dependency', 'README.md'), '# Dependency cache\n', 'utf8');
    await writeFile(join(repo, '.nx', 'cache', 'result.md'), '# Nx cache\n', 'utf8');
    await writeFile(join(repo, '.private', 'notes.md'), '# Implicit hidden notes\n', 'utf8');
    await writeFile(join(repo, '.claude', 'guide.md'), '# Explicit hidden guidance\n', 'utf8');
    await writeFile(
      join(home, 'seed-manifest.yaml'),
      [
        'version: 1',
        'projects:',
        '  - name: windows-guidance',
        `    path: ${repo}`,
        '    uri: threadnote://resources/repos/windows-guidance',
        '    seed:',
        '      - "**/*.md"',
        '      - ".claude/**/*.md"',
        '',
      ].join('\n'),
      'utf8',
    );

    const preview = await runCli(['seed', '--dry-run']);
    expect(preview).toContain('windows-guidance/CLAUDE.md');
    expect(preview).toContain('windows-guidance/.claude/guide.md');
    expect(preview).not.toContain('node_modules');
    expect(preview).not.toContain('/.nx/');
    expect(preview).not.toContain('/.private/');

    await runCli(['seed']);
    const seeded = await readFile(
      join(home, 'data', 'local', 'resources', 'repos', 'windows-guidance', 'CLAUDE.md'),
      'utf8',
    );
    expect(seeded).toContain('/c/Users/developer/project');
    expect(seeded).toContain('macOS checkout `<local-path>`');
  });

  it('loads only the prebuilt node-llama runtime', async () => {
    await expect(runCli(['models', 'runtime'])).resolves.toMatch(/node-llama-cpp:\s+prebuilt/i);
  });

  it('serves native MCP tools and recalls the installed-package memory over stdio', async () => {
    const transport = new StdioClientTransport({
      args: [join(root, 'bin', 'threadnote-mcp-server.cjs')],
      command: process.execPath,
      cwd: root,
      env: {
        ...process.env,
        HOME: userHome,
        THREADNOTE_HOME: home,
        THREADNOTE_MCP_TOOLSET: 'full',
        THREADNOTE_USER: 'e2e-user',
        USERPROFILE: userHome,
      } as Record<string, string>,
      stderr: 'pipe',
    });
    const client = new Client({name: 'threadnote-e2e', version: '4.0.0'});
    try {
      await client.connect(transport);
      const names = (await client.listTools()).tools.map(tool => tool.name);
      expect(names).toEqual(expect.arrayContaining(['recall_context', 'remember_context', 'health', 'grep', 'glob']));
      expect(names.some(name => name.startsWith('ov_'))).toBe(false);
      const health = await client.callTool({arguments: {}, name: 'health'});
      expect(health.structuredContent).toMatchObject({status: 'ok', storage: 'native'});
      const recalled = await client.callTool(
        {
          arguments: {
            query: 'QZ9 native recall background service',
            threshold: 0.1,
            uri: 'threadnote://user/e2e-user/memories/durable/projects/threadnote',
          },
          name: 'recall_context',
        },
        undefined,
        {timeout: 180_000},
      );
      const text = (recalled.content as Array<{readonly text?: string}>).map(item => item.text ?? '').join('\n');
      expect(recalled.isError, text).not.toBe(true);
      expect(text).toContain('native-e2e.md');
    } finally {
      await client.close();
    }
  });

  it('publishes a durable memory through a separate Git worktree into the remote', async () => {
    const remote = join(temporaryRoot, 'share-remote.git');
    const seed = join(temporaryRoot, 'share-seed');
    const worktree = join(home, 'share', 'worktrees', 'default');
    const gitdir = join(home, 'share', 'teams', 'default.gitdir');
    await mkdir(seed, {recursive: true});
    await runGit(['init', '--bare', remote], temporaryRoot);
    await runGit(['init', '-b', 'main'], seed);
    await runGit(['config', 'user.email', 'threadnote-e2e@example.com'], seed);
    await runGit(['config', 'user.name', 'Threadnote E2E'], seed);
    await writeFile(join(seed, 'README.md'), '# Threadnote E2E share\n', 'utf8');
    await runGit(['add', 'README.md'], seed);
    await runGit(['commit', '-m', 'initial'], seed);
    await runGit(['remote', 'add', 'origin', remote], seed);
    await runGit(['push', '-u', 'origin', 'main'], seed);
    await runGit(['--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main'], temporaryRoot);
    await mkdir(join(home, 'share', 'worktrees'), {recursive: true});
    await mkdir(join(home, 'share', 'teams'), {recursive: true});
    await runGit(['clone', `--separate-git-dir=${gitdir}`, '--branch', 'main', '--', remote, worktree], temporaryRoot);
    await runGit(['config', 'user.email', 'threadnote-e2e@example.com'], worktree);
    await runGit(['config', 'user.name', 'Threadnote E2E'], worktree);
    await writeFile(
      join(home, 'share', 'teams.json'),
      `${JSON.stringify(
        {
          defaultTeam: 'default',
          teams: {
            default: {
              addedAt: '2026-07-27T00:00:00.000Z',
              gitdir,
              name: 'default',
              remote,
              worktree,
            },
          },
          version: 1,
        },
        undefined,
        2,
      )}\n`,
      'utf8',
    );
    await runCli([
      'remember',
      '--kind',
      'durable',
      '--project',
      'threadnote',
      '--topic',
      'share-publish-e2e',
      '--text',
      'QZ9 separate canonical and Git worktree publication succeeds.',
    ]);

    const output = await runCli([
      'share',
      'publish',
      'threadnote://user/e2e-user/memories/durable/projects/threadnote/share-publish-e2e.md',
      '--team',
      'default',
    ]);

    expect(output).toContain('Published threadnote://user/e2e-user/memories/durable/projects/threadnote/');
    await expect(
      readFile(join(worktree, 'durable', 'projects', 'threadnote', 'share-publish-e2e.md'), 'utf8'),
    ).resolves.toContain('QZ9 separate canonical and Git worktree');
    await expect(
      readFile(
        join(
          home,
          'data',
          'local',
          'user',
          'e2e-user',
          'memories',
          'durable',
          'projects',
          'threadnote',
          'share-publish-e2e.md',
        ),
        'utf8',
      ),
    ).rejects.toMatchObject({code: 'ENOENT'});
    await expect(
      readFile(
        join(
          home,
          'data',
          'local',
          'user',
          'e2e-user',
          'memories',
          'shared',
          'default',
          'durable',
          'projects',
          'threadnote',
          'share-publish-e2e.md',
        ),
        'utf8',
      ),
    ).resolves.toContain('QZ9 separate canonical and Git worktree');
    const remoteContent = await runGit(
      ['--git-dir', remote, 'show', 'main:durable/projects/threadnote/share-publish-e2e.md'],
      temporaryRoot,
    );
    expect(remoteContent).toContain('QZ9 separate canonical and Git worktree');
  });
});

async function activeVectorGeneration(): Promise<string> {
  const pointer = JSON.parse(
    await readFile(join(home, 'indexes', 'vectors', coreEmbeddingModelId, 'active.json'), 'utf8'),
  ) as {readonly generation?: string};
  expect(pointer.generation).toEqual(expect.any(String));
  return pointer.generation as string;
}

async function runCli(args: readonly string[]): Promise<string> {
  const result = await execute(process.execPath, [cli, '--home', home, ...args], {
    cwd: root,
    env: {
      ...process.env,
      HOME: userHome,
      THREADNOTE_USER: 'e2e-user',
      USERPROFILE: userHome,
    },
    timeout: 180_000,
  });
  return `${result.stdout}${result.stderr}`;
}

async function runGit(args: readonly string[], cwd: string): Promise<string> {
  const result = await execute('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      HOME: userHome,
      USERPROFILE: userHome,
    },
    timeout: 60_000,
  });
  return `${result.stdout}${result.stderr}`;
}
