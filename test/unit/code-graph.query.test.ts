import {expect, it} from '@effect/vitest';
import {Effect, Fiber} from 'effect';
import {TestClock} from 'effect/testing';
import {describe} from 'vitest';
import type {CodeGraphEmbeddingIndexShape} from '../../src/code_graph/embedding.js';
import type {CodeGraphLayout} from '../../src/code_graph/layout.js';
import {exactNodeQuery, neighborQuery, traversalQuery} from '../../src/code_graph/query.js';
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

const stableSeed: CodeGraphQueryNode = {
  ...seed,
  id: `cgs_${'a'.repeat(32)}`,
};

const stableDependent: CodeGraphQueryNode = {
  ...dependent,
  id: `cgs_${'b'.repeat(32)}`,
};

const stableEdge: CodeGraphEdge = {
  ...edge,
  id: 'stable-dependent-calls-seed',
  sourceId: stableDependent.id,
  targetId: stableSeed.id,
};

const layout: CodeGraphLayout = {
  checkoutId: 'fixture-checkout',
  databaseWriteLockPath: '/fixture/database-write.lock',
  databasePath: '/fixture/graph.sqlite',
  lockPath: '/fixture/graph.lock',
  repositoryRoot: '/fixture',
  staleMarkerPath: '/fixture/stale',
  vectorRoot: '/fixture/vectors',
  worktreeLockRoot: '/fixture/worktree-locks',
  worktreeId: 'fixture-worktree',
};

const embedding = {
  search: () => Effect.succeed(new Map<string, number>()),
} as unknown as CodeGraphEmbeddingIndexShape;

