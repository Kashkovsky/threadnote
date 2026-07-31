import {access, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {docsSections} from '../../website/src/content/docs.js';
import {heroScenario} from '../../website/src/content/landing.js';
import {managerDemoShares, managerDemoTabs} from '../../website/src/content/managerDemo.js';
import {proTips} from '../../website/src/content/proTips.js';

const root = process.cwd();
const toolKeys = {
  inspect_code_graph: new Set([
    'base',
    'callerCwd',
    'depth',
    'edgeLimit',
    'from',
    'includeHeuristic',
    'includeModelAssociations',
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
      ['content/proTips.ts', 'content/managerDemo.ts'].map(path =>
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
    const scenarios = [heroScenario, ...proTips.map(tip => tip.scenario)];

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
            expect(['query', 'explain', 'path', 'impact']).toContain(payload.operation);
            expectNonEmptyString(payload, 'callerCwd');
            expect(payload.callerCwd).toMatch(/^\//);
            if (payload.operation === 'query') expectNonEmptyString(payload, 'query');
            if (payload.operation === 'explain') expectNonEmptyString(payload, 'symbol');
            if (payload.operation === 'path') {
              expectNonEmptyString(payload, 'from');
              expectNonEmptyString(payload, 'to');
            }
            if (payload.operation === 'impact') {
              expect(typeof payload.query === 'string' || typeof payload.base === 'string').toBe(true);
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

  it('labels synthetic Manager data and includes the Graphify FAQ comparison', async () => {
    const [managerSource, faqSource] = await Promise.all([
      readFile(join(root, 'website', 'src', 'components', 'ManagerMock.tsx'), 'utf8'),
      readFile(join(root, 'website', 'src', 'pages', 'FaqPage.tsx'), 'utf8'),
    ]);

    expect(managerSource).toContain('Mock data — no local files read');
    expect(faqSource).toContain('Threadnote vs Graphify');
    expect(faqSource.indexOf('The practical questions')).toBeLessThan(faqSource.indexOf('Threadnote vs Graphify'));
    expect(faqSource).toContain('Not TypeScript-only');
    expect(faqSource).toContain('36 tree-sitter grammars');
    expect(faqSource).toContain('512 MiB load guard');
    expect(faqSource).toContain('no eligible-repository admission cap');
    expect(faqSource).toContain('semantic inputs require an assistant or configured model');
    expect(faqSource).not.toContain(
      'Broader language and multimodal analysis, including documents, papers, and diagrams',
    );
    expect(faqSource).toContain(
      'https://github.com/Graphify-Labs/graphify/tree/4fe11092ccbe9f543608f140c790f68d5d83cae4',
    );
    expect(faqSource).toContain('https://graphify.net/knowledge-graph-for-ai-coding-assistants.html');
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
