import {Database} from 'bun:sqlite';
import {describe, expect, it} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import * as FC from 'effect/testing/FastCheck';
import {
  codeGraphAdjacencyQueryStatement,
  codeGraphCompactLexicalCleanupPageStatement,
  codeGraphEffectiveSymbolTermsQueryStatement,
  codeGraphExactSymbolQueryStatement,
  codeGraphSymbolPathClass,
  codeGraphSymbolPathScoreMultiplier,
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

interface LexicalPostingSpec {
  readonly symbol: number;
  readonly term: string;
  readonly weight: number;
}

type LexicalFixtureFormat = 'compact' | 'legacy';

const edgeSpec = FC.record({
  confidence: FC.integer({max: 100, min: 0}),
  id: FC.integer({max: 15, min: 0}),
  provenance: FC.constantFrom(...allProvenances),
  relation: FC.constantFrom(...relations),
  source: FC.integer({max: 5, min: 0}),
  target: FC.integer({max: 5, min: 0}),
});
const lexicalPostingSpec = FC.record({
  symbol: FC.integer({max: 7, min: 0}),
  term: FC.constantFrom('alpha', 'beta', 'delta', 'gamma', 'omega'),
  weight: FC.integer({max: 5, min: 1}),
});
const bazelLabelSegment = FC.array(
  FC.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._+-'),
  {maxLength: 16, minLength: 1},
).map(characters => characters.join(''));

const symbolPathDirectory = FC.constantFrom(
  '__tests__',
  'app',
  'docs',
  'fixtures',
  'integration',
  'lib',
  'spec',
  'src',
  'test',
  'tests',
);
const symbolFileName = FC.constantFrom(
  'AGENTS.md',
  'guide.mdx',
  'helpers.ts',
  'mcp.native-tools.test.ts',
  'mcp_server.ts',
  'notes.rst',
  'widget.spec.tsx',
);
const symbolQueryTerm = FC.constantFrom('docs', 'md', 'mcp', 'recall_context', 'spec', 'test');

describe('code graph indexed query properties', () => {
  it.prop(
    'never scores a test or documentation symbol path above an implementation path',
    {
      directories: FC.array(symbolPathDirectory, {maxLength: 3}),
      fileName: symbolFileName,
      queryTerms: FC.array(symbolQueryTerm, {maxLength: 3}),
    },
    ({directories, fileName, queryTerms}) => {
      const symbolPath = [...directories, fileName].join('/');
      const pathClass = codeGraphSymbolPathClass(symbolPath);
      const multiplier = codeGraphSymbolPathScoreMultiplier(symbolPath, queryTerms);

      expect(multiplier).toBeGreaterThan(0);
      expect(multiplier).toBeLessThanOrEqual(codeGraphSymbolPathScoreMultiplier('src/implementation.ts', queryTerms));
      expect(codeGraphSymbolPathClass(symbolPath.replaceAll('/', '\\'))).toBe(pathClass);
      expect(codeGraphSymbolPathClass(symbolPath.toUpperCase())).toBe(pathClass);
      expect(codeGraphSymbolPathScoreMultiplier(symbolPath, [])).toBeLessThanOrEqual(multiplier);
      expect(
        codeGraphSymbolPathScoreMultiplier(symbolPath, [...queryTerms, pathClass === 'test' ? 'test' : 'docs']),
      ).toBe(1);
      if (pathClass === 'implementation') expect(multiplier).toBe(1);
    },
    {fastCheck: {numRuns: 200}},
  );

  it.effect('treats a database observed during partial schema publication as unavailable', () =>
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

        yield* Effect.sync(() => {
          const partial = new Database(databasePath);
          partial.exec('CREATE TABLE snapshots (id TEXT PRIMARY KEY)');
          partial.close(false);
        });

        expect(yield* store.readySnapshotForCommit(databasePath, repositoryId, 'commit')).toBeUndefined();
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
        yield* Effect.sync(() => {
          const highCardinalityBase = Array.from({length: 4_000}, (_, index) => ({
            symbol: index,
            term: index === 0 ? 'progress' : `base-noise-${index}`,
            weight: 1,
          }));
          const highCardinalityCurrent = Array.from({length: 2_000}, (_, index) => ({
            symbol: index,
            term: index === 1 ? 'manager' : `current-noise-${index}`,
            weight: 1,
          }));
          insertLexicalOverlayFixture(
            databasePath,
            highCardinalityBase,
            highCardinalityCurrent,
            new Set(),
            'compact',
            'compact',
          );
        });
        const database = new Database(databasePath, {strict: true});
        try {
          database.exec('ANALYZE');
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
          expect(termPlan).toContain('SEARCH current_legacy_terms USING PRIMARY KEY (snapshot_id=? AND term=?)');
          expect(termPlan).toContain('SEARCH base_legacy_terms USING PRIMARY KEY (snapshot_id=? AND term=?)');
          expect(termPlan).toContain(
            'SEARCH current_compact_terms USING COVERING INDEX sqlite_autoindex_lexical_compact_terms_1 (snapshot_key=? AND term=?)',
          );
          expect(termPlan).toContain(
            'SEARCH current_compact_postings USING PRIMARY KEY (snapshot_key=? AND term_key=?)',
          );
          expect(termPlan).toContain(
            'SEARCH base_compact_terms USING COVERING INDEX sqlite_autoindex_lexical_compact_terms_1 (snapshot_key=? AND term=?)',
          );
          expect(termPlan).toContain('SEARCH base_compact_postings USING PRIMARY KEY (snapshot_key=? AND term_key=?)');
          expect(termPlan.join('\n')).not.toMatch(
            /SCAN (?:current_legacy_terms|base_legacy_terms|current_compact_postings|base_compact_postings|current_compact_symbols|base_compact_symbols|symbol_terms)/u,
          );
          const compactSnapshot = database
            .query('SELECT snapshot_key FROM lexical_compact_snapshots WHERE snapshot_id = ?')
            .get(currentSnapshotId) as {readonly snapshot_key: number};
          for (const table of [
            'lexical_compact_postings',
            'lexical_compact_symbols',
            'lexical_compact_terms',
          ] as const) {
            const cleanup = codeGraphCompactLexicalCleanupPageStatement(table, compactSnapshot.snapshot_key, 5_000);
            const cleanupPlan = queryPlan(database, cleanup.text, cleanup.parameters).join('\n');
            expect(cleanupPlan).toMatch(/SEARCH candidate USING (?:PRIMARY KEY|COVERING INDEX).*snapshot_key=/u);
            expect(cleanupPlan).not.toMatch(/SCAN candidate|USE TEMP B-TREE/u);
          }
        } finally {
          database.close(false);
        }
      }),
    ).pipe(Effect.provide(ApplicationLayer)),
  );

  it.effect.prop(
    'preserves canonical rows and exact ranking across mixed lexical formats, overrides, and deletions',
    {
      base: FC.array(lexicalPostingSpec, {maxLength: 30}),
      baseFormat: FC.constantFrom<LexicalFixtureFormat>('compact', 'legacy'),
      current: FC.array(lexicalPostingSpec, {maxLength: 30}),
      currentFormat: FC.constantFrom<LexicalFixtureFormat>('compact', 'legacy'),
      deletedSymbols: FC.array(FC.integer({max: 7, min: 0}), {maxLength: 8}),
      limit: FC.integer({max: 20, min: 1}),
      terms: FC.uniqueArray(FC.constantFrom('alpha', 'beta', 'delta', 'gamma', 'omega'), {
        maxLength: 5,
        minLength: 1,
      }),
    },
    ({base, baseFormat, current, currentFormat, deletedSymbols, limit, terms}) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const store = yield* CodeGraphStore;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-lexical-mixed-property-'});
          const databasePath = path.join(root, 'graph-v3.sqlite');
          yield* store.initialize(databasePath);
          const expected = yield* Effect.sync(() =>
            insertLexicalOverlayFixture(
              databasePath,
              base,
              current,
              new Set(deletedSymbols.map(lexicalSymbolId)),
              baseFormat,
              currentFormat,
            ),
          );

          const actual = yield* Effect.sync(() => {
            const database = new Database(databasePath, {readonly: true, strict: true});
            try {
              const candidates = codeGraphTermCandidateQueryStatement(currentSnapshotId, baseSnapshotId, terms, limit);
              const rows = database.query(candidates.text).all(...candidates.parameters) as readonly {
                readonly score: number;
                readonly symbol_id: string;
              }[];
              const canonical = codeGraphEffectiveSymbolTermsQueryStatement(currentSnapshotId, baseSnapshotId);
              const canonicalRows = database.query(canonical.text).all(...canonical.parameters) as readonly {
                readonly symbol_id: string;
                readonly term: string;
                readonly weight: number;
              }[];
              return {canonicalRows, rows};
            } finally {
              database.close(false);
            }
          });
          const expectedScores = lexicalCandidateReference(expected, new Set(terms), limit);
          expect(actual.canonicalRows).toEqual(expected);
          expect(actual.rows.map(row => ({score: Number(row.score), symbol_id: row.symbol_id}))).toEqual(
            expectedScores,
          );
        }),
      ).pipe(Effect.provide(ApplicationLayer)),
    {fastCheck: {numRuns: 80}},
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

