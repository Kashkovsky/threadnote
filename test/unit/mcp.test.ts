import {it as effectIt} from '@effect/vitest';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {runEffect} from '../helpers/effect-runtime.js';
import {chmod, mkdtemp, readFile, rm, writeFile} from '../helpers/node-fs-promises.js';
import {tmpdir} from '../helpers/node-os.js';
import {delimiter, join} from '../helpers/node-path.js';
import {Effect, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {captureConsole} from '../../src/effect/console.js';
import {installCursorCloudAgentIntegration, readAgentIntegrationRegistry} from '../../src/agent_integration/index.js';
import {installCommandShim} from '../../src/command-shim.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {SystemInfo} from '../../src/effect/system.js';
import {repairRegisteredMcpClients, runUninstall} from '../../src/lifecycle.js';
import {mcpAdapterCommand, resolveMcpClients, runMcpInstall} from '../../src/mcp/index.js';
import {mcpToolCapabilities, parseMcpToolset} from '../../src/mcp/toolset.js';
import type {RuntimeConfig} from '../../src/types.js';

function runtime(agentContextHome = '/tmp/threadnote-test'): RuntimeConfig {
  return {
    account: 'local',
    agentContextHome,
    agentId: 'threadnote',
    manifestPath: `${agentContextHome}/seed-manifest.yaml`,
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
      const path = yield* Path.Path;
      const binDirectory = '/opt/threadnote/bin';
      const brokerLauncher = path.join(binDirectory, 'threadnote-mcp-server');
      const testSystem = SystemInfo.of({
        ...baseSystem,
        environment: () => ({
          ...baseSystem.environment(),
          THREADNOTE_BIN_DIR: binDirectory,
        }),
        platform: 'linux',
      });
      const command = yield* mcpAdapterCommand().pipe(Effect.provideService(SystemInfo, testSystem));

      expect(command).toEqual([brokerLauncher]);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('renders the broker launcher for every supported MCP host', () =>
    Effect.gen(function* () {
      const baseSystem = yield* SystemInfo;
      const path = yield* Path.Path;
      const binDirectory = '/opt/threadnote/bin';
      const brokerLauncher = path.join(binDirectory, 'threadnote-mcp-server');
      const testSystem = SystemInfo.of({
        ...baseSystem,
        environment: () => ({
          ...baseSystem.environment(),
          THREADNOTE_BIN_DIR: binDirectory,
        }),
        platform: 'linux',
      });

      for (const agent of ['codex', 'claude', 'cursor', 'copilot'] as const) {
        const result = yield* captureConsole(runMcpInstall(runtime(), agent, {})).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        const renderedBrokerLauncher =
          agent === 'cursor' || agent === 'copilot' ? JSON.stringify(brokerLauncher).slice(1, -1) : brokerLauncher;
        expect(result.output, agent).toContain(renderedBrokerLauncher);
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
      'Invalid MCP toolset: minimal. Expected core, cursor-cloud-personal, cursor-cloud-local, cursor-cloud, cursor-cloud-git-beta, or full.',
    );
  });

  it('gives Cursor Cloud shared writes without review, publishing, maintenance, or worksets', () => {
    expect(mcpToolCapabilities(parseMcpToolset('cursor-cloud-personal'))).toEqual({
      contextBrief: false,
      graphLocal: true,
      graphWorkset: false,
      maintenance: false,
      memoryPublish: false,
      memoryRead: true,
      memoryReview: false,
      memoryWrite: true,
    });
    expect(mcpToolCapabilities(parseMcpToolset('cursor-cloud-git-beta'))).toEqual(
      mcpToolCapabilities(parseMcpToolset('cursor-cloud-personal')),
    );
    expect(mcpToolCapabilities(parseMcpToolset('cursor-cloud'))).toEqual(
      mcpToolCapabilities(parseMcpToolset('cursor-cloud-personal')),
    );
  });

  it('keeps the Cursor Cloud local toolset graph-only', () => {
    expect(mcpToolCapabilities(parseMcpToolset('cursor-cloud-local'))).toEqual({
      contextBrief: false,
      graphLocal: true,
      graphWorkset: false,
      maintenance: false,
      memoryPublish: false,
      memoryRead: false,
      memoryReview: false,
      memoryWrite: false,
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
        const testRuntime = runtime(path.join(user, '.threadnote'));
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
                  env: {
                    THREADNOTE_USER: 'test-user',
                    THREADNOTE_MCP_TOOLSET: 'core',
                    THREADNOTE_HOME: testRuntime.agentContextHome,
                    THREADNOTE_MCP_CLIENT: agent,
                    THREADNOTE_AGENT_ID: 'threadnote',
                    THREADNOTE_ACCOUNT: 'local',
                    USER_EXTENSION: 'preserved',
                  },
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

          const result = yield* captureConsole(runMcpInstall(testRuntime, agent, {apply: true})).pipe(
            Effect.provideService(SystemInfo, testSystem),
          );

          expect(result.output, agent).toContain(`Already configured: ${configPath}`);
          expect(yield* fs.readFileString(configPath), agent).toBe(original);
          const registry = yield* readAgentIntegrationRegistry(testRuntime);
          expect(registry?.hosts[agent]).toMatchObject({
            mcp: {name: 'threadnote', repair: true, toolset: 'core'},
            status: 'current',
          });
          const skillRoot = path.join(user, agent === 'cursor' ? '.cursor' : '.copilot', 'skills');
          expect(yield* fs.exists(path.join(skillRoot, 'threadnote-context', 'SKILL.md')), agent).toBe(true);
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
        const testRuntime = runtime(path.join(user, '.threadnote'));
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
                    THREADNOTE_HOME: testRuntime.agentContextHome,
                    THREADNOTE_MCP_TOOLSET: 'full',
                    THREADNOTE_USER: 'test-user',
                  },
                  ...(agent === 'copilot' ? {type: 'stdio'} : {}),
                },
              },
            }),
          );

          const result = yield* captureConsole(runMcpInstall(testRuntime, agent, {apply: true})).pipe(
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

  effectIt.effect('uninstall removes a registered custom MCP name and its host bundle', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseSystem = yield* SystemInfo;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-custom-mcp-uninstall-'});
        const user = path.join(root, 'user');
        const bin = path.join(root, 'bin');
        const cursorPath = path.join(user, '.cursor', 'mcp.json');
        const testRuntime = runtime(path.join(user, '.threadnote'));
        yield* fs.makeDirectory(path.dirname(cursorPath), {recursive: true});
        yield* fs.writeFileString(
          cursorPath,
          JSON.stringify({mcpServers: {unrelated: {command: 'keep-me'}}}, undefined, 2),
        );
        const testSystem = SystemInfo.of({
          ...baseSystem,
          environment: () => ({...baseSystem.environment(), PATH: bin, THREADNOTE_BIN_DIR: bin}),
          homeDirectory: user,
          platform: 'linux',
        });

        yield* runMcpInstall(testRuntime, 'cursor', {
          apply: true,
          name: 'team-memory',
          toolset: 'full',
        }).pipe(Effect.provideService(SystemInfo, testSystem));
        yield* runUninstall(testRuntime, {preserveMemories: true}).pipe(Effect.provideService(SystemInfo, testSystem));

        const cursorConfig: unknown = JSON.parse(yield* fs.readFileString(cursorPath));
        expect(cursorConfig).toMatchObject({mcpServers: {unrelated: {command: 'keep-me'}}});
        expect(JSON.stringify(cursorConfig)).not.toContain('team-memory');
        expect(yield* readAgentIntegrationRegistry(testRuntime)).toBeUndefined();
        expect(yield* fs.exists(path.join(user, '.cursor', 'rules', 'threadnote.mdc'))).toBe(false);
        expect(yield* fs.exists(path.join(user, '.cursor', 'skills', 'threadnote-context', 'SKILL.md'))).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('uninstall preserves a Dashboard-owned personal Cursor MCP entry', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseSystem = yield* SystemInfo;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-cursor-cloud-uninstall-'});
        const user = path.join(root, 'user');
        const bin = path.join(root, 'bin');
        const cursorPath = path.join(user, '.cursor', 'mcp.json');
        const testRuntime = runtime(path.join(user, '.threadnote'));
        const originalConfig = {
          mcpServers: {
            threadnote: {command: 'dashboard-owned-local-companion'},
            unrelated: {command: 'keep-me'},
          },
        };
        yield* fs.makeDirectory(path.dirname(cursorPath), {recursive: true});
        yield* fs.writeFileString(cursorPath, `${JSON.stringify(originalConfig, undefined, 2)}\n`);
        const testSystem = SystemInfo.of({
          ...baseSystem,
          environment: () => ({...baseSystem.environment(), PATH: bin, THREADNOTE_BIN_DIR: bin}),
          homeDirectory: user,
          platform: 'linux',
        });

        yield* installCursorCloudAgentIntegration(testRuntime, false).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        yield* runUninstall(testRuntime, {preserveMemories: true}).pipe(Effect.provideService(SystemInfo, testSystem));

        expect(JSON.parse(yield* fs.readFileString(cursorPath))).toEqual(originalConfig);
        expect(yield* readAgentIntegrationRegistry(testRuntime)).toBeUndefined();
        expect(yield* fs.exists(path.join(user, '.cursor', 'rules', 'threadnote.mdc'))).toBe(false);
        expect(yield* fs.exists(path.join(user, '.cursor', 'skills', 'threadnote-context', 'SKILL.md'))).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('does not classify a fresh Cursor MCP install as a legacy integration', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseSystem = yield* SystemInfo;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-fresh-cursor-install-'});
        const user = path.join(root, 'user');
        const bin = path.join(root, 'bin');
        const testRuntime = runtime(path.join(user, '.threadnote'));
        const testSystem = SystemInfo.of({
          ...baseSystem,
          environment: () => ({...baseSystem.environment(), PATH: bin, THREADNOTE_BIN_DIR: bin}),
          homeDirectory: user,
          platform: 'linux',
        });

        const result = yield* captureConsole(
          runMcpInstall(testRuntime, 'cursor', {apply: true}).pipe(Effect.provideService(SystemInfo, testSystem)),
        );

        expect(result.output).toContain('No legacy agent integrations found.');
        expect(result.output).not.toContain('Migrated 1 legacy agent integration');
        expect(result.output.match(/Wrote instructions:/g)).toHaveLength(1);
        expect(yield* readAgentIntegrationRegistry(testRuntime)).toMatchObject({
          hosts: {cursor: {mcp: {name: 'threadnote', repair: true}, status: 'current'}},
          legacyInstructionsMigrated: true,
        });
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('serializes concurrent MCP install and uninstall into a consistent winning state', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseSystem = yield* SystemInfo;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-mcp-install-uninstall-race-'});
        const user = path.join(root, 'user');
        const bin = path.join(root, 'bin');
        const cursorPath = path.join(user, '.cursor', 'mcp.json');
        const rulePath = path.join(user, '.cursor', 'rules', 'threadnote.mdc');
        const skillPath = path.join(user, '.cursor', 'skills', 'threadnote-context', 'SKILL.md');
        const testRuntime = runtime(path.join(user, '.threadnote'));
        yield* fs.makeDirectory(path.dirname(cursorPath), {recursive: true});
        yield* fs.writeFileString(cursorPath, '{}\n');
        const testSystem = SystemInfo.of({
          ...baseSystem,
          environment: () => ({...baseSystem.environment(), PATH: bin, THREADNOTE_BIN_DIR: bin}),
          homeDirectory: user,
          platform: 'linux',
        });

        yield* Effect.forEach(
          [
            runMcpInstall(testRuntime, 'cursor', {apply: true, name: 'team-memory', toolset: 'full'}),
            runUninstall(testRuntime, {preserveMemories: true}),
          ],
          operation => operation.pipe(Effect.provideService(SystemInfo, testSystem)),
          {concurrency: 'unbounded'},
        ).pipe(TestClock.withLive);

        const registry = yield* readAgentIntegrationRegistry(testRuntime);
        const cursorConfig = JSON.parse(yield* fs.readFileString(cursorPath)) as {
          readonly mcpServers?: Record<string, unknown>;
        };
        const installed = registry?.hosts.cursor?.status === 'current';
        expect(cursorConfig.mcpServers?.['team-memory'] !== undefined).toBe(installed);
        expect(yield* fs.exists(rulePath)).toBe(installed);
        expect(yield* fs.exists(skillPath)).toBe(installed);
        expect(registry === undefined || Object.keys(registry.hosts).length === 0).toBe(!installed);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('uninstall retains a receipt when its custom MCP entry cannot be removed', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseSystem = yield* SystemInfo;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-custom-mcp-retry-'});
        const user = path.join(root, 'user');
        const bin = path.join(root, 'bin');
        const cursorPath = path.join(user, '.cursor', 'mcp.json');
        const testRuntime = runtime(path.join(user, '.threadnote'));
        yield* fs.makeDirectory(path.dirname(cursorPath), {recursive: true});
        yield* fs.writeFileString(cursorPath, '{}\n');
        const testSystem = SystemInfo.of({
          ...baseSystem,
          environment: () => ({...baseSystem.environment(), PATH: bin, THREADNOTE_BIN_DIR: bin}),
          homeDirectory: user,
          platform: 'linux',
        });
        yield* runMcpInstall(testRuntime, 'cursor', {
          apply: true,
          name: 'team-memory',
          toolset: 'full',
        }).pipe(Effect.provideService(SystemInfo, testSystem));
        yield* installCommandShim(false).pipe(Effect.provideService(SystemInfo, testSystem));
        yield* fs.writeFileString(cursorPath, '{ invalid json\n');

        const uninstall = yield* runUninstall(testRuntime, {preserveMemories: true}).pipe(
          Effect.provideService(SystemInfo, testSystem),
          Effect.exit,
        );

        expect(uninstall._tag).toBe('Failure');
        expect((yield* readAgentIntegrationRegistry(testRuntime))?.hosts.cursor?.mcp).toMatchObject({
          name: 'team-memory',
          repair: true,
        });
        expect(yield* fs.readFileString(cursorPath)).toBe('{ invalid json\n');
        expect(yield* fs.exists(path.join(bin, 'threadnote'))).toBe(true);
        expect(yield* fs.exists(path.join(bin, 'threadnote-mcp-server'))).toBe(true);
        expect(yield* fs.exists(path.join(user, '.cursor', 'rules', 'threadnote.mdc'))).toBe(true);
        expect(yield* fs.exists(path.join(user, '.cursor', 'skills', 'threadnote-context', 'SKILL.md'))).toBe(true);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('refuses explicit MCP omission without removing retry-critical state', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseSystem = yield* SystemInfo;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-mcp-omitted-uninstall-'});
        const user = path.join(root, 'user');
        const bin = path.join(root, 'bin');
        const cursorPath = path.join(user, '.cursor', 'mcp.json');
        const testRuntime = runtime(path.join(user, '.threadnote'));
        yield* fs.makeDirectory(path.dirname(cursorPath), {recursive: true});
        yield* fs.writeFileString(cursorPath, '{}\n');
        const testSystem = SystemInfo.of({
          ...baseSystem,
          environment: () => ({...baseSystem.environment(), PATH: bin, THREADNOTE_BIN_DIR: bin}),
          homeDirectory: user,
          platform: 'linux',
        });
        yield* runMcpInstall(testRuntime, 'cursor', {apply: true}).pipe(Effect.provideService(SystemInfo, testSystem));
        yield* installCommandShim(false).pipe(Effect.provideService(SystemInfo, testSystem));

        const uninstall = yield* runUninstall(testRuntime, {mcp: 'none', preserveMemories: true}).pipe(
          Effect.provideService(SystemInfo, testSystem),
          Effect.exit,
        );

        expect(uninstall._tag).toBe('Failure');
        expect((yield* readAgentIntegrationRegistry(testRuntime))?.hosts.cursor?.status).toBe('current');
        expect(yield* fs.exists(path.join(bin, 'threadnote'))).toBe(true);
        expect(yield* fs.exists(path.join(bin, 'threadnote-mcp-server'))).toBe(true);
        expect(yield* fs.exists(path.join(user, '.cursor', 'rules', 'threadnote.mdc'))).toBe(true);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );
});

describe('MCP agent executable resolution', () => {
  posixIt('does not remove or add semantically current Codex and Claude broker configurations', async () => {
    const bin = await mkdtemp(join(tmpdir(), 'threadnote-managed-bin-'));
    const userHome = await mkdtemp(join(tmpdir(), 'threadnote-agent-home-'));
    temporaryDirectories.push(bin);
    temporaryDirectories.push(userHome);
    const system = await runEffect(SystemInfo);
    const testSystem = SystemInfo.of({...system, homeDirectory: userHome});
    const testRuntime = runtime(join(userHome, '.threadnote'));
    process.env.THREADNOTE_BIN_DIR = bin;
    const broker = join(bin, 'threadnote-mcp-server');

    for (const agent of ['codex', 'claude'] as const) {
      const managedEnvironment = {
        THREADNOTE_ACCOUNT: 'local',
        THREADNOTE_AGENT_ID: 'threadnote',
        THREADNOTE_HOME: testRuntime.agentContextHome,
        THREADNOTE_MCP_CLIENT: agent,
        THREADNOTE_MCP_TOOLSET: 'core',
        THREADNOTE_USER: 'test-user',
      };

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

      await runEffect(
        runMcpInstall(testRuntime, agent, {apply: true}).pipe(Effect.provideService(SystemInfo, testSystem)),
      );

      const calls = await readFile(callsPath, 'utf8');
      expect(calls, agent).toContain('mcp get threadnote');
      expect(calls, agent).not.toContain('mcp remove');
      expect(calls, agent).not.toContain('mcp add');
      const registry = await runEffect(readAgentIntegrationRegistry(testRuntime));
      expect(registry?.hosts[agent]).toMatchObject({
        mcp: {name: 'threadnote', repair: true, toolset: 'core'},
        status: 'current',
      });
      const instructionPath = join(userHome, agent === 'codex' ? '.codex/AGENTS.md' : '.claude/CLAUDE.md');
      expect(await readFile(instructionPath, 'utf8'), agent).toContain('Use the installed Threadnote skills');
      await rm(callsPath, {force: true});
    }
  });

  posixIt('migrates legacy direct Codex and Claude server configurations to the broker launcher', async () => {
    const bin = await mkdtemp(join(tmpdir(), 'threadnote-managed-bin-'));
    const userHome = await mkdtemp(join(tmpdir(), 'threadnote-agent-home-'));
    temporaryDirectories.push(bin);
    temporaryDirectories.push(userHome);
    const system = await runEffect(SystemInfo);
    const testSystem = SystemInfo.of({...system, homeDirectory: userHome});
    const testRuntime = runtime(join(userHome, '.threadnote'));
    process.env.THREADNOTE_BIN_DIR = bin;
    const broker = join(bin, 'threadnote-mcp-server');
    const legacyCommand = join(bin, 'threadnote');
    const managedEnvironment = {
      THREADNOTE_ACCOUNT: 'local',
      THREADNOTE_AGENT_ID: 'threadnote',
      THREADNOTE_HOME: testRuntime.agentContextHome,
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

      await runEffect(
        runMcpInstall(testRuntime, agent, {apply: true}).pipe(Effect.provideService(SystemInfo, testSystem)),
      );

      const calls = await readFile(callsPath, 'utf8');
      expect(calls, agent).toContain(
        agent === 'claude' ? 'mcp remove --scope user threadnote' : 'mcp remove threadnote',
      );
      expect(calls, agent).toContain('mcp add');
      expect(calls, agent).toContain(broker);
      await rm(callsPath, {force: true});
    }
  });

  posixIt('removes Claude project scope from its recorded install directory', async () => {
    const bin = await mkdtemp(join(tmpdir(), 'threadnote-claude-project-bin-'));
    const userHome = await mkdtemp(join(tmpdir(), 'threadnote-claude-project-home-'));
    const projectA = await mkdtemp(join(tmpdir(), 'threadnote-claude-project-a-'));
    const projectB = await mkdtemp(join(tmpdir(), 'threadnote-claude-project-b-'));
    temporaryDirectories.push(bin, userHome, projectA, projectB);
    const callsPath = join(tmpdir(), `threadnote-claude-project-calls-${process.pid}-${Date.now()}`);
    const launcher = await agentLauncher(
      'claude',
      [
        'if [ "$1" = "--version" ]; then printf \'%s\\n\' \'claude 1\'; exit 0; fi',
        `printf '%s|%s\\n' "$PWD" "$*" >> ${shellLiteral(callsPath)}`,
        'if [ "$1 $2" = "mcp get" ]; then exit 1; fi',
        'exit 0',
      ].join('\n'),
    );
    const system = await runEffect(SystemInfo);
    const pathValue = [join(launcher, '..'), '/usr/bin', '/bin'].join(delimiter);
    const environment = {
      ...system.environment(),
      PATH: pathValue,
      THREADNOTE_BIN_DIR: bin,
      THREADNOTE_CALLER_CWD: projectA,
    };
    const installSystem = SystemInfo.of({
      ...system,
      environment: () => environment,
      homeDirectory: userHome,
    });
    const testRuntime = runtime(join(userHome, '.threadnote'));

    await runEffect(
      runMcpInstall(testRuntime, 'claude', {
        apply: true,
        name: 'team-memory',
        scope: 'project',
      }).pipe(Effect.provideService(SystemInfo, installSystem)),
    );
    const receipt = await runEffect(readAgentIntegrationRegistry(testRuntime));
    expect(receipt?.hosts.claude?.mcp).toMatchObject({
      cwd: projectA,
      name: 'team-memory',
      repair: true,
      scope: 'project',
    });
    await writeFile(callsPath, '');
    const projectBSystem = SystemInfo.of({
      ...installSystem,
      environment: () => ({...environment, THREADNOTE_CALLER_CWD: projectB}),
    });
    await runEffect(
      repairRegisteredMcpClients(testRuntime, receipt, ['claude'], false).pipe(
        Effect.provideService(SystemInfo, projectBSystem),
      ),
    );
    const repairCalls = await readFile(callsPath, 'utf8');
    expect(repairCalls).toContain(`${projectA}|mcp get team-memory`);
    expect(repairCalls).toContain(`${projectA}|mcp remove --scope project team-memory`);
    expect(repairCalls).toContain(`${projectA}|mcp add --scope project team-memory`);
    expect((await runEffect(readAgentIntegrationRegistry(testRuntime)))?.hosts.claude?.mcp.cwd).toBe(projectA);
    await writeFile(callsPath, '');

    await runEffect(
      runUninstall(testRuntime, {preserveMemories: true}).pipe(Effect.provideService(SystemInfo, projectBSystem)),
    );

    expect(await readFile(callsPath, 'utf8')).toContain(`${projectA}|mcp remove --scope project team-memory`);
    expect(await runEffect(readAgentIntegrationRegistry(testRuntime))).toBeUndefined();
    await rm(callsPath, {force: true});
  });

  posixIt('uses a healthy later PATH entry when the first Codex launcher is stale', async () => {
    const userHome = await mkdtemp(join(tmpdir(), 'threadnote-agent-home-'));
    temporaryDirectories.push(userHome);
    const system = await runEffect(SystemInfo);
    const testSystem = SystemInfo.of({...system, homeDirectory: userHome});
    const testRuntime = runtime(join(userHome, '.threadnote'));
    const broken = await codexLauncher("printf '%s\\n' 'missing native binary' >&2\nexit 1");
    const callsPath = join(tmpdir(), `threadnote-codex-calls-${process.pid}-${Date.now()}`);
    const healthy = await codexLauncher(
      `if [ "$1" = "--version" ]; then printf '%s\\n' 'codex-cli 1.0.0'; exit 0; fi\nprintf '%s\\n' "$*" >> "${callsPath}"`,
    );
    process.env.PATH = [join(broken, '..'), join(healthy, '..')].join(delimiter);

    await runEffect(
      runMcpInstall(testRuntime, 'codex', {apply: true}).pipe(Effect.provideService(SystemInfo, testSystem)),
    );

    const calls = await readFile(callsPath, 'utf8');
    expect(calls).toContain('mcp remove threadnote');
    expect(calls).toContain(`mcp add --env THREADNOTE_HOME=${testRuntime.agentContextHome}`);
    await rm(callsPath, {force: true});
  });

  posixIt('skips a broken Codex launcher during repair and gives explicit installs an actionable error', async () => {
    const broken = await codexLauncher("printf '%s\\n' 'missing native binary' >&2\nexit 1");
    process.env.PATH = [join(broken, '..'), '/usr/bin', '/bin'].join(delimiter);

    const resolution = await resolveMcpClients('codex', 'repair').pipe(captureConsole, runEffect);
    expect(resolution.value).toEqual([]);
    expect(resolution.output).toMatch(/codex command.*not working/i);
    await expect(runEffect(runMcpInstall(runtime(), 'codex', {apply: true}))).rejects.toThrow(
      /repair or reinstall codex.*threadnote mcp-install codex --apply/i,
    );
  });
});
