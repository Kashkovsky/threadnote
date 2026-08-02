import {Database} from 'bun:sqlite';
import {describe, expect, it} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import * as FC from 'effect/testing/FastCheck';
import {
  codeGraphAdjacencyQueryStatement,
  codeGraphExactSymbolQueryStatement,
  codeGraphSymbolsByIdsQueryStatement,
  codeGraphTermCandidateQueryStatement,
  CodeGraphStore,
  isCanonicalAbsoluteBazelLabel,
} from '../../src/code_graph/store.js';
import type {CodeGraphEdge, CodeGraphProvenance} from '../../src/code_graph/types.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';

const baseSnapshotId = 'snapshot-base';
const currentSnapshotId = 'snapshot-current';
const repositoryId = 'repository-query-property';
const worktreeId = 'worktree-query-property';
const allProvenances = ['declared', 'heuristic', 'model', 'resolved', 'syntactic'] as const;
const relations = ['calls', 'extends', 'imports', 'references'] as const;

interface EdgeSpec {
  readonly confidence: number;
  readonly id: number;
  readonly provenance: CodeGraphProvenance;
  readonly relation: (typeof relations)[number];
  readonly source: number;
  readonly target: number;
}

const edgeSpec = FC.record({
  confidence: FC.integer({max: 100, min: 0}),
  id: FC.integer({max: 15, min: 0}),
  provenance: FC.constantFrom(...allProvenances),
  relation: FC.constantFrom(...relations),
  source: FC.integer({max: 5, min: 0}),
  target: FC.integer({max: 5, min: 0}),
});
const bazelLabelSegment = FC.array(
  FC.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._+-'),
  {maxLength: 16, minLength: 1},
).map(characters => characters.join(''));

