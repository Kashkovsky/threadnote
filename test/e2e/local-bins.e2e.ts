import {mkdtemp, readdir, readFile, rm} from 'node:fs/promises';
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
let home: string;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'threadnote-native-e2e-'));
});

afterAll(async () => {
  await rm(home, {force: true, recursive: true});
});

describe('built self-contained distribution', () => {
  it('initializes the owned home without server or interpreter artifacts', async () => {
    const output = await runCli(['install']);
    expect(output).toContain('Install complete');
    const files = await readdir(home, {recursive: true});
    expect(files).toContain('layout.json');
    expect(files.some(file => /\.py$|server\.pid|server\.lock|ov\.conf/i.test(file))).toBe(false);
  });

  it('stores and recalls canonical memory through built launchers', async () => {
    await runCli([
      'remember',
      '--kind',
      'durable',
      '--project',
      'threadnote',
      '--topic',
      'native-e2e',
      '--text',
      'QZ9 native recall survives without a background service.',
    ]);
    const recall = await runCli(['recall', '--query', 'QZ9 native recall background service']);
    expect(recall).toContain('native-e2e.md');
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

  it('loads only the prebuilt node-llama runtime', async () => {
    await expect(runCli(['models', 'runtime'])).resolves.toMatch(/node-llama-cpp:\s+prebuilt/i);
  });

  it('serves native core and full MCP toolsets over stdio', async () => {
    const transport = new StdioClientTransport({
      args: [join(root, 'bin', 'threadnote-mcp-server.cjs')],
      command: process.execPath,
      cwd: root,
      env: {
        ...process.env,
        THREADNOTE_HOME: home,
        THREADNOTE_MCP_TOOLSET: 'full',
        THREADNOTE_USER: 'e2e-user',
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
    } finally {
      await client.close();
    }
  });
});

async function runCli(args: readonly string[]): Promise<string> {
  const result = await execute(process.execPath, [cli, '--home', home, ...args], {
    cwd: root,
    env: {...process.env, THREADNOTE_USER: 'e2e-user'},
    timeout: 60_000,
  });
  return `${result.stdout}${result.stderr}`;
}
