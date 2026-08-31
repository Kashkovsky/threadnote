import {Console, Effect, FileSystem, Path} from 'effect';
import {
  installAgentIntegration,
  installAgentIntegrationInTransaction,
  migrateLegacyAgentIntegrationsInTransaction,
  readAgentIntegrationRegistry,
  registeredAgentClients,
} from '../agent_integration/index.js';
import {type AgentIntegrationMcpReceipt, withAgentIntegrationLock} from '../agent_integration/registry.js';
import {commandLauncherPath} from '../command-shim.js';
import {THREADNOTE_MCP_NAME} from '../constants.js';
import {maybeRunEffect, runCommandEffect} from '../effect/command.js';
import {SystemInfo} from '../effect/system.js';
import {DEFAULT_MCP_TOOLSET, MCP_TOOLSET_ENV, type McpToolset} from './toolset.js';
import type {AgentClient, ClaudeMcpScope, DoctorCheck, JsonObject, McpInstallOptions, RuntimeConfig} from '../types.js';
import {
  ensureDirectory,
  exists,
  expandPath,
  findExecutable,
  findWorkingExecutable,
  formatShellCommand,
  getInvocationCwd,
  isJsonObject,
  parseJsonConfigObject,
  readFileIfExists,
  removePathIfExists,
} from '../utils.js';

export function runMcpInstall(config: RuntimeConfig, agent: AgentClient, options: McpInstallOptions) {
  const install = runMcpInstallInTransaction(config, agent, options);
  return options.apply === true ? withAgentIntegrationLock(config, install) : install;
}

const runMcpInstallInTransaction = Effect.fn('mcp.runInstallInTransaction')(function* (
  config: RuntimeConfig,
  agent: AgentClient,
  options: McpInstallOptions,
) {
  const name = options.name ?? THREADNOTE_MCP_NAME;
  const apply = options.apply === true;
  const toolset = options.toolset ?? DEFAULT_MCP_TOOLSET;
  const scope = agent === 'claude' ? (options.scope ?? 'user') : undefined;
  const cwd = options.cwd ?? (agent === 'claude' && scope !== 'user' ? yield* getInvocationCwd() : undefined);
  const legacyInferredClients =
    apply && (yield* readAgentIntegrationRegistry(config)) === undefined
      ? yield* inferConfiguredMcpClients()
      : undefined;

  if (agent === 'cursor') {
    yield* runCursorMcpInstall(config, name, {
      apply,
      dryRunApplyCommand: options.dryRunApplyCommand,
      toolset,
    });
    yield* finishAgentIntegrationInstall(config, agent, {apply, legacyInferredClients, name, toolset});
    return;
  }
  if (agent === 'copilot') {
    yield* runCopilotMcpInstall(config, name, {
      apply,
      dryRunApplyCommand: options.dryRunApplyCommand,
      toolset,
    });
    yield* finishAgentIntegrationInstall(config, agent, {apply, legacyInferredClients, name, toolset});
    return;
  }

  const agentExecutable = apply ? yield* requiredMcpAgentExecutable(agent) : agent;
  const command = yield* buildMcpInstallCommand(config, agent, agentExecutable, name, {cwd, scope, toolset});
  const removeCommand = yield* buildMcpRemoveCommand(agent, agentExecutable, name, {cwd, scope});

  if (!apply) {
    yield* Console.log(
      options.dryRunApplyCommand
        ? `Dry run. Run \`${options.dryRunApplyCommand}\` without \`--dry-run\` to modify the selected agent config.`
        : 'Dry run. Re-run with --apply to modify the selected agent config.',
    );
    if (removeCommand.cwd || command.cwd) {
      yield* Console.log(`Command working directory: ${removeCommand.cwd ?? command.cwd}`);
    }
    yield* Console.log(formatShellCommand(removeCommand.executable, removeCommand.args));
    yield* Console.log(formatShellCommand(command.executable, command.args));
    yield* printMcpSnippet(config, agent, name, {scope, toolset});
    yield* installAgentIntegration(config, agent, {
      cwd,
      dryRun: true,
      name,
      scope,
      toolset,
    });
    return;
  }

  if (
    yield* cliMcpConfigurationMatches(config, agent, agentExecutable, name, {
      cwd,
      scope,
      toolset,
    })
  ) {
    yield* Console.log(`Already configured: ${agent} MCP ${name}`);
  } else {
    yield* maybeRunEffect(false, removeCommand.executable, removeCommand.args, {
      allowFailure: true,
      cwd: removeCommand.cwd,
    });
    yield* maybeRunEffect(false, command.executable, command.args, {cwd: command.cwd});
  }
  yield* finishAgentIntegrationInstall(config, agent, {
    apply,
    cwd,
    legacyInferredClients,
    name,
    scope,
    toolset,
  });
});

