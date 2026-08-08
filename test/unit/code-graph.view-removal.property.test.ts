import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database} from 'bun:sqlite';
import {Effect} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {CodeGraphStore, type CodeGraphViewRemovalResult} from '../../src/code_graph/store.js';
import {CODE_GRAPH_EXTRACTOR_GENERATION} from '../../src/code_graph/types.js';
import type {RepositoryIdentity} from '../../src/code_graph/types.js';
import {runEffect} from '../helpers/effect-runtime.js';

const WORKTREE_IDS = ['1', '2', '3'].map(digit => digit.repeat(64));
const SNAPSHOT_IDS = ['snapshot-model-0', 'snapshot-model-1', 'snapshot-model-2'];
const MISSING_SNAPSHOT_ID = 'snapshot-model-missing';

const eventArbitrary = fc.record({
  kind: fc.constantFrom<'legacy-promote' | 'promote' | 'remove'>('legacy-promote', 'promote', 'remove'),
  snapshot: fc.integer({max: SNAPSHOT_IDS.length, min: 0}),
  worktree: fc.integer({max: WORKTREE_IDS.length - 1, min: 0}),
});

describe('code graph view removal state-machine properties', () => {
  it('matches the pointer/tombstone model and never mutates unrelated shared views', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(eventArbitrary, {maxLength: 20}), async events => {
        const root = mkdtempSync(join(tmpdir(), 'threadnote-view-removal-property-'));
        const checkoutId = 'a'.repeat(64);
        const repositoryId = 'b'.repeat(64);
        const databasePath = join(root, 'indexes', 'code-graph', 'repositories', checkoutId, 'graph-v3.sqlite');
        const pointers = new Map(WORKTREE_IDS.map((worktreeId, index) => [worktreeId, SNAPSHOT_IDS[index]!]));
        const tombstones = new Map<string, string>();
        try {
          await runEffect(
            Effect.gen(function* () {
              const store = yield* CodeGraphStore;
              yield* store.initialize(databasePath);
              yield* Effect.sync(() => seedModel(databasePath, repositoryId));
              yield* Effect.forEach(
                SNAPSHOT_IDS,
                snapshotId => store.acquireSnapshotLease(databasePath, snapshotId, 60 * 60_000),
                {concurrency: 1},
              );

              for (const event of events) {
                const worktreeId = WORKTREE_IDS[event.worktree]!;
                const snapshotId = SNAPSHOT_IDS[event.snapshot] ?? MISSING_SNAPSHOT_ID;
                if (event.kind === 'promote' && snapshotId !== MISSING_SNAPSHOT_ID) {
                  yield* store.promote(databasePath, identity(root, checkoutId, repositoryId, worktreeId), snapshotId);
                  pointers.set(worktreeId, snapshotId);
                  tombstones.delete(worktreeId);
                } else if (event.kind === 'legacy-promote' && snapshotId !== MISSING_SNAPSHOT_ID) {
                  yield* Effect.sync(() => legacyPromote(databasePath, worktreeId, snapshotId));
                  pointers.set(worktreeId, snapshotId);
                } else {
                  const expected = modelRemove(pointers, tombstones, worktreeId, snapshotId);
                  const actual = yield* store.removeView(databasePath, worktreeId, snapshotId);
                  expect(actual).toEqual(expected);
                }

                const databaseState = yield* Effect.sync(() => readModel(databasePath));
                expect(databaseState.pointers).toEqual(sortedEntries(pointers));
                expect(databaseState.tombstones).toEqual(sortedEntries(tombstones));
                expect(databaseState.readySnapshots).toEqual(SNAPSHOT_IDS);

                const expectedVisible = [...pointers]
                  .filter(([worktreeId, snapshotId]) => tombstones.get(worktreeId) !== snapshotId)
                  .sort(([left], [right]) => left.localeCompare(right));
                const catalogs = yield* store.loadVisualizationCatalogs(databasePath, 'deferred', {viewLimit: 64});
                expect(
                  catalogs
                    .map(catalog => [catalog.viewWorktreeId, catalog.snapshot.id] as const)
                    .sort(([left], [right]) => left.localeCompare(right)),
                ).toEqual(expectedVisible);
                for (const worktree of WORKTREE_IDS) {
                  const pointer = pointers.get(worktree);
                  const expectedReady =
                    pointer !== undefined && tombstones.get(worktree) !== pointer ? pointer : undefined;
                  expect((yield* store.readySnapshot(databasePath, worktree))?.id).toBe(expectedReady);
                }
              }
            }),
          );
        } finally {
          rmSync(root, {force: true, recursive: true});
        }
      }),
      {numRuns: 40},
    );
  });
});

