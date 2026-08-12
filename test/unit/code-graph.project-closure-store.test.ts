import {provideTestLayer} from '../helpers/effect-layer.js';
import {mkdtempSync, rmSync} from '../helpers/node-fs.js';
import {tmpdir} from '../helpers/node-os.js';
import {join} from '../helpers/node-path.js';
import {Database} from 'bun:sqlite';
import {describe, expect, it} from '@effect/vitest';
import {Effect} from 'effect';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import {CodeGraphStore, type CodeGraphStoreShape} from '../../src/code_graph/store.js';
import type {
  CodeGraphFileFacts,
  CodeGraphInventoryFile,
  CodeGraphSnapshot,
  CodeGraphSymbol,
  RepositoryIdentity,
} from '../../src/code_graph/types.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';

describe('project-closure persisted store', () => {
  it.effect('accepts a scoped project surface replacement while changed closure remains strict', () =>
    withStoreFixture(({databasePath, file, identity, store}) =>
      Effect.gen(function* () {
        const baseSymbol = symbol(1);
        const base = snapshot(identity, 'base', 1);
        yield* store.prepareActivation(databasePath, [file]);
        yield* store.stageActivationFacts(databasePath, [baseSymbol], []);
        yield* store.activateStaged(databasePath, identity, base, {
          fileSetFingerprint: 'same-files',
          packProvenance: [],
          workspaceFingerprint: 'same-workspace',
        });

        const replacement = symbol(2);
        const facts = fileFacts(file.path, replacement);
        const added = {...file, contentHash: 'added-hash', path: 'packages/added/index.ts'};
        expect(
          yield* store.preparePersistedIncrementalActivation(databasePath, base.id, [file, added], [facts, facts], {
            resolutionClosure: 'project',
          }),
        ).toBe(false);
        expect(
          yield* store.preparePersistedIncrementalActivation(
            databasePath,
            base.id,
            [added],
            [{...facts, path: added.path}],
            {resolutionClosure: 'project'},
          ),
        ).toBe(true);
        expect(
          yield* store.preparePersistedIncrementalActivation(
            databasePath,
            base.id,
            [{...file, mode: '100755'}],
            [facts],
            {resolutionClosure: 'project'},
          ),
        ).toBe(false);
        expect(
          yield* store.preparePersistedIncrementalActivation(databasePath, base.id, [file], [facts], {
            deletedPaths: ['packages/deleted/index.ts'],
            resolutionClosure: 'project',
          }),
        ).toBe(false);
        expect(
          yield* store.preparePersistedIncrementalActivation(databasePath, base.id, [], [], {
            deletedPaths: [file.path],
            resolutionClosure: 'project',
          }),
        ).toBe(true);
        expect(
          yield* store.preparePersistedIncrementalActivation(databasePath, base.id, [file], [facts], {
            deletedPaths: ['packages/deleted/index.ts'],
            resolutionClosure: 'full',
          }),
        ).toBe(true);
        expect(
          yield* store.preparePersistedIncrementalActivation(databasePath, base.id, [file], [facts], {
            resolutionClosure: 'changed',
          }),
        ).toBe(false);
        expect(
          yield* store.preparePersistedIncrementalActivation(databasePath, base.id, [file], [facts], {
            resolutionClosure: 'project',
          }),
        ).toBe(true);

        const ready = {...snapshot(identity, 'project', 1), baseSnapshotId: base.id};
        yield* store.resolveStagedReferences(databasePath);
        yield* store.activateStaged(databasePath, identity, ready);
        const graph = yield* store.loadGraph(databasePath, ready.id);
        expect(graph.symbols).toEqual([replacement]);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('bounds reusable exact-base reexport output without returning a partial closure', () =>
    withStoreFixture(({databasePath, file, identity, store}) =>
      Effect.gen(function* () {
        const base = snapshot(identity, 'reexports', 1);
        yield* store.prepareActivation(databasePath, [file]);
        yield* store.stageActivationFacts(databasePath, [symbol(1)], []);
        yield* store.activateStaged(databasePath, identity, base, {
          fileSetFingerprint: 'same-files',
          packProvenance: [],
          workspaceFingerprint: 'same-workspace',
        });
        yield* Effect.sync(() => insertReexports(databasePath, base.id, 10_001));

        expect(
          yield* store.reusableReexports(databasePath, base.id, [{name: 'foo', path: 'packages/barrel/index.ts'}], {
            maxRows: 10_000,
          }),
        ).toHaveLength(10_001);
        expect(
          yield* store.reusableReexports(databasePath, base.id, [{name: 'foo', path: 'packages/barrel/index.ts'}], {
            maxRows: 10_001,
          }),
        ).toHaveLength(10_001);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('does not hide later batched provenance behind overlapping prefix rows', () =>
    withStoreFixture(({databasePath, file, identity, store}) =>
      Effect.gen(function* () {
        const base = snapshot(identity, 'overlap', 1);
        yield* store.prepareActivation(databasePath, [file]);
        yield* store.stageActivationFacts(databasePath, [symbol(1)], []);
        yield* store.activateStaged(databasePath, identity, base, {
          fileSetFingerprint: 'same-files',
          packProvenance: [],
          workspaceFingerprint: 'same-workspace',
        });
        yield* Effect.sync(() => insertOverlappingReexports(databasePath, base.id));
        const seeds = [
          {name: 'foo', path: 'a'},
          ...Array.from({length: 199}, (_, index) => ({name: `missing-${index}`, path: 'missing'})),
          {name: 'foo', path: 'z'},
        ];

        expect(yield* store.reusableReexports(databasePath, base.id, seeds, {maxRows: 2})).toHaveLength(3);
        expect(yield* store.reusableReexports(databasePath, base.id, seeds, {maxRows: 3})).toEqual([
          {importedName: 'shared', localName: 'foo', sourcePath: 'a', targetPath: 'm'},
          {importedName: 'value', localName: 'shared', sourcePath: 'm', targetPath: 'q'},
          {importedName: 'shared', localName: 'foo', sourcePath: 'z', targetPath: 'm'},
        ]);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('rejects unknown persisted resolution closure tags at preparation and activation', () =>
    withStoreFixture(({databasePath, file, identity, sql, store}) =>
      Effect.gen(function* () {
        const base = snapshot(identity, 'closure-base', 1);
        yield* store.prepareActivation(databasePath, [file]);
        yield* store.stageActivationFacts(databasePath, [symbol(1)], []);
        yield* store.activateStaged(databasePath, identity, base, {
          fileSetFingerprint: 'same-files',
          packProvenance: [],
          workspaceFingerprint: 'same-workspace',
        });
        const facts = fileFacts(file.path, symbol(2));
        expect(
          yield* store.preparePersistedIncrementalActivation(databasePath, base.id, [file], [facts], {
            resolutionClosure: 'unknown' as 'project',
          }),
        ).toBe(false);
        expect(
          yield* store.preparePersistedIncrementalActivation(databasePath, base.id, [file], [facts], {
            resolutionClosure: 'project',
          }),
        ).toBe(true);
        yield* store.resolveStagedReferences(databasePath);
        yield* sql`UPDATE activation_state SET value = 'unknown' WHERE key = 'resolution_closure'`;
        const ready = {...snapshot(identity, 'closure-invalid', 1), baseSnapshotId: base.id};
        const activation = yield* Effect.exit(store.activateStaged(databasePath, identity, ready));

        expect(activation._tag).toBe('Failure');
        expect(
          yield* store.preparePersistedIncrementalActivation(databasePath, base.id, [file], [facts], {
            resolutionClosure: 'project',
          }),
        ).toBe(true);
        yield* sql`UPDATE activation_files SET mode = '100755' WHERE path = ${file.path}`;
        yield* store.resolveStagedReferences(databasePath);
        const mismatchedReady = {...snapshot(identity, 'closure-mode-invalid', 1), baseSnapshotId: base.id};
        expect((yield* Effect.exit(store.activateStaged(databasePath, identity, mismatchedReady)))._tag).toBe(
          'Failure',
        );
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('reports raw cache bytes and rejects a payload whose path disagrees with its tuple', () =>
    withStoreFixture(({databasePath, file, store}) =>
      Effect.gen(function* () {
        yield* store.initialize(databasePath);
        const mismatched = JSON.stringify(fileFacts('packages/other/index.ts', symbol(1)));
        yield* Effect.sync(() => insertCachedFact(databasePath, file, 'extractor', mismatched));
        const decoded = yield* store.loadCachedFacts(databasePath, [file], 'extractor');
        expect(decoded.facts.size).toBe(0);

        const oversized = ' '.repeat(8 * 1_048_576 + 1);
        yield* Effect.sync(() => insertCachedFact(databasePath, file, 'extractor', oversized));
        const metadata = yield* store.loadCachedFacts(databasePath, [file], 'extractor', {decode: false});
        expect(metadata.bytes).toBe(oversized.length);
        expect(metadata.bytesByPath?.get(file.path)).toBe(oversized.length);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );
});

function withStoreFixture<A, E>(
  use: (fixture: {
    readonly databasePath: string;
    readonly file: CodeGraphInventoryFile;
    readonly identity: RepositoryIdentity;
    readonly sql: SqlClient.SqlClient;
    readonly store: CodeGraphStoreShape;
  }) => Effect.Effect<A, E>,
) {
  return Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), 'threadnote-project-closure-store-'))),
    root =>
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        const databasePath = join(root, 'graph-v3.sqlite');
        const identity = repositoryIdentity(root);
        const file = inventoryFile();
        return yield* store.withSession(
          databasePath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return yield* use({databasePath, file, identity, sql, store});
          }),
        );
      }),
    root => Effect.sync(() => rmSync(root, {force: true, recursive: true})),
  );
}

function repositoryIdentity(root: string): RepositoryIdentity {
  return {
    caseMode: 'sensitive',
    checkoutId: 'c'.repeat(64),
    displayName: 'project-closure-store',
    gitCommonDirectory: root,
    headCommit: '1'.repeat(40),
    objectFormat: 'sha1',
    repoRoot: root,
    repositoryId: 'r'.repeat(64),
    worktreeId: 'w'.repeat(64),
  };
}

function inventoryFile(): CodeGraphInventoryFile {
  return {
    blobId: 'blob',
    contentHash: 'hash',
    language: 'typescript',
    mode: '100644',
    path: 'packages/barrel/index.ts',
    size: 1,
    source: 'commit',
  };
}

function symbol(arity: number): CodeGraphSymbol {
  return {
    arity,
    contentHash: `hash-${arity}`,
    exported: true,
    id: 'symbol',
    kind: 'function',
    language: 'typescript',
    lookupKeys: [`typescript:project:path:packages%2Fbarrel%2Findex.ts:name:foo:arity:${arity}`],
    name: 'foo',
    packageName: 'barrel',
    path: 'packages/barrel/index.ts',
    qualifiedName: 'foo',
    resolutionDomain: 'typescript',
    resolutionScopeId: 'project',
    span: {column: 1, endColumn: 2, endLine: 1, line: 1},
  };
}

function fileFacts(path: string, value: CodeGraphSymbol): CodeGraphFileFacts {
  return {diagnostics: [], edges: [], path, references: [], symbols: [value]};
}

function snapshot(identity: RepositoryIdentity, suffix: string, symbolCount: number): CodeGraphSnapshot {
  return {
    commit: identity.headCommit,
    dirty: !['base', 'closure-base', 'overlap', 'reexports'].includes(suffix),
    edgeCount: 0,
    extractorSet: 'extractor',
    fileCount: 1,
    id: `snapshot-${suffix}`,
    repositoryId: identity.repositoryId,
    state: 'ready',
    symbolCount,
    worktreeId: identity.worktreeId,
  };
}

function insertReexports(databasePath: string, snapshotId: string, count: number): void {
  const database = new Database(databasePath);
  try {
    const insert = database.prepare(
      `INSERT INTO snapshot_reexport_provenance (
        snapshot_id, source_path, local_name, target_path, imported_name
      ) VALUES (?, ?, ?, ?, ?)`,
    );
    database.transaction(() => {
      for (let index = 0; index < count; index += 1) {
        insert.run(
          snapshotId,
          'packages/barrel/index.ts',
          'foo',
          `packages/target-${String(index).padStart(5, '0')}.ts`,
          `target${index}`,
        );
      }
    })();
  } finally {
    database.close(false);
  }
}

function insertOverlappingReexports(databasePath: string, snapshotId: string): void {
  const database = new Database(databasePath);
  try {
    const insert = database.prepare(
      `INSERT INTO snapshot_reexport_provenance (
        snapshot_id, source_path, local_name, target_path, imported_name
      ) VALUES (?, ?, ?, ?, ?)`,
    );
    database.transaction(() => {
      insert.run(snapshotId, 'a', 'foo', 'm', 'shared');
      insert.run(snapshotId, 'm', 'shared', 'q', 'value');
      insert.run(snapshotId, 'z', 'foo', 'm', 'shared');
    })();
  } finally {
    database.close(false);
  }
}

function insertCachedFact(
  databasePath: string,
  file: CodeGraphInventoryFile,
  extractorSet: string,
  factsJson: string,
): void {
  const database = new Database(databasePath);
  try {
    database.run(
      `INSERT INTO file_blobs (content_hash, extractor_set, path_hint, facts_json, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(content_hash, extractor_set, path_hint) DO UPDATE SET facts_json = excluded.facts_json`,
      [file.contentHash, extractorSet, file.path, factsJson, new Date().toISOString()],
    );
  } finally {
    database.close(false);
  }
}