describe('code graph indexed query properties', () => {
  it.effect('treats a database file observed before schema publication as unavailable', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const store = yield* CodeGraphStore;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-schema-race-'});
        const databasePath = path.join(root, 'graph-v3.sqlite');
        yield* Effect.sync(() => new Database(databasePath).close(false));

        const [active, byId, byCommit] = yield* Effect.all([
          store.readySnapshot(databasePath, worktreeId),
          store.readySnapshotById(databasePath, currentSnapshotId),
          store.readySnapshotForCommit(databasePath, repositoryId, 'commit'),
        ]);

        expect(active).toBeUndefined();
        expect(byId).toBeUndefined();
        expect(byCommit).toBeUndefined();
      }),
    ).pipe(Effect.provide(ApplicationLayer)),
  );

  it.effect.prop(
    'matches effective-overlay adjacency for incoming, outgoing, and deduplicated both-direction reads',
    {
      allowedProvenances: FC.uniqueArray(FC.constantFrom(...allProvenances), {maxLength: 5, minLength: 1}),
      base: FC.array(edgeSpec, {maxLength: 20}),
      current: FC.array(edgeSpec, {maxLength: 20}),
      deletedIds: FC.array(FC.integer({max: 15, min: 0}), {maxLength: 12}),
      direction: FC.constantFrom('both' as const, 'incoming' as const, 'outgoing' as const),
      limit: FC.integer({max: 20, min: 1}),
      nodeIds: FC.uniqueArray(FC.integer({max: 5, min: 0}), {maxLength: 4, minLength: 1}),
    },
    ({allowedProvenances, base, current, deletedIds, direction, limit, nodeIds}) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const store = yield* CodeGraphStore;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-query-property-'});
          const databasePath = path.join(root, 'graph-v3.sqlite');
          yield* store.initialize(databasePath);

          const baseById = lastEdgeById(base);
          const currentById = lastEdgeById(current);
          const deletions = new Set(deletedIds.map(edgeId));
          yield* Effect.sync(() =>
            insertOverlayFixture(databasePath, [...baseById.values()], [...currentById.values()], deletions),
          );

          const requestedIds = nodeIds.map(nodeId);
          const actual = yield* store.edgesForNodes(
            databasePath,
            currentSnapshotId,
            requestedIds,
            direction,
            limit,
            allowedProvenances,
          );
          const expected = referenceAdjacency(
            baseById,
            currentById,
            deletions,
            new Set(requestedIds),
            direction,
            limit,
            new Set(allowedProvenances),
          );

          expect(actual.map(edgeIdentity)).toEqual(expected.map(edgeIdentity));
          expect(new Set(actual.map(edge => edge.id)).size).toBe(actual.length);
        }),
      ).pipe(Effect.provide(ApplicationLayer)),
    {fastCheck: {numRuns: 35}},
  );

  it.effect('suppresses a base edge when its overlay replacement moves away from the requested node', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const store = yield* CodeGraphStore;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-overlay-query-'});
        const databasePath = path.join(root, 'graph-v3.sqlite');
        yield* store.initialize(databasePath);
        const base = [
          graphEdge({confidence: 90, id: 0, provenance: 'declared', relation: 'calls', source: 0, target: 1}),
          graphEdge({confidence: 80, id: 1, provenance: 'resolved', relation: 'calls', source: 0, target: 0}),
          graphEdge({confidence: 70, id: 2, provenance: 'syntactic', relation: 'imports', source: 2, target: 0}),
        ];
        const current = [
          graphEdge({confidence: 95, id: 0, provenance: 'declared', relation: 'calls', source: 4, target: 5}),
          graphEdge({confidence: 85, id: 3, provenance: 'resolved', relation: 'extends', source: 0, target: 3}),
        ];
        yield* Effect.sync(() => insertOverlayFixture(databasePath, base, current, new Set([edgeId(2)])));

        const [outgoing, both, summary] = yield* Effect.all([
          store.edgesForNodes(databasePath, currentSnapshotId, [nodeId(0)], 'outgoing', 20, allProvenances),
          store.edgesForNodes(databasePath, currentSnapshotId, [nodeId(0)], 'both', 20, allProvenances),
          store.relationshipSummaryForNode(databasePath, currentSnapshotId, nodeId(0), allProvenances),
        ]);

        expect(outgoing.map(edge => edge.id)).toEqual([edgeId(3), edgeId(1)]);
        expect(both.map(edge => edge.id)).toEqual([edgeId(3), edgeId(1)]);
        expect(summary).toMatchObject({incoming: 1, outgoing: 2});
      }),
    ).pipe(Effect.provide(ApplicationLayer)),
  );

  it.effect('forces directional and exact-match indexes instead of scanning effective snapshots', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const store = yield* CodeGraphStore;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-query-plan-'});
        const databasePath = path.join(root, 'graph-v3.sqlite');
        yield* store.initialize(databasePath);
        const database = new Database(databasePath, {readonly: true, strict: true});
        try {
          const adjacency = codeGraphAdjacencyQueryStatement(
            currentSnapshotId,
            baseSnapshotId,
            ['node-1', 'node-2'],
            'both',
            40,
            ['declared', 'resolved', 'syntactic'],
          );
          const adjacencyPlan = queryPlan(database, adjacency.text, adjacency.parameters);
          expect(adjacencyPlan.filter(detail => detail.includes('edges_source'))).toHaveLength(2);
          expect(adjacencyPlan.filter(detail => detail.includes('edges_target'))).toHaveLength(2);
          expect(adjacencyPlan.join('\n')).not.toMatch(/SCAN (?:current_edges|base_edges|effective_edges)/u);
          expect(adjacency.text.match(/LIMIT \?/gu)).toHaveLength(5);

          const exact = codeGraphExactSymbolQueryStatement(currentSnapshotId, baseSnapshotId, 'ProgressManager', 20);
          const exactPlan = queryPlan(database, exact.text, exact.parameters);
          for (const index of ['symbols_name_nocase', 'symbols_qualified_nocase', 'symbols_path_nocase']) {
            expect(exactPlan.filter(detail => detail.includes(index))).toHaveLength(2);
          }
          expect(exactPlan.join('\n')).not.toMatch(/SCAN (?:current_symbols|base_symbols|effective_symbols)/u);

          const byIds = codeGraphSymbolsByIdsQueryStatement(currentSnapshotId, baseSnapshotId, [
            'symbol-a',
            'symbol-b',
          ]);
          const byIdsPlan = queryPlan(database, byIds.text, byIds.parameters);
          expect(byIdsPlan).toContain('SEARCH current_symbols USING PRIMARY KEY (snapshot_id=? AND id=?)');
          expect(byIdsPlan).toContain('SEARCH base_symbols USING PRIMARY KEY (snapshot_id=? AND id=?)');
          expect(byIdsPlan.join('\n')).not.toMatch(/SCAN (?:current_symbols|base_symbols|effective_symbols)/u);

          const terms = codeGraphTermCandidateQueryStatement(
            currentSnapshotId,
            baseSnapshotId,
            ['progress', 'manager'],
            400,
          );
          const termPlan = queryPlan(database, terms.text, terms.parameters);
          expect(termPlan).toContain('SEARCH current_terms USING PRIMARY KEY (snapshot_id=? AND term=?)');
          expect(termPlan).toContain('SEARCH base_terms USING PRIMARY KEY (snapshot_id=? AND term=?)');
          expect(termPlan.join('\n')).not.toMatch(/SCAN (?:current_terms|base_terms|symbol_terms)/u);
        } finally {
          database.close(false);
        }
      }),
    ).pipe(Effect.provide(ApplicationLayer)),
  );

  it.effect('bounds every branch before merging a high-degree adjacency result', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const store = yield* CodeGraphStore;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-high-degree-'});
        const databasePath = path.join(root, 'graph-v3.sqlite');
        yield* store.initialize(databasePath);
        const edges = Array.from({length: 50_000}, (_, index): CodeGraphEdge => ({
          confidence: (100 - (index % 100)) / 100,
          evidencePath: `src/high-degree-${index}.ts`,
          evidenceSpan: {column: 1, endColumn: 2, endLine: 1, line: 1},
          id: `high-degree-${String(index).padStart(6, '0')}`,
          provenance: allProvenances[index % allProvenances.length]!,
          relation: relations[index % relations.length]!,
          sourceId: 'hub',
          sourceName: 'hub',
          targetId: `leaf-${index}`,
          targetName: `leaf-${String(index).padStart(6, '0')}`,
        }));
        yield* Effect.sync(() => insertOverlayFixture(databasePath, [], edges, new Set()));

        const startedAt = performance.now();
        const actual = yield* store.edgesForNodes(
          databasePath,
          currentSnapshotId,
          ['hub'],
          'outgoing',
          40,
          allProvenances,
        );
        const elapsedMilliseconds = performance.now() - startedAt;
        const expected = [...edges].sort(compareEdges).slice(0, 40);

        expect(actual.map(edge => edge.id)).toEqual(expected.map(edge => edge.id));
        expect(elapsedMilliseconds).toBeLessThan(2_000);
      }),
    ).pipe(Effect.provide(ApplicationLayer)),
  );

  it.effect('ranks an exact-case declaration above case-insensitive local properties', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const store = yield* CodeGraphStore;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-ranking-'});
        const databasePath = path.join(root, 'graph-v3.sqlite');
        yield* store.initialize(databasePath);
        yield* Effect.sync(() => insertRankingFixture(databasePath));

        const results = yield* store.searchSymbols(databasePath, currentSnapshotId, 'ProgressManager', 20);

        expect(results.map(result => [result.kind, result.name, result.score])).toEqual([
          ['class', 'ProgressManager', 1],
          ['property', 'progressManager', 0.98],
          ['property', 'progressManager', 0.98],
        ]);
      }),
    ).pipe(Effect.provide(ApplicationLayer)),
  );

  it.effect('resolves an exact repository path without broad lexical candidate expansion', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const store = yield* CodeGraphStore;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-exact-path-'});
        const databasePath = path.join(root, 'graph-v3.sqlite');
        yield* store.initialize(databasePath);
        yield* Effect.sync(() => insertExactPathFixture(databasePath));

        const results = yield* store.searchSymbols(databasePath, currentSnapshotId, '.\\src\\feature\\button.ts', 20);

        expect(results.map(result => [result.kind, result.name, result.path, result.score])).toEqual([
          ['module', 'src/feature/button.ts', 'src/feature/button.ts', 1],
          ['function', 'createButton', 'src/feature/button.ts', 0.9],
        ]);
      }),
    ).pipe(Effect.provide(ApplicationLayer)),
  );

  it.effect('preserves canonical Bazel labels for exact qualified-name lookup', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const store = yield* CodeGraphStore;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-bazel-label-'});
        const databasePath = path.join(root, 'graph-v3.sqlite');
        yield* store.initialize(databasePath);
        yield* Effect.sync(() => insertBazelLabelFixture(databasePath));

        const [rootTarget, nestedTarget] = yield* Effect.all([
          store.searchSymbols(databasePath, currentSnapshotId, '//:main', 20),
          store.searchSymbols(databasePath, currentSnapshotId, '//platform/build:runner', 20),
        ]);

        expect(rootTarget[0]).toMatchObject({
          kind: 'target',
          language: 'bazel-build',
          path: 'BUILD.bazel',
          qualifiedName: '//:main',
          score: 0.99,
        });
        expect(nestedTarget[0]).toMatchObject({
          kind: 'target',
          language: 'bazel-build',
          path: 'platform/build/BUILD.bazel',
          qualifiedName: '//platform/build:runner',
          score: 0.99,
        });
      }),
    ).pipe(Effect.provide(ApplicationLayer)),
  );

  it.effect.prop(
    'distinguishes canonical absolute Bazel labels from repository paths',
    {
      packageSegments: FC.array(bazelLabelSegment, {maxLength: 5}),
      repository: FC.option(bazelLabelSegment, {nil: undefined}),
      target: bazelLabelSegment,
    },
    ({packageSegments, repository, target}) =>
      Effect.sync(() => {
        const repositoryPrefix = repository === undefined ? '' : `@${repository}`;
        const label = `${repositoryPrefix}//${packageSegments.join('/')}:${target}`;
        expect(isCanonicalAbsoluteBazelLabel(label)).toBe(true);
        expect(isCanonicalAbsoluteBazelLabel(label.replace('//', '/'))).toBe(false);
        expect(isCanonicalAbsoluteBazelLabel(`${packageSegments.join('/')}/${target}.ts`)).toBe(false);
      }),
    {fastCheck: {numRuns: 100}},
  );
});