const finishAgentIntegrationInstall = Effect.fn('mcp.finishAgentIntegrationInstall')(function* (
  config: RuntimeConfig,
  agent: AgentClient,
  options: {
    readonly apply: boolean;
    readonly cwd?: string;
    readonly legacyInferredClients?: readonly AgentClient[];
    readonly name: string;
    readonly scope?: ClaudeMcpScope;
    readonly toolset: McpToolset;
  },
) {
  const receipt: AgentIntegrationMcpReceipt = {
    ...(options.cwd === undefined ? {} : {cwd: options.cwd}),
    name: options.name,
    repair: true,
    ...(options.scope === undefined ? {} : {scope: options.scope}),
    toolset: options.toolset,
  };
  if (!options.apply) {
    yield* installAgentIntegrationInTransaction(config, agent, receipt, true);
    return;
  }
  if (options.legacyInferredClients !== undefined) {
    yield* migrateLegacyAgentIntegrationsInTransaction(config, options.legacyInferredClients, false);
  }
  yield* installAgentIntegrationInTransaction(config, agent, receipt, false);
});

class McpOperationError extends Error {
  readonly _tag = 'McpOperationError' as const;
}

export const mcpConfigurationChecks = Effect.fn('mcp.configurationChecks')(function* (
  config: RuntimeConfig,
  inferredClients?: readonly AgentClient[],
) {
  const checks: DoctorCheck[] = [];
  const registry = yield* readAgentIntegrationRegistry(config);
  const inferred = registry === undefined ? (inferredClients ?? (yield* inferConfiguredMcpClients())) : [];
  const clients = registry === undefined ? inferred : registeredAgentClients(registry);
  for (const agent of clients) {
    const receipt = registry?.hosts[agent];
    const name = receipt?.mcp.name ?? THREADNOTE_MCP_NAME;
    const repair = receipt?.mcp.repair ?? true;
    if (agent === 'cursor') {
      checks.push(
        yield* jsonMcpConfigurationCheck('cursor MCP', yield* cursorMcpConfigPath(), 'mcpServers', name, repair),
      );
      continue;
    }
    if (agent === 'copilot') {
      checks.push(
        yield* jsonMcpConfigurationCheck('copilot MCP', yield* copilotMcpConfigPath(), 'servers', name, repair),
      );
      continue;
    }
    const executable = yield* findMcpAgentExecutable(agent);
    if (!executable) {
      checks.push({
        detail: `${agent} command unavailable; cannot inspect registered MCP ${name}`,
        name: `${agent} MCP`,
        status: 'warn',
      });
      continue;
    }
    const result = yield* runCommandEffect(executable, ['mcp', 'get', name], {
      allowFailure: true,
      maxOutputBytes: 64 * 1024,
      timeoutMs: 5_000,
    }).pipe(Effect.option);
    const configured = result._tag === 'Some' && result.value.exitCode === 0;
    const current = configured && isBrokerMcpCommandOutput(result.value.stdout);
    checks.push({
      detail: current
        ? `${name} broker configured`
        : configured
          ? repair
            ? `${name} uses the legacy direct server command; repair will migrate it to the session broker`
            : `${name} configuration predates receipts; run threadnote mcp-install ${agent} --apply to manage it`
          : repair
            ? `missing or unreadable; repair will configure ${name}`
            : `missing or unreadable; run threadnote mcp-install ${agent} --apply to manage it`,
      name: `${agent} MCP`,
      status: current ? 'ok' : 'warn',
    });
  }
  return checks;
});

function jsonMcpConfigurationCheck(
  checkName: string,
  configPath: string,
  containerKey: 'mcpServers' | 'servers',
  serverName: string,
  repair: boolean,
) {
  return Effect.gen(function* () {
    const raw = yield* readFileIfExists(configPath);
    const parsed = raw ? parseJsonConfigObject(raw) : undefined;
    const container = parsed?.[containerKey];
    const server = isJsonObject(container) && isJsonObject(container[serverName]) ? container[serverName] : undefined;
    const configured = server !== undefined;
    const current = configured && isBrokerMcpServerConfig(server);
    return {
      detail: current
        ? `${serverName} broker configured in ${configPath}`
        : configured
          ? repair
            ? `${configPath} uses the legacy direct server command; repair will migrate it to the session broker`
            : `${configPath} predates receipts; run threadnote mcp-install ${checkName.split(' ')[0]} --apply to manage it`
          : repair
            ? `${configPath} missing entry`
            : `${configPath} missing entry; run threadnote mcp-install ${checkName.split(' ')[0]} --apply to manage it`,
      name: checkName,
      status: current ? ('ok' as const) : ('warn' as const),
    };
  });
}

