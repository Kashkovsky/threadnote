import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {CommandResult, RuntimeConfig} from '../../src/types.js';

vi.mock('../../src/utils.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/utils.js')>();
  return {
    ...actual,
    findExecutable: vi.fn(),
    isExecutable: vi.fn(),
    isTcpPortOpen: vi.fn(),
    maybeRun: vi.fn(),
    runCommand: vi.fn(),
    runInteractive: vi.fn(),
    sleep: vi.fn(),
  };
});

import {parseUpdateRuntime, runPostUpdate, runUpdate} from '../../src/update.js';
import * as utils from '../../src/utils.js';

const ok = (stdout = ''): CommandResult => ({exitCode: 0, stdout, stderr: ''});

async function makeRuntime(): Promise<RuntimeConfig> {
  const home = await mkdtemp(join(tmpdir(), 'threadnote-update-'));
  return {
    account: 'local',
    agentContextHome: home,
    agentId: 'threadnote',
    host: '127.0.0.1',
    manifestPath: join(home, 'seed-manifest.yaml'),
    openVikingVersion: '0.3.24',
    port: 1933,
    user: 'denys',
  };
}

function mockLatestVersion(version: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      if (String(url).includes('/health')) {
        return {ok: true};
      }
      return {
        json: async () => ({version}),
        ok: true,
      };
    }),
  );
}

describe('parseUpdateRuntime', () => {
  beforeEach(() => {
    vi.mocked(utils.findExecutable).mockReset();
    vi.mocked(utils.isExecutable).mockReset();
    vi.mocked(utils.isTcpPortOpen).mockReset();
    vi.mocked(utils.maybeRun).mockReset();
    vi.mocked(utils.runCommand).mockReset();
    vi.mocked(utils.runInteractive).mockReset();
    vi.mocked(utils.sleep).mockReset();
    vi.mocked(utils.maybeRun).mockResolvedValue(ok());
    vi.mocked(utils.runCommand).mockResolvedValue(ok());
    vi.mocked(utils.runInteractive).mockResolvedValue(0);
    vi.mocked(utils.sleep).mockResolvedValue(undefined);
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
});

describe('runUpdate', () => {
  const homes: string[] = [];

  beforeEach(() => {
    vi.mocked(utils.findExecutable).mockReset();
    vi.mocked(utils.isExecutable).mockReset();
    vi.mocked(utils.isTcpPortOpen).mockReset();
    vi.mocked(utils.maybeRun).mockReset();
    vi.mocked(utils.runCommand).mockReset();
    vi.mocked(utils.runInteractive).mockReset();
    vi.mocked(utils.sleep).mockReset();
    vi.mocked(utils.findExecutable).mockImplementation(async commands => {
      if (commands.includes('npm')) {
        return '/usr/bin/npm';
      }
      if (commands.includes('threadnote')) {
        return '/usr/local/bin/threadnote';
      }
      return undefined;
    });
    vi.mocked(utils.isExecutable).mockResolvedValue(true);
    vi.mocked(utils.maybeRun).mockResolvedValue(ok());
    vi.mocked(utils.runCommand).mockImplementation(async (executable, args) => {
      if (executable === 'npm' && args[0] === 'prefix') {
        return ok('/tmp/npm-global\n');
      }
      return ok();
    });
    vi.mocked(utils.runInteractive).mockResolvedValue(0);
    vi.mocked(utils.sleep).mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(homes.splice(0).map(home => rm(home, {force: true, recursive: true})));
  });

  it('streams the package update and repair output instead of buffering it', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    mockLatestVersion('99.0.0');

    await runUpdate(config, {postUpdate: false, runtime: 'npm'});

    expect(vi.mocked(utils.runInteractive)).toHaveBeenCalledWith(
      'npm',
      expect.arrayContaining(['install', '--global', 'threadnote@latest']),
    );
    expect(vi.mocked(utils.runInteractive)).toHaveBeenCalledWith('/tmp/npm-global/bin/threadnote', [
      'repair',
      '--no-post-update',
    ]);
    expect(vi.mocked(utils.maybeRun)).not.toHaveBeenCalled();
  });
});

describe('runPostUpdate', () => {
  const homes: string[] = [];
  const originalArgv = process.argv;

  beforeEach(() => {
    vi.mocked(utils.findExecutable).mockReset();
    vi.mocked(utils.isExecutable).mockReset();
    vi.mocked(utils.isTcpPortOpen).mockReset();
    vi.mocked(utils.maybeRun).mockReset();
    vi.mocked(utils.runCommand).mockReset();
    vi.mocked(utils.runInteractive).mockReset();
    vi.mocked(utils.sleep).mockReset();
    vi.mocked(utils.findExecutable).mockImplementation(async commands => {
      if (commands.includes('ov') || commands.includes('openviking')) {
        return '/ov';
      }
      if (commands.includes('threadnote')) {
        return '/threadnote';
      }
      return undefined;
    });
    vi.mocked(utils.isTcpPortOpen).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    vi.mocked(utils.maybeRun).mockResolvedValue(ok());
    vi.mocked(utils.runCommand).mockImplementation(async (executable, args) => {
      if (executable === '/ov' && args[0] === 'version') {
        return ok('CLI:     0.3.23\nServer:  0.3.23\n');
      }
      return ok();
    });
    vi.mocked(utils.runInteractive).mockResolvedValue(0);
    vi.mocked(utils.sleep).mockResolvedValue(undefined);
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
      vi.fn(async () => ({ok: true})),
    );

    await runPostUpdate(config, {fromVersion: '1.1.0', toVersion: '1.1.0'});

    const stopCall = vi.mocked(utils.runInteractive).mock.calls.find(call => call[1][0] === 'stop');
    const startCall = vi.mocked(utils.runInteractive).mock.calls.find(call => call[1][0] === 'start');

    expect(stopCall).toBeDefined();
    expect(startCall).toBeDefined();
    expect(vi.mocked(utils.isTcpPortOpen)).toHaveBeenCalledWith('127.0.0.1', 1933, 300);
    expect(vi.mocked(utils.isTcpPortOpen).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(utils.runInteractive).mock.invocationCallOrder[
        vi.mocked(utils.runInteractive).mock.calls.findIndex(call => call[1][0] === 'start')
      ],
    );
  });
});