function lastEdgeById(values: readonly EdgeSpec[]): ReadonlyMap<string, CodeGraphEdge> {
  const output = new Map<string, CodeGraphEdge>();
  for (const value of values) output.set(edgeId(value.id), graphEdge(value));
  return output;
}

function graphEdge(value: EdgeSpec): CodeGraphEdge {
  return {
    confidence: value.confidence / 100,
    evidencePath: `src/${value.id}.ts`,
    evidenceSpan: {column: 1, endColumn: 2, endLine: 1, line: 1},
    id: edgeId(value.id),
    provenance: value.provenance,
    relation: value.relation,
    sourceId: nodeId(value.source),
    sourceName: nodeId(value.source),
    targetId: nodeId(value.target),
    targetName: nodeId(value.target),
  };
}

function referenceAdjacency(
  base: ReadonlyMap<string, CodeGraphEdge>,
  current: ReadonlyMap<string, CodeGraphEdge>,
  deletions: ReadonlySet<string>,
  nodeIds: ReadonlySet<string>,
  direction: 'both' | 'incoming' | 'outgoing',
  limit: number,
  allowedProvenances: ReadonlySet<CodeGraphProvenance>,
): readonly CodeGraphEdge[] {
  const effective = new Map(current);
  for (const [id, edge] of base) {
    if (!current.has(id) && !deletions.has(id)) effective.set(id, edge);
  }
  return [...effective.values()]
    .filter(edge => {
      if (!allowedProvenances.has(edge.provenance)) return false;
      if (direction === 'incoming') return edge.targetId !== undefined && nodeIds.has(edge.targetId);
      if (direction === 'outgoing') return edge.sourceId !== undefined && nodeIds.has(edge.sourceId);
      return (
        (edge.sourceId !== undefined && nodeIds.has(edge.sourceId)) ||
        (edge.targetId !== undefined && nodeIds.has(edge.targetId))
      );
    })
    .sort(compareEdges)
    .slice(0, limit);
}

