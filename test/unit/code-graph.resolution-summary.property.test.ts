import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {describe, expect} from 'vitest';
import {CodeGraphStore} from '../../src/code_graph/store.js';
import type {
  CodeGraphEdge,
  CodeGraphInventoryFile,
  CodeGraphReference,
  CodeGraphSnapshot,
  CodeGraphSymbol,
  RepositoryIdentity,
} from '../../src/code_graph/types.js';
import {SystemInfo} from '../../src/effect/system.js';
import {claimPersistentBuildForTest} from '../helpers/code-graph-build.js';

const ResolutionSummaryTestLayer = CodeGraphStore.layer.pipe(
  Layer.provideMerge(SystemInfo.layer),
  Layer.provideMerge(BunServices.layer),
);

const lookupKeys = ['typescript:name:alpha', 'typescript:name:beta', 'typescript:name:gamma'] as const;

interface ResolutionCase {
  readonly references: ReadonlyArray<{
    readonly exportedOnly: boolean;
    readonly relation: 'calls' | 'overrides';
    readonly sourceIndex: number;
    readonly tiers: ReadonlyArray<ReadonlyArray<(typeof lookupKeys)[number]>>;
  }>;
  readonly symbols: ReadonlyArray<{
    readonly exported: boolean;
    readonly keys: ReadonlyArray<(typeof lookupKeys)[number]>;
  }>;
}

const resolutionCaseArbitrary: fc.Arbitrary<ResolutionCase> = fc
  .array(
    fc.record({
      exported: fc.boolean(),
      keys: fc.array(fc.constantFrom(...lookupKeys), {maxLength: 3, minLength: 1}),
    }),
    {maxLength: 6, minLength: 2},
  )
  .chain(symbols =>
    fc.record({
      references: fc.array(
        fc.record({
          exportedOnly: fc.boolean(),
          relation: fc.constantFrom('calls' as const, 'overrides' as const),
          sourceIndex: fc.integer({max: symbols.length - 1, min: 0}),
          tiers: fc.array(fc.array(fc.constantFrom(...lookupKeys), {maxLength: 3, minLength: 1}), {
            maxLength: 3,
            minLength: 1,
          }),
        }),
        {maxLength: 6, minLength: 1},
      ),
      symbols: fc.constant(symbols),
    }),
  );

describe('persistent reference lookup summaries', () => {
  effectIt.layer(ResolutionSummaryTestLayer)(layerIt => {
    layerIt.effect.prop(
      'are equivalent to raw candidate-union resolution across tiers, exports, duplicates, and overrides',
      {testCase: resolutionCaseArbitrary},
      ({testCase}) =>
        Effect.scoped(
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* fileSystem.makeTempDirectoryScoped({
              prefix: 'threadnote-resolution-summary-property-',
            });
            const fixture = resolutionFacts(root, testCase);
            const raw = yield* resolveWithTemporaryActivation(path.join(root, 'raw.sqlite'), fixture);
            const summarized = yield* resolveWithPersistentActivation(path.join(root, 'summarized.sqlite'), fixture);

            expect(summarized).toEqual(raw);
          }),
        ).pipe(TestClock.withLive),
      {fastCheck: {numRuns: 40}},
    );
  });
});

