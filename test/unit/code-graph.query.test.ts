import {expect, it} from '@effect/vitest';
import {Effect} from 'effect';
import {TestClock} from 'effect/testing';
import {describe} from 'vitest';
import type {CodeGraphEmbeddingIndexShape} from '../../src/code_graph/embedding.js';
import type {CodeGraphLayout} from '../../src/code_graph/layout.js';
import {traversalQuery} from '../../src/code_graph/query.js';
import type {CodeGraphStoreShape} from '../../src/code_graph/store.js';
import type {CodeGraphEdge, CodeGraphQueryNode} from '../../src/code_graph/types.js';

const seed: CodeGraphQueryNode = {
  contentHash: 'seed-hash',
  exported: true,
  id: 'seed',
  kind: 'function',
  language: 'typescript',
  name: 'seed',
  path: 'src/seed.ts',
  qualifiedName: 'seed',
  score: 1,
  span: {column: 1, endColumn: 2, endLine: 1, line: 1},
};

const dependent: CodeGraphQueryNode = {
  ...seed,
  contentHash: 'dependent-hash',
  id: 'dependent',
  name: 'dependent',
  path: 'src/dependent.ts',
  qualifiedName: 'dependent',
};

const edge: CodeGraphEdge = {
  confidence: 1,
  evidencePath: dependent.path,
  evidenceSpan: dependent.span,
  id: 'dependent-calls-seed',
  provenance: 'resolved',
  relation: 'calls',
  sourceId: dependent.id,
  sourceName: dependent.name,
  targetId: seed.id,
  targetName: seed.name,
};

const layout: CodeGraphLayout = {
  databasePath: '/fixture/graph.sqlite',
  lockPath: '/fixture/graph.lock',
  repositoryRoot: '/fixture',
  staleMarkerPath: '/fixture/stale',
  vectorRoot: '/fixture/vectors',
  worktreeId: 'fixture-worktree',
};

const embedding = {
  search: () => Effect.succeed(new Map<string, number>()),
} as unknown as CodeGraphEmbeddingIndexShape;

describe('code graph query budgets', () => {
  for (const phase of ['search', 'adjacency', 'hydration'] as const) {
    it.effect(`enforces the absolute deadline after ${phase}`, () =>
      Effect.gen(function* () {
        const calls: string[] = [];
        const store = {
          edgesForNodes: () =>
            Effect.gen(function* () {
              calls.push('adjacency');
              if (phase === 'adjacency') yield* TestClock.adjust(2_001);
              return [edge];
            }),
          searchSymbolsByPaths: () =>
            Effect.gen(function* () {
              calls.push('search');
              if (phase === 'search') yield* TestClock.adjust(2_001);
              return [[seed]];
            }),
          symbolsByIds: () =>
            Effect.gen(function* () {
              calls.push('hydration');
              if (phase === 'hydration') yield* TestClock.adjust(2_001);
              return [dependent];
            }),
        } as unknown as CodeGraphStoreShape;

        const result = yield* traversalQuery(
          store,
          layout.databasePath,
          'snapshot',
          'seed',
          'incoming',
          20,
          40,
          2,
          ['resolved'],
          embedding,
          '/fixture/home',
          layout,
          true,
          [seed.path],
        );

        expect(result.warnings).toContain('Graph traversal reached its elapsed-time budget; results are partial.');
        expect(calls).toEqual(
          phase === 'search'
            ? ['search']
            : phase === 'adjacency'
              ? ['search', 'adjacency']
              : ['search', 'adjacency', 'hydration'],
        );
      }),
    );
  }
});