function compareEdges(left: CodeGraphEdge, right: CodeGraphEdge): number {
  return (
    provenanceOrder(left.provenance) - provenanceOrder(right.provenance) ||
    right.confidence - left.confidence ||
    compareText(left.sourceName, right.sourceName) ||
    compareText(left.relation, right.relation) ||
    compareText(left.targetName, right.targetName) ||
    compareText(left.id, right.id)
  );
}

function provenanceOrder(provenance: CodeGraphProvenance): number {
  if (provenance === 'declared') return 0;
  if (provenance === 'resolved') return 1;
  if (provenance === 'syntactic') return 2;
  return 3;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function edgeIdentity(edge: CodeGraphEdge): readonly unknown[] {
  return [
    edge.id,
    edge.sourceId,
    edge.targetId,
    edge.provenance,
    edge.relation,
    edge.confidence,
    edge.sourceName,
    edge.targetName,
  ];
}

function insertOverlayFixture(
  databasePath: string,
  base: readonly CodeGraphEdge[],
  current: readonly CodeGraphEdge[],
  deletions: ReadonlySet<string>,
): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database.transaction(() => {
      insertRepository(database);
      insertSnapshot(database, baseSnapshotId, undefined, base.length);
      insertSnapshot(database, currentSnapshotId, baseSnapshotId, current.length);
      for (const edge of base) insertEdge(database, baseSnapshotId, edge);
      for (const edge of current) insertEdge(database, currentSnapshotId, edge);
      const deletion = database.query('INSERT INTO snapshot_edge_deletions (snapshot_id, edge_id) VALUES (?, ?)');
      for (const id of deletions) deletion.run(currentSnapshotId, id);
    })();
  } finally {
    database.close(false);
  }
}

