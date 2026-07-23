import {spawn} from 'node:child_process';
import {access, mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {delimiter, dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {Effect} from 'effect';
import {expect, it, vi} from 'vitest';
import {resolveCommandInvocation, terminateCommandProcess} from '../../src/effect/command.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {runUpdate} from '../../src/update.js';
import type {RuntimeConfig} from '../../src/types.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const windowsIt = process.platform === 'win32' ? it : it.skip;

interface ProcessResult {
  readonly code: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

interface CandidateReview {
  readonly candidates: readonly {readonly candidateId: string}[];
  readonly reviewId: string;
  readonly revision: number;
}

interface TextContent {
  readonly text: string;
  readonly type: 'text';
}

windowsIt('forwards PowerShell bootstrap switches and explicit package managers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'threadnote bootstrap options '));
  const fakeBin = join(root, 'fake bin');
  const prefix = join(root, 'npm prefix');
  const log = join(root, 'bootstrap.log');
  const npm = join(fakeBin, 'npm.cmd');
  const threadnote = join(prefix, 'threadnote.cmd');
  const powershellBin = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: join(root, 'home'),
    PATH: [fakeBin, powershellBin].join(delimiter),
    THREADNOTE_E2E_BOOTSTRAP_LOG: log,
    THREADNOTE_E2E_FAKE_PREFIX: prefix,
    USERPROFILE: join(root, 'home'),
  };
  try {
    await mkdir(fakeBin, {recursive: true});
    await mkdir(prefix, {recursive: true});
    await writeFile(
      npm,
      '@ECHO off\r\n@ECHO npm %*>>"%THREADNOTE_E2E_BOOTSTRAP_LOG%"\r\n@if /I "%~1"=="prefix" @ECHO %THREADNOTE_E2E_FAKE_PREFIX%\r\n',
    );
    await writeFile(threadnote, '@ECHO off\r\n@ECHO threadnote %*>>"%THREADNOTE_E2E_BOOTSTRAP_LOG%"\r\n@exit /b 0\r\n');

    for (const manager of ['pip', 'pipx']) {
      expectSuccess(await runBootstrap(env, ['-DryRun', '-NoStart', '-PackageManager', manager]), manager);
    }
    await writeFile(join(fakeBin, 'uv.cmd'), '@ECHO off\r\n@exit /b 0\r\n');
    expectSuccess(await runBootstrap(env, ['-DryRun', '-Force', '-WithHooks', '-PackageManager', 'uv']), 'uv');

    const calls = await readFile(log, 'utf8');
    expect(calls).toContain('threadnote install --dry-run --no-start --package-manager pip');
    expect(calls).toContain('threadnote install --dry-run --no-start --package-manager pipx');
    expect(calls).toContain('threadnote install --dry-run --force --with-hooks --package-manager uv');
  } finally {
    await rm(root, {force: true, recursive: true});
  }
});

windowsIt('updates and repairs through native runtime launchers outside the installed bin path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'threadnote windows update '));
  const fakeBin = join(root, 'runtime launchers');
  const npmPrefix = join(root, 'npm prefix');
  const denoInstall = join(root, 'deno install');
  const denoBin = join(denoInstall, 'bin');
  const log = join(root, 'update.log');
  const originalPath = process.env.PATH;
  const originalDenoInstallRoot = process.env.DENO_INSTALL_ROOT;
  const originalDenoInstall = process.env.DENO_INSTALL;
  const originalNpmPrefix = process.env.THREADNOTE_E2E_NPM_PREFIX;
  const originalUpdateLog = process.env.THREADNOTE_E2E_UPDATE_LOG;
  const config: RuntimeConfig = {
    account: 'local',
    agentContextHome: root,
    agentId: 'threadnote',
    host: '127.0.0.1',
    manifestPath: join(root, 'seed-manifest.yaml'),
    openVikingVersion: '0.4.10',
    port: 1933,
    user: 'windows-update-e2e',
  };
  try {
    await mkdir(fakeBin, {recursive: true});
    await mkdir(npmPrefix, {recursive: true});
    await mkdir(denoBin, {recursive: true});
    await writeFile(
      join(fakeBin, 'npm.cmd'),
      '@ECHO off\r\n@ECHO npm %*>>"%THREADNOTE_E2E_UPDATE_LOG%"\r\n@if /I "%~1"=="prefix" @ECHO %THREADNOTE_E2E_NPM_PREFIX%\r\n@exit /b 0\r\n',
    );
    await writeFile(
      join(fakeBin, 'deno.cmd'),
      '@ECHO off\r\n@ECHO deno %* registry=%NPM_CONFIG_REGISTRY%>>"%THREADNOTE_E2E_UPDATE_LOG%"\r\n@exit /b 0\r\n',
    );
    await writeFile(
      join(npmPrefix, 'threadnote.cmd'),
      '@ECHO off\r\n@ECHO npm-threadnote %*>>"%THREADNOTE_E2E_UPDATE_LOG%"\r\n@exit /b 0\r\n',
    );
    await writeFile(
      join(denoBin, 'threadnote.cmd'),
      '@ECHO off\r\n@ECHO deno-threadnote %*>>"%THREADNOTE_E2E_UPDATE_LOG%"\r\n@exit /b 0\r\n',
    );
    process.env.PATH = [fakeBin, originalPath ?? ''].join(delimiter);
    process.env.DENO_INSTALL_ROOT = denoInstall;
    delete process.env.DENO_INSTALL;
    process.env.THREADNOTE_E2E_NPM_PREFIX = npmPrefix;
    process.env.THREADNOTE_E2E_UPDATE_LOG = log;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes('api.github.com')) {
          return Response.json([]);
        }
        if (url.endsWith('/beta')) {
          return Response.json({version: '99.0.0-beta.1'});
        }
        if (url.endsWith('/latest')) {
          return Response.json({version: '99.0.0'});
        }
        return new Response('Not found', {status: 404});
      }),
    );

    await Effect.runPromise(
      runUpdate(config, {postUpdate: false, runtime: 'npm'}).pipe(Effect.provide(ApplicationLayer)),
    );
    await Effect.runPromise(
      runUpdate(config, {postUpdate: false, runtime: 'deno'}).pipe(Effect.provide(ApplicationLayer)),
    );

    const calls = await readFile(log, 'utf8');
    expect(calls).toContain('npm install --global');
    expect(calls).toContain('--registry=https://registry.npmjs.org/');
    expect(calls).toContain('npm-threadnote repair --no-post-update');
    expect(calls).toContain('deno install --global');
    expect(calls).toContain('registry=https://registry.npmjs.org/');
    expect(calls).toContain('deno-threadnote repair --no-post-update');
  } finally {
    vi.unstubAllGlobals();
    process.env.PATH = originalPath;
    if (originalDenoInstallRoot === undefined) {
      delete process.env.DENO_INSTALL_ROOT;
    } else {
      process.env.DENO_INSTALL_ROOT = originalDenoInstallRoot;
    }
    if (originalDenoInstall === undefined) {
      delete process.env.DENO_INSTALL;
    } else {
      process.env.DENO_INSTALL = originalDenoInstall;
    }
    if (originalNpmPrefix === undefined) {
      delete process.env.THREADNOTE_E2E_NPM_PREFIX;
    } else {
      process.env.THREADNOTE_E2E_NPM_PREFIX = originalNpmPrefix;
    }
    if (originalUpdateLog === undefined) {
      delete process.env.THREADNOTE_E2E_UPDATE_LOG;
    } else {
      process.env.THREADNOTE_E2E_UPDATE_LOG = originalUpdateLog;
    }
    await rm(root, {force: true, recursive: true});
  }
});

