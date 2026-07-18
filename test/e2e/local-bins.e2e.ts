import {spawn, type ChildProcess} from 'node:child_process';
import {mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {createServer, type Server} from 'node:http';
import {createServer as createNetServer, type AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {afterAll, afterEach, beforeAll, describe, expect, it} from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CLI_BIN = join(REPO_ROOT, 'bin', 'threadnote.cjs');
const MCP_BIN = join(REPO_ROOT, 'bin', 'threadnote-mcp-server.cjs');
const TEMP_ROOTS: string[] = [];
let LIVE_OV: LiveOpenViking;

interface ProcessResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: string;
}

interface TestFixture {
  readonly env: NodeJS.ProcessEnv;
  readonly home: string;
  readonly manifest: string;
  readonly root: string;
}

interface LiveOpenViking {
  readonly cliConfig: string;
  readonly env: NodeJS.ProcessEnv;
  readonly home: string;
  readonly mcpUrl: string;
  readonly ov: string;
  readonly port: number;
  readonly process: ChildProcess;
  readonly root: string;
  readonly serverConfig: string;
  readonly version: string;
}

interface TextContent {
  readonly text: string;
  readonly type: 'text';
}

beforeAll(async () => {
  LIVE_OV = await startLiveOpenViking();
}, 120_000);

afterEach(async () => {
  await Promise.all(TEMP_ROOTS.splice(0).map(path => rm(path, {force: true, recursive: true})));
});

afterAll(async () => {
  await Promise.all(TEMP_ROOTS.splice(0).map(path => rm(path, {force: true, recursive: true})));
  if (LIVE_OV) await stopLiveOpenViking(LIVE_OV);
}, 30_000);

describe('published local bins', () => {
  it('runs against the pinned live OpenViking server and suite-scoped datastore', async () => {
    expect(LIVE_OV.version).toBe(await pinnedOpenVikingVersion());
    expect(LIVE_OV.home.startsWith(tmpdir())).toBe(true);
    expect(LIVE_OV.home).toContain('threadnote-bin-e2e-openviking-');
    const health = await runProcess(LIVE_OV.ov, ['health', '--output', 'json'], {env: LIVE_OV.env});
    expectSuccess(health, 'live ov health');
    expect(health.stdout).toMatch(/"status"\s*:\s*"ok"/);
    await expect(stat(join(LIVE_OV.home, 'data'))).resolves.toMatchObject({isDirectory: expect.any(Function)});
  });

  it('loads every command path, completion target, parser edge, and expected failure through the CJS launcher', async () => {
    const fixture = await makeFixture('surface');
    const commandPaths = [
      [],
      ['manage'],
      ['doctor'],
      ['install'],
      ['version'],
      ['update'],
      ['post-update'],
      ['repair'],
      ['start'],
      ['stop'],
      ['uninstall'],
      ['seed'],
      ['init-manifest'],
      ['seed-skills'],
      ['mcp-install'],
      ['install-hooks'],
      ['pre-compact-hook'],
      ['session-start-hook'],
      ['remember'],
      ['migrate-memories'],
      ['migrate-lifecycle'],
      ['migrate-projects'],
      ['migrate-project-names'],
      ['recall'],
      ['workset'],
      ['workset', 'list'],
      ['workset', 'show'],
      ['compact'],
      ['read'],
      ['list'],
      ['ls'],
      ['handoff'],
      ['archive'],
      ['forget'],
      ['share'],
      ['share', 'init'],
      ['share', 'status'],
      ['share', 'sync'],
      ['share', 'conflicts'],
      ['share', 'conflict'],
      ['share', 'conflict', 'show'],
      ['share', 'conflict', 'resolve'],
      ['share', 'publish'],
      ['share', 'publish-artifact'],
      ['share', 'publish-bundle'],
      ['share', 'install-artifacts'],
      ['share', 'unpublish'],
      ['share', 'list'],
      ['share', 'rename'],
      ['share', 'set-url'],
      ['share', 'remove'],
      ['export-pack'],
      ['import-pack'],
    ] as const;
    for (const commandPath of commandPaths) {
      const result = await runCli(fixture, [...commandPath, '--help']);
      expectSuccess(result, `${commandPath.join(' ') || 'root'} --help`);
      expect(result.stdout).toContain('USAGE');
    }

    for (const shell of ['bash', 'zsh', 'fish', 'sh']) {
      const result = await runCli(fixture, ['--completions', shell]);
      expectSuccess(result, `--completions ${shell}`);
      expect(result.stdout).toContain('threadnote');
    }

    const version = await runCli(fixture, ['--version']);
    expectSuccess(version, '--version');
    expect(version.stdout).toMatch(/^threadnote v\d+\.\d+\.\d+/m);

    const values = await runCli(fixture, [
      'handoff',
      '--dry-run',
      '--project',
      'e2e',
      '--topic',
      'parser',
      '--blockers',
      '- none',
      '--task=local=bin',
    ]);
    expectSuccess(values, 'dash-prefixed and multi-equals values');
    expect(values.stdout).toContain('blockers:\n- none');
    expect(values.stdout).toContain('task: local=bin');

    const stdin = await runCli(
      fixture,
      ['remember', '--dry-run', '--stdin', '--project', 'e2e'],
      'remembered from stdin\n',
    );
    expectSuccess(stdin, 'remember --stdin');
    expect(stdin.stdout).toContain('remembered from stdin');

    await expectCliFailure(fixture, ['--port', '0', 'doctor', '--dry-run'], 'between 1 and 65535');
    await expectCliFailure(fixture, ['--port', '65536', 'doctor', '--dry-run'], 'between 1 and 65535');
    await expectCliFailure(fixture, ['manage', '--ui-port', '65536', '--no-open'], 'between 0 and 65535');
    await expectCliFailure(fixture, ['remember', '--dry-run', '--text', '   '], 'Provide memory text');
    await expectCliFailure(
      fixture,
      ['compact', '--project', 'e2e', '--apply', '--dry-run'],
      'Cannot combine --apply with --dry-run',
    );
    await expectCliFailure(fixture, ['definitely-not-a-command'], 'Unknown subcommand');
  });

  it('executes memory create, replace, recall, read, list, compact, archive, forget, and pack flows', async () => {
    const fixture = await makeFixture('memory');
    const memoryUri = 'viking://user/e2e/memories/durable/projects/e2e/lifecycle.md';
    const handoffUri = 'viking://user/e2e/memories/handoffs/active/e2e/progress.md';

    const remembered = await runCli(fixture, [
      'remember',
      '--kind',
      'durable',
      '--project',
      'e2e',
      '--topic',
      'lifecycle',
      '--text',
      'First local-bin memory',
    ]);
    expectSuccess(remembered, 'remember');
    expect(remembered.stdout).toContain(`Stored memory: ${memoryUri}`);

    const read = await runCli(fixture, ['read', memoryUri]);
    expectSuccess(read, 'read');
    expect(read.stdout).toContain('First local-bin memory');

    const list = await runCli(fixture, [
      'list',
      'viking://user/e2e/memories/durable/projects/e2e',
      '--all',
      '--recursive',
      '--simple',
    ]);
    expectSuccess(list, 'list');
    expect(list.stdout).toContain(memoryUri);

    const recall = await runCli(fixture, [
      'recall',
      '--query',
      'First local-bin memory',
      '--project',
      'e2e',
      '--node-limit',
      '5',
    ]);
    expectSuccess(recall, 'recall');
    expect(recall.stdout).toContain(memoryUri);

    const replaced = await runCli(fixture, [
      'remember',
      '--kind',
      'durable',
      '--project',
      'e2e',
      '--topic',
      'lifecycle',
      '--replace',
      memoryUri,
      '--text',
      'Updated local-bin memory',
    ]);
    expectSuccess(replaced, 'remember --replace');
    expect(replaced.stdout).toContain('Updated existing memory in place');
    const reread = await runCli(fixture, ['read', memoryUri]);
    expect(reread.stdout).toContain('Updated local-bin memory');
    expect(reread.stdout).not.toContain('supersedes:');

    const handoff = await runCli(fixture, [
      'handoff',
      '--project',
      'e2e',
      '--topic',
      'progress',
      '--task',
      'E2E handoff',
      '--tests',
      'local bins',
      '--blockers',
      '- none',
    ]);
    expectSuccess(handoff, 'handoff');
    expect(handoff.stdout).toContain(`Stored memory: ${handoffUri}`);

    const compact = await runCli(fixture, ['compact', '--project', 'e2e', '--dry-run']);
    expectSuccess(compact, 'compact --dry-run');
    expect(compact.stdout).toContain('Records scanned: 2');

    const archived = await runCli(fixture, ['archive', memoryUri]);
    expectSuccess(archived, 'archive');
    expect(archived.stdout).toContain(`Archived original memory: ${memoryUri}`);
    const missing = await runCli(fixture, ['read', memoryUri]);
    expect(missing.code).not.toBe(0);
    const archivedList = await runCli(fixture, [
      'list',
      'viking://user/e2e/memories/durable/archived/e2e',
      '--recursive',
      '--simple',
    ]);
    expectSuccess(archivedList, 'list archived');
    expect(archivedList.stdout).toContain('/durable/archived/e2e/');
    const archivedMemoryUri = archivedList.stdout.match(
      /viking:\/\/user\/e2e\/memories\/durable\/archived\/e2e\/\S+\.md/,
    )?.[0];
    expect(archivedMemoryUri).toBeDefined();

    const forgotten = await runCli(fixture, ['forget', handoffUri]);
    expectSuccess(forgotten, 'forget');
    const forgottenRead = await runCli(fixture, ['read', handoffUri]);
    expect(forgottenRead.code).not.toBe(0);

    const packPath = join(fixture.root, 'context.ovpack');
    const exported = await runCli(fixture, ['export-pack', '--path', packPath]);
    expectSuccess(exported, 'export-pack');
    await expect(stat(packPath)).resolves.toMatchObject({isFile: expect.any(Function)});
    const defaultImport = await runCli(fixture, ['import-pack', '--dry-run', '--path', packPath]);
    expectSuccess(defaultImport, 'import-pack --dry-run');
    expect(defaultImport.stdout).toContain(`${packPath} viking://user/e2e`);
    const imported = await runCli(fixture, [
      'import-pack',
      '--path',
      packPath,
      '--target-uri',
      'viking://user/e2e-import',
    ]);
    expectSuccess(imported, 'import-pack');
    expect(imported.stdout).toContain('viking://user/e2e-import/memories');
    const importedMemory = await runCli(fixture, [
      'read',
      (archivedMemoryUri as string).replace('viking://user/e2e/', 'viking://user/e2e-import/'),
    ]);
    expectSuccess(importedMemory, 'read imported memory');
    expect(importedMemory.stdout).toContain('Updated local-bin memory');
  });

  it('executes setup, manifest, seed, hooks, MCP install, migration, and lifecycle dry-run paths', async () => {
    const fixture = await makeFixture('operations');
    const manifest = await runCli(fixture, [
      'init-manifest',
      '--path',
      fixture.manifest,
      '--repo',
      REPO_ROOT,
      '--replace',
    ]);
    expectSuccess(manifest, 'init-manifest');
    expect(await readFile(fixture.manifest, 'utf8')).toContain('name: threadnote');

    const worksets = await runCli(fixture, ['workset', 'list']);
    expectSuccess(worksets, 'workset list');
    expect(worksets.stdout).toContain('No worksets defined');

    const seed = await runCli(fixture, ['seed']);
    expectSuccess(seed, 'seed');
    expect(seed.stdout).toMatch(/Seed complete: [1-9]\d* candidate/);
    const unchanged = await runCli(fixture, ['seed']);
    expectSuccess(unchanged, 'seed unchanged');
    expect(unchanged.stdout).toMatch(/[1-9]\d* unchanged/);

    const commands: readonly (readonly string[])[] = [
      ['doctor', '--dry-run'],
      ['install', '--dry-run', '--package-manager', 'pip', '--no-start'],
      ['repair', '--dry-run', '--package-manager', 'pip', '--mcp', 'none', '--no-start', '--no-post-update'],
      ['start', '--dry-run'],
      ['stop', '--dry-run'],
      ['uninstall', '--dry-run', '--mcp', 'none', '--preserve-memories'],
      ['seed-skills', '--dry-run'],
      ['migrate-memories', '--dry-run'],
      ['migrate-lifecycle', '--dry-run'],
      ['migrate-projects', '--dry-run'],
      ['migrate-project-names', '--dry-run'],
      ['post-update', '--dry-run', '--from-version', '1.9.0', '--to-version', '1.9.0'],
      ['pre-compact-hook', '--dry-run'],
      ['session-start-hook', '--dry-run'],
    ];
    for (const args of commands) {
      const result = await runCli(fixture, args, args[0] === 'pre-compact-hook' ? '{}\n' : undefined);
      expectSuccess(result, args.join(' '));
    }
    for (const agent of ['codex', 'claude', 'cursor', 'copilot']) {
      expectSuccess(await runCli(fixture, ['mcp-install', agent]), `mcp-install ${agent}`);
      expectSuccess(await runCli(fixture, ['install-hooks', agent, '--dry-run']), `install-hooks ${agent} --dry-run`);
    }
  });

  it('executes local-git share publish, artifact, sync, rename, unpublish, and removal flows', async () => {
    const fixture = await makeFixture('share');
    const remote = await makeBareRemote(fixture);
    const initialized = await runCli(fixture, [
      'share',
      'init',
      remote,
      '--team',
      'e2e-team',
      '--set-default',
      '--no-push',
    ]);
    expectSuccess(initialized, 'share init');
    expect(initialized.stdout).toContain('e2e-team');
    const listed = await runCli(fixture, ['share', 'list']);
    expectSuccess(listed, 'share list');
    expect(listed.stdout).toContain('e2e-team');

    const personalUri = 'viking://user/e2e/memories/durable/projects/e2e/share-memory.md';
    const sharedUri = 'viking://user/e2e/memories/shared/e2e-team/durable/projects/e2e/share-memory.md';
    expectSuccess(
      await runCli(fixture, [
        'remember',
        '--project',
        'e2e',
        '--topic',
        'share-memory',
        '--text',
        'Memory shared through a local git remote',
      ]),
      'remember for share',
    );
    const published = await runCli(fixture, ['share', 'publish', personalUri, '--team', 'e2e-team', '--no-push']);
    expectSuccess(published, 'share publish');
    expect(published.stdout).toContain(sharedUri);
    expect((await runCli(fixture, ['read', sharedUri])).stdout).toContain('Memory shared through a local git remote');
    expect((await runCli(fixture, ['read', personalUri])).code).not.toBe(0);

    const skillRoot = join(fixture.root, 'e2e-skill');
    const skillPath = join(skillRoot, 'SKILL.md');
    await mkdir(skillRoot, {recursive: true});
    await writeFile(skillPath, '# E2E skill\n\nSafe local-bin fixture.\n', 'utf8');
    const artifact = await runCli(fixture, [
      'share',
      'publish-artifact',
      skillPath,
      '--team',
      'e2e-team',
      '--agent',
      'codex',
      '--kind',
      'skill',
      '--name',
      'e2e-skill',
      '--no-push',
    ]);
    expectSuccess(artifact, 'share publish-artifact');
    expect(artifact.stdout).toContain('e2e-skill');
    const artifactInstall = await runCli(fixture, [
      'share',
      'install-artifacts',
      '--team',
      'e2e-team',
      '--agent',
      'codex',
      '--kind',
      'skill',
      '--name',
      'e2e-skill',
      '--dry-run',
      '--no-sync',
    ]);
    expectSuccess(artifactInstall, 'share install-artifacts --dry-run');
    expect(artifactInstall.stdout).toContain('e2e-skill');

    expectSuccess(await runCli(fixture, ['share', 'status', '--team', 'e2e-team']), 'share status');
    expectSuccess(await runCli(fixture, ['share', 'sync', '--team', 'e2e-team', '--no-push']), 'share sync --no-push');
    expectSuccess(await runCli(fixture, ['share', 'conflicts', '--team', 'e2e-team']), 'share conflicts');

    const unpublished = await runCli(fixture, ['share', 'unpublish', sharedUri, '--team', 'e2e-team', '--no-push']);
    expectSuccess(unpublished, 'share unpublish');
    expect((await runCli(fixture, ['read', personalUri])).stdout).toContain('Memory shared through a local git remote');
    expect((await runCli(fixture, ['read', sharedUri])).code).not.toBe(0);

    expectSuccess(
      await runCli(fixture, ['share', 'rename', '--team', 'e2e-team', '--to', 'renamed-team']),
      'share rename',
    );
    expectSuccess(await runCli(fixture, ['share', 'set-url', remote, '--team', 'renamed-team']), 'share set-url');
    expectSuccess(
      await runCli(fixture, ['share', 'remove', '--team', 'renamed-team', '--keep-files']),
      'share remove --keep-files',
    );
    const finalList = await runCli(fixture, ['share', 'list']);
    expectSuccess(finalList, 'share list after remove');
    expect(finalList.stdout).not.toContain('renamed-team');
  });

  it('runs the manager UI and authenticated read/write APIs, then finalizes on SIGINT', async () => {
    const fixture = await makeFixture('manager');
    expectSuccess(
      await runCli(fixture, [
        'remember',
        '--project',
        'e2e',
        '--topic',
        'manager-source',
        '--text',
        'Manager source memory',
      ]),
      'manager source memory',
    );
    const manager = await startManager(fixture);
    try {
      const page = await fetch(manager.url);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('Threadnote');

      const unauthorized = await fetch(`${manager.baseUrl}/api/tree`);
      expect(unauthorized.status).toBe(401);
      const tree = await managerFetch(manager, '/api/tree');
      expect(tree.status).toBe(200);
      expect(JSON.stringify(await tree.json())).toContain('manager-source.md');

      const saved = await managerFetch(manager, '/api/memory/save', {
        method: 'POST',
        body: JSON.stringify({project: 'e2e', text: 'Saved through manager API', topic: 'manager-api'}),
      });
      expect(saved.status).toBe(200);
      expect(JSON.stringify(await saved.json())).toContain('manager-api.md');
      const read = await managerFetch(
        manager,
        `/api/memory?uri=${encodeURIComponent('viking://user/e2e/memories/durable/projects/e2e/manager-api.md')}`,
      );
      expect(read.status).toBe(200);
      expect(JSON.stringify(await read.json())).toContain('Saved through manager API');
    } finally {
      manager.process.kill('SIGINT');
      const exit = await waitForExit(manager.process);
      expect(exit).toEqual({code: 130, signal: null});
    }
    await expect(fetch(manager.url)).rejects.toThrow();
  });

  it('runs opt-in Effect AI consolidation through the manager against an OpenAI-compatible endpoint', async () => {
    const fixture = await makeFixture('effect-ai');
    const sourceUris = [
      'viking://user/e2e/memories/durable/projects/e2e/ai-source-one.md',
      'viking://user/e2e/memories/durable/projects/e2e/ai-source-two.md',
    ];
    for (const [index, uri] of sourceUris.entries()) {
      const topic = uri.split('/').at(-1)?.replace(/\.md$/, '') ?? `source-${index}`;
      expectSuccess(
        await runCli(fixture, [
          'remember',
          '--project',
          'e2e',
          '--topic',
          topic,
          '--text',
          `Effect AI source ${index + 1}`,
        ]),
        `Effect AI source ${index + 1}`,
      );
    }
    const ai = await makeOpenAiCompatibleServer();
    fixture.env.THREADNOTE_EFFECT_AI = '1';
    fixture.env.THREADNOTE_EFFECT_AI_API_KEY = 'e2e-key';
    fixture.env.THREADNOTE_EFFECT_AI_API_URL = `${ai.baseUrl}/v1`;
    fixture.env.THREADNOTE_EFFECT_AI_MODEL = 'e2e-model';
    const manager = await startManager(fixture);
    try {
      const consolidation = await managerFetch(manager, '/api/consolidations', {
        method: 'POST',
        body: JSON.stringify({
          agent: 'effect-ai',
          kind: 'durable',
          project: 'e2e',
          topic: 'ai-consolidated',
          uris: sourceUris,
        }),
      });
      expect(consolidation.status).toBe(200);
      const body = (await consolidation.json()) as {
        readonly job: {readonly draft?: string; readonly error?: string; readonly id: string; readonly status: string};
      };
      expect(body.job, body.job.error).toMatchObject({
        draft: 'Consolidated by Effect AI E2E',
        status: 'completed',
      });
      expect(ai.requests).toHaveLength(1);
      expect(ai.requests[0]?.url).toBe('/v1/chat/completions');
      expect(ai.requests[0]?.authorization).toBe('Bearer e2e-key');

      const applied = await managerFetch(manager, `/api/consolidations/${body.job.id}/apply`, {
        method: 'POST',
        body: JSON.stringify({cleanup: 'keep', confirm: true}),
      });
      expect(applied.status).toBe(200);
      const consolidatedUri = 'viking://user/e2e/memories/durable/projects/e2e/ai-consolidated.md';
      const consolidated = await runCli(fixture, ['read', consolidatedUri]);
      expectSuccess(consolidated, 'read Effect AI consolidation');
      expect(consolidated.stdout).toContain('Consolidated by Effect AI E2E');
      for (const uri of sourceUris) expectSuccess(await runCli(fixture, ['read', uri]), `kept source ${uri}`);
    } finally {
      manager.process.kill('SIGINT');
      await waitForExit(manager.process);
      await ai.close();
    }
  });

  it('serves core and full MCP protocols through the packaged stdio bin', async () => {
    const fixture = await makeFixture('mcp');
    await withMcpClient(fixture, LIVE_OV.mcpUrl, 'core', async client => {
      const tools = await client.listTools();
      expect(tools.tools.map(tool => tool.name)).toEqual([
        'recall_context',
        'read_context',
        'list_context',
        'remember_context',
        'threadnote_guide',
        'share_publish',
      ]);
      const recallSchema = tools.tools.find(tool => tool.name === 'recall_context')?.inputSchema;
      expect(recallSchema).toMatchObject({
        additionalProperties: false,
        properties: {nodeLimit: {maximum: 100, minimum: 1, type: 'integer'}},
        type: 'object',
      });

      const stored = await callToolText(client, 'remember_context', {
        project: 'e2e',
        text: 'MCP local-bin memory',
        topic: 'mcp-bin',
      });
      expect(stored).toContain('mcp-bin.md');
      const uri = 'viking://user/e2e/memories/durable/projects/e2e/mcp-bin.md';
      expect(await callToolText(client, 'read_context', {uri})).toContain('MCP local-bin memory');
      expect(
        await callToolText(client, 'list_context', {
          recursive: true,
          uri: 'viking://user/e2e/memories/durable/projects/e2e',
        }),
      ).toContain(uri);
      expect(await callToolText(client, 'recall_context', {query: 'MCP local-bin memory'})).toContain(uri);

      const invalid = await client.callTool({arguments: {nodeLimit: 0, query: 'x'}, name: 'recall_context'});
      expect(invalid.isError).toBe(true);
      expect(textFromToolResult(invalid)).toContain('greater than or equal to 1');
    });

    await withMcpClient(fixture, LIVE_OV.mcpUrl, 'full', async client => {
      const tools = await client.listTools();
      expect(tools.tools.length).toBeGreaterThan(30);
      expect(tools.tools.map(tool => tool.name)).toContain('ov_health');
      expect(await callToolText(client, 'ov_health', {})).toMatch(/healthy|status|ok/i);
      expect(
        await callToolText(client, 'ov_search', {
          context_type: 'memory',
          query: 'MCP local-bin memory',
          target_uri: 'viking://user/e2e/memories',
        }),
      ).toContain('mcp-bin.md');
    });
  });

  it('packs, installs, and runs both launchers from the npm artifact', async () => {
    const fixture = await makeFixture('package');
    const pack = await runProcess('npm', ['pack', '--json', '--pack-destination', fixture.root], {
      cwd: REPO_ROOT,
      env: fixture.env,
      timeoutMs: 120_000,
    });
    expectSuccess(pack, 'npm pack');
    const jsonStart = pack.stdout.search(/\[\s*\{/);
    expect(jsonStart, `npm pack did not emit JSON:\n${pack.stdout}`).toBeGreaterThanOrEqual(0);
    const packResult = JSON.parse(pack.stdout.slice(jsonStart)) as readonly {
      filename: string;
      files: readonly {path: string}[];
    }[];
    const packed = packResult[0];
    expect(packed?.files.map(file => file.path)).toEqual(
      expect.arrayContaining([
        'bin/threadnote.cjs',
        'bin/threadnote-mcp-server.cjs',
        'dist/threadnote.js',
        'dist/mcp_server.js',
      ]),
    );
    const tarball = join(fixture.root, packed?.filename ?? '');
    const installRoot = join(fixture.root, 'installed');
    await mkdir(installRoot, {recursive: true});
    await writeFile(join(installRoot, 'package.json'), '{"private":true}\n', 'utf8');
    const installed = await runProcess(
      'npm',
      ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', tarball],
      {cwd: installRoot, env: fixture.env, timeoutMs: 120_000},
    );
    expectSuccess(installed, 'npm install tarball');

    const installedCli = join(installRoot, 'node_modules', '.bin', 'threadnote');
    const installedVersion = await runProcess(installedCli, ['--version'], {cwd: installRoot, env: fixture.env});
    expectSuccess(installedVersion, 'installed threadnote --version');
    expect(installedVersion.stdout).toMatch(/^threadnote v\d+\.\d+\.\d+/m);

    const installedMcp = join(installRoot, 'node_modules', 'threadnote', 'bin', 'threadnote-mcp-server.cjs');
    await withMcpClient(
      fixture,
      LIVE_OV.mcpUrl,
      'core',
      async client => {
        expect((await client.listTools()).tools.map(tool => tool.name)).toContain('threadnote_guide');
      },
      installedMcp,
    );
  });
});

async function startLiveOpenViking(): Promise<LiveOpenViking> {
  const root = await mkdtemp(join(tmpdir(), 'threadnote-bin-e2e-openviking-'));
  const home = join(root, 'home');
  const serverConfig = join(home, 'ov.conf');
  const cliConfig = join(home, 'ovcli.conf');
  const version = await pinnedOpenVikingVersion();
  const ov = process.env.THREADNOTE_E2E_OV?.trim() || 'ov';
  const serverCommand = process.env.THREADNOTE_E2E_OPENVIKING_SERVER?.trim() || 'openviking-server';
  const cliVersion = await runProcess(ov, ['version'], {timeoutMs: 15_000});
  if (cliVersion.code !== 0) {
    await rm(root, {force: true, recursive: true});
    throw new Error(
      `OpenViking CLI is required for local-bin E2E. Run npm run test:e2e:install-openviking first.\n${cliVersion.stderr}`,
    );
  }
  const installedVersion = /^\s*CLI:\s*(\S+)/m.exec(cliVersion.stdout)?.[1];
  if (installedVersion !== version) {
    await rm(root, {force: true, recursive: true});
    throw new Error(
      `OpenViking CLI ${installedVersion ?? 'unknown'} does not match Threadnote pin ${version}. Run npm run test:e2e:install-openviking.`,
    );
  }

  const port = await freeTcpPort();
  await mkdir(home, {recursive: true});
  await writeFile(
    serverConfig,
    `${JSON.stringify(
      {
        auto_generate_l0: false,
        auto_generate_l1: false,
        default_account: 'local',
        default_agent: 'threadnote',
        default_user: 'e2e',
        server: {host: '127.0.0.1', port},
        storage: {workspace: join(home, 'data')},
      },
      undefined,
      2,
    )}\n`,
    {encoding: 'utf8', mode: 0o600},
  );
  await writeFile(
    cliConfig,
    `${JSON.stringify(
      {
        account: 'local',
        agent_id: 'threadnote',
        timeout: 60,
        url: `http://127.0.0.1:${port}`,
        user: 'e2e',
      },
      undefined,
      2,
    )}\n`,
    {encoding: 'utf8', mode: 0o600},
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPENVIKING_CLI_CONFIG_FILE: cliConfig,
    OPENVIKING_CONFIG_FILE: serverConfig,
    THREADNOTE_ACCOUNT: 'local',
    THREADNOTE_AGENT_ID: 'threadnote',
    THREADNOTE_HOME: home,
    THREADNOTE_HOST: '127.0.0.1',
    THREADNOTE_OPENVIKING_MCP_URL: `http://127.0.0.1:${port}/mcp`,
    THREADNOTE_OPENVIKING_VERSION: version,
    THREADNOTE_OV: ov,
    THREADNOTE_PORT: String(port),
    THREADNOTE_USER: 'e2e',
  };
  const server = spawn(
    serverCommand,
    ['--config', serverConfig, '--host', '127.0.0.1', '--port', String(port), '--workers', '1'],
    {cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe']},
  );
  let output = '';
  server.stdout?.on('data', chunk => (output += chunk.toString('utf8')));
  server.stderr?.on('data', chunk => (output += chunk.toString('utf8')));
  try {
    const deadline = Date.now() + 90_000;
    let health: {readonly version?: string} | undefined;
    while (Date.now() < deadline) {
      if (server.exitCode !== null || server.signalCode !== null) {
        throw new Error(`OpenViking server exited during startup.\n${output}`);
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`);
        if (response.ok) {
          health = (await response.json()) as {readonly version?: string};
          break;
        }
      } catch {
        // Startup commonly refuses connections until storage and embeddings are ready.
      }
      await new Promise(resolveWait => setTimeout(resolveWait, 250));
    }
    if (!health) throw new Error(`OpenViking server did not become healthy.\n${output}`);
    if (health.version !== version) {
      throw new Error(`OpenViking server ${health.version ?? 'unknown'} does not match Threadnote pin ${version}.`);
    }
    return {
      cliConfig,
      env,
      home,
      mcpUrl: `http://127.0.0.1:${port}/mcp`,
      ov,
      port,
      process: server,
      root,
      serverConfig,
      version,
    };
  } catch (cause: unknown) {
    server.kill('SIGKILL');
    await rm(root, {force: true, recursive: true});
    throw cause;
  }
}

async function stopLiveOpenViking(live: LiveOpenViking): Promise<void> {
  if (live.process.exitCode === null && live.process.signalCode === null) {
    live.process.kill('SIGTERM');
    await Promise.race([
      new Promise<void>(resolveExit => live.process.once('exit', () => resolveExit())),
      new Promise<void>(resolveTimeout =>
        setTimeout(() => {
          live.process.kill('SIGKILL');
          resolveTimeout();
        }, 10_000),
      ),
    ]);
  }
  await rm(live.root, {force: true, recursive: true});
  await expect(stat(live.root)).rejects.toMatchObject({code: 'ENOENT'});
}

async function pinnedOpenVikingVersion(): Promise<string> {
  const source = await readFile(join(REPO_ROOT, 'src', 'constants.ts'), 'utf8');
  const version = /DEFAULT_OPENVIKING_VERSION\s*=\s*'([^']+)'/.exec(source)?.[1];
  if (!version) throw new Error('Could not read DEFAULT_OPENVIKING_VERSION from src/constants.ts.');
  return version;
}

