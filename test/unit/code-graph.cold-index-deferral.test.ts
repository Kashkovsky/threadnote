import {it as effectIt} from '@effect/vitest';
import {Effect, Exit, FileSystem, Path} from 'effect';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  CodeGraphDiskCapacityPressureError,
  type CodeGraphDirectPersistentCapacityBoundary,
} from '../../src/code_graph/disk_capacity.js';
import {CodeGraphStore} from '../../src/code_graph/store.js';
import {
  codeGraphColdIndexDeferralEligible,
  deferCodeGraphQueryIndexesForColdBuild,
} from '../../src/code_graph/store_cold_index_deferral.js';
import type {CodeGraphDirectPersistentCapacityProtector} from '../../src/code_graph/store_models.js';
import {claimPersistentSnapshotBuild} from '../../src/code_graph/store_persistent_build.js';
import {
  CODE_GRAPH_QUERY_INDEX_DEFINITIONS,
  inspectCodeGraphQueryIndexes,
} from '../../src/code_graph/store_query_indexes.js';
import {codeGraphSchemaInitializationReceiptCurrent} from '../../src/code_graph/store_schema_receipt.js';
import type {
  CodeGraphEdge,
  CodeGraphInventoryFile,
  CodeGraphSnapshot,
  CodeGraphStoreError,
  CodeGraphSymbol,
  RepositoryIdentity,
} from '../../src/code_graph/types.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {claimPersistentBuildForTest} from '../helpers/code-graph-build.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

