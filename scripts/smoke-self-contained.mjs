import {execFileSync, spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const root = join(import.meta.dirname, '..');
const temporaryRoot = mkdtempSync(join(tmpdir(), 'threadnote-self-contained-'));
const home = join(temporaryRoot, 'home');
const userHome = join(temporaryRoot, 'user-home');
const installRoot = join(temporaryRoot, 'install');
const packRoot = join(temporaryRoot, 'pack');
const runRoot = join(temporaryRoot, 'run');
mkdirSync(home, {recursive: true});
mkdirSync(userHome, {recursive: true});
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
  HOME: userHome,
  NVM_DIR: '',
  NVM_HOME: '',
  PATH: dirname(process.execPath),
  THREADNOTE_HOME: home,
  THREADNOTE_USER: 'self-contained-smoke',
  USERPROFILE: userHome,
};
const coreEmbeddingModelId = 'bge-small-en-v1.5-q8';
const longContextTokenCount = process.platform === 'win32' ? 180 : 900;
const realModelTimeoutMs = 300_000;
let smokeFailure;

try {
  const version = run(['--version']);
  if (!version.includes('4.0.0')) throw new Error(`Installed CLI shim reported an unexpected version:\n${version}`);
  mkdirSync(join(home, 'cache'), {recursive: true});
  writeFileSync(join(home, 'cache', 'recall-index-v6.json'), '{"legacy":true}\n');
  const install = run(['install']);
  if (!install.includes(`${coreEmbeddingModelId}: core embedding model verified`)) {
    throw new Error(`Clean install did not provision the core embedding model:\n${install}`);
  }
  const initial = assertCoreRecallArtifacts();
  const longContext = Array.from(
    {length: longContextTokenCount},
    (_, index) => `QZ9-long-context-token-${String(index).padStart(4, '0')}`,
  ).join(' ');
  run(
    ['remember', '--kind', 'durable', '--project', 'threadnote', '--topic', 'self-contained-smoke', '--stdin'],
    `QZ9 native canonical storage works without an external runtime.\n\n${longContext}`,
  );
  const recall = run(['recall', '--query', 'QZ9 self contained native canonical storage']);
  if (!recall.includes('self-contained-smoke')) throw new Error(`Recall smoke missed stored memory:\n${recall}`);
  const refreshedGeneration = activeVectorGeneration();
  if (refreshedGeneration === initial.vectorGeneration) {
    throw new Error('Recall did not refresh the vector index after storing a canonical memory.');
  }
  assertActiveVectorSidecar(refreshedGeneration);

  const repeatInstall = run(['install']);
  if (!repeatInstall.includes(`${coreEmbeddingModelId}: core embedding model verified`)) {
    throw new Error(`Repeat install did not verify the existing core model:\n${repeatInstall}`);
  }
  if (statSync(initial.modelPath).mtimeMs !== initial.modelModifiedAt) {
    throw new Error('Repeat install replaced or modified an already installed core embedding model.');
  }
  if (activeVectorGeneration() !== refreshedGeneration) {
    throw new Error('Repeat install unnecessarily replaced an already current vector generation.');
  }

  const doctor = run(['doctor']);
  for (const required of [
    /OK\s+lexical recall index:/,
    new RegExp(`OK\\s+embedding model: ${coreEmbeddingModelId}`),
    /OK\s+vector recall index:/,
    /(?:OK|WARN)\s+.*MCP/i,
    /OK\s+codex user instructions:/,
  ]) {
    if (!required.test(doctor)) throw new Error(`Doctor omitted a core release check (${required}):\n${doctor}`);
  }
  const runtime = run(['models', 'runtime']);
  if (!/node-llama-cpp:\s+prebuilt/i.test(runtime)) {
    throw new Error(`Native runtime did not report a prebuilt binary:\n${runtime}`);
  }
  await verifyMcpShim();
  process.stdout.write('Self-contained clean-home smoke passed with a restricted PATH.\n');
} catch (error) {
  smokeFailure = error;
  throw error;
} finally {
  try {
    rmSync(temporaryRoot, {force: true, maxRetries: 10, recursive: true, retryDelay: 200});
  } catch (cleanupError) {
    if (!smokeFailure) throw cleanupError;
    process.stderr.write(`Temporary smoke cleanup also failed: ${String(cleanupError)}\n`);
  }
}

function run(args, input) {
  return execFileSync(cliShim, args, {
    cwd: runRoot,
    encoding: 'utf8',
    env: environment,
    input,
    shell: process.platform === 'win32',
    timeout: realModelTimeoutMs,
  });
}

function assertCoreRecallArtifacts() {
  const lexicalDatabase = join(home, 'indexes', 'lexical', 'active-v2.sqlite');
  if (!existsSync(lexicalDatabase) || statSync(lexicalDatabase).size === 0) {
    throw new Error('Clean install did not create a populated lexical SQLite index.');
  }
  if (existsSync(join(home, 'cache', 'recall-index-v6.json'))) {
    throw new Error('Clean install left the legacy monolithic lexical JSON cache active.');
  }
  const selection = JSON.parse(readFileSync(join(home, 'models', 'selection.json'), 'utf8'));
  if (selection?.roles?.embedding !== coreEmbeddingModelId) {
    throw new Error(`Clean install selected an unexpected embedding model: ${JSON.stringify(selection)}`);
  }
  const modelRoot = join(home, 'models', 'embedding', coreEmbeddingModelId);
  const receipt = JSON.parse(readFileSync(join(modelRoot, 'manifest.json'), 'utf8'));
  const modelPath = join(modelRoot, `${receipt.sha256}.gguf`);
  const installed = statSync(modelPath);
  if (installed.size !== receipt.size) {
    throw new Error(`Installed core model has ${installed.size} bytes; expected ${receipt.size}.`);
  }
  const vectorGeneration = activeVectorGeneration();
  assertActiveVectorSidecar(vectorGeneration);
  const files = readdirSync(home, {recursive: true});
  if (files.some(file => /\.py$|server\.pid|server\.lock|ov\.conf/i.test(String(file)))) {
    throw new Error('Clean Threadnote home contains a Python, daemon, or OpenViking runtime artifact.');
  }
  return {modelModifiedAt: installed.mtimeMs, modelPath, vectorGeneration};
}

function activeVectorGeneration() {
  const pointer = JSON.parse(
    readFileSync(join(home, 'indexes', 'vectors', coreEmbeddingModelId, 'active.json'), 'utf8'),
  );
  if (typeof pointer?.generation !== 'string' || pointer.generation.length === 0) {
    throw new Error(`Vector index pointer is invalid: ${JSON.stringify(pointer)}`);
  }
  return pointer.generation;
}

function assertActiveVectorSidecar(generation) {
  const sidecar = join(home, 'indexes', 'vectors', coreEmbeddingModelId, 'generations', generation, 'vectors.bin');
  if (!existsSync(sidecar) || statSync(sidecar).size === 0) {
    throw new Error(`Vector index generation ${generation} has no sidecar.`);
  }
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
    const recalled = await client.callTool(
      {
        arguments: {
          query: 'QZ9 native canonical storage',
          threshold: 0.1,
          uri: 'threadnote://user/self-contained-smoke/memories/durable/projects/threadnote',
        },
        name: 'recall_context',
      },
      undefined,
      {timeout: realModelTimeoutMs},
    );
    const text = (recalled.content ?? []).map(item => ('text' in item ? item.text : '')).join('\n');
    if (recalled.isError === true || !text.includes('self-contained-smoke.md')) {
      throw new Error(`Installed MCP recall did not find the canonical memory:\n${text}`);
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
