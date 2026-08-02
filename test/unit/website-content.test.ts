import {access, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {docsSections, mcpTools} from '../../website/src/content/docs.js';
import {graphAnalyzeScenario, graphInspectScenario, heroScenario} from '../../website/src/content/landing.js';
import {managerDemoShares, managerDemoTabs} from '../../website/src/content/managerDemo.js';
import {
  adaptRetainedPerformanceArtifact,
  performanceEvidence,
  retainedPerformanceArtifactFieldPaths,
} from '../../website/src/content/performance.js';
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

function verifiedPerformanceFixture(): Record<string, unknown> {
  const overlayDigest = 'd'.repeat(64);
  const controls = Object.fromEntries(
    ['java', 'kotlin', 'typescript', 'bazel'].map((language, index) => [
      language,
      {
        query: `${language} definition`,
        path: `src/${language}/control.${language}`,
        stableNodeId: `cgs_${String(index + 1).repeat(32)}`,
        milliseconds: index + 1,
        passed: true,
      },
    ]),
  );

  return {
    schemaVersion: 1,
    status: 'verified',
    artifact: {
      url: 'https://github.com/Kashkovsky/threadnote/releases/download/example/performance.json',
      sha256: 'a'.repeat(64),
      generatedAt: '2026-08-02T20:00:00Z',
    },
    source: {
      threadnote: {version: '4.0.0-beta.example', commit: 'b'.repeat(40)},
      repository: {
        name: 'Example/public-monorepo',
        url: 'https://github.com/Example/public-monorepo',
        commit: 'c'.repeat(40),
        checkout: 'clean',
      },
    },
    runner: {
      hardware: 'Example runner',
      operatingSystem: 'Example OS',
      architecture: 'arm64',
      memoryBytes: 64 * 1024 ** 3,
      logicalCpuCount: 10,
      runtime: {name: 'Bun', version: '1.3.14'},
      database: {name: 'SQLite', version: '3.54.0'},
      disk: {medium: 'SSD', filesystem: 'APFS'},
    },
    inventory: {
      eligibleFiles: 100,
      indexedFiles: 90,
      excludedFiles: 10,
      languages: {java: 20, kotlin: 20, typescript: 20, bazel: 5},
    },
    graph: {
      symbols: 1_000,
      relationships: 2_000,
      references: 500,
      referenceCandidates: 700,
      lookupKeys: 3_000,
      lexicalPostings: 10_000,
    },
    phases: {
      cold: {
        totalMilliseconds: 10_000,
        discoveryMilliseconds: 500,
        extractionMilliseconds: 2_000,
        materializationMilliseconds: 3_000,
        resolutionMilliseconds: 1_000,
        activationMilliseconds: 2_000,
      },
      incremental: {totalMilliseconds: 300, changedFiles: 1},
      independentRebuild: {totalMilliseconds: 9_500},
    },
    queries: {sampleCount: 20, p50Milliseconds: 5, p95Milliseconds: 12, maxMilliseconds: 18},
    controls,
    parity: {
      cleanColdDigest: 'e'.repeat(64),
      incrementalOverlayDigest: overlayDigest,
      independentOverlayDigest: overlayDigest,
      incrementalMatchesIndependent: true,
    },
    storage: {
      databaseBytes: 1024 ** 3,
      peakResidentBytes: 512 * 1024 ** 2,
      peakWalBytes: 64 * 1024 ** 2,
      peakTemporaryBytes: 0,
      peakDurableGrowthBytes: 2 * 1024 ** 3,
    },
    manager: {
      catalogColdMilliseconds: 30,
      catalogWarmMilliseconds: 5,
      overviewColdMilliseconds: 20,
      overviewWarmMilliseconds: 4,
      detailColdMilliseconds: 10,
      renderProxyMilliseconds: 2,
      maxPayloadBytes: 400_000,
      nodeBudget: 500,
      edgeBudget: 1_500,
    },
    concurrency: {simultaneousWorktrees: 3, isolationPassed: true},
  };
}

describe('Threadnote 4 website content', () => {
  it('ships real entry documents for every root page', async () => {
    const routes = [
      'index.html',
      'performance/index.html',
      'docs/index.html',
      'pro-tips/index.html',
      'manager-demo/index.html',
      'faq/index.html',
    ];

    await Promise.all(routes.map(route => access(join(root, 'website', route))));
    const config = await readFile(join(root, 'website', 'vite.config.ts'), 'utf8');
    for (const route of ['performance', 'docs', 'proTips', 'managerDemo', 'faq']) {
      expect(config).toContain(`${route}:`);
    }
  });

  it('shows the copyright in the shared site footer', async () => {
    const [shell, ...pages] = await Promise.all(
      [
        'components/SiteShell.tsx',
        'pages/LandingPage.tsx',
        'pages/PerformancePage.tsx',
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
    expect(landingSource).toContain("siteHref('performance/')");
    expect(landingSource).toContain('real polyglot Bazel monorepo');
    expect(landingSource).toContain('Final values stay visibly');
    expect(scenarios).toContain('current commit + isolated dirty overlay');
    expect(scenarios).toContain('paged SQLite analysis · no repository admission cap');
  });

  it('fails closed until one complete retained performance artifact is available', async () => {
    const [pageSource, evidenceSource] = await Promise.all([
      readFile(join(root, 'website', 'src', 'pages', 'PerformancePage.tsx'), 'utf8'),
      readFile(join(root, 'website', 'src', 'content', 'performance.ts'), 'utf8'),
    ]);

    expect(performanceEvidence).toMatchObject({state: 'pending'});
    const verifiedFixture = verifiedPerformanceFixture();
    expect(adaptRetainedPerformanceArtifact(verifiedFixture)).toMatchObject({state: 'verified'});
    expect(() => adaptRetainedPerformanceArtifact({schemaVersion: 1, status: 'verified'})).toThrow(
      'unexpected or missing fields',
    );
    expect(() =>
      adaptRetainedPerformanceArtifact({schemaVersion: 1, status: 'pending', reason: 'still running', value: 1}),
    ).toThrow('unexpected or missing fields');
    const mismatchedFixture = structuredClone(verifiedFixture);
    const parity = mismatchedFixture.parity as Record<string, unknown>;
    parity.independentOverlayDigest = 'f'.repeat(64);
    expect(() => adaptRetainedPerformanceArtifact(mismatchedFixture)).toThrow('overlay digests must match');
    expect(retainedPerformanceArtifactFieldPaths).toEqual(
      expect.arrayContaining([
        'artifact.url',
        'artifact.sha256',
        'artifact.generatedAt',
        'source.threadnote.commit',
        'source.repository.commit',
        'runner.hardware',
        'runner.runtime.version',
        'runner.database.version',
        'inventory.languages.java',
        'inventory.languages.kotlin',
        'inventory.languages.typescript',
        'inventory.languages.bazel',
        'phases.cold.materializationMilliseconds',
        'phases.incremental.totalMilliseconds',
        'phases.independentRebuild.totalMilliseconds',
        'queries.p95Milliseconds',
        'controls.java.stableNodeId',
        'controls.kotlin.stableNodeId',
        'controls.typescript.stableNodeId',
        'controls.bazel.stableNodeId',
        'parity.incrementalOverlayDigest',
        'parity.independentOverlayDigest',
        'storage.peakResidentBytes',
        'storage.peakWalBytes',
        'storage.peakTemporaryBytes',
        'manager.overviewColdMilliseconds',
        'manager.renderProxyMilliseconds',
        'concurrency.simultaneousWorktrees',
      ]),
    );

    expect(pageSource).toContain('Large codebases are a normal case');
    expect(pageSource).toContain('Repository size is never an admission test');
    expect(pageSource).toContain('bounded parser worker pool');
    expect(pageSource).toContain('one backpressured SQLite writer');
    expect(pageSource).toContain('One commit graph. One truthful overlay per worktree');
    expect(pageSource).toContain('Graph responses stay deliberately bounded');
    expect(pageSource).toContain('returns the complete record');
    expect(pageSource).toContain('Your agents will love it');
    expect(pageSource).not.toMatch(/232_750|2_658_990|7_308_099|33_285_996_544/);
    expect(evidenceSource).toContain('Strict public adapter for one retained, exact-HEAD benchmark artifact');
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
    expect(content).toContain('[Performance page](/performance/)');
    expect(content).toContain('incremental-versus-independent-rebuild digest parity');
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
