import {Effect} from 'effect';
import {runMcpInstall} from '../../mcp/install.js';
import type {AgentClient} from '../../types.js';
import {readAgentIntegrationRegistry} from '../registry.js';
import {AgentAdapterActionError, type AgentAdapterActionOptions, type AgentAdapterDefinition} from './contract.js';

export {LEGACY_ARTIFACT_TARGETS} from './legacy_targets.js';

function defineLegacyAgentAdapter(id: string, legacyClient: AgentClient): AgentAdapterDefinition {
  const receipt = (options: AgentAdapterActionOptions) => options.registry?.hosts[legacyClient] ?? undefined;
  const install = (config: Parameters<AgentAdapterDefinition['actions']['install']>[0]) =>
    runMcpInstall(config, legacyClient, {apply: false});
  const repair: AgentAdapterDefinition['actions']['repair'] = (config, adapter, options) =>
    Effect.gen(function* () {
      const current = receipt(options) ?? (yield* readAgentIntegrationRegistry(config))?.hosts[legacyClient];
      if (!current)
        return yield* AgentAdapterActionError.make({
          message: `No receipt for ${adapter.catalog.id}; use agents install.`,
        });
      yield* runMcpInstall(config, legacyClient, {
        apply: options.apply,
        name: current.mcp.name,
        hostRoot: current.mcp.hostRoot,
        cwd: current.mcp.cwd,
        project: current.mcp.cwd,
        scope: current.mcp.scope,
        setupLockHeld: options.setupLockHeld,
        toolset: current.mcp.toolset,
      });
    });
  return {
    actions: {
      install: (config, _adapter, options) =>
        options.apply
          ? runMcpInstall(config, legacyClient, {apply: true, setupLockHeld: options.setupLockHeld})
          : install(config),
      remove: (_config, _adapter, _options) =>
        AgentAdapterActionError.make({
          message: 'Compatibility surfaces use threadnote uninstall for removal; per-surface removal is not available.',
        }),
      repair,
      status: (_config, _adapter, context) => {
        const current = context.registry?.hosts[legacyClient];
        if (!current) return Effect.succeed({state: 'absent' as const, detail: 'No managed receipt.'});
        const checks = [...context.legacyChecks, ...context.mcpChecks];
        return Effect.succeed({
          state:
            current.status === 'current' &&
            checks.filter(check => check.name.startsWith(`${legacyClient} `)).every(check => check.status === 'ok')
              ? ('current' as const)
              : ('stale' as const),
          detail: 'Compatibility adapter; see threadnote doctor for detailed checks.',
        });
      },
    },
    adapterVersion: 1,
    hooks: {client: legacyClient, kind: 'legacy-client'},
    id,
    kind: 'legacy',
    legacyClient,
  };
}

export const legacyAdapterDefinitions: readonly AgentAdapterDefinition[] = [
  defineLegacyAgentAdapter('codex-cli', 'codex'),
  defineLegacyAgentAdapter('claude-code', 'claude'),
  defineLegacyAgentAdapter('cursor-desktop', 'cursor'),
  defineLegacyAgentAdapter('copilot-vscode', 'copilot'),
  defineLegacyAgentAdapter('omp-agent', 'omp'),
];
