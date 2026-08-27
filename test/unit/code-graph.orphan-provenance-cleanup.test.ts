import {provideTestLayer} from '../helpers/effect-layer.js';
import {execFileSync} from '../helpers/node-child-process.js';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from '../helpers/node-fs.js';
import {tmpdir} from '../helpers/node-os.js';
import {join} from '../helpers/node-path.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Database} from 'bun:sqlite';
import {Effect, Layer, Path, Ref} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {afterEach, describe, expect} from 'vitest';
import type {CodeGraphWorktreeReconciliationAuthorityObservation} from '../../src/code_graph/git_worktree_registration.js';
import {
  recordVerifiedCodeGraphLocalAssociation,
  type CodeGraphWorktreeReconciliationEvidenceCandidate,
} from '../../src/code_graph/local_provenance.js';
import {codeGraphLayout} from '../../src/code_graph/layout.js';
import {CodeGraphMaintenanceCoordinator} from '../../src/code_graph/maintenance_coordinator.js';
import {
  CODE_GRAPH_ORPHAN_PROVENANCE_CANDIDATE_LIMIT,
  makeCodeGraphOrphanProvenanceCleaner,
  type CodeGraphOrphanProvenanceCleanupDependencies,
} from '../../src/code_graph/orphan_provenance_cleanup.js';
import {resolveRepositoryIdentity} from '../../src/code_graph/repository.js';
import {CodeGraphStore} from '../../src/code_graph/store.js';
import {CODE_GRAPH_EXTRACTOR_GENERATION, type RepositoryIdentity} from '../../src/code_graph/types.js';
import {CommandExecutor} from '../../src/effect/command.js';
import {SystemInfo} from '../../src/effect/system.js';

const checkoutId = 'a'.repeat(64);
const repositoryId = 'b'.repeat(64);
const anchorWorktreeId = 'c'.repeat(64);
const targetWorktreeId = 'd'.repeat(64);
const registryRootIdentity = 'e'.repeat(64);
const privateRoot = '/private/threadnote/orphan-provenance-test';
const temporaryRoots: string[] = [];
const storeLayer = CodeGraphStore.layer.pipe(
  Layer.provideMerge(SystemInfo.layer),
  Layer.provideMerge(BunServices.layer),
);
const maintenanceLayer = CodeGraphMaintenanceCoordinator.layer.pipe(
  Layer.provideMerge(Layer.merge(CodeGraphStore.layer, CommandExecutor.layer)),
  Layer.provideMerge(SystemInfo.layer),
  Layer.provideMerge(BunServices.layer),
);

const anchor: RepositoryIdentity = {
  caseMode: 'sensitive',
  checkoutId,
  displayName: 'threadnote/orphan-provenance-test',
  gitCommonDirectory: `${privateRoot}/.git`,
  headCommit: '1'.repeat(40),
  objectFormat: 'sha1',
  repositoryId,
  repoRoot: privateRoot,
  worktreeId: anchorWorktreeId,
};

const linkedEvidence: Extract<CodeGraphWorktreeReconciliationEvidenceCandidate, {readonly state: 'candidate'}> = {
  canonicalWorktreePath: `${privateRoot}/removed-linked-worktree`,
  checkoutId,
  evidenceToken: '2'.repeat(64),
  recordDigest: '3'.repeat(64),
  recordIdentity: '4'.repeat(64),
  registration: {adminNameKeys: ['5'.repeat(64)], kind: 'linked'},
  repositoryId,
  state: 'candidate',
  worktreeId: targetWorktreeId,
};

afterEach(() => {
  for (const root of temporaryRoots.splice(0).reverse()) rmSync(root, {force: true, recursive: true});
});

