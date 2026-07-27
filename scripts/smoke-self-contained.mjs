import {execFileSync, spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const root = join(import.meta.dirname, '..');
const temporaryRoot = mkdtempSync(join(tmpdir(), 'threadnote-self-contained-'));
const home = join(temporaryRoot, 'home');
const installRoot = join(temporaryRoot, 'install');
const packRoot = join(temporaryRoot, 'pack');
const runRoot = join(temporaryRoot, 'run');
mkdirSync(home, {recursive: true});
mkdirSync(installRoot, {recursive: true});
mkdirSync(packRoot, {recursive: true});
mkdirSync(runRoot, {recursive: true});
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('npm_execpath is required for the package smoke test.');
const packOutput = runNpm(['pack', '--ignore-scripts', '--json', '--pack-destination', packRoot], root);
const packResult = JSON.parse(packOutput);
const filename = Array.isArray(packResult) ? packResult[0]?.filename : undefined;
if (typeof filename !== 'string' || !filename.endsWith('.tgz')) {
  throw new Error(`npm pack did not report a tarball filename:\n${packOutput}`);
}
const tarball = join(packRoot, filename);
const installOutput = runNpm(
  [
    'install',
    '--foreground-scripts',
    '--loglevel=notice',
    '--node-llama-cpp-postinstall=skip',
    '--omit=dev',
    '--no-audit',
    '--no-fund',
    '--prefix',
    installRoot,
    tarball,
  ],
  runRoot,
  true,
);
if (!/Skipping node-llama-cpp postinstall.*skip.*configuration/i.test(installOutput)) {
  throw new Error(`node-llama-cpp did not honor Threadnote's install-time skip policy:\n${installOutput}`);
}
const binRoot = join(installRoot, 'node_modules', '.bin');
const cliShim = join(binRoot, process.platform === 'win32' ? 'threadnote.cmd' : 'threadnote');
const mcpShim = join(binRoot, process.platform === 'win32' ? 'threadnote-mcp-server.cmd' : 'threadnote-mcp-server');
const environment = {
  ...process.env,
  PATH: dirname(process.execPath),
  THREADNOTE_HOME: home,
  THREADNOTE_USER: 'self-contained-smoke',
};

try {
  const version = run(['--version']);
  if (!version.includes('4.0.0')) throw new Error(`Installed CLI shim reported an unexpected version:\n${version}`);
  run(['install']);
  run([
    'remember',
    '--kind',
    'durable',
    '--project',
    'threadnote',
    '--topic',
    'self-contained-smoke',
    '--text',
    'Native canonical storage works without an external runtime.',
  ]);
  const recall = run(['recall', '--query', 'self contained native canonical storage']);
  if (!recall.includes('self-contained-smoke')) throw new Error(`Recall smoke missed stored memory:\n${recall}`);
  const runtime = run(['models', 'runtime']);
  if (!/node-llama-cpp:\s+prebuilt/i.test(runtime)) {
    throw new Error(`Native runtime did not report a prebuilt binary:\n${runtime}`);
  }
  await verifyMcpShim();
  process.stdout.write('Self-contained clean-home smoke passed with a restricted PATH.\n');
} finally {
  rmSync(temporaryRoot, {force: true, recursive: true});
}

function run(args) {
  return execFileSync(cliShim, args, {
    cwd: runRoot,
    encoding: 'utf8',
    env: environment,
    shell: process.platform === 'win32',
    timeout: 60_000,
  });
}

async function verifyMcpShim() {
  const windows = process.platform === 'win32';
  const transport = new StdioClientTransport({
    command: windows ? (process.env.ComSpec ?? 'cmd.exe') : mcpShim,
    args: windows ? ['/d', '/s', '/c', `call "${mcpShim}"`] : [],
    cwd: runRoot,
    env: environment,
    stderr: 'pipe',
  });
  const client = new Client({name: 'threadnote-self-contained-smoke', version: '1.0.0'});
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    if (!tools.tools.some(tool => tool.name === 'recall_context')) {
      throw new Error('Installed MCP shim did not expose recall_context.');
    }
  } finally {
    await client.close();
  }
}

function runNpm(args, cwd, includeStderr = false) {
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd,
    encoding: 'utf8',
    env: process.env,
    timeout: 180_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`npm ${args[0] ?? 'command'} failed with ${result.status}:\n${result.stdout}${result.stderr}`);
  }
  return includeStderr ? `${result.stdout}${result.stderr}` : result.stdout;
}