async function freeTcpPort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolveListen();
    });
  });
  const address = server.address() as AddressInfo;
  await new Promise<void>((resolveClose, reject) => server.close(error => (error ? reject(error) : resolveClose())));
  return address.port;
}

async function makeFixture(name: string): Promise<TestFixture> {
  const root = await mkdtemp(join(tmpdir(), `threadnote-bin-e2e-${name}-`));
  TEMP_ROOTS.push(root);
  const home = LIVE_OV.home;
  const manifest = join(root, 'seed-manifest.yaml');
  return {
    env: {
      ...process.env,
      ...LIVE_OV.env,
      CI: '1',
      GIT_AUTHOR_EMAIL: 'threadnote-e2e@example.com',
      GIT_AUTHOR_NAME: 'Threadnote E2E',
      GIT_COMMITTER_EMAIL: 'threadnote-e2e@example.com',
      GIT_COMMITTER_NAME: 'Threadnote E2E',
      NO_COLOR: '1',
      NO_UPDATE_NOTIFIER: '1',
      THREADNOTE_ACCOUNT: 'local',
      THREADNOTE_AGENT_ID: 'threadnote',
      THREADNOTE_HOME: home,
      THREADNOTE_MANIFEST: manifest,
      THREADNOTE_MCP_TOOLSET: 'core',
      THREADNOTE_NO_UPDATE_CHECK: '1',
      THREADNOTE_OV: LIVE_OV.ov,
      THREADNOTE_USER: 'e2e',
    },
    home,
    manifest,
    root,
  };
}