export const inferConfiguredMcpClients = Effect.fn('mcp.inferConfiguredClients')(function* () {
  const clients: AgentClient[] = [];
  for (const agent of ['codex', 'claude'] as const) {
    const executable = yield* findMcpAgentExecutable(agent);
    if (!executable) continue;
    const result = yield* runCommandEffect(executable, ['mcp', 'get', THREADNOTE_MCP_NAME], {
      allowFailure: true,
      maxOutputBytes: 64 * 1024,
      timeoutMs: 5_000,
    }).pipe(Effect.option);
    if (result._tag === 'Some' && result.value.exitCode === 0) clients.push(agent);
  }
  const cursor = yield* readJsonMcpServer(yield* cursorMcpConfigPath(), 'mcpServers', THREADNOTE_MCP_NAME);
  if (cursor !== undefined) clients.push('cursor');
  const copilot = yield* readJsonMcpServer(yield* copilotMcpConfigPath(), 'servers', THREADNOTE_MCP_NAME);
  if (copilot !== undefined) clients.push('copilot');
  return clients;
});

function readJsonMcpServer(configPath: string, containerKey: 'mcpServers' | 'servers', serverName: string) {
  return Effect.gen(function* () {
    const raw = yield* readFileIfExists(configPath);
    const parsed = raw ? parseJsonConfigObject(raw) : undefined;
    const container = parsed?.[containerKey];
    return isJsonObject(container) && isJsonObject(container[serverName]) ? container[serverName] : undefined;
  });
}

function isBrokerMcpCommandOutput(output: string): boolean {
  return /(?:^|[\\/])threadnote-mcp-server(?:\.cmd)?(?:\s|$)/im.test(output);
}

function isBrokerMcpServerConfig(server: JsonObject): boolean {
  const command = server.command;
  const arguments_ = server.args;
  const values = [command, ...(Array.isArray(arguments_) ? arguments_ : [])];
  return values.some(
    value => typeof value === 'string' && /(?:^|[\\/])threadnote-mcp-server(?:\.cmd)?$/i.test(value.trim()),
  );
}

const cliMcpConfigurationMatches = Effect.fn('mcp.cliConfigurationMatches')(function* (
  config: RuntimeConfig,
  agent: 'claude' | 'codex',
  agentExecutable: string,
  name: string,
  options: {
    readonly cwd?: string;
    readonly scope?: ClaudeMcpScope;
    readonly toolset: McpToolset;
  },
) {
  const result = yield* runCommandEffect(
    agentExecutable,
    agent === 'codex' ? ['mcp', 'get', name, '--json'] : ['mcp', 'get', name],
    {
      allowFailure: true,
      maxOutputBytes: 64 * 1024,
      timeoutMs: 5_000,
      cwd: options.cwd,
    },
  ).pipe(Effect.option);
  if (result._tag === 'None' || result.value.exitCode !== 0) return false;

  const command = yield* mcpAdapterCommand();
  const environment = mcpEnvironmentObject(config, options.toolset);
  return agent === 'codex'
    ? codexMcpConfigurationMatches(result.value.stdout, command, environment)
    : claudeMcpConfigurationMatches(result.value.stdout, command, environment, options.scope ?? 'user');
});

function codexMcpConfigurationMatches(output: string, command: readonly string[], environment: JsonObject): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return false;
  }
  if (!isJsonObject(parsed) || parsed.enabled !== true || !isJsonObject(parsed.transport)) return false;
  const transport = parsed.transport;
  return (
    transport.type === 'stdio' &&
    transport.command === command[0] &&
    stringArrayEquals(transport.args, command.slice(1)) &&
    managedMcpEnvironmentMatches(transport.env, environment)
  );
}

function claudeMcpConfigurationMatches(
  output: string,
  command: readonly string[],
  environment: JsonObject,
  scope: ClaudeMcpScope,
): boolean {
  const lines = output.split(/\r?\n/);
  const field = (name: string) =>
    lines
      .find(line => line.startsWith(`  ${name}:`))
      ?.slice(name.length + 3)
      .trim();
  const environmentStart = lines.findIndex(line => line.trim() === 'Environment:');
  if (environmentStart < 0) return false;
  const actualEnvironment: Record<string, string> = {};
  for (const line of lines.slice(environmentStart + 1)) {
    if (!line.startsWith('    ')) break;
    const entry = line.trim();
    const equalsAt = entry.indexOf('=');
    if (equalsAt <= 0) return false;
    actualEnvironment[entry.slice(0, equalsAt)] = entry.slice(equalsAt + 1);
  }
  const expectedScope = scope === 'user' ? 'User config' : scope === 'local' ? 'Local config' : 'Project config';
  return (
    field('Type') === 'stdio' &&
    field('Command') === command[0] &&
    field('Args') === command.slice(1).join(' ') &&
    field('Scope')?.startsWith(expectedScope) === true &&
    managedMcpEnvironmentMatches(actualEnvironment, environment)
  );
}

