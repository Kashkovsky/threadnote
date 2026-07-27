import {Console, Effect, FileSystem, Path} from 'effect';
import {THREADNOTE_MCP_NAME} from './constants.js';
import {maybeRunEffect} from './effect/command.js';
import {SystemInfo} from './effect/system.js';
import {DEFAULT_MCP_TOOLSET, MCP_TOOLSET_ENV, type McpToolset} from './mcp_toolset.js';
import type {AgentClient, ClaudeMcpScope, JsonObject, McpInstallOptions, RuntimeConfig} from './types.js';
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
  toolRoot,
} from './utils.js';

export function runMcpInstall(config: RuntimeConfig, agent: AgentClient, options: McpInstallOptions) {
  return Effect.gen(function* () {
    const name = options.name ?? THREADNOTE_MCP_NAME;
    const apply = options.apply === true;
    const toolset = options.toolset ?? DEFAULT_MCP_TOOLSET;

    if (agent === 'cursor') {
      yield* runCursorMcpInstall(config, name, {
        apply,
        toolset,
      });
      return;
    }
    if (agent === 'copilot') {
      yield* runCopilotMcpInstall(config, name, {
        apply,
        toolset,
      });
      return;
    }

    const agentExecutable = apply ? yield* requiredMcpAgentExecutable(agent) : agent;

    const command = yield* buildMcpInstallCommand(config, agent, agentExecutable, name, {
      scope: options.scope,
      toolset,
    });
    const removeCommand = yield* buildMcpRemoveCommand(agent, agentExecutable, name);

    if (!apply) {
      yield* Console.log('Dry run. Re-run with --apply to modify the selected agent config.');
      if (removeCommand.cwd || command.cwd) {
        yield* Console.log(`Command working directory: ${removeCommand.cwd ?? command.cwd}`);
      }
      yield* Console.log(formatShellCommand(removeCommand.executable, removeCommand.args));
      yield* Console.log(formatShellCommand(command.executable, command.args));
      yield* printMcpSnippet(config, agent, name, {scope: options.scope, toolset});
      return;
    }

    yield* maybeRunEffect(false, removeCommand.executable, removeCommand.args, {
      allowFailure: true,
      cwd: removeCommand.cwd,
    });
    yield* maybeRunEffect(false, command.executable, command.args, {cwd: command.cwd});
  });
}

