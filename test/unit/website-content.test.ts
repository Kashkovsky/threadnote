import {access, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {
  bindRetainedPerformanceArtifact,
  performanceArtifactPublicUrl,
  sha256Hex,
} from '../../scripts/site-performance-evidence.js';
import {assertExternalPerformanceEvidence} from '../../scripts/benchmark-code-graph.js';
import {docsSections, mcpTools} from '../../website/src/content/docs.js';
import {graphAnalyzeScenario, graphInspectScenario, heroScenario} from '../../website/src/content/landing.js';
import {managerDemoShares, managerDemoTabs} from '../../website/src/content/managerDemo.js';
import {
  retainedPerformanceArtifactFieldPaths,
  validateRetainedPerformancePayload,
} from '../../website/src/content/performance.js';
import type {BenchmarkArtifactV1} from '../../src/evaluation/benchmark.js';
import {proTips} from '../../website/src/content/proTips.js';
import {EXTERNAL_REPOSITORY_REQUIRED_MEASUREMENTS} from '../../src/evaluation/external_evidence.js';

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

const fixtureLockfileSha256 = '1'.repeat(64);
const fixturePackageManifestSha256 = '2'.repeat(64);

function harnessMeasurement(
  name: string,
  unit: 'bytes' | 'count' | 'milliseconds',
  value: number,
  distribution?: {p50: number; p95: number; p99: number; maximum: number; samples: number},
): Record<string, unknown> {
  return {
    maximum: distribution?.maximum ?? value,
    mean: value,
    minimum: Math.min(value, distribution?.p50 ?? value),
    name,
    p50: distribution?.p50 ?? value,
    p95: distribution?.p95 ?? value,
    p99: distribution?.p99 ?? value,
    samples: distribution?.samples ?? 1,
    unit,
  };
}

function verifiedPerformanceFixture(): Record<string, unknown> {
  const sourceCommit = 'b'.repeat(40);
  const repositoryCommit = 'c'.repeat(40);
  const overlayDigest = 'd'.repeat(64);
  const controls = Object.fromEntries(
    ['java', 'kotlin', 'typescript', 'bazel'].map((language, index) => [
      language,
      {
        query: `${language}Definition`,
        path: `src/${language}/control.${language}`,
        stableNodeId: `cgs_${String(index + 1).repeat(32)}`,
      },
    ]),
  );
  const measurements = [
    harnessMeasurement('cold-index', 'milliseconds', 10_000),
    harnessMeasurement('cold-registration-lock-and-database-setup', 'milliseconds', 500),
    harnessMeasurement('cold-inventory-and-extraction', 'milliseconds', 2_000),
    harnessMeasurement('cold-materialization', 'milliseconds', 3_000),
    harnessMeasurement('cold-reference-resolution', 'milliseconds', 1_000),
    harnessMeasurement('cold-activation-lexical-only', 'milliseconds', 2_000),
    harnessMeasurement('one-file-reindex-index', 'milliseconds', 300),
    harnessMeasurement('same-overlay-full-rebuild-index', 'milliseconds', 9_500),
    harnessMeasurement('hot-exact-lexical-query', 'milliseconds', 8, {
      p50: 5,
      p95: 12,
      p99: 16,
      maximum: 18,
      samples: 25,
    }),
    harnessMeasurement('cold-materialized-file-rows', 'count', 90),
    harnessMeasurement('cold-materialized-symbol-rows', 'count', 1_000),
    harnessMeasurement('cold-materialized-edge-rows', 'count', 2_000),
    harnessMeasurement('cold-materialization-deduplicated-reference-rows-n1', 'count', 500),
    harnessMeasurement('cold-materialized-reference-candidate-rows-n1', 'count', 700),
    harnessMeasurement('cold-materialized-lookup-key-rows-n1', 'count', 3_000),
    harnessMeasurement('cold-materialized-lexical-term-rows', 'count', 10_000),
    harnessMeasurement('sqlite-main-disk', 'bytes', 1024 ** 3),
    harnessMeasurement('cold-process-peak-rss', 'bytes', 512 * 1024 ** 2),
    harnessMeasurement('cold-sqlite-wal-peak-observed', 'bytes', 64 * 1024 ** 2),
    harnessMeasurement('cold-sqlite-temp-peak-observed', 'bytes', 0),
    harnessMeasurement('cold-sqlite-durable-database-pages-high-water-n1', 'bytes', 2 * 1024 ** 3),
    harnessMeasurement('primary-query-structural-parity', 'count', 1),
    harnessMeasurement('structural-graph-digest-parity', 'count', 1),
    harnessMeasurement('manager-catalog-cold', 'milliseconds', 30),
    harnessMeasurement('manager-catalog-warm', 'milliseconds', 5),
    harnessMeasurement('manager-overview-cold', 'milliseconds', 20),
    harnessMeasurement('manager-overview-warm', 'milliseconds', 4),
    harnessMeasurement('manager-detail-cold', 'milliseconds', 10),
    harnessMeasurement('manager-node-detail-cold', 'milliseconds', 8),
    harnessMeasurement('manager-layout-preparation-proxy', 'milliseconds', 2),
    harnessMeasurement('manager-response-payload', 'bytes', 400_000),
    harnessMeasurement('manager-bounded-query', 'milliseconds', 10, {
      p50: 6,
      p95: 14,
      p99: 20,
      maximum: 24,
      samples: 25,
    }),
    harnessMeasurement('manager-bounded-query-payload', 'bytes', 120_000),
    harnessMeasurement('concurrent-worktree-isolation-duration', 'milliseconds', 250),
  ];
  for (const [language, files, duration] of [
    ['java', 20, 1],
    ['kotlin', 20, 2],
    ['typescript', 20, 3],
    ['bazel-build', 5, 4],
  ] as const) {
    measurements.push(
      harnessMeasurement(`cold-materialized-file-rows-language-${language}`, 'count', files),
      harnessMeasurement(`cold-materialized-symbol-rows-language-${language}`, 'count', files * 10),
      harnessMeasurement(`external-query-cold-${language}-duration`, 'milliseconds', duration),
      harnessMeasurement(`external-query-cold-${language}-returned-nodes`, 'count', 2),
      harnessMeasurement(`external-query-cold-${language}-expected-path-language-nodes`, 'count', 1),
      harnessMeasurement(`external-query-incremental-${language}-returned-nodes`, 'count', 2),
      harnessMeasurement(`external-query-incremental-${language}-expected-path-language-nodes`, 'count', 1),
      harnessMeasurement(`external-query-same-overlay-reference-${language}-returned-nodes`, 'count', 2),
      harnessMeasurement(`external-query-same-overlay-reference-${language}-expected-path-language-nodes`, 'count', 1),
      harnessMeasurement(`external-query-${language}-same-overlay-structural-parity`, 'count', 1),
    );
  }
  for (const operation of ['query', 'node', 'neighbors', 'explain', 'impact', 'path']) {
    measurements.push(
      harnessMeasurement(`mcp-${operation}-duration`, 'milliseconds', 10),
      harnessMeasurement(`mcp-${operation}-structured-output`, 'bytes', 1_024),
      harnessMeasurement(`mcp-${operation}-text-output`, 'bytes', 1_024),
    );
  }
  const measurementNames = new Set(measurements.map(measurement => String(measurement.name)));
  for (const required of EXTERNAL_REPOSITORY_REQUIRED_MEASUREMENTS) {
    if (measurementNames.has(required.name)) continue;
    const value =
      required.name.startsWith('cold-activation-copying-') && required.name.endsWith('-observed-n1')
        ? 0
        : required.name.endsWith('-external-sampler-version-n1')
          ? 4
          : required.name.endsWith('-external-process-tree-failures-n1') ||
              required.name.endsWith('-external-open-temp-process-tree-failures-n1') ||
              required.name.endsWith('-journal-peak-observed')
            ? 0
            : required.name === 'cold-activation-observed-stages-n1'
              ? 3
              : required.name.endsWith('-activation-observed-stages-n1')
                ? 32
                : 1;
    measurements.push(harnessMeasurement(required.name, required.unit, value));
  }

  return {
    createdAt: '2026-08-02T20:00:00Z',
    environment: {
      architecture: 'arm64',
      commit: sourceCommit,
      cpu: 'Example runner',
      dirty: false,
      fixtureHash: `external-code-graph-v1:${repositoryCommit}`,
      memoryBytes: 64 * 1024 ** 3,
      node: 'bun/1.3.14',
      operatingSystem: 'Example OS',
      packageManager: 'bun/1.3.14',
      runner: 'threadnote-code-graph-e2e',
      runnerVersion: '1',
    },
    measurements,
    metadata: {
      benchmarkDiskFilesystem: 'apfs',
      benchmarkDiskMedium: 'solid-state',
      benchmarkInventoryEligibleFiles: 100,
      benchmarkInventoryExcludedFiles: 10,
      benchmarkLogicalCpuCount: 10,
      benchmarkMeasuredExecutionMode: 'local-source-application-layer',
      benchmarkMeasuredSourceCommit: sourceCommit,
      benchmarkMeasuredSourceLockfileSha256: fixtureLockfileSha256,
      benchmarkMeasuredSourcePackageManifestSha256: fixturePackageManifestSha256,
      benchmarkSourceValidationMode: 'managed-payload-exact-head-validated',
      benchmarkValidatedManagedDependencyInstallation: 'bun install --frozen-lockfile',
      benchmarkValidatedManagedExecutableSha256: '3'.repeat(64),
      benchmarkValidatedManagedPayload: 'exact-head-not-executed',
      benchmarkValidatedManagedPayloadBytes: 1_000_000,
      benchmarkValidatedManagedPayloadFileCount: 20,
      benchmarkValidatedManagedPayloadManifestSha256: '4'.repeat(64),
      benchmarkValidatedManagedProcessLeaseInspection: 'complete',
      benchmarkValidatedManagedReleaseMetadataSha256: '5'.repeat(64),
      benchmarkValidatedManagedRuntime: 'bun-1.3.14',
      benchmarkValidatedManagedTarget: 'darwin-arm64',
      benchmarkValidatedManagedVersion: `4.0.0-beta.32.local.g${sourceCommit}`,
      coldMaterializationStorageMode: 'direct-persistent',
      externalControlCount: 4,
      externalControlEvidence: JSON.stringify(controls),
      externalControlLanguages: 'java,kotlin,typescript,bazel-build',
      externalRepositoryCommit: repositoryCommit,
      externalRepositoryMode: 'clean checkout with a byte-compared, scoped one-file overlay',
      externalQueryControlTimeoutMilliseconds: 120_000,
      externalRepositoryName: 'JetBrains/intellij-community',
      externalRepositoryPublicVerification: 'anonymous-https-exact-commit-fetch',
      externalRepositoryUrl: 'https://github.com/JetBrains/intellij-community',
      managerDetailEdgeCount: 100,
      managerDetailNodeCount: 80,
      managerEdgeBudget: 1_500,
      managerLayoutPreparationMeasurement:
        'client-side graph layout-preparation only; excludes browser and WebGL paint',
      managerNodeBudget: 500,
      managerOverviewEdgeCount: 200,
      managerOverviewNodeCount: 100,
      managerRequestCancellationPassed: true,
      managerRequestLifecycleControl:
        'real Manager queries through the GraphWorkspace request gate: superseding aborts an in-flight request; a completed late response is rejected',
      managerSequenceTimeoutMilliseconds: 180_000,
      managerServiceResponseTimingIncludesSerialization: true,
      managerSnapshotBindingPassed: true,
      managerStaleResponseRejectionPassed: true,
      mcpOperationCount: 6,
      oneFileReindexMaterializationMode: 'incremental-overlay',
      oneFileReindexMaterializationStorageMode: 'temporary-staged',
      releaseEvidenceRef: 'refs/tags/v4.0.0-beta.32',
      releaseEvidenceResolvedSha: sourceCommit,
      releaseEvidenceSha: sourceCommit,
      retrievalMode: 'lexical-only',
      runnerClass: 'local-unclassified',
      runnerIdentity: 'runner-0123456789abcdef',
      sameOverlayReferenceMaterializationMode: 'full',
      sameOverlayReferenceMaterializationStorageMode: 'direct-persistent',
      simultaneousWorktrees: 2,
      sqliteVersion: '3.54.0',
      structuralGraphDigestCold: 'e'.repeat(64),
      structuralGraphDigestIncremental: overlayDigest,
      structuralGraphDigestSameOverlayReference: overlayDigest,
      worktreeIsolationCleanupPassed: true,
      worktreeIsolationCommandTimeoutMilliseconds: 30_000,
      worktreeIsolationIndexedFiles: 2,
      worktreeIsolationPassed: true,
      worktreeIsolationOuterTimeoutMilliseconds: 300_000,
      worktreeIsolationTopology: 'bounded-synthetic-linked-worktrees-in-measured-primary-home',
    },
    suite: 'code-graph-external-repository-v1',
    version: 1,
    warmups: 5,
  };
}

function fixtureBytes(fixture: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(fixture));
}