interface LexicalCanonicalRow {
  readonly symbol_id: string;
  readonly term: string;
  readonly weight: number;
}

function insertLexicalOverlayFixture(
  databasePath: string,
  baseInput: readonly LexicalPostingSpec[],
  currentInput: readonly LexicalPostingSpec[],
  deletedSymbolIds: ReadonlySet<string>,
  baseFormat: LexicalFixtureFormat,
  currentFormat: LexicalFixtureFormat,
): readonly LexicalCanonicalRow[] {
  const base = normalizedLexicalPostings(baseInput);
  const current = normalizedLexicalPostings(currentInput);
  const currentSymbolIds = new Set(current.map(row => row.symbol_id));
  const database = new Database(databasePath, {strict: true});
  try {
    database.transaction(() => {
      insertRepository(database);
      insertSnapshot(database, baseSnapshotId, undefined, 0);
      insertSnapshot(database, currentSnapshotId, baseSnapshotId, 0);
      insertLexicalSnapshot(database, baseSnapshotId, base, baseFormat);
      insertLexicalSnapshot(database, currentSnapshotId, current, currentFormat);
      const deletion = database.query('INSERT INTO snapshot_symbol_deletions (snapshot_id, symbol_id) VALUES (?, ?)');
      for (const symbolId of [...deletedSymbolIds].sort()) deletion.run(currentSnapshotId, symbolId);
    })();
  } finally {
    database.close(false);
  }
  return [
    ...current,
    ...base.filter(row => !currentSymbolIds.has(row.symbol_id) && !deletedSymbolIds.has(row.symbol_id)),
  ].sort(
    (left, right) => left.term.localeCompare(right.term, 'en') || left.symbol_id.localeCompare(right.symbol_id, 'en'),
  );
}

