import {Schema} from 'effect';
import catalog from '../../config/agent-integrations.json' with {type: 'json'};

const capability = Schema.Struct({
  status: Schema.Literals(['managed', 'partial', 'unsupported']),
  reason: Schema.optionalKey(Schema.String),
});

export const AgentCatalogEntry = Schema.Struct({
  id: Schema.String,
  agentId: Schema.String,
  displayName: Schema.String,
  tier: Schema.Literals(['full', 'core', 'project', 'manual', 'experimental']),
  aliases: Schema.Array(Schema.String),
  scopes: Schema.Array(Schema.Literals(['user', 'project', 'local'])),
  platforms: Schema.Array(Schema.Literals(['darwin', 'linux', 'win32'])),
  capabilities: Schema.Struct({mcp: capability, instructions: capability, skills: capability, hooks: capability}),
  officialDocs: Schema.Array(Schema.String),
  lastVerified: Schema.String,
  caveats: Schema.Array(Schema.String),
  setup: Schema.Array(Schema.String),
  verification: Schema.String,
});

export type AgentCatalogEntry = typeof AgentCatalogEntry.Type;
export type AgentId = AgentCatalogEntry['agentId'];
export type AgentSurfaceId = AgentCatalogEntry['id'];

export function validateAgentCatalog(value: unknown): readonly AgentCatalogEntry[] {
  const parsed = Schema.decodeUnknownSync(
    Schema.Struct({version: Schema.Literal(1), agents: Schema.Array(AgentCatalogEntry)}),
  )(value);
  const selectors = new Set<string>();
  for (const entry of parsed.agents) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.lastVerified) || entry.officialDocs.length === 0) {
      throw new Error(`Missing verification evidence for ${entry.id}`);
    }
    for (const selector of new Set([entry.id, ...entry.aliases])) {
      if (!/^[a-z][a-z0-9-]*$/.test(selector) || selectors.has(selector))
        throw new Error(`Duplicate or invalid agent selector: ${selector}`);
      selectors.add(selector);
    }
    for (const url of entry.officialDocs) {
      if (new URL(url).protocol !== 'https:') throw new Error(`Agent documentation must use HTTPS: ${entry.id}`);
    }
    for (const value of Object.values(entry.capabilities)) {
      if (value.status !== 'managed' && !value.reason?.trim())
        throw new Error(`Missing capability reason: ${entry.id}`);
    }
  }
  return parsed.agents;
}

export const AGENT_CATALOG = validateAgentCatalog(catalog);

export function findAgentSurface(selector: string): AgentCatalogEntry | undefined {
  return AGENT_CATALOG.find(entry => entry.id === selector || entry.aliases.includes(selector));
}