function stringArrayEquals(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) && value.length === expected.length && value.every((entry, index) => entry === expected[index])
  );
}

function managedMcpEnvironmentMatches(value: unknown, expected: JsonObject): boolean {
  return isJsonObject(value) && Object.entries(expected).every(([key, expectedValue]) => value[key] === expectedValue);
}

function jsonMcpConfigurationMatches(
  currentContent: string | undefined,
  containerKey: 'mcpServers' | 'servers',
  name: string,
  expected: JsonObject,
): boolean {
  if (currentContent === undefined) return false;
  const parsed = parseJsonConfigObject(currentContent);
  const container = parsed?.[containerKey];
  const actual = isJsonObject(container) && isJsonObject(container[name]) ? container[name] : undefined;
  const expectedArgs = expected.args;
  if (
    actual === undefined ||
    typeof expected.command !== 'string' ||
    !Array.isArray(expectedArgs) ||
    !expectedArgs.every(argument => typeof argument === 'string') ||
    !isJsonObject(expected.env)
  ) {
    return false;
  }
  return (
    actual.command === expected.command &&
    stringArrayEquals(actual.args, expectedArgs) &&
    (expected.type === undefined || actual.type === expected.type) &&
    managedMcpEnvironmentMatches(actual.env, expected.env)
  );
}

const runCursorMcpInstall = Effect.fn('mcp.runCursorInstall')(function* (
  config: RuntimeConfig,
  name: string,
  options: {
    readonly apply: boolean;
    readonly dryRunApplyCommand?: string;
    readonly toolset: McpToolset;
  },
) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const path = yield* cursorMcpConfigPath();
  const serverConfig = yield* buildCursorMcpServerConfig(config, {
    toolset: options.toolset,
  });
  const currentContent = yield* readFileIfExists(path);
  const current = jsonMcpConfigurationMatches(currentContent, 'mcpServers', name, serverConfig);
  const nextContent = renderCursorMcpConfig(path, currentContent, name, serverConfig);

  if (!options.apply) {
    yield* Console.log(
      options.dryRunApplyCommand
        ? `Dry run. Run \`${options.dryRunApplyCommand}\` without \`--dry-run\` to modify Cursor MCP config.`
        : 'Dry run. Re-run with --apply to modify Cursor MCP config.',
    );
    yield* printCursorMcpSnippet(config, name, {
      toolset: options.toolset,
    });
    return;
  }

  if (current || currentContent === nextContent) {
    yield* Console.log(`Already configured: ${path}`);
    return;
  }
  yield* ensureDirectory(pathService.dirname(path), false);
  yield* fs.writeFileString(path, nextContent, {mode: 0o644});
  yield* Console.log(
    currentContent === undefined ? `Wrote Cursor MCP config: ${path}` : `Updated Cursor MCP config: ${path}`,
  );
});

const runCopilotMcpInstall = Effect.fn('mcp.runCopilotInstall')(function* (
  config: RuntimeConfig,
  name: string,
  options: {
    readonly apply: boolean;
    readonly dryRunApplyCommand?: string;
    readonly toolset: McpToolset;
  },
) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const path = yield* copilotMcpConfigPath();
  const serverConfig = yield* buildCopilotMcpServerConfig(config, {
    toolset: options.toolset,
  });
  const currentContent = yield* readFileIfExists(path);
  const current = jsonMcpConfigurationMatches(currentContent, 'servers', name, serverConfig);
  const nextContent = renderCopilotMcpConfig(path, currentContent, name, serverConfig);

  if (!options.apply) {
    yield* Console.log(
      options.dryRunApplyCommand
        ? `Dry run. Run \`${options.dryRunApplyCommand}\` without \`--dry-run\` to modify GitHub Copilot MCP config.`
        : 'Dry run. Re-run with --apply to modify GitHub Copilot MCP config.',
    );
    yield* printCopilotMcpSnippet(config, name, {
      toolset: options.toolset,
    });
    return;
  }

  if (current || currentContent === nextContent) {
    yield* Console.log(`Already configured: ${path}`);
    return;
  }
  yield* ensureDirectory(pathService.dirname(path), false);
  yield* fs.writeFileString(path, nextContent, {mode: 0o644});
  yield* Console.log(
    currentContent === undefined
      ? `Wrote GitHub Copilot MCP config: ${path}`
      : `Updated GitHub Copilot MCP config: ${path}`,
  );
});

