import {AGENT_CATALOG, findAgentSurface} from './catalog.js';
import {defineCatalogAgentAdapter} from './adapters/catalog.js';
import {
  LEGACY_ARTIFACT_TARGETS,
  managedAgentAdapterDefinitions,
  type AgentAdapter,
  type AgentAdapterDefinition,
  type JsonAgentStrategy,
} from './adapters/index.js';

const definitions = new Map(managedAgentAdapterDefinitions.map(definition => [definition.id, definition]));

export const AGENT_ADAPTERS: readonly AgentAdapter[] = AGENT_CATALOG.map(catalog => {
  const definition: AgentAdapterDefinition = definitions.get(catalog.id) ?? defineCatalogAgentAdapter(catalog.id);
  return {...definition, catalog};
});

export {LEGACY_ARTIFACT_TARGETS};
export type {AgentAdapter, JsonAgentStrategy};

export function getAgentAdapter(selector: string): AgentAdapter | undefined {
  const entry = findAgentSurface(selector);
  return AGENT_ADAPTERS.find(adapter => adapter.catalog.id === entry?.id);
}

export {jsonServerDisabled} from './json_config.js';