describe('automatic orphan provenance cleanup', () => {
  effectIt.effect.prop(
    'removes only when every generated authority predicate remains exact and no active view exists',
    {
      activeView: fc.boolean(),
      anchorStable: fc.boolean(),
      evidenceStable: fc.boolean(),
      finalAbsent: fc.boolean(),
      initialAbsent: fc.boolean(),
      maintenanceInactive: fc.boolean(),
      missingPath: fc.boolean(),
      registryRootStable: fc.boolean(),
    },
    predicates =>
      Effect.gen(function* () {
        const cleanups = yield* Ref.make(0);
        let authorityReads = 0;
        let evidenceReads = 0;
        let anchorReads = 0;
        const dependencies = successfulDependencies({
          cleanupProvenance: () => Ref.update(cleanups, count => count + 1).pipe(Effect.as({state: 'removed'})),
          maintenanceIntentActive: () => Effect.succeed(!predicates.maintenanceInactive),
          observeAuthority: () =>
            Effect.sync(() => {
              authorityReads += 1;
              const initial = authorityReads === 1;
              return completeAuthority({
                missing: predicates.missingPath,
                registryAbsent: initial ? predicates.initialAbsent : predicates.finalAbsent,
                registryRootIdentity:
                  !initial && !predicates.registryRootStable ? 'f'.repeat(64) : registryRootIdentity,
              });
            }),
          observeView: () =>
            Effect.succeed(
              predicates.activeView
                ? ({snapshotId: `cgsn_${'6'.repeat(40)}`, state: 'active'} as const)
                : ({state: 'absent'} as const),
            ),
          readEvidenceCandidate: () =>
            Effect.sync(() => {
              evidenceReads += 1;
              return evidenceReads > 1 && !predicates.evidenceStable
                ? {...linkedEvidence, recordDigest: '7'.repeat(64)}
                : linkedEvidence;
            }),
          resolveAnchor: () =>
            Effect.sync(() => {
              anchorReads += 1;
              return anchorReads > 1 && !predicates.anchorStable ? {...anchor, repositoryId: '8'.repeat(64)} : anchor;
            }),
        });

        const result = yield* (yield* makeCodeGraphOrphanProvenanceCleaner(dependencies)).tick(tick());
        const expectedRemoval =
          !predicates.activeView &&
          predicates.anchorStable &&
          predicates.evidenceStable &&
          predicates.finalAbsent &&
          predicates.initialAbsent &&
          predicates.maintenanceInactive &&
          predicates.missingPath &&
          predicates.registryRootStable;

        expect(result.state === 'removed').toBe(expectedRemoval);
        expect(yield* Ref.get(cleanups)).toBe(expectedRemoval ? 1 : 0);
      }),
  );

  effectIt.effect('keeps a durable bounded cursor and excludes an active view from sidecar candidates', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const root = mkdtempSync(join(tmpdir(), 'threadnote-orphan-provenance-cursor-'));
        temporaryRoots.push(root);
        const databasePath = join(root, 'indexes', 'code-graph', 'repositories', checkoutId, 'graph-v3.sqlite');
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        const worktreeIds = Array.from({length: 70}, (_, index) => index.toString(16).padStart(64, '0'));
        yield* Effect.sync(() => seedActiveView(databasePath, worktreeIds.at(-1)!));

        const pages = yield* Effect.all(
          Array.from({length: 3}, () =>
            store.claimOrphanProvenanceCandidates(
              databasePath,
              worktreeIds,
              CODE_GRAPH_ORPHAN_PROVENANCE_CANDIDATE_LIMIT,
              {waitTimeoutMilliseconds: 5_000},
            ),
          ),
          {concurrency: 1},
        );
        const claimed = new Set(pages.flatMap(page => page.worktreeIds));
        expect(pages.map(page => page.worktreeIds.length)).toEqual([32, 32, 32]);
        expect(claimed.size).toBe(69);
        expect(claimed.has(worktreeIds.at(-1)!)).toBe(false);
        expect(yield* store.observeOrphanProvenanceView(databasePath, worktreeIds.at(-1)!)).toMatchObject({
          state: 'active',
        });
        expect(yield* store.observeOrphanProvenanceView(databasePath, worktreeIds[0]!)).toEqual({state: 'absent'});

        const malformed = yield* Effect.sync(() => corruptOrphanCursor(databasePath)).pipe(
          Effect.andThen(store.claimOrphanProvenanceCandidates(databasePath, worktreeIds, 1).pipe(Effect.exit)),
        );
        expect(malformed._tag).toBe('Failure');
      }).pipe(provideTestLayer(storeLayer)),
    ),
  );

  effectIt.effect('removes a real deleted linked-worktree sidecar through routine maintenance', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fixture = yield* createLiveOrphanFixture;
        const maintenance = yield* CodeGraphMaintenanceCoordinator;
        expect(readGraphRowCounts(fixture.databasePath)).toEqual({
          activeSnapshots: 0,
          cleanupRows: 0,
          snapshots: 0,
        });

        yield* Effect.sync(() =>
          execFileSync('git', ['-C', fixture.main, 'worktree', 'remove', fixture.linked], {encoding: 'utf8'}),
        );
        const input = {
          anchorIdentity: fixture.mainIdentity,
          automaticTail: false as const,
          checkoutId: fixture.mainIdentity.checkoutId,
          databasePath: fixture.databasePath,
          threadnoteHome: fixture.home,
          writerLockPath: fixture.layout.databaseWriteLockPath,
        };
        const results = yield* Effect.forEach(Array.from({length: 3}), () => maintenance.tick(input), {
          concurrency: 1,
        });

        expect(results).toContainEqual({
          cleanup: 'orphan-provenance',
          expiredLeases: 0,
          remaining: true,
          retiredSnapshots: 0,
          rowsDeleted: 0,
          state: 'completed',
        });
        expect(existsSync(fixture.sidecar)).toBe(false);
        expect(readFileSync(fixture.mainFile, 'utf8')).toBe('main source\n');
        expect(readGraphRowCounts(fixture.databasePath)).toEqual({
          activeSnapshots: 0,
          cleanupRows: 0,
          snapshots: 0,
        });
        expect(JSON.stringify(results)).not.toContain(fixture.root);
      }).pipe(provideTestLayer(maintenanceLayer)),
    ),
  );
});

