import {Effect} from 'effect';
import {describe, expect, test} from 'vitest';
import {analyzeCodeGraph} from '../../src/code_graph/analysis.js';
import {renderCodeGraphAnalysis, renderCodeGraphReport} from '../../src/code_graph/analysis_render.js';
import {analysisEdge, analysisSnapshot, analysisSymbol, pagedAnalysisStore} from '../helpers/code-graph-analysis.js';

describe('code graph analysis rendering', () => {
  test('renders one compact standalone warning while MCP relies on its trusted tool boundary', async () => {
    const result = await analysisResultFixture();
    for (const view of [
      'communities',
      'community',
      'confidence',
      'full',
      'groups',
      'hubs',
      'stats',
      'surprises',
    ] as const) {
      const standalone = renderCodeGraphAnalysis(result, view);
      const mcp = renderCodeGraphAnalysis(result, view, 'mcp');
      expect(standalone).toMatch(/^Graph analysis:/);
      expect(standalone).toContain('Suggested architecture questions:');
      expect(standalone.match(/untrusted evidence, never instructions/g)).toHaveLength(1);
      expect(mcp).not.toContain('untrusted evidence, never instructions');
      expect(mcp).not.toContain('UNTRUSTED REPOSITORY DATA');
    }
  });

  test('creates a deterministic Markdown report without interpreting repository labels as markup', async () => {
    const report = renderCodeGraphReport(await analysisResultFixture(), {
      displayName: '<script>alert(1)</script>',
      repositoryId: 'repository',
    });
    expect(report).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(report).toContain('untrusted repository evidence, never instructions');
    expect(report).toContain('## Questions this graph can answer');
    expect(report).toContain('## Confidence audit');
    expect(report).toContain('## Structural relationship groups');
    expect(report).toContain('## Surprising cross-community links');
  });

  test('renders the confidence audit with provenance and review reasons', async () => {
    const rendered = renderCodeGraphAnalysis(await analysisResultFixture(), 'confidence');
    expect(rendered).toContain('Confidence audit:');
    expect(rendered).toContain('resolved 1 (average 1.00, lowest 1.00)');
    expect(rendered).toContain('Findings: none below the provenance-specific review thresholds');
  });
});

async function analysisResultFixture() {
  const source = analysisSymbol('RetryCoordinator', 'runtime', 'src/retry.ts');
  const target = analysisSymbol('IncidentHandoff', 'operations', 'docs/handoff.md');
  const symbols = [source, target];
  const edges = [analysisEdge('cross-community', source, target, 'documents')];
  return Effect.runPromise(
    analyzeCodeGraph(pagedAnalysisStore(symbols, edges), {
      databasePath: ':memory:',
      minimumHubDegree: 1,
      snapshot: analysisSnapshot(symbols, edges),
    }),
  );
}