function normalizedLexicalPostings(input: readonly LexicalPostingSpec[]): readonly LexicalCanonicalRow[] {
  const rows = new Map<string, LexicalCanonicalRow>();
  for (const posting of input) {
    const symbolId = lexicalSymbolId(posting.symbol);
    const key = `${posting.term}\0${symbolId}`;
    const current = rows.get(key);
    if (current === undefined || posting.weight > current.weight) {
      rows.set(key, {symbol_id: symbolId, term: posting.term, weight: posting.weight});
    }
  }
  return [...rows.values()].sort(
    (left, right) => left.term.localeCompare(right.term, 'en') || left.symbol_id.localeCompare(right.symbol_id, 'en'),
  );
}

function insertLexicalSnapshot(
  database: Database,
  snapshotId: string,
  postings: readonly LexicalCanonicalRow[],
  format: LexicalFixtureFormat,
): void {
  const symbolIds = [...new Set(postings.map(row => row.symbol_id))].sort();
  const insertSymbol = database.query(`INSERT INTO symbols (
    snapshot_id, id, content_hash, kind, name, qualified_name, path, language, arity,
    lookup_keys_json, resolution_domain, resolution_scope_id, package_name, exported,
    signature, documentation, span_json
  ) VALUES (?, ?, ?, 'function', ?, ?, ?, 'typescript', NULL, '[]', 'typescript', NULL, NULL, 1, NULL, NULL, ?)`);
  for (const symbolId of symbolIds) {
    insertSymbol.run(
      snapshotId,
      symbolId,
      `hash-${snapshotId}-${symbolId}`,
      symbolId,
      symbolId,
      `src/${symbolId}.ts`,
      spanJson,
    );
  }
  database.query('UPDATE snapshots SET symbol_count = ? WHERE id = ?').run(symbolIds.length, snapshotId);
  if (format === 'legacy') {
    const insert = database.query(
      'INSERT INTO symbol_terms (snapshot_id, term, symbol_id, weight) VALUES (?, ?, ?, ?)',
    );
    for (const posting of postings) insert.run(snapshotId, posting.term, posting.symbol_id, posting.weight);
    return;
  }
  database.query('INSERT INTO lexical_compact_snapshots (snapshot_id) VALUES (?)').run(snapshotId);
  const compact = database
    .query('SELECT snapshot_key FROM lexical_compact_snapshots WHERE snapshot_id = ?')
    .get(snapshotId) as {readonly snapshot_key: number};
  const insertCompactSymbol = database.query(
    'INSERT INTO lexical_compact_symbols (snapshot_key, symbol_id) VALUES (?, ?)',
  );
  for (const symbolId of symbolIds) insertCompactSymbol.run(compact.snapshot_key, symbolId);
  const terms = [...new Set(postings.map(row => row.term))].sort();
  const insertTerm = database.query('INSERT INTO lexical_compact_terms (snapshot_key, term) VALUES (?, ?)');
  for (const term of terms) insertTerm.run(compact.snapshot_key, term);
  const insertPosting = database.query(
    `INSERT INTO lexical_compact_postings (snapshot_key, term_key, symbol_key, weight)
     SELECT ?, term.term_key, symbol.symbol_key, ?
     FROM lexical_compact_terms AS term, lexical_compact_symbols AS symbol
     WHERE term.snapshot_key = ? AND term.term = ?
       AND symbol.snapshot_key = ? AND symbol.symbol_id = ?`,
  );
  for (const posting of postings) {
    insertPosting.run(
      compact.snapshot_key,
      posting.weight,
      compact.snapshot_key,
      posting.term,
      compact.snapshot_key,
      posting.symbol_id,
    );
  }
  database
    .query(
      `INSERT INTO lexical_storage_formats (
         snapshot_id, format_version, posting_count, symbol_count, term_count, created_at
       ) VALUES (?, 1, ?, ?, ?, ?)`,
    )
    .run(snapshotId, postings.length, symbolIds.length, terms.length, timestamp);
}

function lexicalCandidateReference(
  rows: readonly LexicalCanonicalRow[],
  terms: ReadonlySet<string>,
  limit: number,
): readonly {readonly score: number; readonly symbol_id: string}[] {
  const scores = new Map<string, number>();
  for (const row of rows) {
    if (terms.has(row.term)) scores.set(row.symbol_id, (scores.get(row.symbol_id) ?? 0) + row.weight);
  }
  return [...scores]
    .map(([symbol_id, score]) => ({score, symbol_id}))
    .sort((left, right) => right.score - left.score || left.symbol_id.localeCompare(right.symbol_id, 'en'))
    .slice(0, limit);
}

function lexicalSymbolId(value: number): string {
  return `lexical-symbol-${value}`;
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
