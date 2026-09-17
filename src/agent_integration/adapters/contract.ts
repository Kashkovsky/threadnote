import {Schema, type Crypto, type FileSystem, type Path} from 'effect';
import type {Effect} from 'effect';
import type {CommandExecutor} from '../../effect/command.js';
import type {SystemInfo} from '../../effect/system.js';
import type {McpToolset} from '../../mcp/toolset.js';
import type {AgentClient, DoctorCheck, RuntimeConfig} from '../../types.js';
import type {AgentCatalogEntry} from '../catalog.js';
import type {AgentIntegrationRegistry} from '../registry.js';

export class AgentAdapterActionError extends Schema.TaggedError<AgentAdapterActionError>()('AgentAdapterActionError', {
  message: Schema.String,
}) {}

export interface JsonAgentStrategy {
  readonly root: string;
  readonly xdg?: boolean;
  readonly mcpFile: string;
  readonly container: string;
  readonly instructionFile: string;
  readonly skillRoot: 'native' | 'shared';
  readonly entryType?: 'stdio';
  readonly policyGlobs?: boolean;
  readonly unverifiedPolicyFile?: string;
}

export type AgentAdapterAction = 'install' | 'remove' | 'repair';

export interface AgentAdapterStatus {
  readonly state: 'absent' | 'current' | 'disabled' | 'manual' | 'stale' | 'unsupported';
  readonly detail: string;
}

export interface AgentAdapterStatusContext {
  readonly registry: AgentIntegrationRegistry | undefined;
  readonly legacyChecks: readonly DoctorCheck[];
  readonly mcpChecks: readonly DoctorCheck[];
}

export interface AgentAdapterActionOptions {
  readonly apply: boolean;
  readonly excludedConsumers?: ReadonlySet<string>;
  readonly inTransaction?: boolean;
  readonly registry?: AgentIntegrationRegistry;
  readonly toolset?: McpToolset;
}

export type AgentAdapterRuntimeServices =
  CommandExecutor | Crypto.Crypto | FileSystem.FileSystem | Path.Path | SystemInfo;

export type AgentAdapterMutation = (
  config: RuntimeConfig,
  adapter: AgentAdapter,
  options: AgentAdapterActionOptions,
) => Effect.Effect<AgentIntegrationRegistry | void, unknown, AgentAdapterRuntimeServices>;

export interface AgentAdapterActions {
  readonly install: AgentAdapterMutation;
  readonly remove: AgentAdapterMutation;
  readonly repair: AgentAdapterMutation;
  readonly status: (
    config: RuntimeConfig,
    adapter: AgentAdapter,
    context: AgentAdapterStatusContext,
  ) => Effect.Effect<AgentAdapterStatus, unknown, AgentAdapterRuntimeServices>;
}

export interface AgentAdapterDefinition {
  readonly actions: AgentAdapterActions;
  readonly adapterVersion: 1;
  readonly id: string;
  readonly kind: 'catalog' | 'json' | 'legacy';
  readonly legacyClient?: AgentClient;
  readonly json?: JsonAgentStrategy;
}

export interface AgentAdapter extends Omit<AgentAdapterDefinition, 'id'> {
  readonly catalog: AgentCatalogEntry;
}