export const removeMcpConfigs = Effect.fn('mcp.removeConfigs')(function* (
  value: string,
  dryRun: boolean,
  receipts: Readonly<Partial<Record<AgentClient, AgentIntegrationMcpReceipt>>> = {},
) {
  const clients = yield* resolveMcpClients(value, 'remove');
  if (clients.length === 0) {
    yield* Console.log('Skipping MCP config removal.');
    return [];
  }
  const removed: AgentClient[] = [];
  for (const client of clients) {
    const receipt = receipts[client];
    const name = receipt?.name ?? THREADNOTE_MCP_NAME;
    if (client === 'cursor') {
      if (yield* removeCursorMcpConfig(name, dryRun)) removed.push(client);
      continue;
    }
    if (client === 'copilot') {
      if (yield* removeCopilotMcpConfig(name, dryRun)) removed.push(client);
      continue;
    }
    const executable = yield* requiredMcpAgentExecutable(client);
    const command = yield* buildMcpRemoveCommand(client, executable, name, {
      cwd: receipt?.cwd,
      scope: receipt?.scope,
    });
    const result = yield* maybeRunEffect(dryRun, command.executable, command.args, {
      allowFailure: true,
      cwd: command.cwd,
    });
    if (dryRun || result?.exitCode === 0) removed.push(client);
  }
  return removed;
});

export const removeMcpSnippets = Effect.fn('mcp.removeSnippets')(function* (config: RuntimeConfig, dryRun: boolean) {
  const path = yield* Path.Path;
  yield* removePathIfExists(
    path.join(config.agentContextHome, 'mcp', `${THREADNOTE_MCP_NAME}.codex.toml`),
    'MCP snippet',
    dryRun,
  );
  yield* removePathIfExists(
    path.join(config.agentContextHome, 'mcp', `${THREADNOTE_MCP_NAME}.claude.txt`),
    'MCP snippet',
    dryRun,
  );
  yield* removePathIfExists(
    path.join(config.agentContextHome, 'mcp', `${THREADNOTE_MCP_NAME}.cursor.json`),
    'MCP snippet',
    dryRun,
  );
  yield* removePathIfExists(
    path.join(config.agentContextHome, 'mcp', `${THREADNOTE_MCP_NAME}.copilot.json`),
    'MCP snippet',
    dryRun,
  );
});

const buildMcpInstallCommand = Effect.fn('mcp.buildInstallCommand')(function* (
  config: RuntimeConfig,
  agent: AgentClient,
  agentExecutable: string,
  name: string,
  options: {
    readonly cwd?: string;
    readonly scope?: ClaudeMcpScope;
    readonly toolset: McpToolset;
  },
) {
  if (agent === 'cursor') {
    return yield* Effect.fail(new McpOperationError('Cursor MCP config is written directly to ~/.cursor/mcp.json.'));
  }
  if (agent === 'copilot') {
    return yield* Effect.fail(
      new McpOperationError('GitHub Copilot MCP config is written directly to the VS Code user mcp.json file.'),
    );
  }
  const claudeCwd = options.cwd ?? (yield* getInvocationCwd());
  const claudeScope = options.scope ?? 'user';
  const command = yield* mcpAdapterCommand();
  const env = mcpEnvironment(config, options.toolset);
  if (agent === 'codex') {
    return {
      executable: agentExecutable,
      args: ['mcp', 'add', ...env.flatMap(value => ['--env', value]), name, '--', ...command],
    };
  }
  return {
    executable: agentExecutable,
    args: ['mcp', 'add', '--scope', claudeScope, name, ...env.flatMap(value => ['--env', value]), '--', ...command],
    cwd: claudeCwd,
  };
});

export const mcpAdapterCommand = Effect.fn('mcp.adapterCommand')(function* () {
  const system = yield* SystemInfo;
  const launcher = yield* commandLauncherPath('mcp');
  if (system.platform === 'win32') {
    const comSpec = system.environment().ComSpec ?? system.environment().COMSPEC ?? 'C:\\Windows\\System32\\cmd.exe';
    return [comSpec, '/d', '/c', launcher];
  }
  return [launcher];
});

const buildMcpRemoveCommand = Effect.fn('mcp.buildRemoveCommand')(function* (
  agent: AgentClient,
  agentExecutable: string,
  name: string,
  options: {readonly cwd?: string; readonly scope?: ClaudeMcpScope} = {},
) {
  if (agent === 'cursor') {
    return yield* Effect.fail(new McpOperationError('Cursor MCP config is removed directly from ~/.cursor/mcp.json.'));
  }
  if (agent === 'copilot') {
    return yield* Effect.fail(
      new McpOperationError('GitHub Copilot MCP config is removed directly from the VS Code user mcp.json file.'),
    );
  }
  return agent === 'codex'
    ? {executable: agentExecutable, args: ['mcp', 'remove', name]}
    : {
        executable: agentExecutable,
        args: ['mcp', 'remove', '--scope', options.scope ?? 'user', name],
        cwd: options.cwd ?? (yield* getInvocationCwd()),
      };
});

