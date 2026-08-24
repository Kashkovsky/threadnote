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
    const context = {checkoutId: identity.checkoutId, repositoryRoot};
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
    expect(yield* fs.exists(sidecarPath)).toBe(false);
    const database = new Database(databasePath, {readonly: true, strict: true});
    try {
      expect(
        database
          .prepare(
            `SELECT
               (SELECT COUNT(*) FROM symbols WHERE snapshot_id = ?) AS symbols,
               (SELECT COUNT(*) FROM snapshot_symbol_lookup WHERE snapshot_id = ?) AS lookup,
               (SELECT COUNT(*) FROM building_materialization_batches WHERE snapshot_id = ?) AS receipts,
               (SELECT posting_count FROM building_lexical_counters WHERE snapshot_id = ?) AS postings`,
          )
          .get(snapshot.id, snapshot.id, snapshot.id, snapshot.id),
      ).toEqual({lookup: 2, postings: 3, receipts: 1, symbols: 1});
    } finally {
      database.close(false);
    }
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