async function makeBareRemote(fixture: TestFixture): Promise<string> {
  const remote = join(fixture.root, 'shared.git');
  const seed = join(fixture.root, 'shared-seed');
  await mkdir(seed, {recursive: true});
  for (const [args, cwd] of [
    [['init', '--bare', remote], fixture.root],
    [['init'], seed],
    [['checkout', '-b', 'main'], seed],
    [['config', 'user.email', 'threadnote-e2e@example.com'], seed],
    [['config', 'user.name', 'Threadnote E2E'], seed],
  ] as const) {
    expectSuccess(await runProcess('git', args, {cwd, env: fixture.env}), `git ${args.join(' ')}`);
  }
  await writeFile(join(seed, 'README.md'), '# Threadnote E2E shared memories\n', 'utf8');
  for (const args of [
    ['add', 'README.md'],
    ['commit', '-m', 'initial'],
    ['remote', 'add', 'origin', remote],
    ['push', '-u', 'origin', 'main'],
  ] as const) {
    expectSuccess(await runProcess('git', args, {cwd: seed, env: fixture.env}), `git ${args.join(' ')}`);
  }
  expectSuccess(
    await runProcess('git', ['--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main'], {
      cwd: fixture.root,
      env: fixture.env,
    }),
    'git set bare HEAD',
  );
  return remote;
}