const findMcpAgentExecutable = Effect.fn('mcp.findAgentExecutable')((agent: 'claude' | 'codex') =>
  findWorkingExecutable([agent]),
);

const requiredMcpAgentExecutable = Effect.fn('mcp.requiredAgentExecutable')(function* (agent: 'claude' | 'codex') {
  const executable = yield* findMcpAgentExecutable(agent);
  if (executable) {
    return executable;
  }
  const discovered = yield* findExecutable([agent]);
  if (discovered) {
    return yield* Effect.fail(
      new McpOperationError(
        `${agent} command was found at ${discovered} but is not working. ` +
          `Repair or reinstall ${agent}, then run threadnote mcp-install ${agent} --apply.`,
      ),
    );
  }
  return yield* Effect.fail(
    new McpOperationError(
      `${agent} command was not found in PATH. Install ${agent}, then run threadnote mcp-install ${agent} --apply.`,
    ),
  );
});

function mcpEnvironment(config: RuntimeConfig, toolset: McpToolset): readonly string[] {
  return [
    `THREADNOTE_HOME=${config.agentContextHome}`,
    `THREADNOTE_ACCOUNT=${config.account}`,
    `THREADNOTE_USER=${config.user}`,
    `THREADNOTE_AGENT_ID=${config.agentId}`,
    `${MCP_TOOLSET_ENV}=${toolset}`,
  ];
}

function mcpEnvironmentObject(config: RuntimeConfig, toolset: McpToolset): JsonObject {
  return {
    THREADNOTE_ACCOUNT: config.account,
    THREADNOTE_AGENT_ID: config.agentId,
    THREADNOTE_HOME: config.agentContextHome,
    [MCP_TOOLSET_ENV]: toolset,
    THREADNOTE_USER: config.user,
  };
}

const buildCursorMcpServerConfig = Effect.fn('mcp.buildCursorServerConfig')(function* (
  config: RuntimeConfig,
  options: {
    readonly toolset: McpToolset;
  },
) {
  const command = yield* mcpAdapterCommand();
  return {
    args: command.slice(1),
    command: command[0],
    env: mcpEnvironmentObject(config, options.toolset),
  };
});

const buildCopilotMcpServerConfig = Effect.fn('mcp.buildCopilotServerConfig')(function* (
  config: RuntimeConfig,
  options: {
    readonly toolset: McpToolset;
  },
) {
  const command = yield* mcpAdapterCommand();
  return {
    args: command.slice(1),
    command: command[0],
    env: mcpEnvironmentObject(config, options.toolset),
    type: 'stdio',
  };
});

function isEmptyConfigContent(content: string | undefined): boolean {
  return content === undefined || content.trim().length === 0;
}

function renderCursorMcpConfig(
  configPath: string,
  currentContent: string | undefined,
  name: string,
  serverConfig: JsonObject,
): string {
  const parsed = isEmptyConfigContent(currentContent) ? {} : parseJsonConfigObject(currentContent ?? '');
  if (parsed === undefined) {
    throw new McpOperationError(`${configPath} exists but is not a JSON object; not modifying it.`);
  }
  if (parsed.mcpServers !== undefined && !isJsonObject(parsed.mcpServers)) {
    throw new McpOperationError(`${configPath} has a non-object mcpServers field; not modifying it.`);
  }
  const nextConfig: Record<string, unknown> = {...parsed};
  const mcpServers = isJsonObject(parsed.mcpServers) ? {...parsed.mcpServers} : {};
  mcpServers[name] = serverConfig;
  nextConfig.mcpServers = mcpServers;
  return `${JSON.stringify(nextConfig, null, 2)}\n`;
}

function renderCopilotMcpConfig(
  configPath: string,
  currentContent: string | undefined,
  name: string,
  serverConfig: JsonObject,
): string {
  const parsed = isEmptyConfigContent(currentContent) ? {} : parseJsonConfigObject(currentContent ?? '');
  if (parsed === undefined) {
    throw new McpOperationError(`${configPath} exists but is not a JSON object; not modifying it.`);
  }
  if (parsed.servers !== undefined && !isJsonObject(parsed.servers)) {
    throw new McpOperationError(`${configPath} has a non-object servers field; not modifying it.`);
  }
  const nextConfig: Record<string, unknown> = {...parsed};
  const servers = isJsonObject(parsed.servers) ? {...parsed.servers} : {};
  servers[name] = serverConfig;
  nextConfig.servers = servers;
  return `${JSON.stringify(nextConfig, null, 2)}\n`;
}