const runCursorMcpInstall = Effect.fn('mcp.runCursorInstall')(function* (
  config: RuntimeConfig,
  name: string,
  options: {
    readonly apply: boolean;
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
  const nextContent = renderCursorMcpConfig(path, currentContent, name, serverConfig);

  if (!options.apply) {
    yield* Console.log('Dry run. Re-run with --apply to modify Cursor MCP config.');
    yield* printCursorMcpSnippet(config, name, {
      toolset: options.toolset,
    });
    return;
  }

  if (currentContent === nextContent) {
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
  const nextContent = renderCopilotMcpConfig(path, currentContent, name, serverConfig);

  if (!options.apply) {
    yield* Console.log('Dry run. Re-run with --apply to modify GitHub Copilot MCP config.');
    yield* printCopilotMcpSnippet(config, name, {
      toolset: options.toolset,
    });
    return;
  }

  if (currentContent === nextContent) {
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

export const removeMcpConfigs = Effect.fn('mcp.removeConfigs')(function* (value: string, dryRun: boolean) {
  const clients = yield* resolveMcpClients(value, 'remove');
  if (clients.length === 0) {
    yield* Console.log('Skipping MCP config removal.');
    return;
  }
  for (const client of clients) {
    if (client === 'cursor') {
      yield* removeCursorMcpConfig(THREADNOTE_MCP_NAME, dryRun);
      continue;
    }
    if (client === 'copilot') {
      yield* removeCopilotMcpConfig(THREADNOTE_MCP_NAME, dryRun);
      continue;
    }
    const executable = yield* requiredMcpAgentExecutable(client);
    const command = yield* buildMcpRemoveCommand(client, executable, THREADNOTE_MCP_NAME);
    yield* maybeRunEffect(dryRun, command.executable, command.args, {
      allowFailure: true,
      cwd: command.cwd,
    });
  }
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
    readonly scope?: ClaudeMcpScope;
    readonly toolset: McpToolset;
  },
) {
  if (agent === 'cursor') {
    return yield* Effect.fail(new Error('Cursor MCP config is written directly to ~/.cursor/mcp.json.'));
  }
  if (agent === 'copilot') {
    return yield* Effect.fail(
      new Error('GitHub Copilot MCP config is written directly to the VS Code user mcp.json file.'),
    );
  }
  const claudeCwd = yield* getInvocationCwd();
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

const mcpAdapterCommand = Effect.fn('mcp.adapterCommand')(function* () {
  const path = yield* Path.Path;
  return ['node', path.join(yield* toolRoot(), 'bin', 'threadnote-mcp-server.cjs')];
});

const buildMcpRemoveCommand = Effect.fn('mcp.buildRemoveCommand')(function* (
  agent: AgentClient,
  agentExecutable: string,
  name: string,
) {
  if (agent === 'cursor') {
    return yield* Effect.fail(new Error('Cursor MCP config is removed directly from ~/.cursor/mcp.json.'));
  }
  if (agent === 'copilot') {
    return yield* Effect.fail(
      new Error('GitHub Copilot MCP config is removed directly from the VS Code user mcp.json file.'),
    );
  }
  return agent === 'codex'
    ? {executable: agentExecutable, args: ['mcp', 'remove', name]}
    : {executable: agentExecutable, args: ['mcp', 'remove', name], cwd: yield* getInvocationCwd()};
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
      new Error(
        `${agent} command was found at ${discovered} but is not working. ` +
          `Repair or reinstall ${agent}, then run threadnote mcp-install ${agent} --apply.`,
      ),
    );
  }
  return yield* Effect.fail(
    new Error(
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
    throw new Error(`${configPath} exists but is not a JSON object; not modifying it.`);
  }
  if (parsed.mcpServers !== undefined && !isJsonObject(parsed.mcpServers)) {
    throw new Error(`${configPath} has a non-object mcpServers field; not modifying it.`);
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
    throw new Error(`${configPath} exists but is not a JSON object; not modifying it.`);
  }
  if (parsed.servers !== undefined && !isJsonObject(parsed.servers)) {
    throw new Error(`${configPath} has a non-object servers field; not modifying it.`);
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
    return;
  }
  const parsed = parseJsonConfigObject(currentContent ?? '');
  if (parsed === undefined) {
    yield* Console.log(`WARN ${path} exists but is not a JSON object; not modifying it.`);
    return;
  }
  if (!isJsonObject(parsed.mcpServers) || parsed.mcpServers[name] === undefined) {
    yield* Console.log(`No Cursor MCP config found: ${path}`);
    return;
  }
  const nextConfig: Record<string, unknown> = {...parsed};
  const mcpServers = {...parsed.mcpServers};
  delete mcpServers[name];
  nextConfig.mcpServers = mcpServers;
  const nextContent = `${JSON.stringify(nextConfig, null, 2)}\n`;
  if (dryRun) {
    yield* Console.log(`Would update Cursor MCP config: ${path}`);
    return;
  }
  yield* fs.writeFileString(path, nextContent, {mode: 0o644});
  yield* Console.log(`Updated Cursor MCP config: ${path}`);
});

const removeCopilotMcpConfig = Effect.fn('mcp.removeCopilotConfig')(function* (name: string, dryRun: boolean) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* copilotMcpConfigPath();
  const currentContent = yield* readFileIfExists(path);
  if (isEmptyConfigContent(currentContent)) {
    yield* Console.log(`Already absent: ${path}`);
    return;
  }
  const parsed = parseJsonConfigObject(currentContent ?? '');
  if (parsed === undefined) {
    yield* Console.log(`WARN ${path} exists but is not a JSON object; not modifying it.`);
    return;
  }
  if (!isJsonObject(parsed.servers) || parsed.servers[name] === undefined) {
    yield* Console.log(`No GitHub Copilot MCP config found: ${path}`);
    return;
  }
  const nextConfig: Record<string, unknown> = {...parsed};
  const servers = {...parsed.servers};
  delete servers[name];
  nextConfig.servers = servers;
  const nextContent = `${JSON.stringify(nextConfig, null, 2)}\n`;
  if (dryRun) {
    yield* Console.log(`Would update GitHub Copilot MCP config: ${path}`);
    return;
  }
  yield* fs.writeFileString(path, nextContent, {mode: 0o644});
  yield* Console.log(`Updated GitHub Copilot MCP config: ${path}`);
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
  throw new Error(`Unsupported agent: ${value}. Expected codex, claude, copilot, or cursor.`);
}

export function parseClaudeMcpScope(value: string): ClaudeMcpScope {
  if (value === 'local' || value === 'project' || value === 'user') {
    return value;
  }
  throw new Error(`Invalid Claude MCP scope: ${value}. Expected local, project, or user.`);
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
