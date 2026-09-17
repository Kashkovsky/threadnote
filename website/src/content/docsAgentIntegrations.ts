import {agentCapabilityNames, agentIntegrations, capabilityLabel, tierLabels} from './agentIntegrations.js';
import type {DocsArticle, DocsSection} from './docsTypes.js';

function agentDetailsArticle(integration: (typeof agentIntegrations)[number]): DocsArticle {
  const capabilityRows = agentCapabilityNames.map(capability => {
    const details = integration.capabilities[capability];
    return [capabilityLabel(capability), details.status, details.reason ?? 'Managed as described by this surface.'];
  });
  capabilityRows.push([
    'Project guidance',
    integration.projectGuidance.status,
    integration.projectGuidance.status === 'managed'
      ? `Managed target: ${integration.projectGuidance.targetPath}.`
      : integration.projectGuidance.reason,
  ]);
  const officialLinks = integration.officialDocs
    .map((url, index) => `[Official documentation ${index + 1}](${url})`)
    .join(' · ');

  return {
    id: `agent-${integration.id}`,
    title: integration.displayName,
    summary: `${tierLabels[integration.tier]} support for the ${integration.id} surface.`,
    keywords: [integration.agentId, integration.id, ...integration.aliases],
    body: [
      {
        type: 'paragraph',
        text: `**Surface:** \`${integration.id}\` · **Product:** ${integration.agentId} · **Tier:** ${tierLabels[integration.tier]}.`,
      },
      {type: 'table', headers: ['Capability', 'Status', 'Notes'], rows: capabilityRows},
      {type: 'heading', text: 'Scope and platform'},
      {
        type: 'paragraph',
        text: `Scopes: ${integration.scopes.length ? integration.scopes.join(', ') : 'No managed install scope.'} · Platforms: ${integration.platforms.join(', ')}.`,
      },
      {type: 'heading', text: 'Setup and verification'},
      {
        type: 'list',
        items: [...integration.setup, `Last verified: ${integration.lastVerified}.`, integration.verification],
      },
      ...(integration.caveats.length
        ? ([{type: 'warning' as const, text: integration.caveats.join(' ')}] as const)
        : []),
      {type: 'paragraph', text: officialLinks},
    ],
  };
}

export const agentIntegrationDocsSection: DocsSection = {
  id: 'agent-integrations',
  title: 'Agent integrations',
  description: 'Catalog-backed support tiers, lifecycle guidance, limitations, and exact surface details.',
  articles: [
    {
      id: 'agent-integrations',
      title: 'Supported agents',
      summary: 'Choose an exact product surface from the catalog-backed support matrix.',
      keywords: ['agents', 'integrations', 'support matrix', 'support tiers', 'catalog'],
      body: [
        {
          type: 'paragraph',
          text: 'Threadnote supports concrete host surfaces, not an undifferentiated product list. See the [supported agents matrix](/agents/) for the current catalog, including official sources and verification dates.',
        },
        {type: 'heading', text: 'Support tiers'},
        {
          type: 'table',
          headers: ['Tier', 'Meaning'],
          rows: [
            ['Full', 'Threadnote manages MCP, instructions, skills, and the lifecycle hooks the host exposes.'],
            ['Core', 'Threadnote manages MCP, instructions, and skills; the host has no suitable lifecycle API.'],
            [
              'Project-only',
              'A dedicated project artifact is safe to manage, but no stable global surface is claimed.',
            ],
            [
              'Manual / compatible',
              'Threadnote CLI and shared conventions work, but this surface has no stable managed MCP install.',
            ],
            [
              'Experimental',
              'The schema, path, or upstream contract remains version-sensitive; read the capability row before applying.',
            ],
          ],
        },
        {
          type: 'note',
          text: 'A catalog entry is not a blanket promise that every capability is managed. Use the exact surface page to check MCP, instructions, skills, hooks, scope, caveats, and setup.',
        },
      ],
    },
    {
      id: 'agent-integration-lifecycle',
      title: 'Install and manage an integration',
      summary:
        'Preview a selected supported surface, apply only the planned changes, then use doctor, repair, and uninstall.',
      keywords: ['mcp-install', 'dry run', 'doctor', 'repair', 'uninstall', 'scope'],
      body: [
        {type: 'heading', text: 'Choose a surface and scope'},
        {
          type: 'paragraph',
          text: 'Start from the [supported agents matrix](/agents/) and select the exact surface rather than assuming a product name maps to one config location. A surface may support user scope, project scope, neither, or a compatibility-only path.',
        },
        {
          type: 'code',
          language: 'sh',
          code: `# Inspect a supported surface's setup instructions first.
threadnote agents install <surface>
threadnote agents install <surface> --apply
threadnote doctor
threadnote doctor --repair
threadnote agents remove <surface>
threadnote agents remove <surface> --apply`,
        },
        {
          type: 'paragraph',
          text: 'Dry run is the review boundary: inspect the selected root, scope, and owned artifacts before applying. Doctor reports the registered integration state; repair and uninstall must preserve unrelated host configuration and use the recorded installation root.',
        },
      ],
    },
    {
      id: 'agent-integration-limitations',
      title: 'Capabilities and limitations',
      summary: 'Interpret managed, partial, and unsupported capability states without overclaiming host support.',
      keywords: ['managed', 'partial', 'unsupported', 'hooks', 'cloud', 'legacy'],
      body: [
        {
          type: 'table',
          headers: ['Status', 'Meaning'],
          rows: [
            ['managed', 'Threadnote owns a documented integration artifact for that capability.'],
            [
              'partial',
              'The host exposes some related behavior, but the catalog caveat or reason limits what Threadnote installs or verifies.',
            ],
            ['unsupported', 'Do not expect Threadnote to write or repair this capability for that surface.'],
          ],
        },
        {type: 'heading', text: 'Project-only, cloud, and legacy surfaces'},
        {
          type: 'paragraph',
          text: 'Project-only surfaces intentionally avoid global configuration. Cloud surfaces can have different writable roots and lifecycle events from their desktop counterpart. Legacy and migration entries document compatibility boundaries; they are not a recommendation to start a new managed installation.',
        },
      ],
    },
    {
      id: 'contributing-agent-integrations',
      title: 'Contribute an agent integration',
      summary:
        'Add a static adapter, one catalog surface, representative fixtures, and the shared conformance coverage together.',
      keywords: ['adapter', 'catalog', 'fixtures', 'conformance', 'contributor'],
      body: [
        {
          type: 'list',
          items: [
            'Add one static adapter for the concrete host surface; keep product identity separate from install roots and schema details.',
            'Add the matching catalog row with tier, capability status/reasons, scope, platform, official docs, setup, caveats, verification text, and last-verified date.',
            'Add path/version fixtures and run the shared conformance checks for plan, dry run, install, doctor, repair, and uninstall.',
            'Verify catalog, adapter registry, CLI output, and this site agree before requesting review.',
          ],
        },
        {
          type: 'note',
          text: 'Do not add a hand-maintained public support list. The catalog is the source for the supported-agents page and per-surface documentation.',
        },
      ],
    },
    ...agentIntegrations.map(agentDetailsArticle),
  ],
};