function successfulDependencies(
  overrides: Partial<CodeGraphOrphanProvenanceCleanupDependencies> = {},
): CodeGraphOrphanProvenanceCleanupDependencies {
  return {
    claimCandidates: () => Effect.succeed({worktreeIds: [targetWorktreeId]}),
    cleanupProvenance: () => Effect.succeed({state: 'removed'}),
    inspectInventory: () => Effect.succeed({state: 'ready', worktreeIds: [targetWorktreeId]}),
    maintenanceIntentActive: () => Effect.succeed(false),
    observeAuthority: () => Effect.succeed(completeAuthority()),
    observeView: () => Effect.succeed({state: 'absent'}),
    readEvidenceCandidate: () => Effect.succeed(linkedEvidence),
    resolveAnchor: () => Effect.succeed(anchor),
    withTargetLock: (_input, _worktreeId, effect) => effect,
    ...overrides,
  };
}

function completeAuthority(
  options: {readonly missing?: boolean; readonly registryAbsent?: boolean; readonly registryRootIdentity?: string} = {},
): Extract<CodeGraphWorktreeReconciliationAuthorityObservation, {readonly state: 'complete'}> {
  return {
    contentDigest: '9'.repeat(64),
    entryCount: 0,
    pathStates: [options.missing === false ? 'present' : 'missing'],
    registryRootIdentity: options.registryRootIdentity ?? registryRootIdentity,
    registryRootKind: 'directory',
    registryStates: [options.registryAbsent === false ? 'present' : 'absent'],
    state: 'complete',
  };
}

function tick() {
  return {
    anchorIdentity: anchor,
    checkoutId,
    databasePath: '/derived/graph-v3.sqlite',
    threadnoteHome: '/derived/threadnote-home',
    writerLockPath: '/derived/database-writer.lock',
  } as const;
}

