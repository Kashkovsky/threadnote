import {describe, expect, it} from '@effect/vitest';
import * as FC from 'effect/testing/FastCheck';
import {Effect} from 'effect';
import type {CodeGraphEmbeddingIndexShape} from '../../src/code_graph/embedding.js';
import {parseGitCatFileBatch, parseGitTree, parseNameStatus} from '../../src/code_graph/inventory.js';
import type {CodeGraphLayout} from '../../src/code_graph/layout.js';
import {neighborQuery, traversalQuery} from '../../src/code_graph/query.js';
import type {CodeGraphStoreShape} from '../../src/code_graph/store.js';
import type {CodeGraphEdge, CodeGraphQueryNode} from '../../src/code_graph/types.js';

const pathSegmentArbitrary = FC.array(
  FC.constantFrom('a', 'Z', '0', ' ', '.', '-', '_', 'é', '漢', '🙂', '\\', '\t', '\n'),
  {maxLength: 14, minLength: 1},
).map(characters => characters.join(''));

const repositoryPathArbitrary = FC.record({
  leadingDot: FC.boolean(),
  segments: FC.array(pathSegmentArbitrary, {maxLength: 4, minLength: 1}),
}).map(({leadingDot, segments}) => `${leadingDot ? './' : ''}${segments.join('/')}`);

const objectIdArbitrary = FC.array(FC.constantFrom(...'0123456789abcdef'), {
  maxLength: 40,
  minLength: 40,
}).map(characters => characters.join(''));

const gitTreeEntryArbitrary = FC.record({
  blobId: objectIdArbitrary,
  mode: FC.constantFrom('100644', '100755'),
  path: repositoryPathArbitrary,
  size: FC.integer({max: 16 * 1_048_576, min: 0}),
});

type NameStatusChange =
  | {
      readonly kind: 'A' | 'D' | 'M';
      readonly path: string;
    }
  | {
      readonly from: string;
      readonly kind: 'C' | 'R';
      readonly score: number;
      readonly to: string;
    };

const nameStatusChangeArbitrary: FC.Arbitrary<NameStatusChange> = FC.oneof(
  FC.record({
    kind: FC.constantFrom('A' as const, 'D' as const, 'M' as const),
    path: repositoryPathArbitrary,
  }),
  FC.record({
    from: repositoryPathArbitrary,
    kind: FC.constantFrom('C' as const, 'R' as const),
    score: FC.integer({max: 100, min: 0}),
    to: repositoryPathArbitrary,
  }),
);

const graphCaseArbitrary = FC.record({
  depth: FC.integer({max: 8, min: 0}),
  nodeCount: FC.integer({max: 8, min: 1}),
  rawEdges: FC.array(FC.tuple(FC.integer({max: 31, min: 0}), FC.integer({max: 31, min: 0})), {maxLength: 32}),
  seedIndex: FC.integer({max: 31, min: 0}),
});

const boundedNeighborCaseArbitrary = FC.record({
  depth: FC.integer({max: 8, min: 0}),
  direction: FC.constantFrom<'both' | 'incoming' | 'outgoing'>('both', 'incoming', 'outgoing'),
  edgeLimit: FC.integer({max: 24, min: 1}),
  nodeCount: FC.integer({max: 8, min: 1}),
  nodeLimit: FC.integer({max: 8, min: 1}),
  rawEdges: FC.array(FC.tuple(FC.integer({max: 31, min: 0}), FC.integer({max: 31, min: 0})), {maxLength: 32}),
  seedIndex: FC.integer({max: 31, min: 0}),
});

const layout: CodeGraphLayout = {
  checkoutId: 'property-checkout',
  databaseWriteLockPath: '/property/database-write.lock',
  databasePath: '/property/graph.sqlite',
  lockPath: '/property/graph.lock',
  repositoryRoot: '/property',
  staleMarkerPath: '/property/stale',
  vectorRoot: '/property/vectors',
  worktreeLockRoot: '/property/worktree-locks',
  worktreeId: 'property-worktree',
};

const emptyEmbedding = {
  search: () => Effect.succeed(new Map<string, number>()),
} as unknown as CodeGraphEmbeddingIndexShape;

