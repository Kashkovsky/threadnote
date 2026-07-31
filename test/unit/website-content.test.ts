import {access, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {docsSections, mcpTools} from '../../website/src/content/docs.js';
import {graphAnalyzeScenario, graphInspectScenario, heroScenario} from '../../website/src/content/landing.js';
import {managerDemoShares, managerDemoTabs} from '../../website/src/content/managerDemo.js';
import {proTips} from '../../website/src/content/proTips.js';

const root = process.cwd();
const toolKeys = {
  analyze_code_graph: new Set([
    'callerCwd',
    'communityId',
    'includeHeuristic',
    'includeModelAssociations',
    'memberLimit',
    'operation',
  ]),
  inspect_code_graph: new Set([
    'base',
    'callerCwd',
    'depth',
    'direction',
    'edgeLimit',
    'from',
    'includeHeuristic',
    'includeModelAssociations',
    'nodeId',
    'nodeLimit',
    'operation',
    'query',
    'symbol',
    'to',
  ]),
  read_context: new Set(['uri', 'uris']),
  recall_context: new Set([
    'callerCwd',
    'includeArchived',
    'nodeLimit',
    'project',
    'query',
    'threshold',
    'uri',
    'workset',
  ]),
  remember_context: new Set([
    'kind',
    'project',
    'references',
    'replaceUri',
    'sourceAgentClient',
    'status',
    'text',
    'topic',
  ]),
  share_publish: new Set(['message', 'preview', 'push', 'redact', 'team', 'uri']),
} as const;

type DisplayedTool = keyof typeof toolKeys;

function toolName(actor: string): DisplayedTool {
  const name = actor.split(' · ', 1)[0];
  if (!name || !(name in toolKeys)) {
    throw new Error(`Website scenario uses an unverified tool contract: ${actor}`);
  }
  return name as DisplayedTool;
}

function parseToolPayload(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Tool payload must be a JSON object: ${text}`);
  }
  return parsed as Record<string, unknown>;
}

function expectNonEmptyString(payload: Record<string, unknown>, key: string): void {
  expect(typeof payload[key]).toBe('string');
  expect((payload[key] as string).trim().length).toBeGreaterThan(0);
}

describe('Threadnote 4 website content', () => {
  it('ships real entry documents for every root page', async () => {
    const routes = [
      'index.html',
      'docs/index.html',
      'pro-tips/index.html',
      'manager-demo/index.html',
      'faq/index.html',
    ];

    await Promise.all(routes.map(route => access(join(root, 'website', route))));
    const config = await readFile(join(root, 'website', 'vite.config.ts'), 'utf8');
    for (const route of ['docs', 'proTips', 'managerDemo', 'faq']) {
      expect(config).toContain(`${route}:`);
    }
  });

  it('shows the copyright in the shared site footer', async () => {
    const [shell, ...pages] = await Promise.all(
      [
        'components/SiteShell.tsx',
        'pages/LandingPage.tsx',
        'pages/DocsPage.tsx',
        'pages/ProTipsPage.tsx',
        'pages/ManagerDemoPage.tsx',
        'pages/FaqPage.tsx',
      ].map(path => readFile(join(root, 'website', 'src', path), 'utf8')),
    );

    expect(shell).toContain('© Denys Kashkovskyi 2026');
    for (const page of pages) {
      expect(page).toContain('<SiteShell');
    }
  });

  it('covers the complete 4.0 documentation map with unique article anchors', () => {
    const articles = docsSections.flatMap(section => section.articles);
    const articleIds = articles.map(article => article.id);

    expect(docsSections.length).toBeGreaterThanOrEqual(8);
    expect(articles.length).toBeGreaterThanOrEqual(35);
    expect(new Set(articleIds).size).toBe(articleIds.length);
    expect(articleIds).toEqual(
      expect.arrayContaining([
        'installation',
        'connect-an-agent',
        'memory-lifecycle',
        'local-ai',
        'sharing-setup',
        'graph-operations',
        'graph-analysis',
        'graph-corpus-and-exports',
        'graph-monorepos',
        'manager',
        'obsidian-source',
        'doctor-and-repair',
        'cli-reference',
        'mcp-reference',
        'architecture',
      ]),
    );
  });

  it('keeps pro-tip simulations aligned with the requested team and graph workflows', () => {
    const ids = proTips.map(tip => tip.id);
    const operations = proTips
      .flatMap(tip => tip.scenario.steps)
      .filter(step => step.kind === 'tool')
      .map(step => step.actor);

    expect(ids).toEqual(
      expect.arrayContaining([
        'share-before-pr',
        'parallel-team',
        'on-call',
        'switch-agents',
        'resume-later',
        'graph-operations',
        'memory-plus-graph',
      ]),
    );
    expect(operations.some(operation => operation.includes('recall_context'))).toBe(true);
    expect(operations.some(operation => operation.includes('inspect_code_graph'))).toBe(true);
    expect(operations.some(operation => operation.includes('share_publish'))).toBe(true);
  });

  it('uses fictional, generic examples in public graph simulations', async () => {
    const publicExamples = await Promise.all(
      ['content/landing.ts', 'content/proTips.ts', 'content/managerDemo.ts'].map(path =>
        readFile(join(root, 'website', 'src', path), 'utf8'),
      ),
    ).then(sources => sources.join('\n'));

    expect(publicExamples).toContain('request retry flow');
    expect(publicExamples).toContain('RequestRetryCoordinator');
    expect(publicExamples).not.toMatch(
      /document shard|DocsHydrationManager|BaseHydrationManager|hydrateDocumentShards/i,
    );
  });

  it('keeps every simulated MCP payload parseable and aligned with the actual tool contract', () => {
    const scenarios = [heroScenario, graphInspectScenario, graphAnalyzeScenario, ...proTips.map(tip => tip.scenario)];

    for (const scenario of scenarios) {
      const sharePreviews: boolean[] = [];
      for (const step of scenario.steps.filter(step => step.kind === 'tool')) {
        const name = toolName(step.actor);
        const payload = parseToolPayload(step.text);
        const allowedKeys: ReadonlySet<string> = toolKeys[name];
        expect(Object.keys(payload).every(key => allowedKeys.has(key))).toBe(true);

        switch (name) {
          case 'recall_context':
            expectNonEmptyString(payload, 'project');
            expectNonEmptyString(payload, 'query');
            expectNonEmptyString(payload, 'callerCwd');
            expect(payload.callerCwd).toMatch(/^\//);
            break;
          case 'read_context':
            expect(
              typeof payload.uri === 'string' ||
                typeof payload.uris === 'string' ||
                (Array.isArray(payload.uris) && payload.uris.length > 0),
            ).toBe(true);
            break;
          case 'remember_context':
            expectNonEmptyString(payload, 'text');
            break;
          case 'share_publish':
            expectNonEmptyString(payload, 'uri');
            expectNonEmptyString(payload, 'team');
            expect(typeof payload.preview).toBe('boolean');
            sharePreviews.push(payload.preview as boolean);
            break;
          case 'inspect_code_graph':
            expect(['query', 'node', 'neighbors', 'explain', 'path', 'impact']).toContain(payload.operation);
            expectNonEmptyString(payload, 'callerCwd');
            expect(payload.callerCwd).toMatch(/^\//);
            if (payload.operation === 'query') expectNonEmptyString(payload, 'query');
            if (payload.operation === 'explain') expectNonEmptyString(payload, 'symbol');
            if (payload.operation === 'node' || payload.operation === 'neighbors') {
              expectNonEmptyString(payload, 'nodeId');
              expect(payload.nodeId).toMatch(/^cgs_[a-f0-9]{32,64}$/);
            }
            if (payload.operation === 'path') {
              expectNonEmptyString(payload, 'from');
              expectNonEmptyString(payload, 'to');
            }
            if (payload.operation === 'impact') {
              expect(typeof payload.query === 'string' || typeof payload.base === 'string').toBe(true);
            }
            break;
          case 'analyze_code_graph':
            expect([
              'stats',
              'communities',
              'community',
              'groups',
              'hubs',
              'surprises',
              'confidence',
              'full',
            ]).toContain(payload.operation);
            expectNonEmptyString(payload, 'callerCwd');
            expect(payload.callerCwd).toMatch(/^\//);
            if (payload.operation === 'community') {
              expectNonEmptyString(payload, 'communityId');
              expect(payload.communityId).toMatch(/^cgc_[a-f0-9]{32}$/);
            }
            break;
        }
      }
      if (sharePreviews.length > 0) {
        expect(sharePreviews[0]).toBe(true);
        expect(sharePreviews.at(-1)).toBe(false);
      }
    }
  });

  it('promotes graph search as a first-class landing-page pillar', async () => {
    const landingSource = await readFile(join(root, 'website', 'src', 'pages', 'LandingPage.tsx'), 'utf8');
    const scenarios = JSON.stringify([graphInspectScenario, graphAnalyzeScenario]);

    expect(landingSource).toContain('id="graph-search"');
    expect(landingSource).toContain('inspect_code_graph');
    expect(landingSource).toContain('analyze_code_graph');
    expect(landingSource).toContain('Current-worktree truth');
    expect(landingSource).toContain('Repository size is not an admission test');
    expect(landingSource).toContain('Architecture signals');
    expect(landingSource).toContain('JSON, GraphML, HTML, or SVG');
    expect(landingSource).toContain('Open the Manager demo');
    expect(scenarios).toContain('current commit + isolated dirty overlay');
    expect(scenarios).toContain('paged SQLite analysis · no repository admission cap');
  });

  it('documents the explicit publishing and supported hook boundaries', () => {
    const content = JSON.stringify(docsSections);

    expect(content).toContain('threadnote install-hooks claude --dry-run');
    expect(content).not.toContain('threadnote install-hooks codex --dry-run');
    expect(content).toContain('threadnote share publish');
    expect(content).toContain('--preview');
    expect(content).toContain('selected vector generation');
  });

  it('uses the real Manager labels and share status fields in the mock data', () => {
    expect(managerDemoTabs.map(tab => tab.label)).toEqual(['Graph', 'Library', 'Sharing', 'Health', 'Tools']);
    for (const share of managerDemoShares) {
      expect(share.name).toBe(share.label);
      expect(share.remote).not.toBe('');
      expect(share.worktree).not.toBe('');
      expect(share.gitdir).not.toBe('');
      expect(typeof share.default).toBe('boolean');
      expect(typeof share.dirty).toBe('boolean');
      expect(['two-way', 'publish', 'read-only']).not.toContain(share.direction);
    }
  });

  it('labels synthetic Manager data and retains the hidden Graphify comparison behind an opt-in flag', async () => {
    const [managerSource, faqSource, faqHtml] = await Promise.all([
      readFile(join(root, 'website', 'src', 'components', 'ManagerMock.tsx'), 'utf8'),
      readFile(join(root, 'website', 'src', 'pages', 'FaqPage.tsx'), 'utf8'),
      readFile(join(root, 'website', 'faq', 'index.html'), 'utf8'),
    ]);

    expect(managerSource).toContain('Mock data — no local files read');
    expect(faqHtml).not.toContain('Graphify');
    expect(faqSource).toContain(
      "const SHOW_GRAPHIFY_COMPARISON = import.meta.env.VITE_SHOW_GRAPHIFY_COMPARISON === 'true'",
    );
    expect(faqSource).toContain('{SHOW_GRAPHIFY_COMPARISON ? (');
    expect(faqSource).toContain('!item.comparisonOnly || SHOW_GRAPHIFY_COMPARISON');
    expect(faqSource).toContain('Threadnote vs Graphify');
    expect(faqSource.indexOf('The practical questions')).toBeLessThan(faqSource.indexOf('Threadnote vs Graphify'));
    expect(faqSource).toContain('Not TypeScript-only');
    expect(faqSource).toContain('36 tree-sitter grammars');
    expect(faqSource).toContain('512 MiB load guard');
    expect(faqSource).toContain('no eligible-repository admission cap');
    expect(faqSource).toContain('per-artifact corpus safety budgets');
    expect(faqSource).toContain('searchable metadata-only nodes');
    expect(faqSource).toContain('semantic inputs require an assistant or configured model');
    expect(faqSource).toContain('analyze_code_graph');
    expect(faqSource).toContain('stable community drill-down, structural n-ary groups, hubs and god nodes');
    expect(faqSource).toContain('PDF text and links');
    expect(faqSource).toContain('not OCR or transcription');
    expect(faqSource).toContain('JSON, GraphML, HTML, or SVG');
    expect(faqSource).toContain('Leiden communities');
    expect(faqSource).toContain('hyperedges');
    expect(faqSource).not.toContain(
      'Broader language and multimodal analysis, including documents, papers, and diagrams',
    );
    expect(faqSource).toContain(
      'https://github.com/Graphify-Labs/graphify/tree/4fe11092ccbe9f543608f140c790f68d5d83cae4',
    );
    expect(faqSource).toContain('https://graphify.net/knowledge-graph-for-ai-coding-assistants.html');
  });

  it('documents the separate whole-graph analysis and corpus/export contracts', () => {
    const content = JSON.stringify(docsSections);
    const analysisTool = mcpTools.find(tool => tool.name === 'analyze_code_graph');

    expect(analysisTool).toMatchObject({toolset: 'core'});
    expect(analysisTool?.keyInputs).toContain(
      'operation: stats | communities | community | groups | hubs | surprises | confidence | full',
    );
    expect(content).toContain('analyze_code_graph');
    expect(content).toContain('threadnote graph communities');
    expect(content).toContain('threadnote graph community --community-id cgc_…');
    expect(content).toContain('threadnote graph groups');
    expect(content).toContain('threadnote graph confidence');
    expect(content).toContain('threadnote graph report --output architecture-report.md');
    expect(content).toContain('OpenXML, OpenDocument, and EPUB');
    expect(content).toContain('does not claim OCR, pixel understanding, or transcription');
    expect(content).toContain('64 MiB per-artifact source budget');
    expect(content).toContain('not repository or graph-size admission caps');
    expect(content).toContain('threadnote graph export --format graphml');
  });

  it('pins the Manager canvas to its stage without a resize feedback loop', async () => {
    const styles = await readFile(join(root, 'website', 'src', 'styles.css'), 'utf8');

    expect(styles).toMatch(/\.manager-demo-graph-stage\s*{[^}]*min-height: 480px;/s);
    expect(styles).toMatch(/\.manager-demo-scene\s*{[^}]*position: absolute;[^}]*inset: 0;/s);
    expect(styles).toMatch(/\.manager-demo-scene-canvas\s*{[^}]*display: block;[^}]*height: 100%;/s);
    expect(styles).not.toContain('.manager-demo-graph-stage > div:first-child');
  });

  it('includes a project-bound social card and Pages marker', async () => {
    await Promise.all([
      access(join(root, 'website', 'public', 'og.png')),
      access(join(root, 'website', 'public', '.nojekyll')),
    ]);
  });
});
