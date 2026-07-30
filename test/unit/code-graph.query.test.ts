import {expect, it} from '@effect/vitest';
import {Effect, Fiber} from 'effect';
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

const semanticMatch: CodeGraphQueryNode = {
  ...seed,
  contentHash: 'semantic-hash',
  id: 'semantic',
  kind: 'document',
  name: 'architecture.md',
  path: 'docs/architecture.md',
  qualifiedName: 'docs/architecture.md',
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
  it.effect('returns lexical evidence when semantic search does not finish within its dedicated deadline', () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const store = {
        edgesForNodes: () =>
          Effect.sync(() => {
            calls.push('adjacency');
            return [];
          }),
        searchSymbolsMany: () =>
          Effect.sync(() => {
            calls.push('search');
            return [[seed]];
          }),
        symbolsByIds: () =>
          Effect.sync(() => {
            calls.push('hydration');
            return [];
          }),
      } as unknown as CodeGraphStoreShape;
      const delayedEmbedding = {
        search: () =>
          Effect.sync(() => {
            calls.push('semantic');
          }).pipe(Effect.andThen(Effect.never)),
      } as unknown as CodeGraphEmbeddingIndexShape;

      const fiber = yield* traversalQuery(
        store,
        layout.databasePath,
        'snapshot',
        'serialize concurrent tasks via mutual exclusion',
        'both',
        20,
        40,
        2,
        ['resolved'],
        delayedEmbedding,
        '/fixture/home',
        layout,
        false,
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust(10_001);
      const result = yield* Fiber.join(fiber);

      expect(result.nodes).toEqual([expect.objectContaining({id: seed.id, score: 1})]);
      expect(result.warnings).toContain(
        'Semantic graph search reached its elapsed-time budget; lexical graph results were returned.',
      );
      expect(calls).toEqual(['search', 'semantic', 'adjacency', 'hydration']);
    }),
  );

  it.effect('accepts semantic evidence that takes longer than the traversal budget', () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const store = {
        edgesForNodes: () =>
          Effect.sync(() => {
            calls.push('adjacency');
            return [];
          }),
        searchSymbolsMany: () =>
          Effect.sync(() => {
            calls.push('search');
            return [[]];
          }),
        symbolsByIds: (_databasePath: string, _snapshotId: string, ids: readonly string[]) =>
          Effect.sync(() => {
            if (ids.length > 0) calls.push('hydration');
            return ids.includes(semanticMatch.id) ? [semanticMatch] : [];
          }),
      } as unknown as CodeGraphStoreShape;
      const delayedEmbedding = {
        search: () =>
          Effect.sync(() => {
            calls.push('semantic');
          }).pipe(Effect.andThen(Effect.sleep(5_000)), Effect.as(new Map([[semanticMatch.id, 0.9]]))),
      } as unknown as CodeGraphEmbeddingIndexShape;

      const fiber = yield* traversalQuery(
        store,
        layout.databasePath,
        'snapshot',
        'architecture overview',
        'both',
        20,
        40,
        2,
        ['resolved'],
        delayedEmbedding,
        '/fixture/home',
        layout,
        false,
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust(5_001);
      const result = yield* Fiber.join(fiber);

      expect(result.nodes).toEqual([expect.objectContaining({id: semanticMatch.id, score: 0.9})]);
      expect(result.warnings).not.toContain(
        'Semantic graph search reached its elapsed-time budget; lexical graph results were returned.',
      );
      expect(calls).toEqual(['search', 'semantic', 'hydration', 'adjacency']);
    }),
  );

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