describe('native code graph parser properties', () => {
  it.prop(
    'round-trips ordinary Git tree records without interpreting repository filenames',
    {
      entries: FC.array(gitTreeEntryArbitrary, {maxLength: 24}),
    },
    ({entries}) => {
      const output = entries.map(entry => `${entry.mode} blob ${entry.blobId} ${entry.size}\t${entry.path}\0`).join('');

      expect(parseGitTree(output)).toEqual(
        entries.map(entry => ({
          ...entry,
          path: normalizeRepositoryPath(entry.path),
        })),
      );
    },
    {fastCheck: {numRuns: 200}},
  );

  it.prop(
    'round-trips byte-exact Git cat-file batches',
    {
      blobs: FC.array(FC.uint8Array({maxLength: 96}), {maxLength: 16}),
    },
    ({blobs}) => {
      const entries = blobs.map((blob, index) => ({
        blobId: `${'0'.repeat(39)}${index.toString(16)}`,
        size: blob.byteLength,
      }));
      const chunks = blobs.flatMap((blob, index) => [
        new TextEncoder().encode(`${entries[index]!.blobId} blob ${blob.byteLength}\n`),
        blob,
        Uint8Array.of(10),
      ]);

      expect(parseGitCatFileBatch(concatenateBytes(chunks), entries)).toEqual(blobs);
    },
    {fastCheck: {numRuns: 150}},
  );

  it.prop(
    'matches a reference model for arbitrary add, modify, delete, copy, and rename records',
    {
      changes: FC.array(nameStatusChangeArbitrary, {maxLength: 40}),
    },
    ({changes}) => {
      const actual = parseNameStatus(encodeNameStatus(changes));
      const expected = modelNameStatus(changes);

      expect([...actual.added].sort()).toEqual([...expected.added].sort());
      expect([...actual.changed].sort()).toEqual([...expected.changed].sort());
      expect([...actual.deleted].sort()).toEqual([...expected.deleted].sort());
    },
    {fastCheck: {numRuns: 200}},
  );
});

describe('native code graph traversal properties', () => {
  it.effect.prop(
    'matches breadth-first reachability and terminates on generated cyclic graphs',
    {
      graph: graphCaseArbitrary,
    },
    ({graph}) => {
      const nodes = Array.from({length: graph.nodeCount}, (_, index) => graphNode(index));
      const seed = nodes[graph.seedIndex % graph.nodeCount]!;
      const edges = graphEdges(graph.nodeCount, graph.rawEdges);
      const store = graphStore(nodes, seed, edges);
      const expected = referenceTraversal(seed.id, edges, graph.depth);

      return Effect.gen(function* () {
        const result = yield* traversalQuery(
          store,
          layout.databasePath,
          'snapshot',
          seed.name,
          'outgoing',
          graph.nodeCount,
          edges.length + 1,
          graph.depth,
          ['resolved'],
          emptyEmbedding,
          '/property/home',
          layout,
          false,
        );

        expect(new Set(result.nodes.map(node => node.id))).toEqual(expected.nodes);
        expect(new Set(result.edges.map(edge => edge.id))).toEqual(expected.edges);
        expect(new Set(result.nodes.map(node => node.id)).size).toBe(result.nodes.length);
        expect(new Set(result.edges.map(edge => edge.id)).size).toBe(result.edges.length);
        expect(result.nodes.every(node => Number.isFinite(node.score) && node.score > 0)).toBe(true);
      });
    },
    {fastCheck: {numRuns: 80}},
  );

  it.effect.prop(
    'keeps exact-ID neighbor traversal within direction, depth, node, and edge bounds',
    {
      graph: boundedNeighborCaseArbitrary,
    },
    ({graph}) => {
      const nodes = Array.from({length: graph.nodeCount}, (_, index) => graphNode(index));
      const seed = nodes[graph.seedIndex % graph.nodeCount]!;
      const edges = graphEdges(graph.nodeCount, graph.rawEdges);
      const store = graphStore(nodes, seed, edges);
      const reachable = referenceNeighborReachability(seed.id, edges, graph.direction, graph.depth);

      return Effect.gen(function* () {
        const result = yield* neighborQuery(
          store,
          layout.databasePath,
          'snapshot',
          seed.id,
          graph.direction,
          graph.nodeLimit,
          graph.edgeLimit,
          graph.depth,
          ['resolved'],
        );

        const visibleIds = new Set(result.nodes.map(node => node.id));
        expect(result.nodes[0]?.id).toBe(seed.id);
        expect(result.nodes.length).toBeLessThanOrEqual(graph.nodeLimit);
        expect(result.edges.length).toBeLessThanOrEqual(graph.edgeLimit);
        expect(visibleIds.size).toBe(result.nodes.length);
        expect(new Set(result.edges.map(edge => edge.id)).size).toBe(result.edges.length);
        expect(result.nodes.every(node => reachable.has(node.id))).toBe(true);
        expect(
          result.edges.every(
            edge =>
              edge.sourceId !== undefined &&
              visibleIds.has(edge.sourceId) &&
              edge.targetId !== undefined &&
              visibleIds.has(edge.targetId),
          ),
        ).toBe(true);
      });
    },
    {fastCheck: {numRuns: 120}},
  );
});

function normalizeRepositoryPath(value: string): string {
  return value.replace(/^\.\/+/, '');
}

function concatenateBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function encodeNameStatus(changes: readonly NameStatusChange[]): string {
  const fields: string[] = [];
  for (const change of changes) {
    if ('from' in change) {
      fields.push(`${change.kind}${change.score}`, change.from, change.to);
    } else {
      fields.push(change.kind, change.path);
    }
  }
  return `${fields.join('\0')}\0`;
}