function modelRemove(
  pointers: Map<string, string>,
  tombstones: Map<string, string>,
  worktreeId: string,
  expectedSnapshotId: string,
): CodeGraphViewRemovalResult {
  const activeSnapshotId = pointers.get(worktreeId);
  const removedSnapshotId = tombstones.get(worktreeId);
  if (activeSnapshotId !== undefined && activeSnapshotId !== expectedSnapshotId) {
    return {
      expectedSnapshotId,
      observedSnapshotId: activeSnapshotId,
      observedState: 'active',
      state: 'stale-target',
    };
  }
  if (activeSnapshotId === undefined) {
    if (removedSnapshotId === expectedSnapshotId) {
      return {expectedSnapshotId, retiredSnapshots: 0, state: 'already-removed'};
    }
    if (removedSnapshotId !== undefined) {
      return {
        expectedSnapshotId,
        observedSnapshotId: removedSnapshotId,
        observedState: 'removed',
        state: 'stale-target',
      };
    }
    return {expectedSnapshotId, state: 'not-found'};
  }
  pointers.delete(worktreeId);
  tombstones.set(worktreeId, expectedSnapshotId);
  return {
    expectedSnapshotId,
    retiredSnapshots: 0,
    state: removedSnapshotId === expectedSnapshotId ? 'already-removed' : 'removed',
  };
}

function seedModel(databasePath: string, repositoryId: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database.run(
      `INSERT INTO repositories (id, display_name, object_format, created_at, last_used_at)
       VALUES (?, 'threadnote/view-removal-property', 'sha1', ?, ?)`,
      [repositoryId, new Date(0).toISOString(), new Date(0).toISOString()],
    );
    const insertSnapshot = database.prepare(
      `INSERT INTO snapshots (
         id, repository_id, worktree_id, commit_id, graph_content_id, base_snapshot_id, extractor_set,
         dirty, overlay_fingerprint, state, file_count, symbol_count, edge_count, started_at, completed_at,
         failure_summary
       ) VALUES (?, ?, ?, ?, ?, NULL, 'view-removal-property', 0, NULL, 'ready', 0, 0, 0, ?, ?, NULL)`,
    );
    const insertGeneration = database.prepare(
      'INSERT INTO snapshot_extractor_generations (snapshot_id, generation) VALUES (?, ?)',
    );
    const insertPointer = database.prepare(
      'INSERT INTO active_snapshots (worktree_id, snapshot_id, activated_at) VALUES (?, ?, ?)',
    );
    database.transaction(() => {
      for (const [index, snapshotId] of SNAPSHOT_IDS.entries()) {
        insertSnapshot.run(
          snapshotId,
          repositoryId,
          WORKTREE_IDS[index],
          `${index}`.padStart(40, '0'),
          `content-${index}`,
          new Date(index).toISOString(),
          new Date(index + 1).toISOString(),
        );
        insertGeneration.run(snapshotId, CODE_GRAPH_EXTRACTOR_GENERATION);
        insertPointer.run(WORKTREE_IDS[index], snapshotId, new Date(index + 10).toISOString());
      }
    })();
  } finally {
    database.close(false);
  }
}

function legacyPromote(databasePath: string, worktreeId: string, snapshotId: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database
      .query(
        `INSERT INTO active_snapshots (worktree_id, snapshot_id, activated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(worktree_id) DO UPDATE SET
           snapshot_id = excluded.snapshot_id,
           activated_at = excluded.activated_at`,
      )
      .run(worktreeId, snapshotId, new Date().toISOString());
  } finally {
    database.close(false);
  }
}

function readModel(databasePath: string) {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return {
      pointers: database
        .query<{readonly snapshot_id: string; readonly worktree_id: string}, []>(
          'SELECT worktree_id, snapshot_id FROM active_snapshots ORDER BY worktree_id',
        )
        .all()
        .map(row => [row.worktree_id, row.snapshot_id] as const),
      readySnapshots: database
        .query<{readonly id: string}, []>("SELECT id FROM snapshots WHERE state = 'ready' ORDER BY id")
        .all()
        .map(row => row.id),
      tombstones: database
        .query<{readonly expected_snapshot_id: string; readonly worktree_id: string}, []>(
          'SELECT worktree_id, expected_snapshot_id FROM removed_views ORDER BY worktree_id',
        )
        .all()
        .map(row => [row.worktree_id, row.expected_snapshot_id] as const),
    };
  } finally {
    database.close(false);
  }
}

function sortedEntries(entries: ReadonlyMap<string, string>): readonly (readonly [string, string])[] {
  return [...entries].sort(([left], [right]) => left.localeCompare(right));
}

function identity(root: string, checkoutId: string, repositoryId: string, worktreeId: string): RepositoryIdentity {
  return {
    caseMode: 'sensitive',
    checkoutId,
    displayName: 'threadnote/view-removal-property',
    gitCommonDirectory: root,
    headCommit: 'f'.repeat(40),
    objectFormat: 'sha1',
    repositoryId,
    repoRoot: root,
    worktreeId,
  };
}
