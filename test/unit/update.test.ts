import {chmod, mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {Effect} from 'effect';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {CommandResult, RuntimeConfig} from '../../src/types.js';

vi.mock('../../src/utils.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/utils.js')>();
  return {
    ...actual,
    currentPackageVersion: vi.fn(actual.currentPackageVersion),
    findExecutable: vi.fn(),
    findOpenVikingCli: vi.fn(),
    isExecutable: vi.fn(),
    isTcpPortOpen: vi.fn(),
    maybeRun: vi.fn(),
    runCommand: vi.fn(),
    runInteractive: vi.fn(),
    sleep: vi.fn(),
  };
});

import {
  parseUpdateRuntime,
  readOpenVikingCliVersion as readOpenVikingCliVersionEffect,
  requestedUpdateChannel,
  resolveUpdateRegistry,
  runPostUpdate,
  runUpdate,
  runtimeThreadnoteBinPath,
} from '../../src/update.js';
import {runVersion} from '../../src/version_command.js';
import {captureConsole} from '../../src/effect/console.js';
import * as utils from '../../src/utils.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {CommandExecutor} from '../../src/effect/command.js';
import {runEffect} from '../helpers/effect-runtime.js';

const runTestEffect = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect);
const readOpenVikingCliVersion = (ov: string) => runEffect(readOpenVikingCliVersionEffect(ov));

const ok = (stdout = ''): CommandResult => ({exitCode: 0, stdout, stderr: ''});

describe('readOpenVikingCliVersion', () => {
  it('uses the server-independent CLI version flag', async () => {
    vi.mocked(utils.runCommand).mockReturnValueOnce(Effect.succeed(ok('openviking 0.4.10\n')));

    await expect(readOpenVikingCliVersion('/ov')).resolves.toBe('0.4.10');
    expect(utils.runCommand).toHaveBeenCalledWith('/ov', ['--version'], {allowFailure: true});
  });

  it('does not mistake OpenViking setup guidance for a version', async () => {
    vi.mocked(utils.runCommand).mockReturnValueOnce(
      Effect.succeed(ok('OpenViking needs a display language before running commands.\n')),
    );

    await expect(readOpenVikingCliVersion('/ov')).resolves.toBeUndefined();
  });
});

async function makeRuntime(): Promise<RuntimeConfig> {
  const home = await mkdtemp(join(tmpdir(), 'threadnote-update-'));
  return {
    account: 'local',
    agentContextHome: home,
    agentId: 'threadnote',
    host: '127.0.0.1',
    manifestPath: join(home, 'seed-manifest.yaml'),
    openVikingVersion: '0.4.7',
    port: 1933,
    user: 'denys',
  };
}