function modelNameStatus(changes: readonly NameStatusChange[]): {
  readonly added: Set<string>;
  readonly changed: Set<string>;
  readonly deleted: Set<string>;
} {
  const added = new Set<string>();
  const changed = new Set<string>();
  const deleted = new Set<string>();
  for (const change of changes) {
    if ('from' in change) {
      if (change.kind === 'R') deleted.add(normalizeRepositoryPath(change.from));
      changed.add(normalizeRepositoryPath(change.to));
      continue;
    }
    if (change.kind === 'D') {
      deleted.add(normalizeRepositoryPath(change.path));
    } else {
      const path = normalizeRepositoryPath(change.path);
      changed.add(path);
      if (change.kind === 'A') added.add(path);
    }
  }
  return {added, changed, deleted};
}

function graphNode(index: number): CodeGraphQueryNode {
  const id = `node-${index}`;
  return {
    contentHash: `hash-${index}`,
    exported: true,
    id,
    kind: 'function',
    language: 'typescript',
    name: id,
    path: `src/${id}.ts`,
    qualifiedName: id,
    score: 1,
    span: {column: 1, endColumn: 2, endLine: 1, line: 1},
  };
}

function graphEdges(nodeCount: number, rawEdges: readonly (readonly [number, number])[]): readonly CodeGraphEdge[] {
  const pairs = new Map<string, readonly [number, number]>();
  for (let index = 0; index < nodeCount; index += 1) {
    const pair = [index, (index + 1) % nodeCount] as const;
    pairs.set(pair.join(':'), pair);
  }
  for (const [rawSource, rawTarget] of rawEdges) {
    const pair = [rawSource % nodeCount, rawTarget % nodeCount] as const;
    pairs.set(pair.join(':'), pair);
  }
  return [...pairs.values()].map(([source, target]) => ({
    confidence: 1,
    evidencePath: `src/node-${source}.ts`,
    evidenceSpan: {column: 1, endColumn: 2, endLine: 1, line: 1},
    id: `edge-${source}-${target}`,
    provenance: 'resolved',
    relation: 'calls',
    sourceId: `node-${source}`,
    sourceName: `node-${source}`,
    targetId: `node-${target}`,
    targetName: `node-${target}`,
  }));
}

function graphStore(
  nodes: readonly CodeGraphQueryNode[],
  seed: CodeGraphQueryNode,
  edges: readonly CodeGraphEdge[],
): CodeGraphStoreShape {
  const byId = new Map(nodes.map(node => [node.id, node]));
  return {
    edgesForNodes: (
      _databasePath: string,
      _snapshotId: string,
      ids: readonly string[],
      direction: 'both' | 'incoming' | 'outgoing',
      limit: number,
    ) =>
      Effect.succeed(
        edges
          .filter(edge => {
            if (direction === 'incoming') return edge.targetId !== undefined && ids.includes(edge.targetId);
            if (direction === 'outgoing') return edge.sourceId !== undefined && ids.includes(edge.sourceId);
            return (
              (edge.sourceId !== undefined && ids.includes(edge.sourceId)) ||
              (edge.targetId !== undefined && ids.includes(edge.targetId))
            );
          })
          .slice(0, limit),
      ),
    searchSymbolsMany: () => Effect.succeed([[seed]]),
    symbolsByIds: (_databasePath: string, _snapshotId: string, ids: readonly string[]) =>
      Effect.succeed(ids.flatMap(id => (byId.has(id) ? [byId.get(id)!] : []))),
  } as unknown as CodeGraphStoreShape;
}

function referenceTraversal(
  seedId: string,
  edges: readonly CodeGraphEdge[],
  depth: number,
): {readonly edges: Set<string>; readonly nodes: Set<string>} {
  const visited = new Set([seedId]);
  const inspectedEdges = new Set<string>();
  let frontier = new Set([seedId]);
  for (let currentDepth = 0; currentDepth < depth && frontier.size > 0; currentDepth += 1) {
    const next = new Set<string>();
    for (const edge of edges) {
      if (!edge.sourceId || !edge.targetId || !frontier.has(edge.sourceId)) continue;
      inspectedEdges.add(edge.id);
      if (!visited.has(edge.targetId)) {
        visited.add(edge.targetId);
        next.add(edge.targetId);
      }
    }
    frontier = next;
  }
  return {edges: inspectedEdges, nodes: visited};
}

function referenceNeighborReachability(
  seedId: string,
  edges: readonly CodeGraphEdge[],
  direction: 'both' | 'incoming' | 'outgoing',
  depth: number,
): ReadonlySet<string> {
  const visited = new Set([seedId]);
  let frontier = new Set([seedId]);
  for (let currentDepth = 0; currentDepth < depth && frontier.size > 0; currentDepth += 1) {
    const next = new Set<string>();
    for (const edge of edges) {
      if (!edge.sourceId || !edge.targetId) continue;
      if (
        (direction === 'outgoing' || direction === 'both') &&
        frontier.has(edge.sourceId) &&
        !visited.has(edge.targetId)
      ) {
        next.add(edge.targetId);
      }
      if (
        (direction === 'incoming' || direction === 'both') &&
        frontier.has(edge.targetId) &&
        !visited.has(edge.sourceId)
      ) {
        next.add(edge.sourceId);
      }
    }
    for (const nodeId of next) visited.add(nodeId);
    frontier = next;
  }
  return visited;
}