const removeCursorMcpConfig = Effect.fn('mcp.removeCursorConfig')(function* (name: string, dryRun: boolean) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* cursorMcpConfigPath();
  const currentContent = yield* readFileIfExists(path);
  if (isEmptyConfigContent(currentContent)) {
    yield* Console.log(`Already absent: ${path}`);
    return true;
  }
  const parsed = parseJsonConfigObject(currentContent ?? '');
  if (parsed === undefined) {
    yield* Console.log(`WARN ${path} exists but is not a JSON object; not modifying it.`);
    return false;
  }
  if (!isJsonObject(parsed.mcpServers) || parsed.mcpServers[name] === undefined) {
    yield* Console.log(`No Cursor MCP config found: ${path}`);
    return true;
  }
  const nextConfig: Record<string, unknown> = {...parsed};
  const mcpServers = {...parsed.mcpServers};
  delete mcpServers[name];
  nextConfig.mcpServers = mcpServers;
  const nextContent = `${JSON.stringify(nextConfig, null, 2)}\n`;
  if (dryRun) {
    yield* Console.log(`Would update Cursor MCP config: ${path}`);
    return true;
  }
  yield* fs.writeFileString(path, nextContent, {mode: 0o644});
  yield* Console.log(`Updated Cursor MCP config: ${path}`);
  return true;
});

const removeCopilotMcpConfig = Effect.fn('mcp.removeCopilotConfig')(function* (name: string, dryRun: boolean) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* copilotMcpConfigPath();
  const currentContent = yield* readFileIfExists(path);
  if (isEmptyConfigContent(currentContent)) {
    yield* Console.log(`Already absent: ${path}`);
    return true;
  }
  const parsed = parseJsonConfigObject(currentContent ?? '');
  if (parsed === undefined) {
    yield* Console.log(`WARN ${path} exists but is not a JSON object; not modifying it.`);
    return false;
  }
  if (!isJsonObject(parsed.servers) || parsed.servers[name] === undefined) {
    yield* Console.log(`No GitHub Copilot MCP config found: ${path}`);
    return true;
  }
  const nextConfig: Record<string, unknown> = {...parsed};
  const servers = {...parsed.servers};
  delete servers[name];
  nextConfig.servers = servers;
  const nextContent = `${JSON.stringify(nextConfig, null, 2)}\n`;
  if (dryRun) {
    yield* Console.log(`Would update GitHub Copilot MCP config: ${path}`);
    return true;
  }
  yield* fs.writeFileString(path, nextContent, {mode: 0o644});
  yield* Console.log(`Updated GitHub Copilot MCP config: ${path}`);
  return true;
});

const printMcpSnippet = Effect.fn('mcp.printSnippet')(function* (
  config: RuntimeConfig,
  agent: AgentClient,
  name: string,
  options: {
    readonly scope?: ClaudeMcpScope;
    readonly toolset: McpToolset;
  },
) {
  if (agent === 'cursor') {
    yield* printCursorMcpSnippet(config, name, {
      toolset: options.toolset,
    });
    return;
  }
  if (agent === 'copilot') {
    yield* printCopilotMcpSnippet(config, name, {
      toolset: options.toolset,
    });
    return;
  }
  const path = yield* Path.Path;
  const snippetPath = path.join(
    config.agentContextHome,
    'mcp',
    `${name}.${agent}.${agent === 'codex' ? 'toml' : 'txt'}`,
  );
  const command = yield* buildMcpInstallCommand(config, agent, agent, name, {
    scope: options.scope,
    toolset: options.toolset,
  });
  const snippet = `${formatShellCommand(command.executable, command.args)}\n`;
  yield* Console.log(`\nSnippet (${snippetPath}):\n${snippet}`);
});

const printCursorMcpSnippet = Effect.fn('mcp.printCursorSnippet')(function* (
  config: RuntimeConfig,
  name: string,
  options: {
    readonly toolset: McpToolset;
  },
) {
  const path = yield* Path.Path;
  const snippetPath = path.join(config.agentContextHome, 'mcp', `${name}.cursor.json`);
  const snippet = JSON.stringify({mcpServers: {[name]: yield* buildCursorMcpServerConfig(config, options)}}, null, 2);
  yield* Console.log(`\nSnippet (${snippetPath}; merge into ${yield* cursorMcpConfigPath()}):\n${snippet}`);
});

const printCopilotMcpSnippet = Effect.fn('mcp.printCopilotSnippet')(function* (
  config: RuntimeConfig,
  name: string,
  options: {
    readonly toolset: McpToolset;
  },
) {
  const path = yield* Path.Path;
  const snippetPath = path.join(config.agentContextHome, 'mcp', `${name}.copilot.json`);
  const snippet = JSON.stringify({servers: {[name]: yield* buildCopilotMcpServerConfig(config, options)}}, null, 2);
  yield* Console.log(`\nSnippet (${snippetPath}; merge into ${yield* copilotMcpConfigPath()}):\n${snippet}`);
});

