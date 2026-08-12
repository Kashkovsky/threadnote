import {it as effectIt} from '@effect/vitest';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {runEffect} from '../helpers/effect-runtime.js';
import {chmod, mkdtemp, readFile, rm, writeFile} from '../helpers/node-fs-promises.js';
import {tmpdir} from '../helpers/node-os.js';
import {delimiter, join} from '../helpers/node-path.js';
import {Effect} from 'effect';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {captureConsole} from '../../src/effect/console.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {SystemInfo} from '../../src/effect/system.js';
import {mcpAdapterCommand, resolveMcpClients, runMcpInstall} from '../../src/mcp.js';
import {mcpToolCapabilities, parseMcpToolset} from '../../src/mcp_toolset.js';
import type {RuntimeConfig} from '../../src/types.js';

function runtime(): RuntimeConfig {
  return {
    account: 'local',
    agentContextHome: '/tmp/threadnote-test',
    agentId: 'threadnote',
    manifestPath: '/tmp/threadnote-test/seed-manifest.yaml',
    user: 'test-user',
  };
}

function dryRunOutput(toolset?: 'core' | 'full') {
  return captureConsole(runMcpInstall(runtime(), 'codex', {toolset})).pipe(
    Effect.map(result => result.output),
    provideTestLayer(ApplicationLayer),
  );
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
  effectIt.effect('installs the core stdio toolset by default', () =>
    Effect.gen(function* () {
      expect(yield* dryRunOutput()).toContain('THREADNOTE_MCP_TOOLSET=core');
    }),
  );

  effectIt.effect('uses the stable standalone launcher instead of POSIX env', () =>
    Effect.gen(function* () {
      const output = yield* dryRunOutput();
      expect(output).toContain('mcp-server');
      expect(output).not.toContain('/usr/bin/env');
    }),
  );

  effectIt.effect('installs the full stdio toolset when requested', () =>
    Effect.gen(function* () {
      expect(yield* dryRunOutput('full')).toContain('THREADNOTE_MCP_TOOLSET=full');
    }),
  );

  effectIt.effect('uses the owning repair command instead of advertising an unsupported apply flag', () =>
    Effect.gen(function* () {
      const result = yield* captureConsole(
        runMcpInstall(runtime(), 'codex', {
          dryRunApplyCommand: 'threadnote repair',
        }),
      ).pipe(provideTestLayer(ApplicationLayer));
      expect(result.output).toContain('Run `threadnote repair` without `--dry-run`');
      expect(result.output).not.toContain('Re-run with --apply');
    }),
  );

  it('rejects unsupported toolsets', () => {
    expect(() => parseMcpToolset('minimal')).toThrow(
      'Invalid MCP toolset: minimal. Expected core, cursor-cloud, or full.',
    );
  });

  it('gives Cursor Cloud shared writes without review, publishing, maintenance, or worksets', () => {
    expect(mcpToolCapabilities(parseMcpToolset('cursor-cloud'))).toEqual({
      contextBrief: false,
      graphLocal: true,
      graphWorkset: false,
      maintenance: false,
      memoryPublish: false,
      memoryRead: true,
      memoryReview: false,
      memoryWrite: true,
    });
  });

  effectIt.effect('launches the Windows MCP cmd adapter through ComSpec', () =>
    Effect.gen(function* () {
      const command = yield* Effect.gen(function* () {
        const baseSystem = yield* SystemInfo;
        const testSystem = SystemInfo.of({
          ...baseSystem,
          environment: () => ({
            ...baseSystem.environment(),
            ComSpec: 'C:\\Windows\\System32\\cmd.exe',
            THREADNOTE_BIN_DIR: 'C:\\Threadnote\\bin',
          }),
          platform: 'win32',
        });
        return yield* mcpAdapterCommand().pipe(Effect.provideService(SystemInfo, testSystem));
      }).pipe(provideTestLayer(ApplicationLayer));

      expect(command.slice(0, 3)).toEqual(['C:\\Windows\\System32\\cmd.exe', '/d', '/c']);
      expect(command[3]).toMatch(/C:\\Threadnote\\bin[\\/]threadnote-mcp-server\.cmd$/);
      expect(command[3]).not.toContain('"');
    }),
  );
});

describe('MCP agent executable resolution', () => {
  posixIt('uses a healthy later PATH entry when the first Codex launcher is stale', async () => {
    const broken = await codexLauncher("printf '%s\\n' 'missing native binary' >&2\nexit 1");
    const callsPath = join(tmpdir(), `threadnote-codex-calls-${process.pid}-${Date.now()}`);
    const healthy = await codexLauncher(
      `if [ "$1" = "--version" ]; then printf '%s\\n' 'codex-cli 1.0.0'; exit 0; fi\nprintf '%s\\n' "$*" >> "${callsPath}"`,
    );
    process.env.PATH = [join(broken, '..'), join(healthy, '..')].join(delimiter);

    await runEffect(runMcpInstall(runtime(), 'codex', {apply: true}));

    const calls = await readFile(callsPath, 'utf8');
    expect(calls).toContain('mcp remove threadnote');
    expect(calls).toContain('mcp add --env THREADNOTE_HOME=/tmp/threadnote-test');
    await rm(callsPath, {force: true});
  });

  posixIt('skips a broken Codex launcher during repair and gives explicit installs an actionable error', async () => {
    const broken = await codexLauncher("printf '%s\\n' 'missing native binary' >&2\nexit 1");
    process.env.PATH = [join(broken, '..'), '/usr/bin', '/bin'].join(delimiter);

    const resolution = await runEffect(captureConsole(resolveMcpClients('codex', 'repair')));
    expect(resolution.value).toEqual([]);
    expect(resolution.output).toMatch(/codex command.*not working/i);
    await expect(runEffect(runMcpInstall(runtime(), 'codex', {apply: true}))).rejects.toThrow(
      /repair or reinstall codex.*threadnote mcp-install codex --apply/i,
    );
  });
});