windowsIt('installs, operates, repairs, and uninstalls the packed package on native Windows', async () => {
  const root = await mkdtemp(join(tmpdir(), 'threadnote windows e2e '));
  const home = join(root, 'User Home');
  const prefix = join(root, 'npm global prefix');
  const cli = join(prefix, 'threadnote.cmd');
  const pidPath = join(home, 'openviking-server.pid');
  const copilotConfig = join(home, 'AppData', 'Roaming', 'Code', 'User', 'mcp.json');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CI: '1',
    HOME: home,
    NO_COLOR: '1',
    NO_UPDATE_NOTIFIER: '1',
    NPM_CONFIG_PREFIX: prefix,
    PATH: [prefix, join(home, '.local', 'bin'), process.env.PATH ?? ''].join(delimiter),
    THREADNOTE_ACCOUNT: 'local',
    THREADNOTE_AGENT_ID: 'threadnote',
    THREADNOTE_COPILOT_MCP_CONFIG: copilotConfig,
    THREADNOTE_HOME: home,
    THREADNOTE_HOST: '127.0.0.1',
    THREADNOTE_NO_UPDATE_CHECK: '1',
    THREADNOTE_PORT: '1933',
    THREADNOTE_USER: 'windows-e2e',
    USERPROFILE: home,
  };

  try {
    await mkdir(home, {recursive: true});
    const tarball = await pack(root, env);
    env.THREADNOTE_PACKAGE = tarball;
    const installed = await runProcess(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        join(REPO_ROOT, 'scripts', 'install.ps1'),
        '-NoStart',
      ],
      {env, timeoutMs: 600_000},
    );
    expectSuccess(installed, 'PowerShell bootstrap');
    expect(installed.stdout).toContain('Preserving the package-manager threadnote.cmd launcher on Windows.');
    await expect(access(cli)).resolves.toBeUndefined();
    await expect(access(join(home, '.local', 'bin', 'threadnote'))).rejects.toMatchObject({code: 'ENOENT'});

    const version = await runCli(cli, ['--version'], env);
    expectSuccess(version, 'threadnote.cmd --version');
    expect(version.stdout).toMatch(/^threadnote v\d+\.\d+\.\d+/m);

    const port = await freeTcpPort();
    env.THREADNOTE_PORT = String(port);
    env.THREADNOTE_OPENVIKING_MCP_URL = `http://127.0.0.1:${port}/mcp`;
    expectSuccess(await runCli(cli, ['start'], env), 'threadnote start');
    await expectHealth(port, true);
    expectSuccess(await runCli(cli, ['doctor', '--strict'], env), 'threadnote doctor --strict');

    const mcpBin = join(prefix, 'node_modules', 'threadnote', 'bin', 'threadnote-mcp-server.cjs');
    const durableUri = 'viking://user/windows-e2e/memories/durable/projects/windows-e2e/native-installation.md';
    await withMcpClient(mcpBin, env, async client => {
      const stored = await callToolText(client, 'remember_context', {
        project: 'windows-e2e',
        text: 'Native Windows installation completed through the packed PowerShell workflow.',
        topic: 'native-installation',
      });
      expect(stored).toContain(durableUri);
      expect(await callToolText(client, 'recall_context', {query: 'native Windows packed PowerShell'})).toContain(
        durableUri,
      );

      const reviewResult = await callToolResult(client, 'review_session_context', {
        decisions: ['Keep the native Windows npm launcher instead of replacing it with a POSIX shim.'],
        evidence: ['test/e2e/windows-install.windows.e2e.ts'],
        invariants: ['Repair and uninstall preserve the OpenViking datastore by default.'],
        outcome: 'Validated the packaged native Windows lifecycle.',
        project: 'windows-e2e',
        sourceAgentClient: 'codex-e2e',
        sourceSessionId: 'windows-install-e2e',
        task: 'Validate native Windows installation',
        topic: 'reviewed-installation',
      });
      const review = structuredContent<CandidateReview>(reviewResult);
      const candidate = review.candidates[0];
      expect(candidate).toBeDefined();
      expect(
        await callToolText(client, 'apply_memory_candidates', {
          action: 'approve',
          approved: true,
          candidateId: candidate?.candidateId,
          reviewId: review.reviewId,
          revision: review.revision,
        }),
      ).toContain('Stored memory:');
    });

    const agentBin = join(root, 'agent launchers');
    const agentLog = join(root, 'agent.log');
    await mkdir(agentBin, {recursive: true});
    for (const agent of ['codex', 'claude']) {
      await writeFile(
        join(agentBin, `${agent}.cmd`),
        '@ECHO off\r\n@if not "%~1"=="--version" @goto run\r\n@ECHO fake-agent 1.0.0\r\n@exit /b 0\r\n:run\r\n@ECHO %~n0 %*>>"%THREADNOTE_E2E_AGENT_LOG%"\r\n@exit /b 0\r\n',
      );
    }
    env.PATH = [agentBin, env.PATH ?? ''].join(delimiter);
    env.THREADNOTE_E2E_AGENT_LOG = agentLog;
    expectSuccess(await runCli(cli, ['mcp-install', 'codex', '--apply'], env), 'Codex MCP install');
    expectSuccess(await runCli(cli, ['mcp-install', 'claude', '--apply'], env), 'Claude MCP install');
    const agentCalls = await readFile(agentLog, 'utf8');
    expect(agentCalls).toContain('codex mcp remove threadnote');
    expect(agentCalls).toContain('codex mcp add --env');
    expect(agentCalls).toContain('claude mcp remove threadnote');
    expect(agentCalls).toContain('claude mcp add --scope user');
    expectSuccess(await runCli(cli, ['mcp-install', 'cursor', '--apply'], env), 'Cursor MCP install');
    expectSuccess(await runCli(cli, ['mcp-install', 'copilot', '--apply'], env), 'Copilot MCP install');
    for (const configPath of [join(home, '.cursor', 'mcp.json'), copilotConfig]) {
      const config = JSON.parse(await readFile(configPath, 'utf8')) as {
        readonly mcpServers?: Record<string, {readonly command?: string}>;
        readonly servers?: Record<string, {readonly command?: string}>;
      };
      const server = config.mcpServers?.threadnote ?? config.servers?.threadnote;
      expect(server?.command).toBe('node');
    }

    expectSuccess(
      await runCli(cli, ['repair', '--mcp', 'none', '--no-start', '--no-post-update'], env),
      'threadnote repair',
    );
    expectSuccess(await runCli(cli, ['read', durableUri], env), 'read after repair');

    expectSuccess(await runCli(cli, ['stop'], env), 'threadnote stop');
    await expectHealth(port, false);
    await expect(access(pidPath)).rejects.toMatchObject({code: 'ENOENT'});

    await writeFile(pidPath, `${process.pid}\n`, 'utf8');
    const unrelatedPid = await runCli(cli, ['stop'], env);
    expect(unrelatedPid.code).not.toBe(0);
    expect(`${unrelatedPid.stdout}\n${unrelatedPid.stderr}`).toMatch(/Refusing to stop process/);
    await expect(access(pidPath)).resolves.toBeUndefined();

    await writeFile(pidPath, '99999999\n', 'utf8');
    expectSuccess(await runCli(cli, ['stop'], env), 'stale pid recovery');
    await expect(access(pidPath)).rejects.toMatchObject({code: 'ENOENT'});

    expectSuccess(await runCli(cli, ['start'], env), 'threadnote restart');
    await expectHealth(port, true);

    expectSuccess(
      await runCli(cli, ['uninstall', '--mcp', 'none', '--preserve-memories'], env),
      'memory-preserving uninstall',
    );
    await expectHealth(port, false);
    await expect(access(cli)).resolves.toBeUndefined();
    const memory = await stat(
      join(
        home,
        'data',
        'viking',
        'local',
        'user',
        'windows-e2e',
        'memories',
        'durable',
        'projects',
        'windows-e2e',
        'native-installation.md',
      ),
    );
    expect(memory.isFile()).toBe(true);
  } finally {
    if (await exists(cli)) {
      await runCli(cli, ['stop'], env).catch(() => undefined);
    }
    await rm(root, {force: true, recursive: true});
  }
});