const cursorMcpConfigPath = Effect.fn('mcp.cursorConfigPath')(() => expandPath('~/.cursor/mcp.json'));

const copilotMcpConfigPath = Effect.fn('mcp.copilotConfigPath')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const environment = system.environment();
  if (environment.THREADNOTE_COPILOT_MCP_CONFIG) {
    return yield* expandPath(environment.THREADNOTE_COPILOT_MCP_CONFIG);
  }
  if (system.platform === 'darwin') {
    const stablePath = yield* expandPath('~/Library/Application Support/Code/User/mcp.json');
    const insidersPath = yield* expandPath('~/Library/Application Support/Code - Insiders/User/mcp.json');
    return (yield* fs.exists(path.dirname(stablePath))) || !(yield* fs.exists(path.dirname(insidersPath)))
      ? stablePath
      : insidersPath;
  }
  if (system.platform === 'win32') {
    const appData = environment.APPDATA;
    return appData
      ? path.join(appData, 'Code', 'User', 'mcp.json')
      : yield* expandPath('~/AppData/Roaming/Code/User/mcp.json');
  }
  const configHome = environment.XDG_CONFIG_HOME
    ? yield* expandPath(environment.XDG_CONFIG_HOME)
    : yield* expandPath('~/.config');
  return path.join(configHome, 'Code', 'User', 'mcp.json');
});

export function parseAgentClient(value: string): AgentClient {
  if (value === 'codex' || value === 'claude' || value === 'copilot' || value === 'cursor') {
    return value;
  }
  throw new McpOperationError(`Unsupported agent: ${value}. Expected codex, claude, copilot, or cursor.`);
}

export function parseClaudeMcpScope(value: string): ClaudeMcpScope {
  if (value === 'local' || value === 'project' || value === 'user') {
    return value;
  }
  throw new McpOperationError(`Invalid Claude MCP scope: ${value}. Expected local, project, or user.`);
}

export const resolveMcpClients = Effect.fn('mcp.resolveClients')(function* (
  value: string,
  action: 'remove' | 'repair',
) {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'none' || normalized === 'false' || normalized === 'off') {
    return [];
  }

  let requested: readonly AgentClient[];
  if (normalized === 'available' || normalized === 'all') {
    requested = ['codex', 'claude', 'cursor', 'copilot'];
  } else {
    requested = normalized
      .split(',')
      .map(part => part.trim())
      .filter(Boolean)
      .map(parseAgentClient);
  }

  const clients: AgentClient[] = [];
  for (const client of requested) {
    if (client === 'cursor') {
      if (!(yield* isCursorAvailable())) {
        yield* Console.log(`WARN Cursor config not found; cannot ${action} cursor MCP config.`);
        continue;
      }
      if (!clients.includes(client)) {
        clients.push(client);
      }
      continue;
    }
    if (client === 'copilot') {
      if (!(yield* isCopilotAvailable())) {
        yield* Console.log(`WARN VS Code/Copilot config not found; cannot ${action} copilot MCP config.`);
        continue;
      }
      if (!clients.includes(client)) {
        clients.push(client);
      }
      continue;
    }
    if (!(yield* findMcpAgentExecutable(client))) {
      const discovered = yield* findExecutable([client]);
      yield* Console.log(
        discovered
          ? `WARN ${client} command at ${discovered} is not working; cannot ${action} ${client} MCP config. ` +
              `Repair or reinstall ${client}, then run threadnote mcp-install ${client} --apply.`
          : `WARN ${client} command not found; cannot ${action} ${client} MCP config.`,
      );
      continue;
    }
    if (!clients.includes(client)) {
      clients.push(client);
    }
  }
  return clients;
});

const isCursorAvailable = Effect.fn('mcp.isCursorAvailable')(function* () {
  const system = yield* SystemInfo;
  if (yield* exists(yield* expandPath('~/.cursor'))) {
    return true;
  }
  if (yield* findExecutable(['cursor', 'cursor-agent'])) {
    return true;
  }
  return system.platform === 'darwin' && (yield* exists('/Applications/Cursor.app'));
});

const isCopilotAvailable = Effect.fn('mcp.isCopilotAvailable')(function* () {
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  if (system.environment().THREADNOTE_COPILOT_MCP_CONFIG) {
    return true;
  }
  if (yield* exists(path.dirname(yield* copilotMcpConfigPath()))) {
    return true;
  }
  if (yield* findExecutable(['code', 'code-insiders'])) {
    return true;
  }
  return system.platform === 'darwin' && (yield* exists('/Applications/Visual Studio Code.app'));
});
