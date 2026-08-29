import {Effect, FileSystem, Path} from 'effect';
import {withExclusiveFileLock} from './effect/file_lock.js';
import {SystemInfo} from './effect/system.js';
import {parseMcpToolset, type McpToolset} from './mcp/toolset.js';
import type {AgentClient, ClaudeMcpScope, RuntimeConfig} from './types.js';
import {ensureDirectory, errorMessage, readFileIfExists} from './utils.js';

export const AGENT_INTEGRATION_REGISTRY_VERSION = 1;
export const AGENT_INTEGRATION_ARTIFACT_VERSION = 1;
export const AGENT_CLIENTS = ['codex', 'claude', 'cursor', 'copilot'] as const;

const AGENT_INTEGRATION_REGISTRY_PATH = 'integrations/agents.json';
const AGENT_INTEGRATION_LOCK_PATH = 'locks/agent-integrations.lock';
const AGENT_INTEGRATION_LOCK_OPTIONS = {
  heartbeatIntervalMilliseconds: 10_000,
  retryIntervalMilliseconds: 25,
  staleAfterMilliseconds: 30_000,
  waitTimeoutMilliseconds: 30_000,
} as const;

export interface AgentIntegrationMcpReceipt {
  readonly cwd?: string;
  readonly name: string;
  readonly repair: boolean;
  readonly scope?: ClaudeMcpScope;
  readonly toolset?: McpToolset;
}

export interface AgentIntegrationHostReceipt {
  readonly artifactVersion: typeof AGENT_INTEGRATION_ARTIFACT_VERSION;
  readonly artifacts: Readonly<Record<string, string>>;
  readonly installedVersion: string;
  readonly mcp: AgentIntegrationMcpReceipt;
  readonly status: 'current' | 'pending';
}

export interface AgentIntegrationRegistry {
  readonly hosts: Partial<Record<AgentClient, AgentIntegrationHostReceipt>>;
  readonly legacyInstructionsMigrated: boolean;
  readonly version: typeof AGENT_INTEGRATION_REGISTRY_VERSION;
}

class AgentIntegrationRegistryError extends Error {
  readonly _tag = 'AgentIntegrationRegistryError' as const;
}

export const readAgentIntegrationRegistry = Effect.fn('agentIntegrations.readRegistry')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
) {
  const target = yield* agentIntegrationRegistryPath(config);
  const content = yield* readFileIfExists(target);
  if (content === undefined) return undefined;
  const parsed = yield* Effect.try({
    try: () => JSON.parse(content) as unknown,
    catch: cause => new AgentIntegrationRegistryError(`Could not parse ${target}: ${errorMessage(cause)}`),
  });
  if (!isAgentIntegrationRegistry(parsed)) {
    return yield* Effect.fail(
      new AgentIntegrationRegistryError(`${target} is not a valid agent integration registry.`),
    );
  }
  return parsed;
});

export function registeredAgentClients(registry: AgentIntegrationRegistry | undefined): readonly AgentClient[] {
  return AGENT_CLIENTS.filter(agent => registry?.hosts[agent] !== undefined);
}

export function repairableAgentClients(registry: AgentIntegrationRegistry | undefined): readonly AgentClient[] {
  return registeredAgentClients(registry).filter(agent => registry?.hosts[agent]?.mcp.repair === true);
}

export function emptyAgentIntegrationRegistry(legacyInstructionsMigrated: boolean): AgentIntegrationRegistry {
  return {hosts: {}, legacyInstructionsMigrated, version: AGENT_INTEGRATION_REGISTRY_VERSION};
}

export function withAgentIntegrationHost(
  registry: AgentIntegrationRegistry,
  agent: AgentClient,
  receipt: AgentIntegrationHostReceipt,
): AgentIntegrationRegistry {
  return {...registry, hosts: {...registry.hosts, [agent]: receipt}};
}

export const agentIntegrationRegistryPath = Effect.fn('agentIntegrations.registryPath')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
) {
  const path = yield* Path.Path;
  return path.join(config.agentContextHome, AGENT_INTEGRATION_REGISTRY_PATH);
});

export const writeAgentIntegrationRegistry = Effect.fn('agentIntegrations.writeRegistry')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  registry: AgentIntegrationRegistry,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const target = yield* agentIntegrationRegistryPath(config);
  const temporary = path.join(path.dirname(target), `.agents.${system.processId}.tmp`);
  yield* ensureDirectory(path.dirname(target), false);
  yield* fs.writeFileString(temporary, `${JSON.stringify(registry, undefined, 2)}\n`, {mode: 0o600});
  yield* fs.rename(temporary, target);
});

export function withAgentIntegrationLock<A, E, R>(
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  effect: Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* withExclusiveFileLock(
      fs,
      path.join(config.agentContextHome, AGENT_INTEGRATION_LOCK_PATH),
      AGENT_INTEGRATION_LOCK_OPTIONS,
      effect,
    );
  });
}

function isAgentIntegrationRegistry(value: unknown): value is AgentIntegrationRegistry {
  if (!isRecord(value) || value.version !== AGENT_INTEGRATION_REGISTRY_VERSION || !isRecord(value.hosts)) return false;
  if (typeof value.legacyInstructionsMigrated !== 'boolean') return false;
  for (const [agent, receipt] of Object.entries(value.hosts)) {
    if (!AGENT_CLIENTS.includes(agent as AgentClient) || !isHostReceipt(receipt)) return false;
  }
  return true;
}

function isHostReceipt(value: unknown): value is AgentIntegrationHostReceipt {
  if (!isRecord(value) || !isRecord(value.mcp) || !isRecord(value.artifacts)) return false;
  if (
    value.artifactVersion !== AGENT_INTEGRATION_ARTIFACT_VERSION ||
    typeof value.installedVersion !== 'string' ||
    (value.status !== 'current' && value.status !== 'pending') ||
    typeof value.mcp.name !== 'string' ||
    typeof value.mcp.repair !== 'boolean'
  ) {
    return false;
  }
  if (value.mcp.toolset !== undefined) {
    try {
      parseMcpToolset(value.mcp.toolset as string);
    } catch {
      return false;
    }
  }
  if (value.mcp.repair && value.mcp.toolset === undefined) return false;
  if (value.mcp.scope !== undefined && !['local', 'project', 'user'].includes(value.mcp.scope as string)) return false;
  if (value.mcp.cwd !== undefined && (typeof value.mcp.cwd !== 'string' || value.mcp.cwd.length === 0)) return false;
  if (
    value.mcp.repair &&
    (value.mcp.scope === 'local' || value.mcp.scope === 'project') &&
    value.mcp.cwd === undefined
  ) {
    return false;
  }
  return Object.values(value.artifacts).every(hash => typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
