import {describe, expect, it} from '@effect/vitest';
import {Effect} from 'effect';
import * as FC from 'effect/testing/FastCheck';
import {analyzeCodeGraph, type CodeGraphAnalysisResult} from '../../src/code_graph/analysis.js';
import type {CodeGraphEdge} from '../../src/code_graph/types.js';
import {analysisEdge, analysisSnapshot, analysisSymbol, pagedAnalysisStore} from '../helpers/code-graph-analysis.js';

const analysisCase = FC.record({
  nodeCount: FC.integer({max: 18, min: 1}),
  packageCount: FC.integer({max: 5, min: 1}),
  rawEdges: FC.array(
    FC.record({
      relation: FC.constantFrom<CodeGraphEdge['relation']>('calls', 'contains', 'extends', 'imports', 'references'),
      source: FC.integer({max: 31, min: 0}),
      target: FC.integer({max: 31, min: 0}),
    }),
    {maxLength: 48},
  ),
});

describe('code graph analysis properties', () => {
  it.effect.prop(
    'keeps partitions, identifiers, labels, and ranking stable across input order and page size',
    {fixture: analysisCase},
    ({fixture}) => {
      const symbols = Array.from({length: fixture.nodeCount}, (_, index) =>
        analysisSymbol(
          `node-${index.toString().padStart(2, '0')}`,
          `package-${index % fixture.packageCount}`,
          `packages/p${index % fixture.packageCount}/src/${index}.ts`,
        ),
      );
      const uniqueEdges = new Map<string, CodeGraphEdge>();
      for (const [index, raw] of fixture.rawEdges.entries()) {
        const source = symbols[raw.source % symbols.length]!;
        const target = symbols[raw.target % symbols.length]!;
        const key = `${source.id}:${raw.relation}:${target.id}`;
        if (!uniqueEdges.has(key)) {
          uniqueEdges.set(key, analysisEdge(`edge-${index.toString().padStart(3, '0')}`, source, target, raw.relation));
        }
      }
      const edges = [...uniqueEdges.values()];
      const snapshot = analysisSnapshot(symbols, edges);
      return Effect.gen(function* () {
        const first = yield* analyzeCodeGraph(pagedAnalysisStore(symbols, edges), {
          budget: {aggregatePageSize: 1, pageSize: 1},
          databasePath: '/property/graph.sqlite',
          snapshot,
        });
        const second = yield* analyzeCodeGraph(pagedAnalysisStore([...symbols].reverse(), [...edges].reverse()), {
          budget: {aggregatePageSize: 7, pageSize: 7},
          databasePath: '/property/graph.sqlite',
          snapshot,
        });

        expect(stableProjection(second)).toEqual(stableProjection(first));
        expect(first.coverage.complete).toBe(true);
        expect(new Set(first.memberships.map(item => item.node.id)).size).toBe(first.memberships.length);
        expect(
          isSorted(
            first.memberships.map(item => item.node.id),
            (left, right) => left.localeCompare(right),
          ),
        ).toBe(true);
        expect(isSorted(first.hubs, compareHubOrder)).toBe(true);
        expect(isSorted(first.surprisingLinks, compareSurpriseOrder)).toBe(true);

        const membership = new Map(first.memberships.map(item => [item.node.id, item]));
        for (const edge of edges) {
          expect(membership.get(edge.sourceId!)?.componentId).toBe(membership.get(edge.targetId!)?.componentId);
          const source = symbols.find(symbol => symbol.id === edge.sourceId)!;
          const target = symbols.find(symbol => symbol.id === edge.targetId)!;
          if (source.path === target.path || isCohesive(edge.relation)) {
            expect(membership.get(source.id)?.communityId).toBe(membership.get(target.id)?.communityId);
          }
        }
        for (const communityId of new Set(first.memberships.map(item => item.communityId))) {
          const componentIds = new Set(
            first.memberships.filter(item => item.communityId === communityId).map(item => item.componentId),
          );
          expect(componentIds.size).toBe(1);
        }
      });
    },
    {fastCheck: {numRuns: 80}},
  );
});

function stableProjection(result: CodeGraphAnalysisResult) {
  return {
    algorithms: result.algorithms,
    allowedProvenances: result.allowedProvenances,
    communities: result.communities,
    components: result.components,
    confidenceAudit: result.confidenceAudit,
    coverage: result.coverage,
    hubThresholds: result.hubThresholds,
    hubs: result.hubs,
    memberships: result.memberships,
    relationshipGroups: result.relationshipGroups,
    statistics: result.statistics,
    suggestedQuestions: result.suggestedQuestions,
    surprisingLinks: result.surprisingLinks,
    trust: result.trust,
    warnings: result.warnings,
  };
}

function isCohesive(relation: CodeGraphEdge['relation']): boolean {
  return ['contains', 'declares', 'exports', 'extends', 'implements', 'overrides', 'reexports'].includes(relation);
}

function isSorted<Value>(values: readonly Value[], compare: (left: Value, right: Value) => number): boolean {
  return values.every((value, index) => index === 0 || compare(values[index - 1]!, value) <= 0);
}

function compareHubOrder(
  left: CodeGraphAnalysisResult['hubs'][number],
  right: CodeGraphAnalysisResult['hubs'][number],
) {
  return (
    right.degree - left.degree ||
    right.incoming - left.incoming ||
    left.node.qualifiedName.localeCompare(right.node.qualifiedName) ||
    left.node.id.localeCompare(right.node.id)
  );
}

function compareSurpriseOrder(
  left: CodeGraphAnalysisResult['surprisingLinks'][number],
  right: CodeGraphAnalysisResult['surprisingLinks'][number],
) {
  return (
    right.score - left.score ||
    right.confidence - left.confidence ||
    left.source.qualifiedName.localeCompare(right.source.qualifiedName) ||
    left.relation.localeCompare(right.relation) ||
    left.target.qualifiedName.localeCompare(right.target.qualifiedName) ||
    left.edgeId.localeCompare(right.edgeId)
  );
}
