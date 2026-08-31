import {Database} from 'bun:sqlite';
import {expect, it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {CodeGraphStore} from '../../src/code_graph/store.js';
import type {
  CodeGraphInventoryFile,
  CodeGraphSnapshot,
  CodeGraphSymbol,
  RepositoryIdentity,
} from '../../src/code_graph/types.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {claimPersistentBuildForTest} from '../helpers/code-graph-build.js';
import {materializationStorageFiles} from '../../src/code_graph/indexer_materialization.js';
import {codeGraphSqliteGet} from '../../src/code_graph/sqlite_statement.js';

effectIt.effect('materializes a full build through the sorted sidecar and removes it after finalization', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-materialization-spool-lifecycle-'});
    const identity = repositoryIdentity(root);
    const repositoryRoot = path.join(root, identity.checkoutId);
    yield* fs.makeDirectory(repositoryRoot, {recursive: true});
    const databasePath = path.join(repositoryRoot, 'graph-v3.sqlite');
    const file: CodeGraphInventoryFile = {
      blobId: '1'.repeat(40),
      contentHash: '2'.repeat(64),
      language: 'typescript',
      mode: '100644',
      path: 'src/main.ts',
      size: 128,
      source: 'commit',
    };
    const snapshot: CodeGraphSnapshot = {
      commit: identity.headCommit,
      dirty: false,
      edgeCount: 0,
      extractorSet: 'materialization-spool-test',
      fileCount: 1,
      graphContentId: `cgc_${'3'.repeat(40)}`,
      id: `cgsn_${'0'.repeat(40)}-direct`,
      repositoryId: identity.repositoryId,
      state: 'building',
      symbolCount: 0,
      worktreeId: identity.worktreeId,
    };
    const symbol: CodeGraphSymbol = {
      contentHash: file.contentHash,
      exported: true,
      id: 'symbol-main',
      kind: 'function',
      language: 'typescript',
      lookupKeys: ['typescript:name:main', 'generic:main'],
      name: 'main',
      path: file.path,
      qualifiedName: 'main',
      span: {column: 1, endColumn: 5, endLine: 1, line: 1},
    };
    let databaseJournalHighWaterBytes = 0;
    let databaseWalHighWaterBytes = 0;
    let sidecarDatabaseHighWaterBytes = 0;
    let sidecarJournalHighWaterBytes = 0;
    let sidecarWalHighWaterBytes = 0;
    const context = {
      checkoutId: identity.checkoutId,
      onStorageObservation: (observation: {
        readonly journalBytes: number;
        readonly sidecarDatabaseBytes: number;
        readonly sidecarJournalBytes: number;
        readonly sidecarWalBytes: number;
        readonly walBytes: number;
      }) => {
        databaseJournalHighWaterBytes = Math.max(databaseJournalHighWaterBytes, observation.journalBytes);
        databaseWalHighWaterBytes = Math.max(databaseWalHighWaterBytes, observation.walBytes);
        sidecarDatabaseHighWaterBytes = Math.max(sidecarDatabaseHighWaterBytes, observation.sidecarDatabaseBytes);
        sidecarJournalHighWaterBytes = Math.max(sidecarJournalHighWaterBytes, observation.sidecarJournalBytes);
        sidecarWalHighWaterBytes = Math.max(sidecarWalHighWaterBytes, observation.sidecarWalBytes);
      },
      repositoryRoot,
    };
    const store = yield* CodeGraphStore;
    yield* store.withSession(
      databasePath,
      Effect.gen(function* () {
        const ownerToken = yield* claimPersistentBuildForTest(store, databasePath, identity, snapshot);
        yield* store.prepareActivation(databasePath, [file], snapshot.id, undefined, ownerToken);
        const batch = {
          batchIndex: 0,
          edges: [],
          finalFactBytes: 100,
          references: [],
          sourceBytes: file.size,
          symbols: [symbol],
        } as const;
        yield* store.stageActivationFactBatches(databasePath, [batch], undefined, undefined, context);
        yield* store.stageActivationFactBatches(databasePath, [batch], undefined, undefined, context);
        yield* store.finalizePersistentMaterializationPlan(databasePath, 1, undefined, undefined, context);
        expect(yield* store.stagedFactCounts(databasePath)).toEqual({edges: 0, symbols: 1});
      }),
    );
    const sidecarPath = path.join(repositoryRoot, `materialization-spool-v1-${snapshot.id}.sqlite`);
    for (const candidate of [sidecarPath, `${sidecarPath}-journal`, `${sidecarPath}-shm`, `${sidecarPath}-wal`]) {
      expect(yield* fs.exists(candidate)).toBe(false);
    }
    expect(Math.max(databaseJournalHighWaterBytes, databaseWalHighWaterBytes)).toBeGreaterThan(0);
    expect(sidecarDatabaseHighWaterBytes).toBeGreaterThan(0);
    expect(sidecarJournalHighWaterBytes).toBeGreaterThan(0);
    expect(sidecarWalHighWaterBytes).toBe(0);
    const database = new Database(databasePath, {readonly: true, strict: true});
    try {
      expect(
        codeGraphSqliteGet<{
          readonly lookup: number;
          readonly postings: number;
          readonly receipts: number;
          readonly symbols: number;
        }>(
          database,
          `SELECT
             (SELECT COUNT(*) FROM symbols WHERE snapshot_id = ?) AS symbols,
             (SELECT COUNT(*) FROM snapshot_symbol_lookup WHERE snapshot_id = ?) AS lookup,
             (SELECT COUNT(*) FROM building_materialization_batches WHERE snapshot_id = ?) AS receipts,
             (SELECT posting_count FROM building_lexical_counters WHERE snapshot_id = ?) AS postings`,
          snapshot.id,
          snapshot.id,
          snapshot.id,
          snapshot.id,
        ),
      ).toEqual({lookup: 2, postings: 3, receipts: 1, symbols: 1});
    } finally {
      database.close(true);
    }
  }).pipe(provideTestLayer(ApplicationLayer)),
);

effectIt.effect('accounts for the sidecar and every journal family in durable high-water samples', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-materialization-spool-storage-'});
    const databasePath = path.join(root, 'graph.sqlite');
    const sidecarPath = path.join(root, 'spool.sqlite');
    for (const [file, size] of [
      [databasePath, 10],
      [`${databasePath}-journal`, 2],
      [`${databasePath}-shm`, 3],
      [`${databasePath}-wal`, 4],
      [sidecarPath, 20],
      [`${sidecarPath}-journal`, 5],
      [`${sidecarPath}-shm`, 6],
      [`${sidecarPath}-wal`, 7],
    ] as const) {
      yield* fs.writeFile(file, new Uint8Array(size));
    }
    expect(yield* materializationStorageFiles(fs, databasePath, [sidecarPath])).toEqual({
      databaseBytes: 10,
      journalBytes: 2,
      sharedMemoryBytes: 3,
      sidecarDatabaseBytes: 20,
      sidecarJournalBytes: 5,
      sidecarSharedMemoryBytes: 6,
      sidecarWalBytes: 7,
      totalBytes: 57,
      walBytes: 4,
    });
  }).pipe(provideTestLayer(ApplicationLayer)),
);

function repositoryIdentity(root: string): RepositoryIdentity {
  return {
    caseMode: 'sensitive',
    checkoutId: 'c'.repeat(64),
    displayName: 'materialization-spool-fixture',
    gitCommonDirectory: root,
    headCommit: '4'.repeat(40),
    objectFormat: 'sha1',
    repoRoot: root,
    repositoryId: 'a'.repeat(64),
    worktreeId: 'd'.repeat(64),
  };
}