function insertRankingFixture(databasePath: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database.transaction(() => {
      insertRepository(database);
      insertSnapshot(database, currentSnapshotId, undefined, 0);
      const insert = database.query(`INSERT INTO symbols (
        snapshot_id, id, content_hash, kind, name, qualified_name, path, language, arity,
        lookup_keys_json, resolution_domain, resolution_scope_id, package_name, exported,
        signature, documentation, span_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, '[]', ?, NULL, NULL, 1, NULL, NULL, ?)`);
      insert.run(
        currentSnapshotId,
        'class-progress-manager',
        'hash-class',
        'class',
        'ProgressManager',
        'com.example.ProgressManager',
        'src/ProgressManager.java',
        'java',
        'java',
        spanJson,
      );
      for (const [id, path] of [
        ['property-a', 'src/A.kt'],
        ['property-b', 'src/B.kt'],
      ] as const) {
        insert.run(
          currentSnapshotId,
          id,
          `hash-${id}`,
          'property',
          'progressManager',
          `com.example.${id}.progressManager`,
          path,
          'kotlin',
          'kotlin',
          spanJson,
        );
      }
    })();
  } finally {
    database.close(false);
  }
}

function insertExactPathFixture(databasePath: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database.transaction(() => {
      insertRepository(database);
      insertSnapshot(database, currentSnapshotId, undefined, 0);
      const insert = database.query(`INSERT INTO symbols (
        snapshot_id, id, content_hash, kind, name, qualified_name, path, language, arity,
        lookup_keys_json, resolution_domain, resolution_scope_id, package_name, exported,
        signature, documentation, span_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'typescript', NULL, '[]', 'typescript', NULL, NULL, 1, NULL, NULL, ?)`);
      insert.run(
        currentSnapshotId,
        'module-button',
        'hash-module-button',
        'module',
        'src/feature/button.ts',
        'src/feature/button.ts',
        'src/feature/button.ts',
        spanJson,
      );
      insert.run(
        currentSnapshotId,
        'function-create-button',
        'hash-function-create-button',
        'function',
        'createButton',
        'src/feature/button.ts#createButton',
        'src/feature/button.ts',
        spanJson,
      );
    })();
  } finally {
    database.close(false);
  }
}