describe('code graph query budgets', () => {
  it.effect('round-trips an exact stable node ID without fuzzy search', () =>
    Effect.gen(function* () {
      const requestedIds: string[][] = [];
      const store = {
        symbolsByIds: (_databasePath: string, _snapshotId: string, ids: readonly string[]) =>
          Effect.sync(() => {
            requestedIds.push([...ids]);
            return ids.includes(stableSeed.id) ? [stableSeed] : [];
          }),
      } as unknown as CodeGraphStoreShape;

      const found = yield* exactNodeQuery(store, layout.databasePath, 'snapshot', stableSeed.id);
      const missing = yield* exactNodeQuery(store, layout.databasePath, 'snapshot', `cgs_${'f'.repeat(32)}`);

      expect(found).toMatchObject({edges: [], nodes: [{id: stableSeed.id, score: 1}], warnings: []});
      expect(missing.nodes).toEqual([]);
      expect(missing.warnings).toEqual([expect.stringContaining('was not found in the selected snapshot')]);
      expect(requestedIds).toEqual([[stableSeed.id], [`cgs_${'f'.repeat(32)}`]]);
    }),
  );

  it.effect('traverses exact-ID neighbors with explicit direction, depth, provenance, and result bounds', () =>
    Effect.gen(function* () {
      const calls: Array<{
        readonly direction: string;
        readonly ids: readonly string[];
        readonly limit: number;
        readonly provenances: readonly string[];
      }> = [];
      const store = {
        edgesForNodes: (
          _databasePath: string,
          _snapshotId: string,
          ids: readonly string[],
          direction: string,
          limit: number,
          provenances: readonly string[],
        ) =>
          Effect.sync(() => {
            calls.push({direction, ids: [...ids], limit, provenances: [...provenances]});
            return ids.includes(stableSeed.id) ? [stableEdge] : [];
          }),
        symbolsByIds: (_databasePath: string, _snapshotId: string, ids: readonly string[]) =>
          Effect.succeed([stableSeed, stableDependent].filter(symbol => ids.includes(symbol.id))),
      } as unknown as CodeGraphStoreShape;

      const result = yield* neighborQuery(store, layout.databasePath, 'snapshot', stableSeed.id, 'incoming', 2, 10, 1, [
        'declared',
        'resolved',
      ]);

      expect(result.nodes.map(node => node.id)).toEqual([stableSeed.id, stableDependent.id]);
      expect(result.edges).toEqual([expect.objectContaining({id: stableEdge.id, provenance: 'resolved'})]);
      expect(calls).toEqual([
        {
          direction: 'incoming',
          ids: [stableSeed.id],
          limit: 10,
          provenances: ['declared', 'resolved'],
        },
      ]);
    }),
  );

  it.effect('reports bounded exact-ID neighborhoods instead of silently truncating them', () =>
    Effect.gen(function* () {
      const extra = {...stableDependent, id: `cgs_${'c'.repeat(32)}`, name: 'extra'};
      const store = {
        edgesForNodes: () =>
          Effect.succeed([
            stableEdge,
            {...stableEdge, id: 'extra-calls-seed', sourceId: extra.id, sourceName: extra.name},
          ]),
        symbolsByIds: (_databasePath: string, _snapshotId: string, ids: readonly string[]) =>
          Effect.succeed([stableSeed, stableDependent, extra].filter(symbol => ids.includes(symbol.id))),
      } as unknown as CodeGraphStoreShape;

      const result = yield* neighborQuery(store, layout.databasePath, 'snapshot', stableSeed.id, 'incoming', 2, 10, 1, [
        'resolved',
      ]);

      expect(result.nodes.map(node => node.id)).toEqual([stableSeed.id, stableDependent.id]);
      expect(result.warnings).toContain('Neighbor traversal reached a configured result limit.');
    }),
  );

  it.effect('returns lexical evidence when semantic search exceeds a surface-specific deadline', () =>
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
        undefined,
        undefined,
        {semanticMilliseconds: 750, traversalMilliseconds: 1_000},
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust(751);
      const result = yield* Fiber.join(fiber);

      expect(result.nodes).toEqual([expect.objectContaining({id: seed.id, score: 1})]);
      expect(result.warnings).toContain(
        'Semantic graph search reached its elapsed-time budget; lexical graph results were returned.',
      );
      expect(calls).toEqual(['search', 'semantic', 'adjacency', 'hydration']);
    }),
  );

  it.effect('skips semantic search when lexical search fills the seed budget', () =>
    Effect.gen(function* () {
      const lexicalMatches = Array.from({length: 12}, (_, index) => ({
        ...seed,
        contentHash: `lexical-${index}-hash`,
        id: `lexical-${index}`,
        name: `lexical${index}`,
        qualifiedName: `lexical${index}`,
      }));
      let semanticCalls = 0;
      const store = {
        edgesForNodes: () => Effect.succeed([]),
        searchSymbolsMany: () => Effect.succeed([lexicalMatches]),
        symbolsByIds: () => Effect.succeed([]),
      } as unknown as CodeGraphStoreShape;
      const unnecessaryEmbedding = {
        search: () =>
          Effect.sync(() => {
            semanticCalls += 1;
            return new Map<string, number>();
          }),
      } as unknown as CodeGraphEmbeddingIndexShape;

      const result = yield* traversalQuery(
        store,
        layout.databasePath,
        'snapshot',
        'director dependency injection',
        'both',
        12,
        1,
        0,
        ['resolved'],
        unnecessaryEmbedding,
        '/fixture/home',
        layout,
        false,
      );

      expect(result.nodes).toHaveLength(12);
      expect(semanticCalls).toBe(0);
      expect(result.warnings).not.toContain(
        'Semantic graph search reached its elapsed-time budget; lexical graph results were returned.',
      );
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

  it.effect('fairly batches deleted-path recovery frontiers above the store node-ID limit', () =>
    Effect.gen(function* () {
      const changedPaths = Array.from({length: 200}, (_, index) => `src/deleted-${String(index).padStart(3, '0')}.ts`);
      const baseGroups = changedPaths.map((path, pathIndex) =>
        Array.from({length: 20}, (_, symbolIndex) => ({
          ...seed,
          contentHash: `base-${pathIndex}-${symbolIndex}-hash`,
          id: `base-${pathIndex}-${symbolIndex}`,
          name: `deleted${pathIndex}_${symbolIndex}`,
          path,
          qualifiedName: `deleted${pathIndex}_${symbolIndex}`,
        })),
      );
      const currentNodes = new Map(
        changedPaths.map((_, index) => {
          const id = `current-${index}`;
          return [
            id,
            {
              ...dependent,
              contentHash: `${id}-hash`,
              id,
              name: `survivor${index}`,
              path: `src/survivor-${String(index).padStart(3, '0')}.ts`,
              qualifiedName: `survivor${index}`,
            },
          ] as const;
        }),
      );
      const baseFrontierSizes: number[] = [];
      const baseFrontiers: string[][] = [];
      const store = {
        edgesForNodes: (_databasePath: string, snapshotId: string, ids: readonly string[]) =>
          Effect.sync(() => {
            if (snapshotId !== 'base') return [];
            baseFrontierSizes.push(ids.length);
            baseFrontiers.push([...ids]);
            return ids.map((id, index) => {
              const pathIndex = Number(id.split('-')[1]);
              const current = currentNodes.get(`current-${pathIndex}`);
              if (!current) throw new Error(`Missing current recovery fixture for ${id}.`);
              return {
                ...edge,
                evidencePath: current.path,
                id: `base-recovery-${index}`,
                sourceId: current.id,
                sourceName: current.name,
                targetId: id,
                targetName: `deleted${pathIndex}_0`,
              };
            });
          }),
        searchSymbolsByPaths: (_databasePath: string, snapshotId: string) =>
          Effect.succeed(snapshotId === 'base' ? baseGroups : changedPaths.map(() => [])),
        symbolsByIds: (_databasePath: string, snapshotId: string, ids: readonly string[]) =>
          Effect.succeed(
            snapshotId === 'snapshot'
              ? ids.flatMap(id => {
                  const node = currentNodes.get(id);
                  return node ? [node] : [];
                })
              : [],
          ),
      } as unknown as CodeGraphStoreShape;

      const result = yield* traversalQuery(
        store,
        layout.databasePath,
        'snapshot',
        'changed paths',
        'incoming',
        200,
        500,
        1,
        ['resolved'],
        embedding,
        '/fixture/home',
        layout,
        true,
        changedPaths,
        'base',
      );

      expect(baseFrontierSizes).toEqual(Array.from({length: 8}, () => 500));
      expect(new Set(baseFrontiers[0]!.slice(0, 200).map(id => Number(id.split('-')[1]))).size).toBe(200);
      expect(result.nodes).toHaveLength(200);
      expect(result.nodes.map(node => node.id)).toContain('current-199');
      expect(result.warnings.some(warning => warning.includes('recovered 200 deleted path(s)'))).toBe(true);
    }),
  );
});