function fixtureBinding(
  artifactBytes: Uint8Array,
  overrides: Partial<Record<'artifactSha256' | 'sourceThreadnoteCommit' | 'sourceTreeSha256', string>> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    artifactSha256: overrides.artifactSha256 ?? sha256Hex(artifactBytes),
    generatedAt: '2026-08-02T20:00:00Z',
    sourceThreadnoteCommit: overrides.sourceThreadnoteCommit ?? 'b'.repeat(40),
    sourceTreeSha256: overrides.sourceTreeSha256 ?? 'f'.repeat(64),
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

  it('binds verified performance evidence to exact local bytes and source', () => {
    const artifactBytes = fixtureBytes(verifiedPerformanceFixture());
    const evidence = bindRetainedPerformanceArtifact({
      artifactBytes,
      artifactPublicUrl: performanceArtifactPublicUrl('/'),
      binding: fixtureBinding(artifactBytes),
      currentLockfileSha256: fixtureLockfileSha256,
      currentPackageManifestSha256: fixturePackageManifestSha256,
      currentSourceTreeSha256: 'f'.repeat(64),
    });

    expect(evidence).toMatchObject({
      state: 'verified',
      artifact: {
        artifact: {
          url: '/performance-evidence.json',
          sha256: sha256Hex(artifactBytes),
          generatedAt: '2026-08-02T20:00:00Z',
        },
        source: {threadnote: {commit: 'b'.repeat(40)}},
      },
    });
  });

  it('keeps harness and website validation fail-closed under the same adversarial mutations', () => {
    const mutations: readonly [string, (fixture: Record<string, unknown>) => void][] = [
      [
        'MCP output',
        fixture => {
          fixture.measurements = (fixture.measurements as Record<string, unknown>[]).filter(
            measurement => measurement.name !== 'mcp-path-text-output',
          );
        },
      ],
      [
        'sampler observation',
        fixture => {
          fixture.measurements = (fixture.measurements as Record<string, unknown>[]).filter(
            measurement => measurement.name !== 'cold-external-storage-samples-n1',
          );
        },
      ],
      [
        'activation observation',
        fixture => {
          fixture.measurements = (fixture.measurements as Record<string, unknown>[]).filter(
            measurement => measurement.name !== 'cold-activation-committing-snapshot-observed-n1',
          );
        },
      ],
      [
        'unknown metadata',
        fixture => {
          (fixture.metadata as Record<string, unknown>).privateRepositoryRoot = '/private/repository';
        },
      ],
      [
        'credential metadata',
        fixture => {
          (fixture.metadata as Record<string, unknown>).runnerIdentity = 'token=github_pat_example';
        },
      ],
      [
        'local-path metadata',
        fixture => {
          (fixture.metadata as Record<string, unknown>).runnerIdentity = '/Users/private/runner';
        },
      ],
      [
        'insufficient p95 samples',
        fixture => {
          const measurement = (fixture.measurements as Record<string, unknown>[]).find(
            candidate => candidate.name === 'manager-bounded-query',
          )!;
          measurement.samples = 24;
        },
      ],
      ['insufficient warmups', fixture => void (fixture.warmups = 4)],
    ];
    for (const [label, mutate] of mutations) {
      const fixture = structuredClone(verifiedPerformanceFixture());
      mutate(fixture);
      for (const validate of [
        (input: unknown) => assertExternalPerformanceEvidence(input as BenchmarkArtifactV1),
        validateRetainedPerformancePayload,
      ]) {
        expect(() => validate(fixture), label).toThrow();
      }
    }
  });

  it('rejects retained artifact tampering and a wrong bound SHA-256', () => {
    const artifactBytes = fixtureBytes(verifiedPerformanceFixture());
    const binding = fixtureBinding(artifactBytes);
    const tamperedBytes = new Uint8Array([...artifactBytes, 10]);

    expect(() =>
      bindRetainedPerformanceArtifact({
        artifactBytes: tamperedBytes,
        artifactPublicUrl: performanceArtifactPublicUrl('/'),
        binding,
        currentLockfileSha256: fixtureLockfileSha256,
        currentPackageManifestSha256: fixturePackageManifestSha256,
        currentSourceTreeSha256: 'f'.repeat(64),
      }),
    ).toThrow('artifact SHA-256 mismatch');
    expect(() =>
      bindRetainedPerformanceArtifact({
        artifactBytes,
        artifactPublicUrl: performanceArtifactPublicUrl('/'),
        binding: fixtureBinding(artifactBytes, {artifactSha256: '0'.repeat(64)}),
        currentLockfileSha256: fixtureLockfileSha256,
        currentPackageManifestSha256: fixturePackageManifestSha256,
        currentSourceTreeSha256: 'f'.repeat(64),
      }),
    ).toThrow('artifact SHA-256 mismatch');
  });

  it('rejects sensitive or machine-local public control evidence at the site binder', () => {
    for (const [field, value] of [
      ['query', `ghp_${'a'.repeat(24)}`],
      ['query', `sk-proj_${'b'.repeat(24)}`],
      ['path', '/Users/example/private.ts'],
      ['path', '/home/example/private.ts'],
      ['path', '/mnt/c/Users/example/private.ts'],
      ['path', '/c/Users/example/private.ts'],
      ['path', 'C:\\Users\\example\\private.ts'],
      ['path', '\\\\server\\share\\private.ts'],
      ['path', '../outside/private.ts'],
    ] as const) {
      const fixture = verifiedPerformanceFixture();
      const metadata = fixture.metadata as Record<string, unknown>;
      const controls = JSON.parse(String(metadata.externalControlEvidence)) as Record<string, Record<string, string>>;
      controls.java = {...controls.java!, [field]: value};
      metadata.externalControlEvidence = JSON.stringify(controls);
      const artifactBytes = fixtureBytes(fixture);

      expect(() =>
        bindRetainedPerformanceArtifact({
          artifactBytes,
          artifactPublicUrl: performanceArtifactPublicUrl('/'),
          binding: fixtureBinding(artifactBytes),
          currentLockfileSha256: fixtureLockfileSha256,
          currentPackageManifestSha256: fixturePackageManifestSha256,
          currentSourceTreeSha256: 'f'.repeat(64),
        }),
      ).toThrow(/privacy-safe|repository-relative/);
    }
  });

  it('rejects evidence bound to the wrong source commit or source tree', () => {
    const artifactBytes = fixtureBytes(verifiedPerformanceFixture());

    expect(() =>
      bindRetainedPerformanceArtifact({
        artifactBytes,
        artifactPublicUrl: performanceArtifactPublicUrl('/'),
        binding: fixtureBinding(artifactBytes, {sourceThreadnoteCommit: '9'.repeat(40)}),
        currentLockfileSha256: fixtureLockfileSha256,
        currentPackageManifestSha256: fixturePackageManifestSha256,
        currentSourceTreeSha256: 'f'.repeat(64),
      }),
    ).toThrow('different Threadnote source commits');
    expect(() =>
      bindRetainedPerformanceArtifact({
        artifactBytes,
        artifactPublicUrl: performanceArtifactPublicUrl('/'),
        binding: fixtureBinding(artifactBytes),
        currentLockfileSha256: fixtureLockfileSha256,
        currentPackageManifestSha256: fixturePackageManifestSha256,
        currentSourceTreeSha256: '8'.repeat(64),
      }),
    ).toThrow('does not match the current Threadnote source tree');
  });

  it('rejects partial, extra, and mixed retained result payloads', () => {
    const partial = verifiedPerformanceFixture();
    delete partial.environment;
    const partialBytes = fixtureBytes(partial);
    expect(() =>
      bindRetainedPerformanceArtifact({
        artifactBytes: partialBytes,
        artifactPublicUrl: performanceArtifactPublicUrl('/'),
        binding: fixtureBinding(partialBytes),
        currentLockfileSha256: fixtureLockfileSha256,
        currentPackageManifestSha256: fixturePackageManifestSha256,
        currentSourceTreeSha256: 'f'.repeat(64),
      }),
    ).toThrow('Missing key');

    const extra = verifiedPerformanceFixture();
    extra.unreviewedResult = 42;
    const extraBytes = fixtureBytes(extra);
    expect(() =>
      bindRetainedPerformanceArtifact({
        artifactBytes: extraBytes,
        artifactPublicUrl: performanceArtifactPublicUrl('/'),
        binding: fixtureBinding(extraBytes),
        currentLockfileSha256: fixtureLockfileSha256,
        currentPackageManifestSha256: fixturePackageManifestSha256,
        currentSourceTreeSha256: 'f'.repeat(64),
      }),
    ).toThrow('unexpected or missing fields');

    const mismatched = verifiedPerformanceFixture();
    const metadata = mismatched.metadata as Record<string, unknown>;
    metadata.structuralGraphDigestSameOverlayReference = '0'.repeat(64);
    const mismatchedBytes = fixtureBytes(mismatched);
    expect(() =>
      bindRetainedPerformanceArtifact({
        artifactBytes: mismatchedBytes,
        artifactPublicUrl: performanceArtifactPublicUrl('/'),
        binding: fixtureBinding(mismatchedBytes),
        currentLockfileSha256: fixtureLockfileSha256,
        currentPackageManifestSha256: fixturePackageManifestSha256,
        currentSourceTreeSha256: 'f'.repeat(64),
      }),
    ).toThrow('overlay digests must match');
  });

  it('rejects fabricated, mixed-runtime, and separately supplied Manager evidence', () => {
    const githubMode = verifiedPerformanceFixture();
    (githubMode.metadata as Record<string, unknown>).benchmarkSourceValidationMode = 'github-actions-clean-source';
    const githubBytes = fixtureBytes(githubMode);
    expect(() =>
      bindRetainedPerformanceArtifact({
        artifactBytes: githubBytes,
        artifactPublicUrl: performanceArtifactPublicUrl('/'),
        binding: fixtureBinding(githubBytes),
        currentLockfileSha256: fixtureLockfileSha256,
        currentPackageManifestSha256: fixturePackageManifestSha256,
        currentSourceTreeSha256: 'f'.repeat(64),
      }),
    ).toThrow('managed-payload-exact-head-validated');

    const missingRuntimeHash = verifiedPerformanceFixture();
    delete (missingRuntimeHash.metadata as Record<string, unknown>).benchmarkValidatedManagedExecutableSha256;
    const runtimeBytes = fixtureBytes(missingRuntimeHash);
    expect(() =>
      bindRetainedPerformanceArtifact({
        artifactBytes: runtimeBytes,
        artifactPublicUrl: performanceArtifactPublicUrl('/'),
        binding: fixtureBinding(runtimeBytes),
        currentLockfileSha256: fixtureLockfileSha256,
        currentPackageManifestSha256: fixturePackageManifestSha256,
        currentSourceTreeSha256: 'f'.repeat(64),
      }),
    ).toThrow('benchmarkValidatedManagedExecutableSha256');

    for (const [label, mutate] of [
      [
        'dirty source',
        (fixture: Record<string, unknown>) => {
          (fixture.environment as Record<string, unknown>).dirty = true;
        },
      ],
      [
        'dependency installation',
        (fixture: Record<string, unknown>) => {
          (fixture.metadata as Record<string, unknown>).benchmarkValidatedManagedDependencyInstallation = 'bun install';
        },
      ],
      [
        'payload manifest hash',
        (fixture: Record<string, unknown>) => {
          delete (fixture.metadata as Record<string, unknown>).benchmarkValidatedManagedPayloadManifestSha256;
        },
      ],
      [
        'release metadata hash',
        (fixture: Record<string, unknown>) => {
          delete (fixture.metadata as Record<string, unknown>).benchmarkValidatedManagedReleaseMetadataSha256;
        },
      ],
      [
        'runtime target',
        (fixture: Record<string, unknown>) => {
          (fixture.metadata as Record<string, unknown>).benchmarkValidatedManagedTarget = 'linux-x64';
        },
      ],
    ] as const) {
      const fixture = verifiedPerformanceFixture();
      mutate(fixture);
      const bytes = fixtureBytes(fixture);
      expect(
        () =>
          bindRetainedPerformanceArtifact({
            artifactBytes: bytes,
            artifactPublicUrl: performanceArtifactPublicUrl('/'),
            binding: fixtureBinding(bytes),
            currentLockfileSha256: fixtureLockfileSha256,
            currentPackageManifestSha256: fixturePackageManifestSha256,
            currentSourceTreeSha256: 'f'.repeat(64),
          }),
        label,
      ).toThrow();
    }

    const withoutManagerQuery = verifiedPerformanceFixture();
    withoutManagerQuery.measurements = (withoutManagerQuery.measurements as Record<string, unknown>[]).filter(
      measurement => measurement.name !== 'manager-bounded-query',
    );
    const managerBytes = fixtureBytes(withoutManagerQuery);
    expect(() =>
      bindRetainedPerformanceArtifact({
        artifactBytes: managerBytes,
        artifactPublicUrl: performanceArtifactPublicUrl('/'),
        binding: fixtureBinding(managerBytes),
        currentLockfileSha256: fixtureLockfileSha256,
        currentPackageManifestSha256: fixturePackageManifestSha256,
        currentSourceTreeSha256: 'f'.repeat(64),
      }),
    ).toThrow('manager-bounded-query');
  });

  it('cross-binds source dependency hashes and the configured site base', () => {
    const artifactBytes = fixtureBytes(verifiedPerformanceFixture());
    expect(performanceArtifactPublicUrl('/')).toBe('/performance-evidence.json');
    expect(performanceArtifactPublicUrl('/threadnote/')).toBe('/threadnote/performance-evidence.json');
    expect(() => performanceArtifactPublicUrl('/threadnote')).toThrow('THREADNOTE_SITE_BASE');
    expect(() => performanceArtifactPublicUrl('/../')).toThrow('THREADNOTE_SITE_BASE');
    expect(() => performanceArtifactPublicUrl('//')).toThrow('THREADNOTE_SITE_BASE');
    expect(() =>
      bindRetainedPerformanceArtifact({
        artifactBytes,
        artifactPublicUrl: performanceArtifactPublicUrl('/threadnote/'),
        binding: fixtureBinding(artifactBytes),
        currentLockfileSha256: '0'.repeat(64),
        currentPackageManifestSha256: fixturePackageManifestSha256,
        currentSourceTreeSha256: 'f'.repeat(64),
      }),
    ).toThrow('lockfile SHA-256');
    expect(() =>
      bindRetainedPerformanceArtifact({
        artifactBytes,
        artifactPublicUrl: performanceArtifactPublicUrl('/threadnote/'),
        binding: fixtureBinding(artifactBytes),
        currentLockfileSha256: fixtureLockfileSha256,
        currentPackageManifestSha256: '0'.repeat(64),
        currentSourceTreeSha256: 'f'.repeat(64),
      }),
    ).toThrow('package manifest SHA-256');
  });

  it('keeps the Performance page pending until bound evidence is emitted at build time', async () => {
    const [pageSource, evidenceSource] = await Promise.all([
      readFile(join(root, 'website', 'src', 'pages', 'PerformancePage.tsx'), 'utf8'),
      readFile(join(root, 'website', 'src', 'content', 'performance.ts'), 'utf8'),
    ]);

    expect(retainedPerformanceArtifactFieldPaths).toEqual(
      expect.arrayContaining([
        'artifact.url',
        'artifact.sha256',
        'artifact.generatedAt',
        'source.threadnote.commit',
        'source.threadnote.lockfileSha256',
        'source.threadnote.packageManifestSha256',
        'source.repository.commit',
        'runner.hardware',
        'runner.runtime.version',
        'runner.runtime.target',
        'runner.runtime.executionMode',
        'runner.runtime.executableSha256',
        'runner.runtime.payloadManifestSha256',
        'runner.runtime.releaseMetadataSha256',
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
        'storage.durableFilesystemGrowthBytes',
        'storage.peakJournalBytes',
        'manager.overviewColdMilliseconds',
        'manager.layoutPreparationProxyMilliseconds',
        'manager.queryP95Milliseconds',
        'manager.queryMaxPayloadBytes',
        'manager.requestCancellationPassed',
        'manager.snapshotBindingPassed',
        'manager.staleResponseRejectionPassed',
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
    expect(evidenceSource).toContain('derives every displayed measurement and provenance field from this one artifact');
    expect(evidenceSource).not.toContain('export function validateBoundRetainedPerformanceArtifact');
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
    expect(content).toContain('[Performance page](../performance/)');
    expect(content).toContain('incremental-versus-independent-rebuild digest parity');
  });

  it('keeps the docs Performance link inside a configured Pages subpath', () => {
    const content = JSON.stringify(docsSections);
    const relativeLink = content.match(/\[Performance page\]\(([^)]+)\)/)?.[1];

    expect(relativeLink).toBe('../performance/');
    expect(new URL(relativeLink ?? '', 'https://example.test/threadnote/docs/').pathname).toBe(
      '/threadnote/performance/',
    );
  });

  it('pins the Manager canvas to its stage without a resize feedback loop', async () => {
    const styles = await readFile(join(root, 'website', 'src', 'styles.css'), 'utf8');

    expect(styles).toMatch(/\.manager-demo-graph-stage\s*{[^}]*min-height: 480px;/s);
    expect(styles).toMatch(/\.manager-demo-scene\s*{[^}]*position: absolute;[^}]*inset: 0;/s);
    expect(styles).toMatch(/\.manager-demo-scene-canvas\s*{[^}]*display: block;[^}]*height: 100%;/s);
    expect(styles).not.toContain('.manager-demo-graph-stage > div:first-child');
  });

  it('collapses the footer before its six links can overflow narrow tablet widths', async () => {
    const styles = await readFile(join(root, 'website', 'src', 'styles.css'), 'utf8');
    const tabletStart = styles.indexOf('@media (max-width: 760px)');
    const mobileStart = styles.indexOf('@media (max-width: 680px)', tabletStart);
    const tabletFooter = styles.slice(tabletStart, mobileStart);

    expect(tabletStart).toBeGreaterThan(-1);
    expect(mobileStart).toBeGreaterThan(tabletStart);
    expect(tabletFooter).toMatch(/\.site-footer\s*{[^}]*grid-template-columns: 1fr;/s);
    expect(tabletFooter).toMatch(/\.site-footer__links\s*{[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/s);
  });

  it('includes a project-bound social card and Pages marker', async () => {
    await Promise.all([
      access(join(root, 'website', 'public', 'og.png')),
      access(join(root, 'website', 'public', '.nojekyll')),
    ]);
  });
});