function insertBazelLabelFixture(databasePath: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database.transaction(() => {
      insertRepository(database);
      insertSnapshot(database, currentSnapshotId, undefined, 0);
      const insert = database.query(`INSERT INTO symbols (
        snapshot_id, id, content_hash, kind, name, qualified_name, path, language, arity,
        lookup_keys_json, resolution_domain, resolution_scope_id, package_name, exported,
        signature, documentation, span_json
      ) VALUES (?, ?, ?, 'target', ?, ?, ?, 'bazel-build', NULL, '[]', 'bazel', NULL, NULL, 1, NULL, NULL, ?)`);
      insert.run(
        currentSnapshotId,
        'bazel-root-main',
        'hash-bazel-root-main',
        'main',
        '//:main',
        'BUILD.bazel',
        spanJson,
      );
      insert.run(
        currentSnapshotId,
        'bazel-platform-runner',
        'hash-bazel-platform-runner',
        'runner',
        '//platform/build:runner',
        'platform/build/BUILD.bazel',
        spanJson,
      );
    })();
  } finally {
    database.close(false);
  }
}

function insertRepository(database: Database): void {
  database
    .query(
      `INSERT INTO repositories (id, display_name, object_format, created_at, last_used_at)
       VALUES (?, 'query-property', 'sha1', ?, ?)`,
    )
    .run(repositoryId, timestamp, timestamp);
}

function insertSnapshot(database: Database, id: string, base: string | undefined, edgeCount: number): void {
  database
    .query(
      `INSERT INTO snapshots (
         id, repository_id, worktree_id, commit_id, base_snapshot_id, extractor_set, dirty,
         overlay_fingerprint, state, file_count, symbol_count, edge_count, started_at, completed_at, failure_summary
       ) VALUES (?, ?, ?, 'commit', ?, 'query-property', 0, NULL, 'ready', 0, 0, ?, ?, ?, NULL)`,
    )
    .run(id, repositoryId, worktreeId, base ?? null, edgeCount, timestamp, timestamp);
}

function insertEdge(database: Database, snapshotId: string, edge: CodeGraphEdge): void {
  database
    .query(
      `INSERT INTO edges (
         snapshot_id, id, source_id, source_name, relation, target_id, target_name,
         provenance, confidence, evidence_path, evidence_span_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      snapshotId,
      edge.id,
      edge.sourceId ?? null,
      edge.sourceName,
      edge.relation,
      edge.targetId ?? null,
      edge.targetName,
      edge.provenance,
      edge.confidence,
      edge.evidencePath,
      JSON.stringify(edge.evidenceSpan),
    );
}

function queryPlan(database: Database, statement: string, parameters: readonly (number | string)[]): readonly string[] {
  return (
    database.query(`EXPLAIN QUERY PLAN ${statement}`).all(...parameters) as readonly {
      readonly detail: string;
    }[]
  ).map(row => row.detail);
}

function edgeId(value: number): string {
  return `edge-${value}`;
}

function nodeId(value: number): string {
  return `node-${value}`;
}

const spanJson = JSON.stringify({column: 1, endColumn: 2, endLine: 1, line: 1});
const timestamp = '2026-08-01T00:00:00.000Z';