describe('code graph cold query-index deferral', () => {
  it('admits exactly stores with no visible or reusable graph state', () => {
    fc.assert(
      fc.property(
        fc.record({
          activeSnapshotPresent: fc.boolean(),
          edgePresent: fc.boolean(),
          otherIncompleteSnapshotPresent: fc.boolean(),
          readySnapshotPresent: fc.boolean(),
          symbolPresent: fc.boolean(),
        }),
        observation => {
          const expected = Object.values(observation).every(present => !present);
          expect(codeGraphColdIndexDeferralEligible(observation)).toBe(expected);
        },
      ),
      {numRuns: 150},
    );
  });

  effectIt.effect('restores every exact index through one capacity boundary before reference resolution', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* coldIndexFixture('restore');
        const store = yield* CodeGraphStore;
        const boundaries: CodeGraphDirectPersistentCapacityBoundary[] = [];
        const progress: {readonly completed: number; readonly elapsedMilliseconds: number; readonly total: number}[] =
          [];
        let pauseRestoration = true;
        const guard: CodeGraphDirectPersistentCapacityProtector = <A, E, R>(
          boundary: CodeGraphDirectPersistentCapacityBoundary,
          transaction: Effect.Effect<A, E, R>,
        ): Effect.Effect<A, E | CodeGraphStoreError, R> =>
          Effect.suspend((): Effect.Effect<A, E | CodeGraphStoreError, R> => {
            boundaries.push({...boundary});
            if (pauseRestoration && boundary.operation === 'restore persistent code graph query indexes') {
              return Effect.fail(new CodeGraphDiskCapacityPressureError(boundary.operation));
            }
            return transaction;
          });

        yield* store.withSession(
          fixture.databasePath,
          Effect.gen(function* () {
            yield* store.initialize(fixture.databasePath);
            const sql = yield* SqlClient.SqlClient;
            const ownerToken = yield* claimPersistentBuildForTest(
              store,
              fixture.databasePath,
              fixture.identity,
              fixture.snapshot,
            );
            yield* store.prepareActivation(
              fixture.databasePath,
              [fixture.file],
              fixture.snapshot.id,
              undefined,
              ownerToken,
            );
            expect((yield* inspectCodeGraphQueryIndexes(sql)).missing.map(definition => definition.name)).toEqual(
              CODE_GRAPH_QUERY_INDEX_DEFINITIONS.map(definition => definition.name),
            );
            expect(yield* codeGraphSchemaInitializationReceiptCurrent(sql)).toBe(false);

            yield* store.stageActivationFactBatches(fixture.databasePath, [
              {
                batchIndex: 0,
                edges: [fixture.edge],
                finalFactBytes: 512,
                references: [],
                symbols: [fixture.symbol],
              },
            ]);
            expect((yield* inspectCodeGraphQueryIndexes(sql)).missing).toHaveLength(
              CODE_GRAPH_QUERY_INDEX_DEFINITIONS.length,
            );
            const failed = yield* store
              .finalizePersistentMaterializationPlan(fixture.databasePath, 1, guard)
              .pipe(Effect.exit);
            expect(Exit.isFailure(failed)).toBe(true);
            expect((yield* inspectCodeGraphQueryIndexes(sql)).missing).toHaveLength(
              CODE_GRAPH_QUERY_INDEX_DEFINITIONS.length,
            );
            const building = yield* sql<{readonly state: string}>`
              SELECT state FROM snapshots WHERE id = ${fixture.snapshot.id}
            `;
            expect(building[0]?.state).toBe('building');

            pauseRestoration = false;
            yield* store.finalizePersistentMaterializationPlan(fixture.databasePath, 1, guard, observation =>
              Effect.sync(() => progress.push(observation)),
            );
            expect((yield* inspectCodeGraphQueryIndexes(sql)).missing).toEqual([]);
            expect(yield* codeGraphSchemaInitializationReceiptCurrent(sql)).toBe(true);
            yield* store.resolveStagedReferences(fixture.databasePath);
          }),
          {writerLockPath: fixture.writerLockPath},
        );

        const restorationBoundaries = boundaries.filter(
          boundary => boundary.operation === 'restore persistent code graph query indexes',
        );
        expect(restorationBoundaries).toHaveLength(2);
        expect(restorationBoundaries[0]).toEqual(restorationBoundaries[1]);
        expect(restorationBoundaries[1]).toEqual({
          finalFactBytes: 0,
          operation: 'restore persistent code graph query indexes',
          rowCount:
            1 +
            CODE_GRAPH_QUERY_INDEX_DEFINITIONS.length +
            CODE_GRAPH_QUERY_INDEX_DEFINITIONS.filter(definition => definition.table === 'edges').length +
            CODE_GRAPH_QUERY_INDEX_DEFINITIONS.filter(definition => definition.table === 'symbols').length,
        });
        expect(progress.map(observation => observation.completed)).toEqual(
          Array.from({length: CODE_GRAPH_QUERY_INDEX_DEFINITIONS.length + 1}, (_, index) => index),
        );
        expect(progress.every(observation => observation.total === CODE_GRAPH_QUERY_INDEX_DEFINITIONS.length)).toBe(
          true,
        );
        expect(
          progress.every(
            (observation, index) =>
              index === 0 || observation.elapsedMilliseconds >= progress[index - 1]!.elapsedMilliseconds,
          ),
        ).toBe(true);
      }).pipe(provideTestLayer(ApplicationLayer)),
    ),
  );

  effectIt.effect('repairs a session-loss deferral before the next session can read graph state', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* coldIndexFixture('session-loss');
        const store = yield* CodeGraphStore;
        yield* store.withSession(
          fixture.databasePath,
          Effect.gen(function* () {
            yield* store.initialize(fixture.databasePath);
            const ownerToken = yield* claimPersistentBuildForTest(
              store,
              fixture.databasePath,
              fixture.identity,
              fixture.snapshot,
            );
            yield* store.prepareActivation(
              fixture.databasePath,
              [fixture.file],
              fixture.snapshot.id,
              undefined,
              ownerToken,
            );
            const sql = yield* SqlClient.SqlClient;
            expect((yield* inspectCodeGraphQueryIndexes(sql)).missing).toHaveLength(
              CODE_GRAPH_QUERY_INDEX_DEFINITIONS.length,
            );
          }),
          {writerLockPath: fixture.writerLockPath},
        );

        yield* store.initialize(fixture.databasePath);
        yield* store.withSession(
          fixture.databasePath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            expect((yield* inspectCodeGraphQueryIndexes(sql)).missing).toEqual([]);
            expect(yield* codeGraphSchemaInitializationReceiptCurrent(sql)).toBe(true);
          }),
          {writerLockPath: fixture.writerLockPath},
        );
      }).pipe(provideTestLayer(ApplicationLayer)),
    ),
  );

  effectIt.effect('revalidates indexes atomically when a claim races cold deferral', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* coldIndexFixture('claim-race');
        const store = yield* CodeGraphStore;
        yield* store.withSession(
          fixture.databasePath,
          Effect.gen(function* () {
            yield* store.initialize(fixture.databasePath);
            const firstOwnerToken = yield* claimPersistentBuildForTest(
              store,
              fixture.databasePath,
              fixture.identity,
              fixture.snapshot,
            );
            // A known batch count keeps the first build's preparation eager so
            // the test can place deferral exactly inside the second claim.
            yield* store.prepareActivation(
              fixture.databasePath,
              [fixture.file],
              fixture.snapshot.id,
              1,
              firstOwnerToken,
            );

            const sql = yield* SqlClient.SqlClient;
            const secondIdentity = {...fixture.identity, worktreeId: 'v'.repeat(64)};
            const secondSnapshot = {
              ...fixture.snapshot,
              id: 'claim-race-second-snapshot',
              worktreeId: secondIdentity.worktreeId,
            };
            let writerAcquisitions = 0;
            let deferredBetweenSchemaCheckAndPublication = false;
            const writerGate = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
              Effect.suspend(() => {
                writerAcquisitions += 1;
                if (writerAcquisitions !== 3) return effect;
                return deferCodeGraphQueryIndexesForColdBuild(sql, fixture.snapshot.id, firstOwnerToken).pipe(
                  Effect.tap(deferred =>
                    Effect.sync(() => {
                      deferredBetweenSchemaCheckAndPublication = deferred;
                    }),
                  ),
                  Effect.andThen(effect),
                );
              });

            yield* claimPersistentSnapshotBuild(
              secondIdentity,
              secondSnapshot,
              'claim-race-owner-token',
              {
                logicalSnapshotId: `cgsn_${'0'.repeat(40)}`,
                owner: {buildId: '11111111-1111-1111', processId: process.pid},
              },
              writerGate,
            );

            expect(writerAcquisitions).toBe(3);
            expect(deferredBetweenSchemaCheckAndPublication).toBe(true);
            expect((yield* inspectCodeGraphQueryIndexes(sql)).missing).toEqual([]);
            expect(yield* codeGraphSchemaInitializationReceiptCurrent(sql)).toBe(true);
          }),
          {writerLockPath: fixture.writerLockPath},
        );
      }).pipe(provideTestLayer(ApplicationLayer)),
    ),
  );

  effectIt.effect('keeps query indexes live when a ready snapshot is reusable', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* coldIndexFixture('ready');
        const store = yield* CodeGraphStore;
        const ready = {...fixture.snapshot, id: `${fixture.snapshot.id}-ready`, state: 'ready' as const};
        yield* store.activate(
          fixture.databasePath,
          fixture.identity,
          ready,
          [fixture.file],
          [fixture.symbol],
          [fixture.edge],
        );
        yield* store.withSession(
          fixture.databasePath,
          Effect.gen(function* () {
            const ownerToken = yield* claimPersistentBuildForTest(
              store,
              fixture.databasePath,
              fixture.identity,
              fixture.snapshot,
            );
            yield* store.prepareActivation(
              fixture.databasePath,
              [fixture.file],
              fixture.snapshot.id,
              undefined,
              ownerToken,
            );
            const sql = yield* SqlClient.SqlClient;
            expect((yield* inspectCodeGraphQueryIndexes(sql)).missing).toEqual([]);
          }),
          {writerLockPath: fixture.writerLockPath},
        );
      }).pipe(provideTestLayer(ApplicationLayer)),
    ),
  );
});

