import {it as effectIt} from '@effect/vitest';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {runEffect} from '../helpers/effect-runtime.js';
import {chmod, mkdtemp, readFile, rm, writeFile} from '../helpers/node-fs-promises.js';
import {tmpdir} from '../helpers/node-os.js';
import {delimiter, join} from '../helpers/node-path.js';
import {Effect, FileSystem, Path} from 'effect';
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
const originalThreadnoteBinDirectory = process.env.THREADNOTE_BIN_DIR;
const temporaryDirectories: string[] = [];
const posixIt = process.platform === 'win32' ? it.skip : it;

async function agentLauncher(agent: 'claude' | 'codex', script: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `threadnote-${agent}-`));
  temporaryDirectories.push(directory);
  const launcher = join(directory, agent);
  await writeFile(launcher, `#!/bin/sh\n${script}\n`);
  await chmod(launcher, 0o755);
  return launcher;
}

const codexLauncher = (script: string) => agentLauncher('codex', script);

function shellLiteral(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = originalPath;
  }
  if (originalThreadnoteBinDirectory === undefined) {
    delete process.env.THREADNOTE_BIN_DIR;
  } else {
    process.env.THREADNOTE_BIN_DIR = originalThreadnoteBinDirectory;
  }
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, {force: true, recursive: true})));
});