function mockRegistryVersions(latest: string, beta: string) {
  const fetch = vi.fn(async (url: string | URL) => {
    const parsed = new URL(url);
    if (parsed.pathname.includes('/health')) {
      return new Response('healthy');
    }
    if (parsed.pathname.endsWith('/threadnote/beta')) {
      return Response.json({version: beta});
    }
    if (parsed.pathname.endsWith('/threadnote/latest')) {
      return Response.json({version: latest});
    }
    if (parsed.hostname === 'api.github.com') {
      return Response.json([]);
    }
    return new Response('Not found', {status: 404});
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

describe('parseUpdateRuntime', () => {
  beforeEach(() => {
    vi.mocked(utils.findExecutable).mockReset();
    vi.mocked(utils.findOpenVikingCli).mockReset();
    vi.mocked(utils.isExecutable).mockReset();
    vi.mocked(utils.isTcpPortOpen).mockReset();
    vi.mocked(utils.maybeRun).mockReset();
    vi.mocked(utils.runCommand).mockReset();
    vi.mocked(utils.runInteractive).mockReset();
    vi.mocked(utils.sleep).mockReset();
    vi.mocked(utils.currentPackageVersion).mockReturnValue(Effect.succeed('2.0.4'));
    vi.mocked(utils.maybeRun).mockReturnValue(Effect.succeed(ok()));
    vi.mocked(utils.findOpenVikingCli).mockReturnValue(Effect.succeed(undefined));
    vi.mocked(utils.runCommand).mockReturnValue(Effect.succeed(ok()));
    vi.mocked(utils.runInteractive).mockReturnValue(Effect.succeed(0));
    vi.mocked(utils.sleep).mockReturnValue(Effect.void);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('accepts the documented values', () => {
    expect(parseUpdateRuntime('auto')).toBe('auto');
    expect(parseUpdateRuntime('npm')).toBe('npm');
    expect(parseUpdateRuntime('bun')).toBe('bun');
    expect(parseUpdateRuntime('deno')).toBe('deno');
  });

  it('throws on anything else', () => {
    expect(() => parseUpdateRuntime('yarn')).toThrow(/Invalid update runtime/);
    expect(() => parseUpdateRuntime('')).toThrow(/Invalid update runtime/);
  });

  it('resolves explicit update channel requests', () => {
    expect(requestedUpdateChannel({})).toBeUndefined();
    expect(requestedUpdateChannel({beta: true})).toBe('beta');
    expect(requestedUpdateChannel({stable: true})).toBe('latest');
    expect(() => requestedUpdateChannel({beta: true, stable: true})).toThrow(/either --beta or --stable/);
  });
});

describe('runUpdate', () => {
  const homes: string[] = [];
  const originalRegistry = process.env.THREADNOTE_NPM_REGISTRY;
  const originalAllowRegistry = process.env.THREADNOTE_ALLOW_UNTRUSTED_NPM_REGISTRY;

  beforeEach(() => {
    delete process.env.THREADNOTE_NPM_REGISTRY;
    delete process.env.THREADNOTE_ALLOW_UNTRUSTED_NPM_REGISTRY;
    vi.mocked(utils.findExecutable).mockReset();
    vi.mocked(utils.findOpenVikingCli).mockReset();
    vi.mocked(utils.isExecutable).mockReset();
    vi.mocked(utils.isTcpPortOpen).mockReset();
    vi.mocked(utils.maybeRun).mockReset();
    vi.mocked(utils.runCommand).mockReset();
    vi.mocked(utils.runInteractive).mockReset();
    vi.mocked(utils.sleep).mockReset();
    vi.mocked(utils.currentPackageVersion).mockReturnValue(Effect.succeed('2.0.4'));
    vi.mocked(utils.findExecutable).mockImplementation(commands => {
      if (commands.includes('npm')) {
        return Effect.succeed('/usr/bin/npm');
      }
      if (commands.includes('threadnote')) {
        return Effect.succeed('/usr/local/bin/threadnote');
      }
      return Effect.succeed(undefined);
    });
    vi.mocked(utils.findOpenVikingCli).mockReturnValue(Effect.succeed(undefined));
    vi.mocked(utils.isExecutable).mockReturnValue(Effect.succeed(true));
    vi.mocked(utils.maybeRun).mockReturnValue(Effect.succeed(ok()));
    vi.mocked(utils.runCommand).mockImplementation((executable, args) => {
      if (executable.endsWith('/npm') && args[0] === 'prefix') {
        return Effect.succeed(ok('/tmp/npm-global\n'));
      }
      return Effect.succeed(ok());
    });
    vi.mocked(utils.runInteractive).mockReturnValue(Effect.succeed(0));
    vi.mocked(utils.sleep).mockReturnValue(Effect.void);
  });

  afterEach(async () => {
    if (originalRegistry === undefined) {
      delete process.env.THREADNOTE_NPM_REGISTRY;
    } else {
      process.env.THREADNOTE_NPM_REGISTRY = originalRegistry;
    }
    if (originalAllowRegistry === undefined) {
      delete process.env.THREADNOTE_ALLOW_UNTRUSTED_NPM_REGISTRY;
    } else {
      process.env.THREADNOTE_ALLOW_UNTRUSTED_NPM_REGISTRY = originalAllowRegistry;
    }
    vi.unstubAllGlobals();
    await Promise.all(homes.splice(0).map(home => rm(home, {force: true, recursive: true})));
  });

  it('streams the package update and repair output instead of buffering it', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const fetch = mockRegistryVersions('99.0.0', '100.0.0-beta.1');
    const prefix = join(config.agentContextHome, 'npm-global');
    const threadnote = runtimeThreadnoteBinPath('npm', prefix, process.platform);
    await mkdir(dirname(threadnote), {recursive: true});
    await writeFile(threadnote, '#!/bin/sh\n');
    await chmod(threadnote, 0o755);
    const executeStreaming = vi.fn(
      (_executable: string, _args: readonly string[], _options?: {readonly env?: NodeJS.ProcessEnv}) =>
        Effect.succeed(ok()),
    );
    const executor = CommandExecutor.of({
      execute: (_executable, args) => Effect.succeed(args[0] === 'prefix' ? ok(`${prefix}\n`) : ok()),
      executeStreaming,
    });

    await runEffect(
      runUpdate(config, {postUpdate: false, runtime: 'npm'}).pipe(Effect.provideService(CommandExecutor, executor)),
    );

    expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/threadnote/latest'))).toBe(true);
    expect(executeStreaming).toHaveBeenCalledWith(
      '/usr/bin/npm',
      expect.arrayContaining(['install', '--global', 'threadnote@latest']),
      {inheritOutput: true},
    );
    expect(executeStreaming).toHaveBeenCalledWith(threadnote, ['repair', '--no-post-update'], {
      inheritOutput: true,
    });
    expect(vi.mocked(utils.maybeRun)).not.toHaveBeenCalled();
  });

  it('runs Deno directly with the registry in its environment', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    mockRegistryVersions('99.0.0', '100.0.0-beta.1');
    const deno = 'C:\\Program Files\\Deno\\deno.exe';
    const originalDenoInstallRoot = process.env.DENO_INSTALL_ROOT;
    const originalDenoInstall = process.env.DENO_INSTALL;
    const denoInstall = join(config.agentContextHome, 'deno-root');
    const denoBin = join(denoInstall, 'bin');
    const threadnote = runtimeThreadnoteBinPath('deno', denoBin, process.platform);
    await mkdir(denoBin, {recursive: true});
    await writeFile(threadnote, '#!/bin/sh\n');
    await chmod(threadnote, 0o755);
    process.env.DENO_INSTALL_ROOT = denoInstall;
    delete process.env.DENO_INSTALL;
    vi.mocked(utils.findExecutable).mockImplementation(commands => {
      if (commands.includes('deno')) {
        return Effect.succeed(deno);
      }
      return Effect.succeed(undefined);
    });

    const executeStreaming = vi.fn(
      (_executable: string, _args: readonly string[], _options?: {readonly env?: NodeJS.ProcessEnv}) =>
        Effect.succeed(ok()),
    );
    const executor = CommandExecutor.of({
      execute: () => Effect.succeed(ok()),
      executeStreaming,
    });

    try {
      await runEffect(
        runUpdate(config, {postUpdate: false, runtime: 'deno'}).pipe(Effect.provideService(CommandExecutor, executor)),
      );
    } finally {
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
    }

    expect(executeStreaming).toHaveBeenCalledWith(
      deno,
      expect.arrayContaining(['install', '--global', 'npm:threadnote@latest']),
      {
        env: expect.objectContaining({NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/'}),
        inheritOutput: true,
      },
    );
    expect(executeStreaming).not.toHaveBeenCalledWith('env', expect.any(Array), expect.anything());
    expect(executeStreaming).toHaveBeenCalledWith(threadnote, ['repair', '--no-post-update'], {
      inheritOutput: true,
    });
  });

  it('updates to the beta dist-tag when --beta is requested', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const fetch = mockRegistryVersions('2.0.4', '3.0.0-beta.1');

    const result = await runEffect(
      captureConsole(runUpdate(config, {beta: true, dryRun: true, repair: false, runtime: 'npm'})),
    );

    expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/threadnote/beta'))).toBe(true);
    expect(result.output).toContain('threadnote@beta');
  });

  it('reports an unpublished beta channel without attempting an update', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const fetch = vi.fn(async (_url: string | URL) => new Response('Not found', {status: 404}));
    vi.stubGlobal('fetch', fetch);

    const result = await runTestEffect(
      captureConsole(
        runUpdate(config, {beta: true, dryRun: true, repair: false, runtime: 'npm'}).pipe(
          Effect.provide(ApplicationLayer),
        ),
      ),
    );

    expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/threadnote/beta'))).toBe(true);
    expect(result.output).toContain('Latest beta version: not published');
    expect(result.output).toContain('No beta release is currently published.');
    expect(vi.mocked(utils.maybeRun)).not.toHaveBeenCalled();
    expect(vi.mocked(utils.runInteractive)).not.toHaveBeenCalled();
  });

  it('does not hide a missing stable dist-tag', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Not found', {status: 404})),
    );

    await expect(
      runTestEffect(
        runUpdate(config, {dryRun: true, repair: false, runtime: 'npm'}).pipe(Effect.provide(ApplicationLayer)),
      ),
    ).rejects.toThrow(/threadnote\/latest returned HTTP 404/);
  });

  it('keeps an installed beta on the beta channel without another flag', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    vi.mocked(utils.currentPackageVersion).mockReturnValue(Effect.succeed('3.0.0-beta.1'));
    const fetch = mockRegistryVersions('2.0.4', '3.0.0-beta.2');

    const result = await runEffect(captureConsole(runUpdate(config, {dryRun: true, repair: false, runtime: 'npm'})));

    expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/threadnote/beta'))).toBe(true);
    expect(result.output).toContain('threadnote@beta');
  });

  it('switches an installed beta to stable even when npm latest is numerically lower', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    vi.mocked(utils.currentPackageVersion).mockReturnValue(Effect.succeed('3.0.0-beta.2'));
    const fetch = mockRegistryVersions('2.0.4', '3.0.0-beta.2');

    const result = await runEffect(
      captureConsole(runUpdate(config, {dryRun: true, repair: false, runtime: 'npm', stable: true})),
    );

    expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/threadnote/latest'))).toBe(true);
    expect(result.output).toContain('threadnote@latest');
    expect(result.output).not.toContain('Threadnote is up to date.');
  });

  it('advertises the explicit stable switch when checking from a newer beta', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    vi.mocked(utils.currentPackageVersion).mockReturnValue(Effect.succeed('3.0.0-beta.2'));
    mockRegistryVersions('2.0.4', '3.0.0-beta.2');

    const result = await runEffect(captureConsole(runUpdate(config, {check: true, stable: true})));

    expect(result.output).toContain('Channel switch available. Run: threadnote update --stable');
  });

  it('shows beta versions in version output only for an installed beta', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const stableFetch = mockRegistryVersions('2.0.4', '3.0.0-beta.2');

    const stable = await runTestEffect(captureConsole(runVersion(config, {}).pipe(Effect.provide(ApplicationLayer))));

    expect(stableFetch.mock.calls.some(([url]) => String(url).endsWith('/threadnote/latest'))).toBe(true);
    expect(stable.output).toContain('Latest version');
    expect(stable.output).not.toContain('3.0.0-beta.2');

    vi.mocked(utils.currentPackageVersion).mockReturnValue(Effect.succeed('3.0.0-beta.1'));
    const betaFetch = mockRegistryVersions('2.0.4', '3.0.0-beta.2');
    const beta = await runTestEffect(captureConsole(runVersion(config, {}).pipe(Effect.provide(ApplicationLayer))));

    expect(betaFetch.mock.calls.some(([url]) => String(url).endsWith('/threadnote/beta'))).toBe(true);
    expect(beta.output).toContain('Latest beta version');
    expect(beta.output).toContain('3.0.0-beta.2');
  });

  it('rejects custom npm registries unless explicitly allowed', () => {
    expect(() => resolveUpdateRegistry('https://registry.example.com/', false, {})).toThrow(
      /Refusing custom npm registry/,
    );
    expect(resolveUpdateRegistry('https://registry.example.com/', true, {})).toBe('https://registry.example.com/');
  });

  it('does not trust THREADNOTE_NPM_REGISTRY without explicit opt-in', () => {
    process.env.THREADNOTE_NPM_REGISTRY = 'https://registry.example.com/';
    expect(() => resolveUpdateRegistry(undefined, false, process.env)).toThrow(/Refusing custom npm registry/);

    process.env.THREADNOTE_ALLOW_UNTRUSTED_NPM_REGISTRY = '1';
    expect(resolveUpdateRegistry(undefined, false, process.env)).toBe('https://registry.example.com/');
  });
});