const coldIndexFixture = Effect.fn('test.coldIndexFixture')(function* (suffix: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({prefix: `threadnote-cold-index-${suffix}-`});
  const identity: RepositoryIdentity = {
    caseMode: 'sensitive',
    checkoutId: 'c'.repeat(64),
    displayName: `cold-index-${suffix}`,
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
    path: 'src/cold-index.ts',
    size: 128,
    source: 'commit',
  };
  const symbol: CodeGraphSymbol = {
    contentHash: file.contentHash,
    exported: true,
    id: `symbol-${suffix}`,
    kind: 'function',
    language: 'typescript',
    lookupKeys: [`typescript:name:coldIndex${suffix}`],
    name: `coldIndex${suffix}`,
    path: file.path,
    qualifiedName: `coldIndex${suffix}`,
    resolutionDomain: 'typescript',
    span: {column: 1, endColumn: 2, endLine: 1, line: 1},
  };
  const edge: CodeGraphEdge = {
    confidence: 1,
    evidencePath: file.path,
    evidenceSpan: symbol.span,
    id: `edge-${suffix}`,
    provenance: 'declared',
    relation: 'calls',
    sourceId: symbol.id,
    sourceName: symbol.name,
    targetId: symbol.id,
    targetName: symbol.name,
  };
  const snapshot: CodeGraphSnapshot = {
    commit: identity.headCommit,
    dirty: false,
    edgeCount: 1,
    extractorSet: 'cold-index-test',
    fileCount: 1,
    id: `cgsn_${suffix.padEnd(40, '0').slice(0, 40)}`,
    repositoryId: identity.repositoryId,
    state: 'building',
    symbolCount: 1,
    worktreeId: identity.worktreeId,
  };
  return {
    databasePath: path.join(root, 'graph.sqlite'),
    edge,
    file,
    identity,
    snapshot,
    symbol,
    writerLockPath: path.join(root, 'writer.lock'),
  };
});