async function runCli(fixture: TestFixture, args: readonly string[], input?: string): Promise<ProcessResult> {
  return runProcess(process.execPath, [CLI_BIN, '--home', fixture.home, ...args], {
    cwd: REPO_ROOT,
    env: fixture.env,
    input,
  });
}

async function expectCliFailure(fixture: TestFixture, args: readonly string[], message: string): Promise<void> {
  const result = await runCli(fixture, args);
  expect(result.code, result.stdout + result.stderr).toBe(1);
  expect(result.stderr).toContain(message);
  expect(result.stderr).not.toContain('FiberFailure');
}

function expectSuccess(result: ProcessResult, operation: string): void {
  expect(result.code, `${operation} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
}

async function runProcess(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly input?: string;
    readonly timeoutMs?: number;
  } = {},
): Promise<ProcessResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? REPO_ROOT,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    let stdout = '';
    child.stdout.on('data', chunk => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', chunk => (stderr += chunk.toString('utf8')));
    child.once('error', reject);
    const timeout = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 30_000);
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolveResult({code, signal, stderr, stdout});
    });
    child.stdin.end(options.input);
  });
}

interface RunningManager {
  readonly baseUrl: string;
  readonly process: ChildProcess;
  readonly token: string;
  readonly url: string;
}

async function startManager(fixture: TestFixture): Promise<RunningManager> {
  const child = spawn(process.execPath, [CLI_BIN, '--home', fixture.home, 'manage', '--ui-port', '0', '--no-open'], {
    cwd: REPO_ROOT,
    env: fixture.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const url = await new Promise<string>((resolveUrl, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`Manager did not start:\n${output}`)), 15_000);
    const consume = (chunk: Buffer): void => {
      output += chunk.toString('utf8');
      const match = /Threadnote manager: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/.exec(output);
      if (match?.[1]) {
        clearTimeout(timeout);
        resolveUrl(match[1]);
      }
    };
    child.stdout?.on('data', consume);
    child.stderr?.on('data', consume);
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`Manager exited before startup: code=${code} signal=${signal}\n${output}`));
    });
  });
  const parsed = new URL(url);
  const token = parsed.searchParams.get('token');
  if (!token) throw new Error(`Manager URL did not contain a token: ${url}`);
  return {baseUrl: parsed.origin, process: child, token, url};
}

function managerFetch(manager: RunningManager, path: string, options: RequestInit = {}): Promise<Response> {
  return fetch(`${manager.baseUrl}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${manager.token}`,
      ...(options.body ? {'content-type': 'application/json'} : {}),
      ...options.headers,
    },
  });
}

async function waitForExit(
  process: ChildProcess,
): Promise<{readonly code: number | null; readonly signal: NodeJS.Signals | null}> {
  return new Promise((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      process.kill('SIGKILL');
      reject(new Error('Process did not exit after SIGINT.'));
    }, 15_000);
    process.once('exit', (code, signal) => {
      clearTimeout(timeout);
      resolveExit({code, signal});
    });
  });
}

async function withMcpClient<T>(
  fixture: TestFixture,
  nativeMcpUrl: string,
  toolset: 'core' | 'full',
  use: (client: Client) => Promise<T>,
  mcpBin = MCP_BIN,
): Promise<T> {
  const transport = new StdioClientTransport({
    args: [mcpBin],
    command: process.execPath,
    cwd: REPO_ROOT,
    env: {
      ...fixture.env,
      THREADNOTE_MCP_TOOLSET: toolset,
      THREADNOTE_OPENVIKING_MCP_URL: nativeMcpUrl,
    } as Record<string, string>,
    stderr: 'pipe',
  });
  const client = new Client({name: 'threadnote-local-bin-e2e', version: '1.0.0'});
  try {
    await client.connect(transport);
    return await use(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function callToolText(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({arguments: args, name}, undefined, {timeout: 10_000});
  const text = textFromToolResult(result);
  expect(result.isError, `${name} failed: ${text}`).not.toBe(true);
  return text;
}

function textFromToolResult(result: unknown): string {
  const content =
    typeof result === 'object' && result !== null && 'content' in result
      ? (result as {readonly content?: unknown}).content
      : undefined;
  return Array.isArray(content)
    ? (content as TextContent[])
        .filter(item => item.type === 'text')
        .map(item => item.text)
        .join('\n')
    : '';
}

async function makeOpenAiCompatibleServer(): Promise<{
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
  readonly requests: Array<{readonly authorization?: string; readonly body: unknown; readonly url?: string}>;
}> {
  const requests: Array<{readonly authorization?: string; readonly body: unknown; readonly url?: string}> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const bodyText = Buffer.concat(chunks).toString('utf8');
    requests.push({
      authorization: typeof request.headers.authorization === 'string' ? request.headers.authorization : undefined,
      body: bodyText ? JSON.parse(bodyText) : undefined,
      url: request.url,
    });
    if (request.url !== '/v1/chat/completions') {
      response.writeHead(404, {'content-type': 'application/json'}).end(JSON.stringify({error: 'not found'}));
      return;
    }
    response.writeHead(200, {'content-type': 'application/json'}).end(
      JSON.stringify({
        choices: [
          {
            finish_reason: 'stop',
            index: 0,
            message: {content: JSON.stringify({draft: 'Consolidated by Effect AI E2E'}), role: 'assistant'},
          },
        ],
        created: Math.floor(Date.now() / 1000),
        id: 'chatcmpl-threadnote-e2e',
        model: 'e2e-model',
        object: 'chat.completion',
        usage: {completion_tokens: 10, prompt_tokens: 20, total_tokens: 30},
      }),
    );
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolveListen();
    });
  });
  const address = server.address() as AddressInfo;
  return {baseUrl: `http://127.0.0.1:${address.port}`, close: () => closeServer(server), requests};
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, reject) => server.close(error => (error ? reject(error) : resolveClose())));
}