describe('MCP toolsets', () => {
  effectIt.effect('installs the core stdio toolset by default', () =>
    Effect.gen(function* () {
      expect(yield* dryRunOutput()).toContain('THREADNOTE_MCP_TOOLSET=core');
    }),
  );

  effectIt.effect('uses the stable MCP broker launcher instead of a direct server command', () =>
    Effect.gen(function* () {
      const baseSystem = yield* SystemInfo;
      const testSystem = SystemInfo.of({
        ...baseSystem,
        environment: () => ({
          ...baseSystem.environment(),
          THREADNOTE_BIN_DIR: '/opt/threadnote/bin',
        }),
        platform: 'linux',
      });
      const command = yield* mcpAdapterCommand().pipe(Effect.provideService(SystemInfo, testSystem));

      expect(command).toEqual(['/opt/threadnote/bin/threadnote-mcp-server']);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('renders the broker launcher for every supported MCP host', () =>
    Effect.gen(function* () {
      const baseSystem = yield* SystemInfo;
      const testSystem = SystemInfo.of({
        ...baseSystem,
        environment: () => ({
          ...baseSystem.environment(),
          THREADNOTE_BIN_DIR: '/opt/threadnote/bin',
        }),
        platform: 'linux',
      });

      for (const agent of ['codex', 'claude', 'cursor', 'copilot'] as const) {
        const result = yield* captureConsole(runMcpInstall(runtime(), agent, {})).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        expect(result.output, agent).toContain('/opt/threadnote/bin/threadnote-mcp-server');
        expect(result.output, agent).not.toMatch(/\bthreadnote\s+mcp-server\b/);
      }
    }).pipe(provideTestLayer(ApplicationLayer)),
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

describe('JSON MCP host configuration', () => {
  effectIt.effect('preserves differently formatted current Cursor and Copilot entries byte-for-byte', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseSystem = yield* SystemInfo;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-json-mcp-current-'});
        const user = path.join(root, 'user');
        const bin = path.join(root, 'bin');
        const broker = path.join(bin, 'threadnote-mcp-server');
        const cursorPath = path.join(user, '.cursor', 'mcp.json');
        const copilotPath = path.join(root, 'copilot-mcp.json');
        const managedEnvironment = {
          THREADNOTE_USER: 'test-user',
          THREADNOTE_MCP_TOOLSET: 'core',
          THREADNOTE_HOME: '/tmp/threadnote-test',
          THREADNOTE_AGENT_ID: 'threadnote',
          THREADNOTE_ACCOUNT: 'local',
          USER_EXTENSION: 'preserved',
        };
        const testSystem = SystemInfo.of({
          ...baseSystem,
          environment: () => ({
            ...baseSystem.environment(),
            THREADNOTE_BIN_DIR: bin,
            THREADNOTE_COPILOT_MCP_CONFIG: copilotPath,
          }),
          homeDirectory: user,
          platform: 'linux',
        });

        for (const agent of ['cursor', 'copilot'] as const) {
          const configPath = agent === 'cursor' ? cursorPath : copilotPath;
          const containerKey = agent === 'cursor' ? 'mcpServers' : 'servers';
          const original = JSON.stringify(
            {
              userSetting: true,
              [containerKey]: {
                unrelated: {command: 'unrelated-server'},
                threadnote: {
                  userMetadata: {preserve: true},
                  env: managedEnvironment,
                  command: broker,
                  args: [],
                  ...(agent === 'copilot' ? {type: 'stdio'} : {}),
                },
              },
            },
            null,
            agent === 'cursor' ? 4 : 0,
          );
          yield* fs.makeDirectory(path.dirname(configPath), {recursive: true});
          yield* fs.writeFileString(configPath, original);

          const result = yield* captureConsole(runMcpInstall(runtime(), agent, {apply: true})).pipe(
            Effect.provideService(SystemInfo, testSystem),
          );

          expect(result.output, agent).toContain(`Already configured: ${configPath}`);
          expect(yield* fs.readFileString(configPath), agent).toBe(original);
        }
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('rewrites drifted Cursor and Copilot entries while preserving unrelated configuration', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseSystem = yield* SystemInfo;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-json-mcp-drift-'});
        const user = path.join(root, 'user');
        const bin = path.join(root, 'bin');
        const broker = path.join(bin, 'threadnote-mcp-server');
        const cursorPath = path.join(user, '.cursor', 'mcp.json');
        const copilotPath = path.join(root, 'copilot-mcp.json');
        const testSystem = SystemInfo.of({
          ...baseSystem,
          environment: () => ({
            ...baseSystem.environment(),
            THREADNOTE_BIN_DIR: bin,
            THREADNOTE_COPILOT_MCP_CONFIG: copilotPath,
          }),
          homeDirectory: user,
          platform: 'linux',
        });

        for (const agent of ['cursor', 'copilot'] as const) {
          const configPath = agent === 'cursor' ? cursorPath : copilotPath;
          const containerKey = agent === 'cursor' ? 'mcpServers' : 'servers';
          yield* fs.makeDirectory(path.dirname(configPath), {recursive: true});
          yield* fs.writeFileString(
            configPath,
            JSON.stringify({
              userSetting: true,
              [containerKey]: {
                unrelated: {command: 'unrelated-server'},
                threadnote: {
                  args: ['mcp-server'],
                  command: path.join(bin, 'threadnote'),
                  env: {
                    THREADNOTE_ACCOUNT: 'local',
                    THREADNOTE_AGENT_ID: 'threadnote',
                    THREADNOTE_HOME: '/tmp/threadnote-test',
                    THREADNOTE_MCP_TOOLSET: 'full',
                    THREADNOTE_USER: 'test-user',
                  },
                  ...(agent === 'copilot' ? {type: 'stdio'} : {}),
                },
              },
            }),
          );

          const result = yield* captureConsole(runMcpInstall(runtime(), agent, {apply: true})).pipe(
            Effect.provideService(SystemInfo, testSystem),
          );
          const updated: unknown = JSON.parse(yield* fs.readFileString(configPath));

          expect(result.output, agent).toContain('Updated');
          expect(updated, agent).toMatchObject({
            userSetting: true,
            [containerKey]: {
              unrelated: {command: 'unrelated-server'},
              threadnote: {
                args: [],
                command: broker,
                env: {THREADNOTE_MCP_TOOLSET: 'core'},
                ...(agent === 'copilot' ? {type: 'stdio'} : {}),
              },
            },
          });
        }
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );
});

describe('MCP agent executable resolution', () => {
  posixIt('does not remove or add semantically current Codex and Claude broker configurations', async () => {
    const bin = await mkdtemp(join(tmpdir(), 'threadnote-managed-bin-'));
    temporaryDirectories.push(bin);
    process.env.THREADNOTE_BIN_DIR = bin;
    const broker = join(bin, 'threadnote-mcp-server');
    const managedEnvironment = {
      THREADNOTE_ACCOUNT: 'local',
      THREADNOTE_AGENT_ID: 'threadnote',
      THREADNOTE_HOME: '/tmp/threadnote-test',
      THREADNOTE_MCP_TOOLSET: 'core',
      THREADNOTE_USER: 'test-user',
    };

    for (const agent of ['codex', 'claude'] as const) {
      const callsPath = join(tmpdir(), `threadnote-${agent}-current-calls-${process.pid}-${Date.now()}`);
      const output =
        agent === 'codex'
          ? JSON.stringify({
              enabled: true,
              transport: {args: [], command: broker, env: managedEnvironment, type: 'stdio'},
            })
          : [
              'threadnote:',
              '  Scope: User config (available in all your projects)',
              '  Status: ✘ Failed to connect',
              '  Type: stdio',
              `  Command: ${broker}`,
              '  Args:',
              '  Environment:',
              ...Object.entries(managedEnvironment).map(([key, value]) => `    ${key}=${value}`),
            ].join('\n');
      const launcher = await agentLauncher(
        agent,
        `if [ "$1" = "--version" ]; then printf '%s\\n' '${agent} 1'; exit 0; fi\nprintf '%s\\n' "$*" >> ${shellLiteral(callsPath)}\nprintf '%s\\n' ${shellLiteral(output)}`,
      );
      process.env.PATH = [join(launcher, '..'), '/usr/bin', '/bin'].join(delimiter);

      await runEffect(runMcpInstall(runtime(), agent, {apply: true}));

      const calls = await readFile(callsPath, 'utf8');
      expect(calls, agent).toContain('mcp get threadnote');
      expect(calls, agent).not.toContain('mcp remove');
      expect(calls, agent).not.toContain('mcp add');
      await rm(callsPath, {force: true});
    }
  });

  posixIt('migrates legacy direct Codex and Claude server configurations to the broker launcher', async () => {
    const bin = await mkdtemp(join(tmpdir(), 'threadnote-managed-bin-'));
    temporaryDirectories.push(bin);
    process.env.THREADNOTE_BIN_DIR = bin;
    const broker = join(bin, 'threadnote-mcp-server');
    const legacyCommand = join(bin, 'threadnote');
    const managedEnvironment = {
      THREADNOTE_ACCOUNT: 'local',
      THREADNOTE_AGENT_ID: 'threadnote',
      THREADNOTE_HOME: '/tmp/threadnote-test',
      THREADNOTE_MCP_TOOLSET: 'core',
      THREADNOTE_USER: 'test-user',
    };

    for (const agent of ['codex', 'claude'] as const) {
      const callsPath = join(tmpdir(), `threadnote-${agent}-legacy-calls-${process.pid}-${Date.now()}`);
      const output =
        agent === 'codex'
          ? JSON.stringify({
              enabled: true,
              transport: {args: ['mcp-server'], command: legacyCommand, env: managedEnvironment, type: 'stdio'},
            })
          : [
              'threadnote:',
              '  Scope: User config (available in all your projects)',
              '  Status: ✘ Failed to connect',
              '  Type: stdio',
              `  Command: ${legacyCommand}`,
              '  Args: mcp-server',
              '  Environment:',
              ...Object.entries(managedEnvironment).map(([key, value]) => `    ${key}=${value}`),
            ].join('\n');
      const launcher = await agentLauncher(
        agent,
        `if [ "$1" = "--version" ]; then printf '%s\\n' '${agent} 1'; exit 0; fi\nprintf '%s\\n' "$*" >> ${shellLiteral(callsPath)}\ncase "$*" in\n  "mcp get threadnote"*) printf '%s\\n' ${shellLiteral(output)} ;;\nesac`,
      );
      process.env.PATH = [join(launcher, '..'), '/usr/bin', '/bin'].join(delimiter);

      await runEffect(runMcpInstall(runtime(), agent, {apply: true}));

      const calls = await readFile(callsPath, 'utf8');
      expect(calls, agent).toContain('mcp remove threadnote');
      expect(calls, agent).toContain('mcp add');
      expect(calls, agent).toContain(broker);
      await rm(callsPath, {force: true});
    }
  });

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