describe('runPostUpdate', () => {
  const homes: string[] = [];
  const originalArgv = process.argv;

  beforeEach(() => {
    vi.mocked(utils.findExecutable).mockReset();
    vi.mocked(utils.findOpenVikingCli).mockReset();
    vi.mocked(utils.isExecutable).mockReset();
    vi.mocked(utils.isTcpPortOpen).mockReset();
    vi.mocked(utils.maybeRun).mockReset();
    vi.mocked(utils.runCommand).mockReset();
    vi.mocked(utils.runInteractive).mockReset();
    vi.mocked(utils.sleep).mockReset();
    vi.mocked(utils.findExecutable).mockImplementation(commands => {
      if (commands.includes('threadnote')) {
        return Effect.succeed('/threadnote');
      }
      return Effect.succeed(undefined);
    });
    vi.mocked(utils.findOpenVikingCli).mockReturnValue(Effect.succeed('/ov'));
    vi.mocked(utils.isTcpPortOpen).mockReturnValue(Effect.succeed(false));
    vi.mocked(utils.maybeRun).mockReturnValue(Effect.succeed(ok()));
    vi.mocked(utils.runCommand).mockImplementation((executable, args) => {
      if (executable === '/ov' && args[0] === '--version') {
        return Effect.succeed(ok('openviking 0.3.23\n'));
      }
      return Effect.succeed(ok());
    });
    vi.mocked(utils.runInteractive).mockReturnValue(Effect.succeed(0));
    vi.mocked(utils.sleep).mockReturnValue(Effect.void);
    process.argv = [process.argv[0] ?? 'node', '/threadnote'];
  });

  afterEach(async () => {
    process.argv = originalArgv;
    vi.unstubAllGlobals();
    await Promise.all(homes.splice(0).map(home => rm(home, {force: true, recursive: true})));
  });

  it('waits for the old OpenViking port listener to close before starting after a pin upgrade', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('healthy')),
    );

    const executeStreaming = vi.fn(
      (_executable: string, _args: readonly string[], _options?: {readonly env?: NodeJS.ProcessEnv}) =>
        Effect.succeed(ok()),
    );
    const executor = CommandExecutor.of({
      execute: () => Effect.succeed(ok()),
      executeStreaming,
    });
    await runEffect(
      runPostUpdate(config, {fromVersion: '1.1.0', toVersion: '1.1.0'}).pipe(
        Effect.provideService(CommandExecutor, executor),
      ),
    );

    const stopCall = executeStreaming.mock.calls.find(call => call[1][0] === 'stop');
    const startCall = executeStreaming.mock.calls.find(call => call[1][0] === 'start');
    const installCall = executeStreaming.mock.calls.find(call => call[1][0] === 'install');

    expect(installCall?.[1]).toEqual(['install', '--force', '--no-start']);
    expect(stopCall).toBeDefined();
    expect(startCall).toBeDefined();
    expect(vi.mocked(utils.isTcpPortOpen)).toHaveBeenCalledWith('127.0.0.1', 1933, 300);
    expect(vi.mocked(utils.isTcpPortOpen).mock.invocationCallOrder[0]).toBeLessThan(
      executeStreaming.mock.invocationCallOrder[executeStreaming.mock.calls.findIndex(call => call[1][0] === 'start')],
    );
  });

  it('does not run the obsolete OpenViking semantic-queue patch after the 1.4.4 update', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    vi.mocked(utils.runCommand).mockImplementation((executable, args) => {
      if (executable === '/ov' && args[0] === '--version') {
        return Effect.succeed(ok('openviking 0.4.7\n'));
      }
      return Effect.succeed(ok());
    });

    await runTestEffect(
      runPostUpdate(config, {fromVersion: '1.4.3', toVersion: '1.4.4', yes: true}).pipe(
        Effect.provide(ApplicationLayer),
      ),
    );

    expect(vi.mocked(utils.runInteractive)).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['repair-semantic-queue']),
    );
  });

  it('offers local recall and full memory enrichment during the 3.0.0 beta cycle', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    vi.mocked(utils.runCommand).mockImplementation((executable, args) => {
      if (executable === '/ov' && args[0] === '--version') {
        return Effect.succeed(ok('openviking 0.4.7\n'));
      }
      return Effect.succeed(ok());
    });
    const executeStreaming = vi.fn(() => Effect.succeed(ok()));
    const executor = CommandExecutor.of({
      execute: () => Effect.succeed(ok()),
      executeStreaming,
    });

    await runEffect(
      runPostUpdate(config, {fromVersion: '3.0.0-beta.4', toVersion: '3.0.0-beta.5', yes: true}).pipe(
        Effect.provideService(CommandExecutor, executor),
      ),
    );

    expect(executeStreaming).toHaveBeenCalledWith('/threadnote', ['local-ai', 'install'], {
      inheritOutput: true,
    });
    expect(executeStreaming).toHaveBeenCalledWith('/threadnote', ['enrich-memories', '--apply', '--install-local-ai'], {
      inheritOutput: true,
    });
  });
});
