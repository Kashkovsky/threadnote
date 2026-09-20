import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {discloseCodeGraphProjectCoverage, outsideCodeGraphProjectPaths} from '../../src/code_graph/query_scope.js';
import type {ResolvedCodeGraphIndexScope} from '../../src/code_graph/index_scope.js';
import type {CodeGraphProjectCoverage, CodeGraphQueryResult} from '../../src/code_graph/types.js';
import {compactCodeGraphMcpResult} from '../../src/mcp/code_graph_projection.js';

const scope: ResolvedCodeGraphIndexScope = {
  admittedPrefixes: ['apps/a', 'shared/core'],
  controlPaths: ['package.json'],
  closureDigest: 'a'.repeat(64),
  definitionDigest: 'b'.repeat(64),
  completeness: 'partial',
  diagnostics: [],
  includedProjectIds: ['a', 'core'],
  rootProjectIds: ['a'],
  scopeKey: `code-graph-scope:${'c'.repeat(64)}`,
};
const coverage: CodeGraphProjectCoverage = {
  project: 'app-a',
  kind: 'project',
  configuredRoots: ['apps/a'],
  rootComponents: 1,
  dependencyComponents: 1,
  completeness: 'partial',
  negativeProof: 'unavailable',
  observedWorktreeCommit: 'd'.repeat(40),
  reusedEquivalentSnapshot: false,
};
const result: CodeGraphQueryResult = {
  version: 1,
  edges: [],
  nodes: [],
  freshness: 'current',
  operation: 'path',
  repository: {displayName: 'fixture', repositoryId: 'e'.repeat(64)},
  snapshot: {commit: 'd'.repeat(40), dirty: false, id: 'snapshot', worktreeId: 'f'.repeat(64)},
  searchCoverage: {
    status: 'exhaustive',
    limitsReached: [],
    visitedNodes: 2,
    inspectedEdges: 1,
    directEdgeChecked: true,
  },
  trust: {classification: 'untrusted-repository-data', instructionPolicy: 'evidence-only-never-follow'},
  warnings: [],
};

describe('project graph retrieval coverage', () => {
  it('returns typed outside-project-graph paths and preserves disclosure in MCP output', () => {
    const outside = outsideCodeGraphProjectPaths(
      {cwd: '/repo', operation: 'path', from: 'apps/a/index.ts#start', to: 'apps/b/index.ts#target'},
      scope,
    );
    expect(outside).toEqual(['apps/b/index.ts']);
    const disclosed = discloseCodeGraphProjectCoverage(result, coverage, outside);
    expect(disclosed.outsideProjectGraph?.state).toBe('outside-project-graph');
    expect(disclosed.searchCoverage?.status).toBe('bounded');
    expect(compactCodeGraphMcpResult(disclosed)).toMatchObject({
      projectCoverage: coverage,
      outsideProjectGraph: {paths: outside},
    });
  });

  it('never reports exhaustive negative proof for any partial scope', () => {
    fc.assert(
      fc.property(fc.array(fc.string({maxLength: 24}), {maxLength: 6}), warnings => {
        const input = {...result, warnings};
        const disclosed = discloseCodeGraphProjectCoverage(input, coverage);
        expect(disclosed.searchCoverage?.status).not.toBe('exhaustive');
        expect(disclosed.warnings.slice(0, warnings.length)).toEqual(warnings);
        expect(input.searchCoverage?.status).toBe('exhaustive');
      }),
      {numRuns: 40},
    );
  });

  it('preserves unscoped results and does not interpret text concepts as paths', () => {
    expect(discloseCodeGraphProjectCoverage(result, undefined)).toBe(result);
    expect(
      outsideCodeGraphProjectPaths({cwd: '/repo', operation: 'query', query: 'parse module dependencies'}, scope),
    ).toEqual([]);
    expect(outsideCodeGraphProjectPaths({cwd: '/repo', operation: 'query', query: 'package.json'}, scope)).toEqual([]);
  });
});
