import {statSync} from 'node:fs';
import {writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {platform} from 'node:os';
import {OPENVIKING_MCP_NAME} from './constants.js';
import type {
  AgentClient,
  ClaudeMcpScope,
  JsonObject,
  MappedCommand,
  McpInstallOptions,
  RuntimeConfig,
} from './types.js';
import {
  ensureDirectory,
  exists,
  expandPath,
  findExecutable,
  formatShellCommand,
  getInvocationCwd,
  isJsonObject,
  maybeRun,
  parseJsonConfigObject,
  readFileIfExists,
  readHttpStatus,
  removePathIfExists,
  toolRoot,
} from './utils.js';

export async function runMcpInstall(
  config: RuntimeConfig,
  agent: AgentClient,
  options: McpInstallOptions,
): Promise<void> {
  const name = options.name ?? OPENVIKING_MCP_NAME;
  const url = options.url ?? `http://${config.host}:${config.port}/mcp`;
  const apply = options.apply === true;
  const nativeHttp = options.nativeHttp === true;

  if (nativeHttp) {
    const mcpStatus = await readHttpStatus(url, 1200);
    const unavailable = mcpStatus === undefined || mcpStatus === 404;
    if (unavailable && apply) {
      throw new Error(
        `OpenViking native MCP endpoint is not available at ${url}. ` +
          'Use the default stdio adapter, or install an OpenViking build that exposes /mcp.',
      );
    }
    if (unavailable) {
      console.log(`WARN OpenViking native MCP endpoint is not available at ${url}; default mcp-install uses stdio.`);
    }
  }

  if (agent === 'cursor') {
    await runCursorMcpInstall(config, name, {
      apply,
      bearerTokenEnvVar: options.bearerTokenEnvVar,
      nativeHttp,
      url,
    });
    return;
  }
  if (agent === 'copilot') {
    await runCopilotMcpInstall(config, name, {
      apply,
      bearerTokenEnvVar: options.bearerTokenEnvVar,
      nativeHttp,
      url,
    });
    return;
  }

  const command = buildMcpInstallCommand(config, agent, name, {
    bearerTokenEnvVar: options.bearerTokenEnvVar,
    nativeHttp,
    scope: options.scope,
    url,
  });
  const removeCommand = buildMcpRemoveCommand(agent, name);

  if (!apply) {
    console.log('Dry run. Re-run with --apply to modify the selected agent config.');
    if (removeCommand.cwd || command.cwd) {
      console.log(`Command working directory: ${removeCommand.cwd ?? command.cwd}`);
    }
    console.log(formatShellCommand(removeCommand.executable, removeCommand.args));
    console.log(formatShellCommand(command.executable, command.args));
    printMcpSnippet(config, agent, name, {nativeHttp, scope: options.scope, url});
    return;
  }

  await maybeRun(false, removeCommand.executable, removeCommand.args, {
    allowFailure: true,
    cwd: removeCommand.cwd,
  });
  await maybeRun(false, command.executable, command.args, {cwd: command.cwd});
}

async function runCursorMcpInstall(
  config: RuntimeConfig,
  name: string,
  options: {
    readonly apply: boolean;
    readonly bearerTokenEnvVar?: string;
    readonly nativeHttp: boolean;
    readonly url: string;
  },
): Promise<void> {
  const path = cursorMcpConfigPath();
  const serverConfig = buildCursorMcpServerConfig(config, {
    bearerTokenEnvVar: options.bearerTokenEnvVar,
    nativeHttp: options.nativeHttp,
    url: options.url,
  });
  const currentContent = await readFileIfExists(path);
  const nextContent = renderCursorMcpConfig(currentContent, name, serverConfig);

  if (!options.apply) {
    console.log('Dry run. Re-run with --apply to modify Cursor MCP config.');
    printCursorMcpSnippet(config, name, {
      bearerTokenEnvVar: options.bearerTokenEnvVar,
      nativeHttp: options.nativeHttp,
      url: options.url,
    });
    return;
  }

  if (currentContent === nextContent) {
    console.log(`Already configured: ${path}`);
    return;
  }
  await ensureDirectory(dirname(path), false);
  await writeFile(path, nextContent, {encoding: 'utf8', mode: 0o644});
  console.log(currentContent === undefined ? `Wrote Cursor MCP config: ${path}` : `Updated Cursor MCP config: ${path}`);
}

async function runCopilotMcpInstall(
  config: RuntimeConfig,
  name: string,
  options: {
    readonly apply: boolean;
    readonly bearerTokenEnvVar?: string;
    readonly nativeHttp: boolean;
    readonly url: string;
  },
): Promise<void> {
  const path = copilotMcpConfigPath();
  const serverConfig = buildCopilotMcpServerConfig(config, {
    bearerTokenEnvVar: options.bearerTokenEnvVar,
    nativeHttp: options.nativeHttp,
    url: options.url,
  });
  const currentContent = await readFileIfExists(path);
  const nextContent = renderCopilotMcpConfig(currentContent, name, serverConfig);

  if (!options.apply) {
    console.log('Dry run. Re-run with --apply to modify GitHub Copilot MCP config.');
    printCopilotMcpSnippet(config, name, {
      bearerTokenEnvVar: options.bearerTokenEnvVar,
      nativeHttp: options.nativeHttp,
      url: options.url,
    });
    return;
  }

  if (currentContent === nextContent) {
    console.log(`Already configured: ${path}`);
    return;
  }
  await ensureDirectory(dirname(path), false);
  await writeFile(path, nextContent, {encoding: 'utf8', mode: 0o644});
  console.log(
    currentContent === undefined
      ? `Wrote GitHub Copilot MCP config: ${path}`
      : `Updated GitHub Copilot MCP config: ${path}`,
  );
}

export async function removeMcpConfigs(value: string, dryRun: boolean): Promise<void> {
  const clients = await resolveMcpClients(value, 'remove');
  if (clients.length === 0) {
    console.log('Skipping MCP config removal.');
    return;
  }
  for (const client of clients) {
    if (client === 'cursor') {
      await removeCursorMcpConfig(OPENVIKING_MCP_NAME, dryRun);
      continue;
    }
    if (client === 'copilot') {
      await removeCopilotMcpConfig(OPENVIKING_MCP_NAME, dryRun);
      continue;
    }
    const command = buildMcpRemoveCommand(client, OPENVIKING_MCP_NAME);
    await maybeRun(dryRun, command.executable, command.args, {allowFailure: true, cwd: command.cwd});
  }
}

export async function removeMcpSnippets(config: RuntimeConfig, dryRun: boolean): Promise<void> {
  await removePathIfExists(
    join(config.agentContextHome, 'mcp', `${OPENVIKING_MCP_NAME}.codex.toml`),
    'MCP snippet',
    dryRun,
  );
  await removePathIfExists(
    join(config.agentContextHome, 'mcp', `${OPENVIKING_MCP_NAME}.claude.txt`),
    'MCP snippet',
    dryRun,
  );
  await removePathIfExists(
    join(config.agentContextHome, 'mcp', `${OPENVIKING_MCP_NAME}.cursor.json`),
    'MCP snippet',
    dryRun,
  );
  await removePathIfExists(
    join(config.agentContextHome, 'mcp', `${OPENVIKING_MCP_NAME}.copilot.json`),
    'MCP snippet',
    dryRun,
  );
}

function buildMcpInstallCommand(
  config: RuntimeConfig,
  agent: AgentClient,
  name: string,
  options: {
    readonly bearerTokenEnvVar?: string;
    readonly nativeHttp: boolean;
    readonly scope?: ClaudeMcpScope;
    readonly url: string;
  },
): MappedCommand {
  if (agent === 'cursor') {
    throw new Error('Cursor MCP config is written directly to ~/.cursor/mcp.json.');
  }
  if (agent === 'copilot') {
    throw new Error('GitHub Copilot MCP config is written directly to the VS Code user mcp.json file.');
  }
  const claudeCwd = getInvocationCwd();
  const claudeScope = options.scope ?? 'user';
  if (!options.nativeHttp) {
    const command = mcpAdapterCommand();
    const env = mcpEnvironment(config);
    if (agent === 'codex') {
      return {
        executable: 'codex',
        args: ['mcp', 'add', ...env.flatMap(value => ['--env', value]), name, '--', '/usr/bin/env', ...command],
      };
    }
    return {
      executable: 'claude',
      args: ['mcp', 'add', '--scope', claudeScope, name, '--', '/usr/bin/env', ...env, ...command],
      cwd: claudeCwd,
    };
  }

  if (agent === 'codex') {
    const args = ['mcp', 'add', name, '--url', options.url];
    if (options.bearerTokenEnvVar) {
      args.push('--bearer-token-env-var', options.bearerTokenEnvVar);
    }
    return {executable: 'codex', args};
  }

  const args = ['mcp', 'add', '--scope', claudeScope, '--transport', 'http', name, options.url];
  if (options.bearerTokenEnvVar) {
    const token = process.env[options.bearerTokenEnvVar];
    if (token) {
      args.push('--header', `Authorization: Bearer ${token}`);
    } else {
      console.log(
        `WARN ${options.bearerTokenEnvVar} is not set; installing Claude MCP without an Authorization header.`,
      );
    }
  }
  return {executable: 'claude', args, cwd: claudeCwd};
}

function mcpAdapterCommand(): readonly string[] {
  return [join(toolRoot(), 'bin', 'threadnote-mcp-server.cjs')];
}

function buildMcpRemoveCommand(agent: AgentClient, name: string): MappedCommand {
  if (agent === 'cursor') {
    throw new Error('Cursor MCP config is removed directly from ~/.cursor/mcp.json.');
  }
  if (agent === 'copilot') {
    throw new Error('GitHub Copilot MCP config is removed directly from the VS Code user mcp.json file.');
  }
  return agent === 'codex'
    ? {executable: 'codex', args: ['mcp', 'remove', name]}
    : {executable: 'claude', args: ['mcp', 'remove', name], cwd: getInvocationCwd()};
}

function mcpEnvironment(config: RuntimeConfig): readonly string[] {
  return [
    `THREADNOTE_HOME=${config.agentContextHome}`,
    `THREADNOTE_ACCOUNT=${config.account}`,
    `THREADNOTE_USER=${config.user}`,
    `THREADNOTE_AGENT_ID=${config.agentId}`,
  ];
}

function mcpEnvironmentObject(config: RuntimeConfig): JsonObject {
  return {
    THREADNOTE_ACCOUNT: config.account,
    THREADNOTE_AGENT_ID: config.agentId,
    THREADNOTE_HOME: config.agentContextHome,
    THREADNOTE_USER: config.user,
  };
}

function buildCursorMcpServerConfig(
  config: RuntimeConfig,
  options: {readonly bearerTokenEnvVar?: string; readonly nativeHttp: boolean; readonly url: string},
): JsonObject {
  if (options.nativeHttp) {
    const server: Record<string, unknown> = {url: options.url};
    if (options.bearerTokenEnvVar) {
      server.headers = {Authorization: `Bearer \${env:${options.bearerTokenEnvVar}}`};
    }
    return server;
  }
  return {
    args: [mcpAdapterCommand()[0]],
    command: '/usr/bin/env',
    env: mcpEnvironmentObject(config),
  };
}

function buildCopilotMcpServerConfig(
  config: RuntimeConfig,
  options: {readonly bearerTokenEnvVar?: string; readonly nativeHttp: boolean; readonly url: string},
): JsonObject {
  if (options.nativeHttp) {
    const server: Record<string, unknown> = {type: 'http', url: options.url};
    if (options.bearerTokenEnvVar) {
      server.headers = {Authorization: `Bearer \${env:${options.bearerTokenEnvVar}}`};
    }
    return server;
  }
  return {
    args: [mcpAdapterCommand()[0]],
    command: '/usr/bin/env',
    env: mcpEnvironmentObject(config),
    type: 'stdio',
  };
}

function renderCursorMcpConfig(currentContent: string | undefined, name: string, serverConfig: JsonObject): string {
  const parsed = currentContent === undefined ? {} : parseJsonConfigObject(currentContent);
  if (parsed === undefined) {
    throw new Error(`${cursorMcpConfigPath()} exists but is not a JSON object; not modifying it.`);
  }
  if (parsed.mcpServers !== undefined && !isJsonObject(parsed.mcpServers)) {
    throw new Error(`${cursorMcpConfigPath()} has a non-object mcpServers field; not modifying it.`);
  }
  const nextConfig: Record<string, unknown> = {...parsed};
  const mcpServers = isJsonObject(parsed.mcpServers) ? {...parsed.mcpServers} : {};
  mcpServers[name] = serverConfig;
  nextConfig.mcpServers = mcpServers;
  return `${JSON.stringify(nextConfig, null, 2)}\n`;
}

function renderCopilotMcpConfig(currentContent: string | undefined, name: string, serverConfig: JsonObject): string {
  const parsed = currentContent === undefined ? {} : parseJsonConfigObject(currentContent);
  if (parsed === undefined) {
    throw new Error(`${copilotMcpConfigPath()} exists but is not a JSON object; not modifying it.`);
  }
  if (parsed.servers !== undefined && !isJsonObject(parsed.servers)) {
    throw new Error(`${copilotMcpConfigPath()} has a non-object servers field; not modifying it.`);
  }
  const nextConfig: Record<string, unknown> = {...parsed};
  const servers = isJsonObject(parsed.servers) ? {...parsed.servers} : {};
  servers[name] = serverConfig;
  nextConfig.servers = servers;
  return `${JSON.stringify(nextConfig, null, 2)}\n`;
}

async function removeCursorMcpConfig(name: string, dryRun: boolean): Promise<void> {
  const path = cursorMcpConfigPath();
  const currentContent = await readFileIfExists(path);
  if (currentContent === undefined) {
    console.log(`Already absent: ${path}`);
    return;
  }
  const parsed = parseJsonConfigObject(currentContent);
  if (parsed === undefined) {
    console.log(`WARN ${path} exists but is not a JSON object; not modifying it.`);
    return;
  }
  if (!isJsonObject(parsed.mcpServers) || parsed.mcpServers[name] === undefined) {
    console.log(`No Cursor MCP config found: ${path}`);
    return;
  }
  const nextConfig: Record<string, unknown> = {...parsed};
  const mcpServers = {...parsed.mcpServers};
  delete mcpServers[name];
  nextConfig.mcpServers = mcpServers;
  const nextContent = `${JSON.stringify(nextConfig, null, 2)}\n`;
  if (dryRun) {
    console.log(`Would update Cursor MCP config: ${path}`);
    return;
  }
  await writeFile(path, nextContent, {encoding: 'utf8', mode: 0o644});
  console.log(`Updated Cursor MCP config: ${path}`);
}

async function removeCopilotMcpConfig(name: string, dryRun: boolean): Promise<void> {
  const path = copilotMcpConfigPath();
  const currentContent = await readFileIfExists(path);
  if (currentContent === undefined) {
    console.log(`Already absent: ${path}`);
    return;
  }
  const parsed = parseJsonConfigObject(currentContent);
  if (parsed === undefined) {
    console.log(`WARN ${path} exists but is not a JSON object; not modifying it.`);
    return;
  }
  if (!isJsonObject(parsed.servers) || parsed.servers[name] === undefined) {
    console.log(`No GitHub Copilot MCP config found: ${path}`);
    return;
  }
  const nextConfig: Record<string, unknown> = {...parsed};
  const servers = {...parsed.servers};
  delete servers[name];
  nextConfig.servers = servers;
  const nextContent = `${JSON.stringify(nextConfig, null, 2)}\n`;
  if (dryRun) {
    console.log(`Would update GitHub Copilot MCP config: ${path}`);
    return;
  }
  await writeFile(path, nextContent, {encoding: 'utf8', mode: 0o644});
  console.log(`Updated GitHub Copilot MCP config: ${path}`);
}

function printMcpSnippet(
  config: RuntimeConfig,
  agent: AgentClient,
  name: string,
  options: {readonly nativeHttp: boolean; readonly scope?: ClaudeMcpScope; readonly url: string},
): void {
  if (agent === 'cursor') {
    printCursorMcpSnippet(config, name, {nativeHttp: options.nativeHttp, url: options.url});
    return;
  }
  if (agent === 'copilot') {
    printCopilotMcpSnippet(config, name, {nativeHttp: options.nativeHttp, url: options.url});
    return;
  }
  const snippetPath = join(config.agentContextHome, 'mcp', `${name}.${agent}.${agent === 'codex' ? 'toml' : 'txt'}`);
  const command = buildMcpInstallCommand(config, agent, name, {
    nativeHttp: options.nativeHttp,
    scope: options.scope,
    url: options.url,
  });
  const snippet = `${formatShellCommand(command.executable, command.args)}\n`;
  console.log(`\nSnippet (${snippetPath}):\n${snippet}`);
}

function printCursorMcpSnippet(
  config: RuntimeConfig,
  name: string,
  options: {readonly bearerTokenEnvVar?: string; readonly nativeHttp: boolean; readonly url: string},
): void {
  const snippetPath = join(config.agentContextHome, 'mcp', `${name}.cursor.json`);
  const snippet = JSON.stringify({mcpServers: {[name]: buildCursorMcpServerConfig(config, options)}}, null, 2);
  console.log(`\nSnippet (${snippetPath}; merge into ${cursorMcpConfigPath()}):\n${snippet}`);
}

function printCopilotMcpSnippet(
  config: RuntimeConfig,
  name: string,
  options: {readonly bearerTokenEnvVar?: string; readonly nativeHttp: boolean; readonly url: string},
): void {
  const snippetPath = join(config.agentContextHome, 'mcp', `${name}.copilot.json`);
  const snippet = JSON.stringify({servers: {[name]: buildCopilotMcpServerConfig(config, options)}}, null, 2);
  console.log(`\nSnippet (${snippetPath}; merge into ${copilotMcpConfigPath()}):\n${snippet}`);
}

function cursorMcpConfigPath(): string {
  return expandPath('~/.cursor/mcp.json');
}

function copilotMcpConfigPath(): string {
  if (process.env.THREADNOTE_COPILOT_MCP_CONFIG) {
    return expandPath(process.env.THREADNOTE_COPILOT_MCP_CONFIG);
  }
  if (platform() === 'darwin') {
    const stablePath = expandPath('~/Library/Application Support/Code/User/mcp.json');
    const insidersPath = expandPath('~/Library/Application Support/Code - Insiders/User/mcp.json');
    return existsSyncDirectory(dirname(stablePath)) || !existsSyncDirectory(dirname(insidersPath))
      ? stablePath
      : insidersPath;
  }
  if (platform() === 'win32') {
    const appData = process.env.APPDATA;
    return appData ? join(appData, 'Code', 'User', 'mcp.json') : expandPath('~/AppData/Roaming/Code/User/mcp.json');
  }
  const configHome = process.env.XDG_CONFIG_HOME ? expandPath(process.env.XDG_CONFIG_HOME) : expandPath('~/.config');
  return join(configHome, 'Code', 'User', 'mcp.json');
}

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

export async function resolveMcpClients(value: string, action: 'remove' | 'repair'): Promise<readonly AgentClient[]> {
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
      if (!(await isCursorAvailable())) {
        console.log(`WARN Cursor config not found; cannot ${action} cursor MCP config.`);
        continue;
      }
      if (!clients.includes(client)) {
        clients.push(client);
      }
      continue;
    }
    if (client === 'copilot') {
      if (!(await isCopilotAvailable())) {
        console.log(`WARN VS Code/Copilot config not found; cannot ${action} copilot MCP config.`);
        continue;
      }
      if (!clients.includes(client)) {
        clients.push(client);
      }
      continue;
    }
    if (!(await findExecutable([client]))) {
      console.log(`WARN ${client} command not found; cannot ${action} ${client} MCP config.`);
      continue;
    }
    if (!clients.includes(client)) {
      clients.push(client);
    }
  }
  return clients;
}

async function isCursorAvailable(): Promise<boolean> {
  if (await exists(expandPath('~/.cursor'))) {
    return true;
  }
  if (await findExecutable(['cursor', 'cursor-agent'])) {
    return true;
  }
  return platform() === 'darwin' && (await exists('/Applications/Cursor.app'));
}

async function isCopilotAvailable(): Promise<boolean> {
  if (process.env.THREADNOTE_COPILOT_MCP_CONFIG) {
    return true;
  }
  if (await exists(dirname(copilotMcpConfigPath()))) {
    return true;
  }
  if (await findExecutable(['code', 'code-insiders'])) {
    return true;
  }
  return platform() === 'darwin' && (await exists('/Applications/Visual Studio Code.app'));
}

function existsSyncDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch (_err: unknown) {
    return false;
  }
}
