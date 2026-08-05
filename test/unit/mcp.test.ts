import {chmod, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {delimiter, join} from 'node:path';
import {Effect} from 'effect';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {getMcpIntegrationStatus, resolveMcpClients, runMcpInstall} from '../../src/mcp.js';
import {parseMcpToolset} from '../../src/mcp_toolset.js';
import type {RuntimeConfig} from '../../src/types.js';

function runtime(): RuntimeConfig {
  return {
    account: 'local',
    agentContextHome: '/tmp/threadnote-test',
    agentId: 'threadnote',
    host: '127.0.0.1',
    manifestPath: '/tmp/threadnote-test/seed-manifest.yaml',
    openVikingVersion: '0.4.7',
    port: 1933,
    user: 'denys',
  };
}

async function dryRunOutput(toolset?: 'core' | 'full'): Promise<string> {
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation(value => lines.push(String(value)));
  await runMcpInstall(runtime(), 'codex', {toolset});
  return lines.join('\n');
}

const originalPath = process.env.PATH;
const originalMcpAdapterCommand = process.env.THREADNOTE_MCP_ADAPTER_COMMAND;
const temporaryDirectories: string[] = [];

async function codexLauncher(script: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'threadnote-codex-'));
  temporaryDirectories.push(directory);
  const launcher = join(directory, 'codex');
  await writeFile(launcher, `#!/bin/sh\n${script}\n`);
  await chmod(launcher, 0o755);
  return launcher;
}

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = originalPath;
  }
  if (originalMcpAdapterCommand === undefined) {
    delete process.env.THREADNOTE_MCP_ADAPTER_COMMAND;
  } else {
    process.env.THREADNOTE_MCP_ADAPTER_COMMAND = originalMcpAdapterCommand;
  }
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, {force: true, recursive: true})));
});

describe('MCP toolsets', () => {
  it('installs the core stdio toolset by default', async () => {
    await expect(dryRunOutput()).resolves.toContain('THREADNOTE_MCP_TOOLSET=core');
  });

  it('installs the full stdio toolset when requested', async () => {
    await expect(dryRunOutput('full')).resolves.toContain('THREADNOTE_MCP_TOOLSET=full');
  });

  it('rejects unsupported toolsets', () => {
    expect(() => parseMcpToolset('minimal')).toThrow('Invalid MCP toolset: minimal. Expected core or full.');
  });

  it('uses an absolute app-managed MCP adapter command when configured', async () => {
    process.env.THREADNOTE_MCP_ADAPTER_COMMAND =
      '/Users/test/Library/Application Support/Threadnote/bin/threadnote-mcp-server';

    await expect(dryRunOutput()).resolves.toContain("'<local-path> Support/Threadnote/bin/threadnote-mcp-server'");
  });

  it('rejects a relative app-managed MCP adapter command', async () => {
    process.env.THREADNOTE_MCP_ADAPTER_COMMAND = 'bin/threadnote-mcp-server';

    await expect(dryRunOutput()).rejects.toThrow('THREADNOTE_MCP_ADAPTER_COMMAND must be an absolute path');
  });
});

describe('MCP agent executable resolution', () => {
  it('reports whether the Codex integration is installed', async () => {
    const installed = await codexLauncher(
      `if [ "$1" = "--version" ]; then printf '%s\\n' 'codex-cli 1.0.0'; exit 0; fi\n` +
        `if [ "$1 $2 $3 $4" = "mcp get threadnote --json" ]; then printf '%s\\n' '{}'; exit 0; fi\n` +
        `exit 1`,
    );
    process.env.PATH = [join(installed, '..'), '/usr/bin', '/bin'].join(delimiter);

    await expect(Effect.runPromise(getMcpIntegrationStatus('codex'))).resolves.toEqual({
      agent: 'codex',
      available: true,
      detail: 'Configured in Codex',
      installed: true,
    });
  });

  it('removes only the selected integration', async () => {
    const callsPath = join(tmpdir(), `threadnote-codex-remove-${process.pid}-${Date.now()}`);
    const launcher = await codexLauncher(
      `if [ "$1" = "--version" ]; then printf '%s\\n' 'codex-cli 1.0.0'; exit 0; fi\n` +
        `printf '%s\\n' "$*" >> "${callsPath}"`,
    );
    process.env.PATH = [join(launcher, '..'), '/usr/bin', '/bin'].join(delimiter);

    await runMcpInstall(runtime(), 'codex', {apply: true, remove: true});

    const calls = await readFile(callsPath, 'utf8');
    expect(calls).toContain('mcp remove threadnote');
    expect(calls).not.toContain('mcp add');
    await rm(callsPath, {force: true});
  });

  it('uses a healthy later PATH entry when the first Codex launcher is stale', async () => {
    const broken = await codexLauncher("printf '%s\\n' 'missing native binary' >&2\nexit 1");
    const callsPath = join(tmpdir(), `threadnote-codex-calls-${process.pid}-${Date.now()}`);
    const healthy = await codexLauncher(
      `if [ "$1" = "--version" ]; then printf '%s\\n' 'codex-cli 1.0.0'; exit 0; fi\nprintf '%s\\n' "$*" >> "${callsPath}"`,
    );
    process.env.PATH = [join(broken, '..'), join(healthy, '..')].join(delimiter);

    await runMcpInstall(runtime(), 'codex', {apply: true});

    const calls = await readFile(callsPath, 'utf8');
    expect(calls).toContain('mcp remove threadnote');
    expect(calls).toContain('mcp add --env THREADNOTE_HOME=/tmp/threadnote-test');
    await rm(callsPath, {force: true});
  });

  it('skips a broken Codex launcher during repair and gives explicit installs an actionable error', async () => {
    const broken = await codexLauncher("printf '%s\\n' 'missing native binary' >&2\nexit 1");
    process.env.PATH = [join(broken, '..'), '/usr/bin', '/bin'].join(delimiter);
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation(value => lines.push(String(value)));

    await expect(resolveMcpClients('codex', 'repair')).resolves.toEqual([]);
    expect(lines.join('\n')).toMatch(/codex command.*not working/i);
    await expect(runMcpInstall(runtime(), 'codex', {apply: true})).rejects.toThrow(
      /repair or reinstall codex.*threadnote mcp-install codex --apply/i,
    );
  });
});