async function runBootstrap(env: NodeJS.ProcessEnv, args: readonly string[]): Promise<ProcessResult> {
  return runProcess(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      join(REPO_ROOT, 'scripts', 'install.ps1'),
      ...args,
    ],
    {env},
  );
}

async function pack(destination: string, env: NodeJS.ProcessEnv): Promise<string> {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) {
    throw new Error('npm_execpath is required to pack the Windows E2E artifact.');
  }
  const result = await runProcess(process.execPath, [npmCli, 'pack', '--json', '--pack-destination', destination], {
    cwd: REPO_ROOT,
    env,
    timeoutMs: 180_000,
  });
  expectSuccess(result, 'npm pack');
  const jsonStart = result.stdout.search(/\[\s*\{/);
  expect(jsonStart, result.stdout).toBeGreaterThanOrEqual(0);
  const packed = JSON.parse(result.stdout.slice(jsonStart)) as readonly {readonly filename: string}[];
  const filename = packed[0]?.filename;
  if (!filename) {
    throw new Error(`npm pack did not return a filename:\n${result.stdout}`);
  }
  return join(destination, filename);
}

async function runCli(command: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<ProcessResult> {
  return runProcess(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$toolArgs = @(ConvertFrom-Json -InputObject $env:THREADNOTE_E2E_ARGS); & $env:THREADNOTE_E2E_CLI @toolArgs; exit $LASTEXITCODE',
    ],
    {
      env: {
        ...env,
        THREADNOTE_E2E_ARGS: JSON.stringify(args),
        THREADNOTE_E2E_CLI: command,
      },
      timeoutMs: 180_000,
    },
  );
}

async function withMcpClient<T>(
  mcpBin: string,
  env: NodeJS.ProcessEnv,
  use: (client: Client) => Promise<T>,
): Promise<T> {
  const transport = new StdioClientTransport({
    args: [mcpBin],
    command: process.execPath,
    cwd: REPO_ROOT,
    env: Object.fromEntries(
      Object.entries({...env, THREADNOTE_MCP_TOOLSET: 'core'}).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    stderr: 'pipe',
  });
  const client = new Client({name: 'threadnote-windows-e2e', version: '1.0.0'});
  try {
    await client.connect(transport);
    return await use(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function callToolText(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  return textFromToolResult(await callToolResult(client, name, args));
}

async function callToolResult(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({arguments: args, name}, undefined, {timeout: 120_000});
  expect(result.isError, `${name} failed: ${textFromToolResult(result)}`).not.toBe(true);
  return result;
}

function structuredContent<T>(result: unknown): T {
  const value =
    typeof result === 'object' && result !== null && 'structuredContent' in result
      ? (result as {readonly structuredContent?: unknown}).structuredContent
      : undefined;
  expect(value).toBeDefined();
  return value as T;
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

async function expectHealth(port: number, healthy: boolean): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const remainingMs = Math.max(1, deadline - Date.now());
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(Math.min(1000, remainingMs)),
      });
      if (healthy && response.ok) {
        await response.body?.cancel();
        return;
      }
      await response.body?.cancel();
    } catch (cause: unknown) {
      const errorName = cause instanceof Error ? cause.name : '';
      if (!healthy && errorName !== 'AbortError' && errorName !== 'TimeoutError') {
        return;
      }
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error(`OpenViking health did not become ${healthy ? 'ready' : 'unavailable'}.`);
}

async function freeTcpPort(): Promise<number> {
  const {createServer} = await import('node:net');
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Could not allocate a Windows E2E port.');
  }
  await new Promise<void>((resolveClose, reject) => server.close(error => (error ? reject(error) : resolveClose())));
  return address.port;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
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
    readonly timeoutMs?: number;
  } = {},
): Promise<ProcessResult> {
  return new Promise((resolveResult, reject) => {
    const invocation = resolveCommandInvocation(command, args);
    const child = spawn(invocation.executable, invocation.args, {
      cwd: options.cwd ?? REPO_ROOT,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    const maxOutputChars = 1_000_000;
    let stderr = '';
    let stdout = '';
    child.stdout.on('data', chunk => {
      stdout = `${stdout}${chunk.toString('utf8')}`.slice(-maxOutputChars);
    });
    child.stderr.on('data', chunk => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-maxOutputChars);
    });
    child.once('error', reject);
    const timeout = setTimeout(() => {
      void terminateCommandProcess(child, invocation, true).catch(reject);
    }, options.timeoutMs ?? 120_000);
    child.once('close', code => {
      clearTimeout(timeout);
      resolveResult({code, stderr, stdout});
    });
  });
}