function seedActiveView(databasePath: string, worktreeId: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    const snapshotId = `cgsn_${'a'.repeat(40)}`;
    database
      .query(
        `INSERT INTO repositories (id, display_name, object_format, created_at, last_used_at)
         VALUES (?, 'threadnote/orphan-provenance-cursor', 'sha1', ?, ?)`,
      )
      .run(repositoryId, new Date(0).toISOString(), new Date(0).toISOString());
    database
      .query(
        `INSERT INTO snapshots (
           id, repository_id, worktree_id, commit_id, graph_content_id, base_snapshot_id, extractor_set,
           dirty, overlay_fingerprint, state, file_count, symbol_count, edge_count, started_at, completed_at,
           failure_summary
         ) VALUES (?, ?, ?, ?, 'orphan-provenance-content', NULL, 'orphan-provenance-test',
                   0, NULL, 'ready', 0, 0, 0, ?, ?, NULL)`,
      )
      .run(snapshotId, repositoryId, worktreeId, 'b'.repeat(40), new Date(0).toISOString(), new Date(1).toISOString());
    database
      .query('INSERT INTO snapshot_extractor_generations (snapshot_id, generation) VALUES (?, ?)')
      .run(snapshotId, CODE_GRAPH_EXTRACTOR_GENERATION);
    database
      .query('INSERT INTO active_snapshots (worktree_id, snapshot_id, activated_at) VALUES (?, ?, ?)')
      .run(worktreeId, snapshotId, new Date(2).toISOString());
  } finally {
    database.close(false);
  }
}

function corruptOrphanCursor(databasePath: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database.query("UPDATE schema_metadata SET value = 'malformed' WHERE key = 'orphan_provenance_cursor'").run();
  } finally {
    database.close(false);
  }
}

const createLiveOrphanFixture = Effect.gen(function* () {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'threadnote-orphan-provenance-live-')));
  temporaryRoots.push(root);
  const main = join(root, 'main');
  const linked = join(root, 'linked');
  const home = join(root, 'threadnote-home');
  const mainFile = join(main, 'main.txt');
  yield* Effect.sync(() => {
    mkdirSync(main, {recursive: true});
    execFileSync('git', ['init', '--initial-branch=main', main], {encoding: 'utf8'});
    execFileSync('git', ['-C', main, 'config', 'user.email', 'threadnote@example.invalid'], {encoding: 'utf8'});
    execFileSync('git', ['-C', main, 'config', 'user.name', 'Threadnote Test'], {encoding: 'utf8'});
    writeFileSync(mainFile, 'main source\n');
    execFileSync('git', ['-C', main, 'add', 'main.txt'], {encoding: 'utf8'});
    execFileSync('git', ['-C', main, 'commit', '-m', 'initial'], {encoding: 'utf8'});
    execFileSync('git', ['-C', main, 'worktree', 'add', '-b', 'linked-test', linked], {encoding: 'utf8'});
  });
  const mainIdentity = yield* resolveRepositoryIdentity(main);
  const linkedIdentity = yield* resolveRepositoryIdentity(linked);
  const association = yield* recordVerifiedCodeGraphLocalAssociation(home, linkedIdentity);
  expect(association.state).toBe('verified');
  const path = yield* Path.Path;
  const layout = codeGraphLayout(path, home, mainIdentity.checkoutId, mainIdentity.worktreeId);
  const store = yield* CodeGraphStore;
  yield* store.initialize(layout.databasePath);
  const sidecar = join(
    home,
    'indexes',
    'code-graph',
    'repositories',
    mainIdentity.checkoutId,
    'local-context',
    'worktrees',
    `${linkedIdentity.worktreeId}.json`,
  );
  expect(existsSync(sidecar)).toBe(true);
  return {
    databasePath: layout.databasePath,
    home,
    layout,
    linked,
    linkedIdentity,
    main,
    mainFile,
    mainIdentity,
    root,
    sidecar,
  };
});

function readGraphRowCounts(databasePath: string) {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return {
      activeSnapshots: Number(
        (database.query('SELECT COUNT(*) AS count FROM active_snapshots').get() as {count: number}).count,
      ),
      cleanupRows: Number(
        (database.query('SELECT COUNT(*) AS count FROM removed_view_cleanup').get() as {count: number}).count,
      ),
      snapshots: Number((database.query('SELECT COUNT(*) AS count FROM snapshots').get() as {count: number}).count),
    };
  } finally {
    database.close(false);
  }
}