function resolutionFacts(root: string, testCase: ResolutionCase) {
  const identity: RepositoryIdentity = {
    caseMode: 'sensitive',
    checkoutId: 'c'.repeat(64),
    displayName: 'resolution-summary-property',
    gitCommonDirectory: root,
    headCommit: '1'.repeat(40),
    objectFormat: 'sha1',
    repoRoot: root,
    repositoryId: 'r'.repeat(64),
    worktreeId: 'w'.repeat(64),
  };
  const file: CodeGraphInventoryFile = {
    blobId: 'b'.repeat(40),
    contentHash: 'h'.repeat(64),
    language: 'typescript',
    mode: '100644',
    path: 'src/resolution.ts',
    size: 128,
    source: 'commit',
  };
  const symbols: CodeGraphSymbol[] = testCase.symbols.map((definition, index) => ({
    contentHash: `hash-${index}`,
    exported: definition.exported,
    id: `symbol-${index}`,
    kind: 'function',
    language: 'typescript',
    lookupKeys: [...definition.keys],
    name: `symbol${index}`,
    path: file.path,
    qualifiedName: `symbol${index}`,
    resolutionDomain: 'typescript',
    span: {column: 1, endColumn: 2, endLine: index + 1, line: index + 1},
  }));
  const edges: CodeGraphEdge[] = [];
  const references: CodeGraphReference[] = [];
  for (const [index, definition] of testCase.references.entries()) {
    const source = symbols[definition.sourceIndex];
    const evidencePath = `src/resolution-${index}.ts`;
    const edge: CodeGraphEdge = {
      confidence: 0.7,
      evidencePath,
      evidenceSpan: source.span,
      id: `edge-${index}`,
      provenance: 'syntactic',
      relation: definition.relation,
      sourceId: source.id,
      sourceName: source.name,
      targetName: `pending${index}`,
    };
    edges.push(edge);
    references.push({
      edgeId: edge.id,
      evidencePath,
      evidenceSpan: source.span,
      exportedOnly: definition.exportedOnly,
      lookupTiers: definition.tiers.map(tier => [...tier]),
      provenance: edge.provenance,
      relation: edge.relation,
      resolutionDomain: 'typescript',
      sourceId: source.id,
      sourceName: source.name,
      targetName: edge.targetName,
    });
  }
  const snapshot: CodeGraphSnapshot = {
    commit: identity.headCommit,
    dirty: false,
    edgeCount: edges.length,
    extractorSet: 'resolution-summary-property',
    fileCount: 1,
    id: 'resolution-summary-property',
    repositoryId: identity.repositoryId,
    state: 'ready',
    symbolCount: symbols.length,
    worktreeId: identity.worktreeId,
  };
  return {edges, file, identity, references, snapshot, symbols};
}

type ResolutionFixture = ReturnType<typeof resolutionFacts>;

function resolveWithTemporaryActivation(databasePath: string, fixture: ResolutionFixture) {
  return Effect.gen(function* () {
    const store = yield* CodeGraphStore;
    return yield* store.withSession(
      databasePath,
      Effect.gen(function* () {
        yield* store.prepareActivation(databasePath, [fixture.file]);
        yield* store.stageActivationFacts(databasePath, fixture.symbols, fixture.edges, fixture.references);
        const summary = yield* store.resolveStagedReferences(databasePath);
        yield* store.activateStaged(databasePath, fixture.identity, fixture.snapshot);
        const graph = yield* store.loadGraph(databasePath, fixture.snapshot.id);
        return normalizedResolution(summary.resolved, graph.edges);
      }),
    );
  });
}

function resolveWithPersistentActivation(databasePath: string, fixture: ResolutionFixture) {
  return Effect.gen(function* () {
    const store = yield* CodeGraphStore;
    return yield* store.withSession(
      databasePath,
      Effect.gen(function* () {
        const ownerToken = yield* claimPersistentBuildForTest(store, databasePath, fixture.identity, {
          ...fixture.snapshot,
          state: 'building',
        });
        yield* store.prepareActivation(databasePath, [fixture.file], fixture.snapshot.id, 1, ownerToken);
        yield* store.stageActivationFacts(
          databasePath,
          fixture.symbols,
          fixture.edges,
          fixture.references,
          undefined,
          0,
        );
        const summary = yield* store.resolveStagedReferences(databasePath);
        yield* store.activateStaged(databasePath, fixture.identity, fixture.snapshot);
        const graph = yield* store.loadGraph(databasePath, fixture.snapshot.id);
        return normalizedResolution(summary.resolved, graph.edges);
      }),
    );
  });
}

function normalizedResolution(resolved: number, edges: ReadonlyArray<CodeGraphEdge>) {
  return {
    edges: edges
      .map(edge => ({
        id: edge.id,
        provenance: edge.provenance,
        relation: edge.relation,
        sourceId: edge.sourceId,
        targetId: edge.targetId,
        targetName: edge.targetName,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    resolved,
  };
}
