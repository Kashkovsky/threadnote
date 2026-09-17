import {Effect} from 'effect';
import {mcpConfigurationChecks} from '../mcp/install.js';
import type {AgentClient, DoctorCheck, RuntimeConfig} from '../types.js';
import {AGENT_ADAPTERS, getAgentAdapter} from './adapters.js';
import type {AgentAdapter, AgentAdapterAction, AgentAdapterStatusContext} from './adapters/contract.js';
import {agentIntegrationDoctorChecks} from './index.js';
import {readAgentIntegrationRegistry} from './registry.js';

const makeStatusContext = Effect.fn('agentAdapters.statusContext')(function* (
  config: RuntimeConfig,
  inferredClients: readonly AgentClient[] = [],
  includeMcpChecks = true,
) {
  const registry = yield* readAgentIntegrationRegistry(config);
  const legacyChecks = yield* agentIntegrationDoctorChecks(config, inferredClients);
  const mcpChecks = includeMcpChecks ? yield* mcpConfigurationChecks(config, inferredClients) : [];
  return {registry, legacyChecks, mcpChecks} satisfies AgentAdapterStatusContext;
});

export function runAgentAdapterAction(
  config: RuntimeConfig,
  adapter: AgentAdapter,
  action: AgentAdapterAction,
  apply: boolean,
) {
  return adapter.actions[action](config, adapter, {apply});
}

export const agentAdapterStatuses = Effect.fn('agentAdapters.statuses')(function* (
  config: RuntimeConfig,
  adapters: readonly AgentAdapter[] = AGENT_ADAPTERS,
) {
  const context = yield* makeStatusContext(config);
  const statuses = [];
  for (const adapter of adapters) {
    statuses.push({id: adapter.catalog.id, ...(yield* adapter.actions.status(config, adapter, context))});
  }
  return statuses;
});

export const agentAdapterStatus = Effect.fn('agentAdapters.status')(function* (
  config: RuntimeConfig,
  adapter: AgentAdapter,
) {
  const context = yield* makeStatusContext(config);
  return yield* adapter.actions.status(config, adapter, context);
});

export const repairRegisteredAgentAdapters = Effect.fn('agentAdapters.repairRegistered')(function* (
  config: RuntimeConfig,
  dryRun: boolean,
) {
  const registry = yield* readAgentIntegrationRegistry(config);
  for (const id of Object.keys(registry?.surfaces ?? {})) {
    const adapter = getAgentAdapter(id);
    if (adapter) yield* adapter.actions.repair(config, adapter, {apply: !dryRun, registry});
  }
});

export const removeRegisteredAgentAdaptersInTransaction = Effect.fn('agentAdapters.removeRegistered')(function* (
  config: RuntimeConfig,
  dryRun: boolean,
  removeLegacyConsumers = false,
) {
  let registry = yield* readAgentIntegrationRegistry(config);
  if (!registry) return;
  const excludedConsumers = new Set(removeLegacyConsumers ? Object.keys(registry.hosts).map(id => `legacy:${id}`) : []);
  for (const id of Object.keys(registry.surfaces ?? {})) {
    const adapter = getAgentAdapter(id);
    if (!adapter) continue;
    const next: typeof registry | void = yield* adapter.actions.remove(config, adapter, {
      apply: !dryRun,
      excludedConsumers,
      inTransaction: true,
      registry,
    });
    if (next) registry = next;
  }
});

export const agentAdapterDoctorChecks = Effect.fn('agentAdapters.doctor')(function* (
  config: RuntimeConfig,
  inferredClients: readonly AgentClient[] = [],
) {
  const context = yield* makeStatusContext(config, inferredClients, false);
  const checks: DoctorCheck[] = [...context.legacyChecks];
  for (const id of Object.keys(context.registry?.surfaces ?? {})) {
    const adapter = getAgentAdapter(id);
    const result = adapter
      ? yield* adapter.actions.status(config, adapter, context)
      : {state: 'unsupported', detail: 'Adapter no longer registered; receipt retained.'};
    checks.push({
      name: `${id} agent surface`,
      status: result.state === 'current' ? 'ok' : 'warn',
      detail: `${result.state}: ${result.detail}`,
    });
  }
  return checks;
});

export const registeredAgentAdapterIds = Effect.fn('agentAdapters.registeredIds')(function* (config: RuntimeConfig) {
  const registry = yield* readAgentIntegrationRegistry(config);
  return AGENT_ADAPTERS.filter(
    adapter =>
      (adapter.legacyClient !== undefined && registry?.hosts[adapter.legacyClient] !== undefined) ||
      registry?.surfaces?.[adapter.catalog.id] !== undefined,
  ).map(adapter => adapter.catalog.id);
});
