import {chmod, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {delimiter, join} from 'node:path';
import {Effect} from 'effect';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {captureConsole} from '../../src/effect/console.js';
import {fromPromise} from '../../src/effect/errors.js';
import {ApplicationLayer, type ApplicationServices} from '../../src/effect/runtime.js';
import {resolveMcpClients, runMcpInstall} from '../../src/mcp.js';
import {parseMcpToolset} from '../../src/mcp_toolset.js';
import type {RuntimeConfig} from '../../src/types.js';

const run = <A, E>(effect: Effect.Effect<A, E, ApplicationServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(ApplicationLayer)));

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
  await run(runMcpInstall(runtime(), 'codex', {toolset}));
  return lines.join('\n');
}

const originalPath = process.env.PATH;
const temporaryDirectories: string[] = [];
const posixIt = process.platform === 'win32' ? it.skip : it;

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
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, {force: true, recursive: true})));
});

describe('MCP toolsets', () => {
  it('installs the core stdio toolset by default', async () => {
    await expect(dryRunOutput()).resolves.toContain('THREADNOTE_MCP_TOOLSET=core');
  });

  it('uses the Node launcher instead of POSIX env', async () => {
    const output = await dryRunOutput();
    expect(output).toContain('-- node <local-path>');
    expect(output).not.toContain('/usr/bin/env');
  });

  it('installs the full stdio toolset when requested', async () => {
    await expect(dryRunOutput('full')).resolves.toContain('THREADNOTE_MCP_TOOLSET=full');
  });

  it('rejects unsupported toolsets', () => {
    expect(() => parseMcpToolset('minimal')).toThrow('Invalid MCP toolset: minimal. Expected core or full.');
  });
});

describe('MCP agent executable resolution', () => {
  posixIt('uses a healthy later PATH entry when the first Codex launcher is stale', async () => {
    const broken = await codexLauncher("printf '%s\\n' 'missing native binary' >&2\nexit 1");
    const callsPath = join(tmpdir(), `threadnote-codex-calls-${process.pid}-${Date.now()}`);
    const healthy = await codexLauncher(
      `if [ "$1" = "--version" ]; then printf '%s\\n' 'codex-cli 1.0.0'; exit 0; fi\nprintf '%s\\n' "$*" >> "${callsPath}"`,
    );
    process.env.PATH = [join(broken, '..'), join(healthy, '..')].join(delimiter);

    await run(runMcpInstall(runtime(), 'codex', {apply: true}));

    const calls = await readFile(callsPath, 'utf8');
    expect(calls).toContain('mcp remove threadnote');
    expect(calls).toContain('mcp add --env THREADNOTE_HOME=/tmp/threadnote-test');
    await rm(callsPath, {force: true});
  });

  posixIt('skips a broken Codex launcher during repair and gives explicit installs an actionable error', async () => {
    const broken = await codexLauncher("printf '%s\\n' 'missing native binary' >&2\nexit 1");
    process.env.PATH = [join(broken, '..'), '/usr/bin', '/bin'].join(delimiter);

    const resolution = await run(
      captureConsole(fromPromise('resolve MCP clients', () => resolveMcpClients('codex', 'repair'))),
    );
    expect(resolution.value).toEqual([]);
    expect(resolution.output).toMatch(/codex command.*not working/i);
    await expect(run(runMcpInstall(runtime(), 'codex', {apply: true}))).rejects.toThrow(
      /repair or reinstall codex.*threadnote mcp-install codex --apply/i,
    );
  });
});
