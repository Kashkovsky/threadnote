import {Effect} from 'effect';
import {AgentAdapterActionError, type AgentAdapterDefinition, type AgentAdapterMutation} from './contract.js';

const unsupported: AgentAdapterMutation = (_config, adapter) =>
  AgentAdapterActionError.make({
    message: `${adapter.catalog.id} is catalog-only; review its capability reasons and setup guidance.`,
  });

export function defineCatalogAgentAdapter(id: string): AgentAdapterDefinition {
  return {
    actions: {
      install: unsupported,
      remove: unsupported,
      repair: unsupported,
      status: (_config, adapter) =>
        Effect.succeed({
          state: adapter.catalog.tier === 'manual' ? 'manual' : 'unsupported',
          detail: adapter.catalog.caveats.join(' '),
        }),
    },
    adapterVersion: 1,
    id,
    kind: 'catalog',
  };
}
