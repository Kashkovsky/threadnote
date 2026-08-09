import {execFileSync, spawn} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Database} from 'bun:sqlite';
import {Deferred, Effect, Fiber, Layer, Path, Ref} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {afterEach, describe, expect} from 'vitest';
import {CommandExecutor} from '../../src/effect/command.js';
import {CODE_GRAPH_GIT_WORKTREE_REGISTRATION_WORKER_ARGUMENT} from '../../src/worker_protocol.js';
import type {CodeGraphWorktreeReconciliationAuthorityObservation} from '../../src/code_graph/git_worktree_registration.js';
import {
  recordVerifiedCodeGraphLocalAssociation,
  type CodeGraphWorktreeReconciliationEvidenceCandidate,
} from '../../src/code_graph/local_provenance.js';
import {codeGraphLayout, type CodeGraphLayout} from '../../src/code_graph/layout.js';
import {resolveRepositoryIdentity} from '../../src/code_graph/repository.js';
import {CodeGraphMaintenanceActiveError} from '../../src/code_graph/maintenance_gate.js';
import {
  CodeGraphStore,
  codeGraphExactSnapshotRetirementStatement,
  codeGraphWorktreeReconciliationCandidatePageStatement,
  type CodeGraphViewRemovalResult,
} from '../../src/code_graph/store.js';
import {SystemInfo} from '../../src/effect/system.js';
import {
  CODE_GRAPH_EXTRACTOR_GENERATION,
  CodeGraphStoreBusyError,
  CodeGraphStoreError,
  type CodeGraphSnapshot,
} from '../../src/code_graph/types.js';
import type {RepositoryIdentity} from '../../src/code_graph/types.js';
import {
  CODE_GRAPH_WORKTREE_RECONCILIATION_CANDIDATE_LIMIT,
  makeCodeGraphWorktreeReconciler,
  makeLiveCodeGraphWorktreeReconciler,
  type CodeGraphWorktreeReconciliationCandidate,
  type CodeGraphWorktreeReconciliationDependencies,
  type CodeGraphWorktreeReconciliationResult,
} from '../../src/code_graph/worktree_reconciliation.js';

const checkoutId = 'a'.repeat(64);
const repositoryId = 'b'.repeat(64);
const anchorWorktreeId = 'c'.repeat(64);
const targetWorktreeId = 'd'.repeat(64);
const expectedSnapshotId = `cgsn_${'e'.repeat(40)}`;
const privateRoot = '/private/threadnote/repository';
const registryRootIdentity = 'f'.repeat(64);
const temporaryRoots: string[] = [];
const storeLayer = CodeGraphStore.layer.pipe(
  Layer.provideMerge(SystemInfo.layer),
  Layer.provideMerge(BunServices.layer),
);
const liveLayer = Layer.merge(CodeGraphStore.layer, CommandExecutor.layer).pipe(
  Layer.provideMerge(SystemInfo.layer),
  Layer.provideMerge(BunServices.layer),
);

afterEach(() => {
  for (const root of temporaryRoots.splice(0).reverse()) rmSync(root, {force: true, recursive: true});
});

const anchor: RepositoryIdentity = {
  caseMode: 'sensitive',
  checkoutId,
  displayName: 'threadnote/reconciliation-test',
  gitCommonDirectory: `${privateRoot}/.git`,
  headCommit: '1'.repeat(40),
  objectFormat: 'sha1',
  repositoryId,
  repoRoot: privateRoot,
  worktreeId: anchorWorktreeId,
};

const candidate: CodeGraphWorktreeReconciliationCandidate = {
  repositoryId,
  snapshotId: expectedSnapshotId,
  worktreeId: targetWorktreeId,
};

const linkedEvidence: Extract<CodeGraphWorktreeReconciliationEvidenceCandidate, {readonly state: 'candidate'}> = {
  canonicalWorktreePath: `${privateRoot}/removed-linked-worktree`,
  checkoutId,
  evidenceToken: '1'.repeat(64),
  recordDigest: '2'.repeat(64),
  recordIdentity: '3'.repeat(64),
  registration: {adminNameKeys: ['4'.repeat(64)], kind: 'linked'},
  repositoryId,
  state: 'candidate',
  worktreeId: targetWorktreeId,
};

const absentBatch: CodeGraphWorktreeReconciliationAuthorityObservation = {
  contentDigest: '5'.repeat(64),
  entryCount: 0,
  pathStates: ['missing'],
  registryRootIdentity,
  registryRootKind: 'directory',
  registryStates: ['absent'],
  state: 'complete',
};

const absentFinal = absentBatch;

describe('automatic missing-worktree reconciliation', () => {
  effectIt.effect('holds the target lock across the final proof and exact snapshot CAS', () =>
    Effect.gen(function* () {
      const events = yield* Ref.make<string[]>([]);
      const anchorReads = yield* Ref.make(0);
      const authorityReads = yield* Ref.make(0);
      const evidenceReads = yield* Ref.make(0);
      const intentReads = yield* Ref.make(0);
      const removalEvidence = yield* Ref.make<unknown>(undefined);
      const dependencies = successfulDependencies({
        maintenanceIntentActive: () =>
          Ref.updateAndGet(intentReads, count => count + 1).pipe(
            Effect.flatMap(count => append(events, count === 1 ? 'initial-intent' : 'post-intent')),
            Effect.as(false),
          ),
        observeAuthority: () =>
          Ref.updateAndGet(authorityReads, count => count + 1).pipe(
            Effect.flatMap(count => append(events, count === 1 ? 'initial-authority' : 'final-authority')),
            Effect.as(absentBatch),
          ),
        readEvidenceCandidate: () =>
          Ref.updateAndGet(evidenceReads, count => count + 1).pipe(
            Effect.flatMap(count =>
              append(events, count === 1 ? 'initial-evidence' : count === 2 ? 'final-evidence' : 'post-evidence'),
            ),
            Effect.as(linkedEvidence),
          ),
        removeView: (_input, _candidate, cleanupEvidence) =>
          Ref.set(removalEvidence, cleanupEvidence).pipe(
            Effect.andThen(append(events, 'remove')),
            Effect.as(removedResult()),
          ),
        resolveAnchor: () =>
          Ref.updateAndGet(anchorReads, count => count + 1).pipe(
            Effect.flatMap(count =>
              append(events, count === 1 ? 'initial-anchor' : count === 2 ? 'final-anchor' : 'post-anchor'),
            ),
            Effect.as(anchor),
          ),
        withTargetLock: (_input, _worktreeId, effect) =>
          append(events, 'lock-enter').pipe(Effect.andThen(effect), Effect.ensuring(append(events, 'lock-exit'))),
      });

      const result = yield* (yield* makeCodeGraphWorktreeReconciler(dependencies)).tick(tick());

      expect(result).toMatchObject({
        expectedSnapshotId,
        state: 'removed',
        worktreeId: targetWorktreeId,
      });
      expect(yield* Ref.get(events)).toEqual([
        'initial-evidence',
        'initial-anchor',
        'initial-authority',
        'lock-enter',
        'initial-intent',
        'final-evidence',
        'final-anchor',
        'final-authority',
        'post-anchor',
        'post-evidence',
        'post-intent',
        'remove',
        'lock-exit',
      ]);
      expect(yield* Ref.get(removalEvidence)).toEqual({
        recordDigest: linkedEvidence.recordDigest,
        recordIdentity: linkedEvidence.recordIdentity,
        repositoryId: linkedEvidence.repositoryId,
      });
    }),
  );

  effectIt.effect('preserves every ambiguous authority state without invoking the core mutation', () =>
    Effect.gen(function* () {
      const cases = [
        {
          name: 'main registration',
          overrides: {readEvidenceCandidate: () => Effect.succeed({state: 'main'} as const)},
        },
        {
          name: 'legacy evidence',
          overrides: {readEvidenceCandidate: () => Effect.succeed({state: 'legacy-unknown'} as const)},
        },
        {
          name: 'invalid evidence',
          overrides: {readEvidenceCandidate: () => Effect.succeed({state: 'invalid'} as const)},
        },
        {
          name: 'verified path',
          overrides: {
            observeAuthority: () => Effect.succeed({...absentBatch, pathStates: ['present'] as const}),
          },
        },
        {
          name: 'stale path',
          overrides: {
            observeAuthority: () => Effect.succeed({...absentBatch, pathStates: ['present'] as const}),
          },
        },
        {
          name: 'registered child',
          overrides: {
            observeAuthority: () => Effect.succeed({...absentBatch, registryStates: ['present'] as const}),
          },
        },
        {
          name: 'unknown initial registry',
          overrides: {
            observeAuthority: () => Effect.succeed({reason: 'ambiguous', state: 'unknown'} as const),
          },
        },
        {
          name: 'unknown final registry',
          overrides: {
            observeAuthority: authoritySequence(absentBatch, {reason: 'unavailable', state: 'unknown'} as const),
          },
        },
        {
          name: 'present final registry',
          overrides: {
            observeAuthority: authoritySequence(absentBatch, {
              ...absentFinal,
              registryStates: ['present'] as const,
            }),
          },
        },
        {
          name: 'replaced registry root',
          overrides: {
            observeAuthority: authoritySequence(absentBatch, {
              ...absentFinal,
              registryRootIdentity: '6'.repeat(64),
            }),
          },
        },
        {
          name: 'active maintenance intent',
          overrides: {maintenanceIntentActive: () => Effect.succeed(true)},
        },
        {
          name: 'identity-mismatched anchor',
          overrides: {resolveAnchor: () => Effect.succeed({...anchor, repositoryId: '7'.repeat(64)})},
        },
      ] as const;

      for (const testCase of cases) {
        const removals = yield* Ref.make(0);
        const dependencies = successfulDependencies({
          ...testCase.overrides,
          removeView: () => Ref.update(removals, count => count + 1).pipe(Effect.as(removedResult())),
        });
        const result = yield* (yield* makeCodeGraphWorktreeReconciler(dependencies)).tick(tick());
        expect(yield* Ref.get(removals), testCase.name).toBe(0);
        expect(result.state, testCase.name).not.toBe('removed');
        expect(JSON.stringify(result), testCase.name).not.toContain(privateRoot);
      }
    }),
  );

  effectIt.effect('does no Git identity or registry work when the claimed page has no missing token', () =>
    Effect.gen(function* () {
      const anchorCalls = yield* Ref.make(0);
      const registryCalls = yield* Ref.make(0);
      const dependencies = successfulDependencies({
        listCandidates: () =>
          Effect.succeed(
            Array.from({length: CODE_GRAPH_WORKTREE_RECONCILIATION_CANDIDATE_LIMIT}, (_, index) => ({
              repositoryId,
              snapshotId: `cgsn_${index.toString(16).padStart(40, '0')}`,
              worktreeId: index.toString(16).padStart(64, '0'),
            })),
          ),
        observeAuthority: () => Ref.update(registryCalls, count => count + 1).pipe(Effect.as(absentBatch)),
        readEvidenceCandidate: () => Effect.succeed({state: 'invalid'} as const),
        resolveAnchor: () => Ref.update(anchorCalls, count => count + 1).pipe(Effect.as(anchor)),
      });

      const result = yield* (yield* makeCodeGraphWorktreeReconciler(dependencies)).tick(tick());

      expect(result).toMatchObject({reason: 'no-missing-candidates', state: 'preserved'});
      expect(yield* Ref.get(anchorCalls)).toBe(0);
      expect(yield* Ref.get(registryCalls)).toBe(0);
    }),
  );

  effectIt.effect('requires the final missing record to be byte-for-byte the initially admitted evidence', () =>
    Effect.gen(function* () {
      const changedEvidence = [
        {...linkedEvidence, recordIdentity: '8'.repeat(64)},
        {...linkedEvidence, registration: {adminNameKeys: ['9'.repeat(64)], kind: 'linked' as const}},
      ] as const;
      for (const changed of changedEvidence) {
        const reads = yield* Ref.make(0);
        const removals = yield* Ref.make(0);
        const dependencies = successfulDependencies({
          readEvidenceCandidate: () =>
            Ref.updateAndGet(reads, count => count + 1).pipe(
              Effect.map(count => (count === 1 ? linkedEvidence : changed)),
            ),
          removeView: () => Ref.update(removals, count => count + 1).pipe(Effect.as(removedResult())),
        });

        const result = yield* (yield* makeCodeGraphWorktreeReconciler(dependencies)).tick(tick());

        expect(result).toMatchObject({reason: 'evidence-changed', state: 'preserved'});
        expect(yield* Ref.get(reads)).toBe(2);
        expect(yield* Ref.get(removals)).toBe(0);
      }
    }),
  );

  effectIt.effect('does not remove when the post-authority evidence re-read changes', () =>
    Effect.gen(function* () {
      const reads = yield* Ref.make(0);
      const removals = yield* Ref.make(0);
      const dependencies = successfulDependencies({
        readEvidenceCandidate: () =>
          Ref.updateAndGet(reads, count => count + 1).pipe(
            Effect.map(count => (count === 3 ? {...linkedEvidence, recordDigest: '8'.repeat(64)} : linkedEvidence)),
          ),
        removeView: () => Ref.update(removals, count => count + 1).pipe(Effect.as(removedResult())),
      });

      const result = yield* (yield* makeCodeGraphWorktreeReconciler(dependencies)).tick(tick());

      expect(result).toMatchObject({reason: 'evidence-changed', state: 'preserved'});
      expect(yield* Ref.get(reads)).toBe(3);
      expect(yield* Ref.get(removals)).toBe(0);
    }),
  );

  effectIt.effect('preserves when maintenance begins during the final authority worker', () =>
    Effect.gen(function* () {
      const intentReads = yield* Ref.make(0);
      const removals = yield* Ref.make(0);
      const dependencies = successfulDependencies({
        maintenanceIntentActive: () =>
          Ref.updateAndGet(intentReads, count => count + 1).pipe(Effect.map(count => count > 1)),
        removeView: () => Ref.update(removals, count => count + 1).pipe(Effect.as(removedResult())),
      });

      const result = yield* (yield* makeCodeGraphWorktreeReconciler(dependencies)).tick(tick());

      expect(result).toMatchObject({reason: 'external-maintenance', state: 'preserved'});
      expect(yield* Ref.get(intentReads)).toBe(2);
      expect(yield* Ref.get(removals)).toBe(0);
    }),
  );

  effectIt.effect('distinguishes a busy target gate from other lock-held catalog failures', () =>
    Effect.gen(function* () {
      const cases = [
        {
          expected: {reason: 'target-busy', state: 'deferred'},
          failure: new CodeGraphStoreBusyError('Target gate is busy.'),
        },
        {
          expected: {reason: 'catalog-unavailable', state: 'deferred'},
          failure: new CodeGraphStoreError('Target gate could not be inspected.', {
            code: 'permission',
            recovery: 'fix-permissions',
          }),
        },
      ] as const;
      for (const testCase of cases) {
        const dependencies = successfulDependencies({
          withTargetLock: () => Effect.fail(testCase.failure),
        });
        const result = yield* (yield* makeCodeGraphWorktreeReconciler(dependencies)).tick(tick());
        expect(result).toMatchObject(testCase.expected);
        expect(JSON.stringify(result)).not.toContain(privateRoot);
      }
    }),
  );

  effectIt.effect('bounds a ten-thousand-view tick to one page and two registry scans', () =>
    Effect.gen(function* () {
      const candidates = Array.from({length: 10_000}, (_, index) => ({
        repositoryId,
        snapshotId: `snapshot-${index}`,
        worktreeId: index.toString(16).padStart(64, '0'),
      }));
      const listedLimits = yield* Ref.make<number[]>([]);
      const authorityScans = yield* Ref.make(0);
      const dependencies = successfulDependencies({
        listCandidates: (_input, limit) =>
          Ref.update(listedLimits, limits => [...limits, limit]).pipe(Effect.as(candidates.slice(0, limit))),
        observeAuthority: (_identity, targets) =>
          Ref.updateAndGet(authorityScans, count => count + 1).pipe(
            Effect.map(count => ({
              ...absentBatch,
              pathStates: targets.map(() => 'missing' as const),
              registryStates: targets.map(() => 'absent' as const),
              ...(count === 1 ? {} : {entryCount: 0}),
            })),
          ),
        readEvidenceCandidate: (_threadnoteHome, target) =>
          Effect.succeed({
            ...linkedEvidence,
            worktreeId: target.worktreeId,
          }),
      });

      const result = yield* (yield* makeCodeGraphWorktreeReconciler(dependencies)).tick(tick());

      expect(result.state).toBe('removed');
      expect(yield* Ref.get(listedLimits)).toEqual([CODE_GRAPH_WORKTREE_RECONCILIATION_CANDIDATE_LIMIT]);
      expect(yield* Ref.get(authorityScans)).toBe(2);
    }),
  );

  effectIt.effect('claims a durable cross-process cursor page and fails closed on malformed state', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const root = mkdtempSync(join(tmpdir(), 'threadnote-reconciliation-cursor-'));
        temporaryRoots.push(root);
        const databasePath = join(root, 'indexes', 'code-graph', 'repositories', checkoutId, 'graph-v3.sqlite');
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        const worktreeIds = Array.from({length: 70}, (_, index) => index.toString(16).padStart(64, '0'));
        yield* Effect.sync(() => seedCandidateViews(databasePath, worktreeIds));

        const pages = yield* Effect.all(
          Array.from({length: 3}, () =>
            store.claimWorktreeReconciliationCandidates(databasePath, 32, {waitTimeoutMilliseconds: 5_000}),
          ),
          {concurrency: 'unbounded'},
        );
        const claimed = new Set(pages.flatMap(page => page.map(entry => entry.worktreeId)));
        expect(pages.map(page => page.length).sort((left, right) => left - right)).toEqual([31, 32, 32]);
        expect(claimed.size).toBe(69);
        expect(claimed.has(worktreeIds.at(-1)!)).toBe(false);

        const malformed = yield* Effect.sync(() => {
          const database = new Database(databasePath, {strict: true});
          try {
            database
              .query("UPDATE schema_metadata SET value = 'malformed' WHERE key = 'worktree_reconciliation_cursor'")
              .run();
          } finally {
            database.close(false);
          }
        }).pipe(Effect.andThen(store.claimWorktreeReconciliationCandidates(databasePath, 32).pipe(Effect.exit)));
        expect(malformed._tag).toBe('Failure');

        const incompatibleVersion = yield* Effect.sync(() => {
          const database = new Database(databasePath, {strict: true});
          try {
            database.query('DELETE FROM schema_metadata WHERE key = ?').run('worktree_reconciliation_cursor');
            database.query("UPDATE schema_metadata SET value = '999' WHERE key = 'schema_version'").run();
          } finally {
            database.close(false);
          }
        }).pipe(Effect.andThen(store.claimWorktreeReconciliationCandidates(databasePath, 32).pipe(Effect.exit)));
        expect(incompatibleVersion._tag).toBe('Failure');
        yield* Effect.sync(() => {
          const database = new Database(databasePath, {strict: true});
          try {
            database.query("UPDATE schema_metadata SET value = '3' WHERE key = 'schema_version'").run();
          } finally {
            database.close(false);
          }
        });

        const partial = yield* Effect.sync(() => {
          const database = new Database(databasePath, {strict: true});
          try {
            database.query('DELETE FROM schema_metadata WHERE key = ?').run('worktree_reconciliation_cursor');
            database.run('DROP TABLE removed_views');
            database.run('CREATE TABLE removed_views (worktree_id TEXT PRIMARY KEY)');
          } finally {
            database.close(false);
          }
        }).pipe(Effect.andThen(store.claimWorktreeReconciliationCandidates(databasePath, 32).pipe(Effect.exit)));
        expect(partial._tag).toBe('Failure');

        const cascadingTombstone = yield* Effect.sync(() => {
          const database = new Database(databasePath, {strict: true});
          try {
            database.run('DROP TABLE removed_views');
            database.run(`CREATE TABLE removed_views (
              worktree_id TEXT PRIMARY KEY NOT NULL,
              expected_snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
              removed_at TEXT NOT NULL
            ) WITHOUT ROWID`);
          } finally {
            database.close(false);
          }
        }).pipe(Effect.andThen(store.claimWorktreeReconciliationCandidates(databasePath, 32).pipe(Effect.exit)));
        expect(cascadingTombstone._tag).toBe('Failure');
      }).pipe(Effect.provide(storeLayer)),
    ),
  );

  effectIt.effect('uses indexed cursor pages without a temporary sort across ten thousand real views', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const root = mkdtempSync(join(tmpdir(), 'threadnote-reconciliation-cursor-load-'));
        temporaryRoots.push(root);
        const databasePath = join(root, 'indexes', 'code-graph', 'repositories', checkoutId, 'graph-v3.sqlite');
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        const worktreeIds = Array.from({length: 10_000}, (_, index) => index.toString(16).padStart(64, '0'));
        yield* Effect.sync(() => seedCandidateViews(databasePath, worktreeIds));

        const plans = yield* Effect.sync(() => {
          const database = new Database(databasePath, {readonly: true, strict: true});
          try {
            return (['after', 'through'] as const).flatMap(boundary => {
              const statement = codeGraphWorktreeReconciliationCandidatePageStatement('7'.repeat(64), boundary, 32);
              return database.query(`EXPLAIN QUERY PLAN ${statement.text}`).all(...statement.parameters) as readonly {
                readonly detail: string;
              }[];
            });
          } finally {
            database.close(false);
          }
        });
        expect(plans.some(plan => /active.*(?:INDEX|PRIMARY KEY)/iu.test(plan.detail))).toBe(true);
        expect(plans.some(plan => /USE TEMP B-TREE/iu.test(plan.detail))).toBe(false);

        yield* Effect.sync(() => tombstoneEveryActiveView(databasePath));
        const firstEmptyPage = yield* store.claimWorktreeReconciliationCandidates(databasePath, 32, {
          waitTimeoutMilliseconds: 0,
        });
        expect(firstEmptyPage).toEqual([]);
        expect(readReconciliationCursor(databasePath)).toBe(worktreeIds[31]);
        const secondEmptyPage = yield* store.claimWorktreeReconciliationCandidates(databasePath, 32, {
          waitTimeoutMilliseconds: 0,
        });
        expect(secondEmptyPage).toEqual([]);
        expect(readReconciliationCursor(databasePath)).toBe(worktreeIds[63]);

        yield* Effect.sync(() => removeViewTombstone(databasePath, worktreeIds[64]!));
        const sparsePage = yield* store.claimWorktreeReconciliationCandidates(databasePath, 32, {
          waitTimeoutMilliseconds: 0,
        });
        expect(sparsePage.map(entry => entry.worktreeId)).toEqual([worktreeIds[64]]);
        expect(readReconciliationCursor(databasePath)).toBe(worktreeIds[95]);
      }).pipe(Effect.provide(storeLayer)),
    ),
  );

  effectIt.effect('retires only the selected snapshot in a high-cardinality catalog', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const root = mkdtempSync(join(tmpdir(), 'threadnote-reconciliation-exact-retirement-'));
        temporaryRoots.push(root);
        const databasePath = join(root, 'indexes', 'code-graph', 'repositories', checkoutId, 'graph-v3.sqlite');
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        const selectedSnapshotId = `cgsn_${'0'.repeat(40)}`;
        yield* Effect.sync(() => {
          seedCandidateViews(databasePath, [targetWorktreeId], false);
          seedReadyOrphanSnapshots(databasePath, 4_096, 1);
        });
        const plan = yield* Effect.sync(() => {
          const database = new Database(databasePath, {readonly: true, strict: true});
          try {
            const statement = codeGraphExactSnapshotRetirementStatement([selectedSnapshotId], Date.now());
            return database.query(`EXPLAIN QUERY PLAN ${statement.text}`).all(...statement.parameters) as readonly {
              readonly detail: string;
            }[];
          } finally {
            database.close(false);
          }
        });
        expect(plan.some(row => row.detail.includes('snapshots_base_state_id'))).toBe(true);
        expect(plan.some(row => row.detail.includes('active_snapshots_snapshot_worktree'))).toBe(true);
        expect(plan.some(row => row.detail.includes('snapshot_leases_snapshot_expiry'))).toBe(true);
        expect(plan.some(row => /SCAN (?:active_snapshots|snapshot_leases|snapshots)\b/iu.test(row.detail))).toBe(
          false,
        );

        const result = yield* store.removeView(databasePath, targetWorktreeId, selectedSnapshotId, {
          requireReconciliationSchema: true,
          waitTimeoutMilliseconds: 0,
        });
        const states = yield* Effect.sync(() => readExactRetirementState(databasePath, selectedSnapshotId));

        expect(result).toEqual({expectedSnapshotId: selectedSnapshotId, retiredSnapshots: 1, state: 'removed'});
        expect(states).toEqual({
          activeSnapshotId: undefined,
          readyOrphans: 4_096,
          removedSnapshotId: selectedSnapshotId,
          selectedState: 'retired',
        });
      }).pipe(Effect.provide(storeLayer)),
    ),
  );

  effectIt.effect('protects exact active and lease ancestry while allowing an expired-only target to retire', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const root = mkdtempSync(join(tmpdir(), 'threadnote-reconciliation-retirement-protection-'));
        temporaryRoots.push(root);
        const databasePath = join(root, 'indexes', 'code-graph', 'repositories', checkoutId, 'graph-v3.sqlite');
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        const worktreeIds = Array.from({length: 5}, (_, index) => String(index + 1).repeat(64));
        const snapshotIds = Array.from({length: 5}, (_, index) => `cgsn_${index.toString(16).padStart(40, '0')}`);
        yield* Effect.sync(() => {
          seedCandidateViews(databasePath, worktreeIds, false);
          seedRetirementProtectionGraph(databasePath, snapshotIds);
        });
        const leaseToken = yield* store.acquireSnapshotLease(databasePath, snapshotIds[0]!, 60_000);

        const results = yield* Effect.forEach(
          worktreeIds,
          (worktreeId, index) =>
            store.removeView(databasePath, worktreeId, snapshotIds[index]!, {
              requireReconciliationSchema: true,
              // Each committed removal may schedule bounded detached cleanup.
              // This sequential authority test waits through that legitimate
              // writer handoff; dedicated contention tests retain zero-wait.
              waitTimeoutMilliseconds: 5_000,
            }),
          {concurrency: 1},
        );
        const states = yield* Effect.sync(() => readSnapshotStates(databasePath, snapshotIds));

        expect(results.map(result => ('retiredSnapshots' in result ? result.retiredSnapshots : undefined))).toEqual([
          0, 0, 0, 0, 1,
        ]);
        expect(results.every(result => result.state === 'removed')).toBe(true);
        expect(states).toEqual([
          {id: snapshotIds[0], state: 'ready'},
          {id: snapshotIds[1], state: 'ready'},
          {id: snapshotIds[2], state: 'ready'},
          {id: snapshotIds[3], state: 'ready'},
          {id: snapshotIds[4], state: 'retired'},
        ]);
        const childAfterRemoval = `cgsn_${'d'.repeat(40)}`;
        yield* Effect.sync(() => seedReadySnapshotChild(databasePath, snapshotIds[0]!, childAfterRemoval));
        yield* store.releaseSnapshotLease(databasePath, leaseToken);
        expect(
          yield* Effect.sync(() => readSnapshotStates(databasePath, [snapshotIds[0]!, childAfterRemoval])),
        ).toEqual([
          {id: snapshotIds[0], state: 'ready'},
          {id: childAfterRemoval, state: 'ready'},
        ]);
      }).pipe(Effect.provide(storeLayer)),
    ),
  );

  effectIt.effect('never retires a blocked candidate base through a released child candidate', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const root = mkdtempSync(join(tmpdir(), 'threadnote-reconciliation-retirement-chain-'));
        temporaryRoots.push(root);
        const databasePath = join(root, 'indexes', 'code-graph', 'repositories', checkoutId, 'graph-v3.sqlite');
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        const targetSnapshotId = `cgsn_${'0'.repeat(40)}`;
        const baseSnapshotId = `cgsn_${'1'.repeat(40)}`;
        const blockingChildId = `cgsn_${'2'.repeat(40)}`;
        yield* Effect.sync(() => {
          seedCandidateViews(databasePath, [targetWorktreeId], false);
          seedLeaseReleaseCounterexample(databasePath, baseSnapshotId, targetSnapshotId, blockingChildId);
        });
        const leaseToken = yield* store.acquireSnapshotLease(databasePath, targetSnapshotId, 60_000);
        const removed = yield* store.removeView(databasePath, targetWorktreeId, targetSnapshotId, {
          requireReconciliationSchema: true,
          waitTimeoutMilliseconds: 0,
        });
        yield* store.releaseSnapshotLease(databasePath, leaseToken);

        expect(removed).toMatchObject({retiredSnapshots: 0, state: 'removed'});
        expect(
          yield* Effect.sync(() =>
            readSnapshotStates(databasePath, [baseSnapshotId, targetSnapshotId, blockingChildId]),
          ),
        ).toEqual([
          {id: baseSnapshotId, state: 'ready'},
          {id: targetSnapshotId, state: 'ready'},
          {id: blockingChildId, state: 'ready'},
        ]);
      }).pipe(Effect.provide(storeLayer)),
    ),
  );

  effectIt.effect('ignores only an exact tombstoned legacy pointer during lease-release retirement', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        for (const exactTombstone of [true, false]) {
          const root = mkdtempSync(join(tmpdir(), 'threadnote-reconciliation-legacy-republish-'));
          temporaryRoots.push(root);
          const databasePath = join(root, 'indexes', 'code-graph', 'repositories', checkoutId, 'graph-v3.sqlite');
          const store = yield* CodeGraphStore;
          yield* store.initialize(databasePath);
          const snapshotId = `cgsn_${'0'.repeat(40)}`;
          yield* Effect.sync(() => seedCandidateViews(databasePath, [targetWorktreeId], false));
          const lease = yield* store.acquireSnapshotLease(databasePath, snapshotId, 60_000);
          const removed = yield* store.removeView(databasePath, targetWorktreeId, snapshotId, {
            requireReconciliationSchema: true,
            waitTimeoutMilliseconds: 0,
          });
          yield* Effect.sync(() =>
            republishLegacyActivePointer(databasePath, targetWorktreeId, snapshotId, exactTombstone),
          );
          yield* store.releaseSnapshotLease(databasePath, lease);
          const state = yield* Effect.sync(() => readLegacyRepublishState(databasePath, targetWorktreeId, snapshotId));

          expect(removed).toMatchObject({retiredSnapshots: 0, state: 'removed'});
          if (exactTombstone) {
            expect(state).toEqual({
              activeSnapshotId: snapshotId,
              removedSnapshotId: snapshotId,
              snapshotState: 'retired',
            });
          } else {
            expect(state).toEqual({
              activeSnapshotId: snapshotId,
              removedSnapshotId: `cgsn_${'f'.repeat(40)}`,
              snapshotState: 'ready',
            });
          }
        }
      }).pipe(Effect.provide(storeLayer)),
    ),
  );

  effectIt.effect('stops exact retirement below an immediate blocker with ten thousand descendants', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const root = mkdtempSync(join(tmpdir(), 'threadnote-reconciliation-pruned-descendants-'));
        temporaryRoots.push(root);
        const databasePath = join(root, 'indexes', 'code-graph', 'repositories', checkoutId, 'graph-v3.sqlite');
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        const rootSnapshotId = `cgsn_${'0'.repeat(40)}`;
        const immediateBlockerId = `cgsn_${'1'.padStart(40, '0')}`;
        const tailId = `cgsn_${(10_001).toString(16).padStart(40, '0')}`;
        yield* Effect.sync(() => {
          seedCandidateViews(databasePath, [targetWorktreeId], false);
          seedBlockedDescendantChain(databasePath, rootSnapshotId, 10_001);
        });
        const statement = codeGraphExactSnapshotRetirementStatement([rootSnapshotId], Date.now());
        const plan = yield* Effect.sync(() => queryPlan(databasePath, statement));
        expect(plan.some(row => row.detail.includes('snapshots_base_state_id'))).toBe(true);
        expect(plan.some(row => /USE TEMP B-TREE|SCAN child/u.test(row.detail))).toBe(false);
        expect(statement.text).not.toMatch(/WITH RECURSIVE|descendant/iu);
        expect(statement.text).toMatch(/child\.base_snapshot_id = candidate\.id/u);

        const removed = yield* store.removeView(databasePath, targetWorktreeId, rootSnapshotId, {
          requireReconciliationSchema: true,
          waitTimeoutMilliseconds: 0,
        });

        expect(removed).toMatchObject({retiredSnapshots: 0, state: 'removed'});
        expect(
          yield* Effect.sync(() => readSnapshotStates(databasePath, [rootSnapshotId, immediateBlockerId, tailId])),
        ).toEqual([
          {id: rootSnapshotId, state: 'ready'},
          {id: immediateBlockerId, state: 'ready'},
          {id: tailId, state: 'ready'},
        ]);
      }).pipe(Effect.provide(storeLayer)),
    ),
  );

  effectIt.effect('keeps DELETE journal mode and files untouched for every incompatible strict API', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const root = mkdtempSync(join(tmpdir(), 'threadnote-reconciliation-delete-journal-'));
        temporaryRoots.push(root);
        const store = yield* CodeGraphStore;
        const operations = ['claim', 'prepare', 'remove'] as const;
        for (const operation of operations) {
          const databasePath = join(root, `${operation}.sqlite`);
          yield* Effect.sync(() => seedIncompatibleDeleteJournalDatabase(databasePath));
          if (operation === 'claim') {
            expect((yield* store.claimWorktreeReconciliationCandidates(databasePath, 1).pipe(Effect.exit))._tag).toBe(
              'Failure',
            );
          } else if (operation === 'prepare') {
            expect(yield* store.prepareWorktreeReconciliationIndexes(databasePath)).toEqual({
              reason: 'incompatible-schema',
              state: 'deferred',
            });
          } else {
            expect(
              (yield* store
                .removeView(databasePath, targetWorktreeId, expectedSnapshotId, {
                  requireReconciliationSchema: true,
                })
                .pipe(Effect.exit))._tag,
            ).toBe('Failure');
          }
          expect(readJournalMode(databasePath)).toBe('delete');
          expect(existsSync(`${databasePath}-wal`)).toBe(false);
          expect(existsSync(`${databasePath}-shm`)).toBe(false);
        }
      }).pipe(Effect.provide(storeLayer)),
    ),
  );

  effectIt.effect(
    'rejects mixed lifecycle DDL, collations, generated columns, and firing triggers without mutation',
    () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const mutations = [
            {
              name: 'generated column',
              setup: (databasePath: string) => {
                executeDatabaseSql(
                  databasePath,
                  'ALTER TABLE active_snapshots ADD COLUMN generated_extra TEXT GENERATED ALWAYS AS (worktree_id) VIRTUAL',
                );
              },
            },
            {
              name: 'snapshot self foreign key',
              setup: (databasePath: string) =>
                rebuildCanonicalTableDefinition(databasePath, 'snapshots', definition =>
                  definition.replace(
                    /\n\s*\)$/u,
                    ',\n      FOREIGN KEY (base_snapshot_id) REFERENCES snapshots(id) ON DELETE CASCADE\n    )',
                  ),
                ),
            },
            {
              name: 'altered lifecycle state check',
              setup: (databasePath: string) =>
                rebuildCanonicalTableDefinition(databasePath, 'snapshots', definition =>
                  definition.replace(
                    "state IN ('building', 'ready', 'failed', 'retired')",
                    "state IN ('building', 'ready', 'failed')",
                  ),
                ),
            },
            {
              name: 'uppercase lifecycle state literals',
              setup: (databasePath: string) =>
                rebuildCanonicalTableDefinition(databasePath, 'snapshots', definition =>
                  definition.replace(
                    "state IN ('building', 'ready', 'failed', 'retired')",
                    "state IN ('BUILDING', 'READY', 'FAILED', 'RETIRED')",
                  ),
                ),
            },
            {
              name: 'case-folded schema metadata key',
              setup: (databasePath: string) =>
                rebuildCanonicalTableDefinition(databasePath, 'schema_metadata', definition =>
                  definition.replace('key TEXT PRIMARY KEY NOT NULL', 'key TEXT PRIMARY KEY NOT NULL COLLATE NOCASE'),
                ),
            },
            {
              name: 'case-folded tombstone equality',
              setup: (databasePath: string) =>
                rebuildCanonicalTableDefinition(databasePath, 'removed_views', definition =>
                  definition.replace(
                    'expected_snapshot_id TEXT NOT NULL',
                    'expected_snapshot_id TEXT NOT NULL COLLATE NOCASE',
                  ),
                ),
            },
            {
              name: 'case-folded required index',
              setup: (databasePath: string) =>
                executeDatabaseSql(
                  databasePath,
                  `DROP INDEX active_snapshots_snapshot_worktree;
                   CREATE INDEX active_snapshots_snapshot_worktree
                   ON active_snapshots(snapshot_id COLLATE NOCASE, worktree_id);`,
                ),
            },
            {
              name: 'case-folded lease capability key',
              setup: (databasePath: string) =>
                rebuildCanonicalTableDefinition(databasePath, 'snapshot_leases', definition =>
                  definition.replace(
                    'token TEXT PRIMARY KEY NOT NULL',
                    'token TEXT COLLATE NOCASE PRIMARY KEY NOT NULL',
                  ),
                ),
            },
            {
              name: 'unexpected delete trigger',
              setup: (databasePath: string) => {
                executeDatabaseSql(
                  databasePath,
                  `CREATE TRIGGER reconciliation_delete_side_effect
                 AFTER DELETE ON active_snapshots BEGIN
                   UPDATE schema_metadata SET value = value WHERE key = 'schema_version';
                 END`,
                );
              },
            },
          ] as const;
          for (const mutation of mutations) {
            const root = mkdtempSync(join(tmpdir(), 'threadnote-reconciliation-mixed-schema-'));
            temporaryRoots.push(root);
            const databasePath = join(root, 'indexes', 'code-graph', 'repositories', checkoutId, 'graph-v3.sqlite');
            const store = yield* CodeGraphStore;
            const snapshotId = `cgsn_${'0'.repeat(40)}`;
            yield* store.initialize(databasePath);
            yield* Effect.sync(() => seedCandidateViews(databasePath, [targetWorktreeId], false));
            expect(yield* store.prepareWorktreeReconciliationIndexes(databasePath), `${mutation.name} control`).toEqual(
              {
                state: 'ready',
              },
            );
            yield* Effect.sync(() => mutation.setup(databasePath));
            const before = yield* Effect.sync(() => readExactRetirementState(databasePath, snapshotId));
            expect(
              (yield* store.claimWorktreeReconciliationCandidates(databasePath, 1).pipe(Effect.exit))._tag,
              mutation.name,
            ).toBe('Failure');
            expect(yield* store.prepareWorktreeReconciliationIndexes(databasePath), mutation.name).toEqual({
              reason: 'incompatible-schema',
              state: 'deferred',
            });
            expect(
              (yield* store
                .removeView(databasePath, targetWorktreeId, snapshotId, {requireReconciliationSchema: true})
                .pipe(Effect.exit))._tag,
              mutation.name,
            ).toBe('Failure');
            expect(yield* Effect.sync(() => readExactRetirementState(databasePath, snapshotId)), mutation.name).toEqual(
              before,
            );
          }
        }).pipe(Effect.provide(storeLayer)),
      ),
  );

  effectIt.effect('preflights every required index before creating the first missing one', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const root = mkdtempSync(join(tmpdir(), 'threadnote-reconciliation-index-preflight-'));
        temporaryRoots.push(root);
        const databasePath = join(root, 'indexes', 'code-graph', 'repositories', checkoutId, 'graph-v3.sqlite');
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        yield* Effect.sync(() => {
          executeDatabaseSql(databasePath, 'DROP INDEX active_snapshots_snapshot_worktree');
          executeDatabaseSql(databasePath, 'DROP INDEX snapshots_base_state_id');
          executeDatabaseSql(databasePath, 'CREATE INDEX snapshots_base_state_id ON snapshots(state, id)');
        });

        expect(yield* store.prepareWorktreeReconciliationIndexes(databasePath)).toEqual({
          reason: 'incompatible-schema',
          state: 'deferred',
        });
        expect(indexDefinition(databasePath, 'active_snapshots_snapshot_worktree')).toBeUndefined();
        expect(indexDefinition(databasePath, 'snapshots_base_state_id')).toContain('snapshots(state, id)');
      }).pipe(Effect.provide(storeLayer)),
    ),
  );

  effectIt.effect('strict removal never initializes or cleans unrelated incompatible extensions', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const root = mkdtempSync(join(tmpdir(), 'threadnote-reconciliation-extension-invariance-'));
        temporaryRoots.push(root);
        const databasePath = join(root, 'indexes', 'code-graph', 'repositories', checkoutId, 'graph-v3.sqlite');
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        const snapshotId = `cgsn_${'0'.repeat(40)}`;
        yield* Effect.sync(() => {
          seedCandidateViews(databasePath, [targetWorktreeId], false);
          executeDatabaseSql(databasePath, 'DROP TABLE snapshot_analysis_summary_receipts');
          executeDatabaseSql(
            databasePath,
            'CREATE TABLE snapshot_analysis_summary_receipts (sentinel TEXT PRIMARY KEY, payload TEXT NOT NULL)',
          );
          executeDatabaseSql(
            databasePath,
            "INSERT INTO snapshot_analysis_summary_receipts (sentinel, payload) VALUES ('keep', 'corrupt-extension')",
          );
        });
        const before = extensionDefinitionAndRows(databasePath);

        expect(
          yield* store.removeView(databasePath, targetWorktreeId, snapshotId, {
            requireReconciliationSchema: true,
            waitTimeoutMilliseconds: 0,
          }),
        ).toMatchObject({state: 'removed'});
        yield* Effect.sleep('100 millis');
        expect(extensionDefinitionAndRows(databasePath)).toEqual(before);
      }).pipe(Effect.provide(storeLayer)),
    ),
  );

  effectIt.effect('rechecks the exact reconciliation schema inside the final writer gate before mutation', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const root = mkdtempSync(join(tmpdir(), 'threadnote-reconciliation-final-schema-'));
        temporaryRoots.push(root);
        const databasePath = join(root, 'indexes', 'code-graph', 'repositories', checkoutId, 'graph-v3.sqlite');
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        const selectedSnapshotId = `cgsn_${'0'.repeat(40)}`;
        yield* Effect.sync(() => seedCandidateViews(databasePath, [targetWorktreeId], false));
        expect(yield* store.claimWorktreeReconciliationCandidates(databasePath, 1)).toHaveLength(1);

        const result = yield* store
          .removeView(databasePath, targetWorktreeId, selectedSnapshotId, {
            beforeDatabaseOpen: () =>
              Effect.sync(() => {
                const database = new Database(databasePath, {strict: true});
                try {
                  database.query("UPDATE schema_metadata SET value = '999' WHERE key = 'schema_version'").run();
                } finally {
                  database.close(false);
                }
              }),
            requireReconciliationSchema: true,
            waitTimeoutMilliseconds: 0,
          })
          .pipe(Effect.exit);
        const state = yield* Effect.sync(() => readExactRetirementState(databasePath, selectedSnapshotId));

        expect(result._tag).toBe('Failure');
        if (result._tag === 'Failure') {
          expect(String(result.cause)).toContain('Code graph reconciliation schema is unavailable.');
          expect(String(result.cause)).not.toContain(root);
        }
        expect(state).toEqual({
          activeSnapshotId: selectedSnapshotId,
          readyOrphans: 0,
          removedSnapshotId: undefined,
          selectedState: 'ready',
        });
      }).pipe(Effect.provide(storeLayer)),
    ),
  );

  effectIt.effect('holds the checkout writer gate while the final candidate database proof runs', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const root = mkdtempSync(join(tmpdir(), 'threadnote-reconciliation-claim-proof-'));
        temporaryRoots.push(root);
        const databasePath = join(root, 'indexes', 'code-graph', 'repositories', checkoutId, 'graph-v3.sqlite');
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        yield* Effect.sync(() => seedCandidateViews(databasePath, [targetWorktreeId], false));
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const owner = yield* store
          .claimWorktreeReconciliationCandidates(databasePath, 1, {
            beforeDatabaseOpen: () =>
              Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
            waitTimeoutMilliseconds: 5_000,
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);

        const contender = yield* store
          .claimWorktreeReconciliationCandidates(databasePath, 1, {waitTimeoutMilliseconds: 0})
          .pipe(Effect.exit);
        expect(contender._tag).toBe('Failure');
        if (contender._tag === 'Failure') expect(String(contender.cause)).toContain('CodeGraphStoreBusyError');

        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(owner)).toHaveLength(1);
      }).pipe(Effect.provide(storeLayer)),
    ),
  );

  effectIt.effect('preserves the typed maintenance sentinel under each strict writer gate', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const root = mkdtempSync(join(tmpdir(), 'threadnote-reconciliation-intent-writer-gate-'));
        temporaryRoots.push(root);
        const databasePath = join(root, 'indexes', 'code-graph', 'repositories', checkoutId, 'graph-v3.sqlite');
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        const snapshotId = `cgsn_${'0'.repeat(40)}`;
        yield* Effect.sync(() => seedCandidateViews(databasePath, [targetWorktreeId], false));
        const refuse = () => Effect.fail(new CodeGraphMaintenanceActiveError());

        const claim = yield* store
          .claimWorktreeReconciliationCandidates(databasePath, 1, {beforeDatabaseOpen: refuse})
          .pipe(Effect.exit);
        const remove = yield* store
          .removeView(databasePath, targetWorktreeId, snapshotId, {
            beforeDatabaseOpen: refuse,
            requireReconciliationSchema: true,
          })
          .pipe(Effect.exit);
        yield* Effect.sync(() => executeDatabaseSql(databasePath, 'DROP INDEX active_snapshots_snapshot_worktree'));
        const prepare = yield* store
          .prepareWorktreeReconciliationIndexes(databasePath, {beforeDatabaseOpen: refuse})
          .pipe(Effect.exit);

        for (const exit of [claim, remove, prepare]) {
          expect(exit._tag).toBe('Failure');
          if (exit._tag === 'Failure') expect(String(exit.cause)).toContain('CodeGraphMaintenanceActiveError');
        }
        expect(yield* Effect.sync(() => readExactRetirementState(databasePath, snapshotId))).toEqual({
          activeSnapshotId: snapshotId,
          readyOrphans: 0,
          removedSnapshotId: undefined,
          selectedState: 'ready',
        });
        expect(indexDefinition(databasePath, 'active_snapshots_snapshot_worktree')).toBeUndefined();
      }).pipe(Effect.provide(storeLayer)),
    ),
  );

  effectIt.effect('reconciles one real removed linked worktree with exactly two bounded registry workers', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fixture = yield* createLiveReconciliationFixture('threadnote-reconciliation-live-remove-');
        const observed = yield* observedLiveReconciler;
        const provenanceBefore = readFileSync(fixture.provenancePath, 'utf8');
        const record = JSON.parse(provenanceBefore) as {
          readonly registration?: {readonly kind?: string};
          readonly schemaVersion?: number;
        };
        expect(record).toMatchObject({registration: {kind: 'linked'}, schemaVersion: 2});

        yield* Effect.sync(() => removeLiveLinkedWorktree(fixture));
        expect(existsSync(fixture.linked)).toBe(false);
        expect(existsSync(fixture.adminPath)).toBe(false);
        const result = yield* observed.reconciler.tick(liveTick(fixture));

        expect(result).toMatchObject({
          expectedSnapshotId: fixture.snapshotId,
          state: 'removed',
          worktreeId: fixture.linkedIdentity.worktreeId,
        });
        expect(yield* Ref.get(observed.workerCalls)).toBe(2);
        const view = readViewState(fixture);
        expect(view.activeSnapshotId).toBeUndefined();
        expect(view.removedSnapshotId).toBe(fixture.snapshotId);
        expect(['retired', undefined]).toContain(view.snapshotState);
        expect(readFileSync(fixture.provenancePath, 'utf8')).toBe(provenanceBefore);
        expect(readFileSync(fixture.mainFile, 'utf8')).toBe('main source\n');
        expect(existsSync(join(fixture.main, '.git'))).toBe(true);
        expect(JSON.stringify(result)).not.toContain(fixture.root);
      }).pipe(Effect.provide(liveLayer)),
    ),
  );

  effectIt.effect('preserves a real graph view when the recorded worktree path reappears', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fixture = yield* createLiveReconciliationFixture('threadnote-reconciliation-live-path-');
        const observed = yield* observedLiveReconciler;
        yield* Effect.sync(() => {
          removeLiveLinkedWorktree(fixture);
          mkdirSync(fixture.linked, {mode: 0o700});
          writeFileSync(join(fixture.linked, 'reappeared.txt'), 'preserve me\n');
        });

        const result = yield* observed.reconciler.tick(liveTick(fixture));

        expect(result).toMatchObject({reason: 'no-missing-candidates', state: 'preserved'});
        expect(yield* Ref.get(observed.workerCalls)).toBe(1);
        expect(readViewState(fixture)).toEqual({
          activeSnapshotId: fixture.snapshotId,
          removedSnapshotId: undefined,
          snapshotState: 'ready',
        });
        expect(readFileSync(join(fixture.linked, 'reappeared.txt'), 'utf8')).toBe('preserve me\n');
        expect(readFileSync(fixture.mainFile, 'utf8')).toBe('main source\n');
      }).pipe(Effect.provide(liveLayer)),
    ),
  );

  effectIt.effect('preserves a real graph view when the linked admin child reappears as a raw file', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fixture = yield* createLiveReconciliationFixture('threadnote-reconciliation-live-admin-');
        const observed = yield* observedLiveReconciler;
        yield* Effect.sync(() => {
          removeLiveLinkedWorktree(fixture);
          mkdirSync(dirname(fixture.adminPath), {mode: 0o700, recursive: true});
          writeFileSync(fixture.adminPath, 'partial admin child\n');
        });

        const result = yield* observed.reconciler.tick(liveTick(fixture));

        expect(result).toMatchObject({reason: 'registered', state: 'preserved'});
        expect(yield* Ref.get(observed.workerCalls)).toBe(1);
        expect(readViewState(fixture)).toEqual({
          activeSnapshotId: fixture.snapshotId,
          removedSnapshotId: undefined,
          snapshotState: 'ready',
        });
        expect(readFileSync(fixture.adminPath, 'utf8')).toBe('partial admin child\n');
        expect(readFileSync(fixture.mainFile, 'utf8')).toBe('main source\n');
        expect(JSON.stringify(result)).not.toContain(fixture.root);
      }).pipe(Effect.provide(liveLayer)),
    ),
  );

  effectIt.effect('converges one exact tombstone under eight real Bun process contenders', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fixture = yield* createLiveReconciliationFixture('threadnote-reconciliation-process-load-');
        yield* Effect.sync(() => removeLiveLinkedWorktree(fixture));
        const outcomes = yield* Effect.promise(() => runLiveReconciliationContenders(fixture, 8));
        const removed = outcomes.filter(outcome => outcome.state === 'removed');

        expect(removed).toHaveLength(1);
        expect(
          outcomes.every(outcome => {
            if (outcome.state === 'removed') return true;
            if (outcome.state === 'preserved') {
              return ['already-removed', 'no-candidates', 'stale-target'].includes(outcome.reason);
            }
            return outcome.reason === 'target-busy' || outcome.reason === 'writer-busy';
          }),
        ).toBe(true);
        expect(outcomes.every(outcome => !JSON.stringify(outcome).includes(fixture.root))).toBe(true);
        const view = readViewState(fixture);
        expect(view.activeSnapshotId).toBeUndefined();
        expect(view.removedSnapshotId).toBe(fixture.snapshotId);
        expect(['retired', undefined]).toContain(view.snapshotState);
        expect(readFileSync(fixture.mainFile, 'utf8')).toBe('main source\n');
        expect(existsSync(fixture.provenancePath)).toBe(true);
      }).pipe(Effect.provide(liveLayer)),
    ),
  );

  effectIt.effect.prop(
    'mutates through the real reconciler iff every generated authority predicate is exact',
    {
      anchorMatches: fc.boolean(),
      evidenceStable: fc.boolean(),
      finalAbsent: fc.boolean(),
      initialAbsent: fc.boolean(),
      linkedRegistration: fc.boolean(),
      maintenanceInactive: fc.boolean(),
      missingProvenance: fc.boolean(),
      registryRootStable: fc.boolean(),
    },
    predicates =>
      Effect.gen(function* () {
        const removals = yield* Ref.make(0);
        let evidenceReads = 0;
        let authorityReads = 0;
        const dependencies = successfulDependencies({
          maintenanceIntentActive: () => Effect.succeed(!predicates.maintenanceInactive),
          observeAuthority: () =>
            Effect.sync(() => {
              authorityReads += 1;
              if (authorityReads === 1) {
                return {
                  ...absentBatch,
                  pathStates: [predicates.missingProvenance ? ('missing' as const) : ('present' as const)],
                  registryStates: [predicates.initialAbsent ? ('absent' as const) : ('present' as const)],
                };
              }
              return {
                ...absentFinal,
                registryRootIdentity: predicates.registryRootStable ? absentFinal.registryRootIdentity : '6'.repeat(64),
                registryStates: [predicates.finalAbsent ? ('absent' as const) : ('present' as const)],
              };
            }),
          readEvidenceCandidate: () =>
            Effect.sync(() => {
              evidenceReads += 1;
              if (!predicates.linkedRegistration) return {state: 'main'} as const;
              return !predicates.evidenceStable && evidenceReads > 1
                ? {...linkedEvidence, recordIdentity: '8'.repeat(64)}
                : linkedEvidence;
            }),
          removeView: () => Ref.update(removals, count => count + 1).pipe(Effect.as(removedResult())),
          resolveAnchor: () =>
            Effect.succeed(predicates.anchorMatches ? anchor : {...anchor, repositoryId: '7'.repeat(64)}),
        });

        const result = yield* (yield* makeCodeGraphWorktreeReconciler(dependencies)).tick(tick());
        const expected =
          predicates.anchorMatches &&
          predicates.evidenceStable &&
          predicates.finalAbsent &&
          predicates.initialAbsent &&
          predicates.linkedRegistration &&
          predicates.maintenanceInactive &&
          predicates.missingProvenance &&
          predicates.registryRootStable;
        expect(result.state === 'removed').toBe(expected);
        expect(yield* Ref.get(removals)).toBe(expected ? 1 : 0);
      }),
  );
});

interface LiveReconciliationFixture {
  readonly adminPath: string;
  readonly home: string;
  readonly layout: CodeGraphLayout;
  readonly linked: string;
  readonly linkedIdentity: RepositoryIdentity;
  readonly main: string;
  readonly mainFile: string;
  readonly mainIdentity: RepositoryIdentity;
  readonly provenancePath: string;
  readonly root: string;
  readonly snapshotId: string;
}

const observedLiveReconciler = Effect.gen(function* () {
  const command = yield* CommandExecutor;
  const workerCalls = yield* Ref.make(0);
  const countingCommand = CommandExecutor.of({
    execute: command.execute,
    executeBytes: (executable, args, options) =>
      Ref.update(
        workerCalls,
        count => count + (args.includes(CODE_GRAPH_GIT_WORKTREE_REGISTRATION_WORKER_ARGUMENT) ? 1 : 0),
      ).pipe(Effect.andThen(command.executeBytes!(executable, args, options))),
    executeStreaming: command.executeStreaming,
  });
  const reconciler = yield* makeLiveCodeGraphWorktreeReconciler().pipe(
    Effect.provideService(CommandExecutor, countingCommand),
  );
  return {reconciler, workerCalls};
});

function createLiveReconciliationFixture(prefix: string) {
  return Effect.gen(function* () {
    const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    temporaryRoots.push(root);
    const home = join(root, 'home');
    const main = join(root, 'main');
    const linked = join(root, 'linked');
    const mainFile = join(main, 'main.txt');
    yield* Effect.sync(() => {
      mkdirSync(home, {mode: 0o700});
      mkdirSync(main, {mode: 0o700});
      runGit(main, ['init', '-q']);
      runGit(main, ['config', 'user.name', 'Threadnote Test']);
      runGit(main, ['config', 'user.email', 'threadnote-test@example.invalid']);
      writeFileSync(mainFile, 'main source\n');
      runGit(main, ['add', 'main.txt']);
      runGit(main, ['commit', '-qm', 'initial']);
      runGit(main, ['worktree', 'add', '-q', '-b', 'e4-linked', linked]);
    });
    const mainIdentity = yield* resolveRepositoryIdentity(main);
    const linkedIdentity = yield* resolveRepositoryIdentity(linked);
    const adminPath = yield* Effect.sync(() =>
      execFileSync('git', ['-C', linked, 'rev-parse', '--path-format=absolute', '--git-dir'], {
        encoding: 'utf8',
      }).trim(),
    );
    const association = yield* recordVerifiedCodeGraphLocalAssociation(home, linkedIdentity);
    if (association.state !== 'verified') {
      return yield* Effect.fail(new Error('Could not record the exact linked-worktree provenance fixture.'));
    }
    const path = yield* Path.Path;
    const layout = codeGraphLayout(path, home, linkedIdentity.checkoutId, linkedIdentity.worktreeId);
    const snapshotId = `cgsn_${'9'.repeat(40)}`;
    const snapshot = {
      commit: linkedIdentity.headCommit,
      completedAt: '2026-08-08T00:00:00.000Z',
      dirty: false,
      edgeCount: 0,
      extractorSet: 'worktree-reconciliation-live-test',
      fileCount: 0,
      id: snapshotId,
      repositoryId: linkedIdentity.repositoryId,
      state: 'ready',
      symbolCount: 0,
      worktreeId: linkedIdentity.worktreeId,
    } satisfies CodeGraphSnapshot;
    const store = yield* CodeGraphStore;
    yield* store.activate(layout.databasePath, linkedIdentity, snapshot, [], [], []);
    yield* store.promote(layout.databasePath, linkedIdentity, snapshotId);
    const provenancePath = join(
      layout.repositoryRoot,
      'local-context',
      'worktrees',
      `${linkedIdentity.worktreeId}.json`,
    );
    if (!existsSync(provenancePath)) {
      return yield* Effect.fail(new Error('The exact linked-worktree provenance fixture is missing.'));
    }
    return {
      adminPath,
      home,
      layout,
      linked,
      linkedIdentity,
      main,
      mainFile,
      mainIdentity,
      provenancePath,
      root,
      snapshotId,
    } satisfies LiveReconciliationFixture;
  });
}

function liveTick(fixture: LiveReconciliationFixture) {
  return {
    anchorIdentity: fixture.mainIdentity,
    checkoutId: fixture.mainIdentity.checkoutId,
    databasePath: fixture.layout.databasePath,
    threadnoteHome: fixture.home,
    writerLockPath: fixture.layout.databaseWriteLockPath,
  } as const;
}

function removeLiveLinkedWorktree(fixture: LiveReconciliationFixture): void {
  runGit(fixture.main, ['worktree', 'remove', '--force', fixture.linked]);
}

function readViewState(fixture: LiveReconciliationFixture): {
  readonly activeSnapshotId?: string;
  readonly removedSnapshotId?: string;
  readonly snapshotState?: string;
} {
  const database = new Database(fixture.layout.databasePath, {readonly: true, strict: true});
  try {
    const active = database
      .query('SELECT snapshot_id FROM active_snapshots WHERE worktree_id = ?')
      .get(fixture.linkedIdentity.worktreeId) as {readonly snapshot_id: string} | null;
    const removed = database
      .query('SELECT expected_snapshot_id FROM removed_views WHERE worktree_id = ?')
      .get(fixture.linkedIdentity.worktreeId) as {readonly expected_snapshot_id: string} | null;
    const snapshot = database.query('SELECT state FROM snapshots WHERE id = ?').get(fixture.snapshotId) as {
      readonly state: string;
    } | null;
    return {
      activeSnapshotId: active?.snapshot_id,
      removedSnapshotId: removed?.expected_snapshot_id,
      snapshotState: snapshot?.state,
    };
  } finally {
    database.close(false);
  }
}

function runGit(cwd: string, args: readonly string[]): void {
  execFileSync('git', ['-C', cwd, ...args], {stdio: 'pipe'});
}

async function runLiveReconciliationContenders(
  fixture: LiveReconciliationFixture,
  count: number,
): Promise<readonly CodeGraphWorktreeReconciliationResult[]> {
  const barrier = join(fixture.root, 'contender-barrier');
  mkdirSync(barrier, {mode: 0o700});
  const contenders = Array.from({length: count}, (_, index) => runLiveReconciliationContender(fixture, barrier, index));
  const completed = Promise.all(contenders);
  await Promise.race([
    waitForContenderBarrier(barrier, count, 10_000),
    completed.then(() => Promise.reject(new Error('E4 contenders exited before the shared barrier was released.'))),
  ]);
  writeFileSync(join(barrier, 'release'), 'go\n', {mode: 0o600});
  return await completed;
}

async function runLiveReconciliationContender(
  fixture: LiveReconciliationFixture,
  barrier: string,
  contender: number,
): Promise<CodeGraphWorktreeReconciliationResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--eval', LIVE_RECONCILIATION_CONTENDER_SOURCE], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        THREADNOTE_E4_CONTENDER_ANCHOR: fixture.main,
        THREADNOTE_E4_CONTENDER_BARRIER: barrier,
        THREADNOTE_E4_CONTENDER_ID: String(contender),
        THREADNOTE_E4_CONTENDER_HOME: fixture.home,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const maximumOutputCharacters = 64 * 1_024;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout = `${stdout}${String(chunk)}`.slice(-maximumOutputCharacters);
    });
    child.stderr.on('data', chunk => {
      stderr = `${stderr}${String(chunk)}`.slice(-maximumOutputCharacters);
    });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.once('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', code => {
      clearTimeout(timeout);
      const resultLine = stdout.split(/\r?\n/u).find(line => line.startsWith('THREADNOTE_E4_RESULT='));
      if (code !== 0 || resultLine === undefined) {
        reject(new Error(`E4 contender exited ${String(code)}: ${stderr || stdout}`));
        return;
      }
      try {
        resolve(JSON.parse(resultLine.slice('THREADNOTE_E4_RESULT='.length)) as CodeGraphWorktreeReconciliationResult);
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function waitForContenderBarrier(barrier: string, count: number, timeoutMilliseconds: number): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  for (;;) {
    if (Array.from({length: count}, (_, index) => existsSync(join(barrier, `${index}.ready`))).every(Boolean)) return;
    if (Date.now() >= deadline) throw new Error('E4 contenders did not reach the shared barrier in time.');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

const LIVE_RECONCILIATION_CONTENDER_SOURCE = String.raw`
import * as BunServices from '@effect/platform-bun/BunServices';
import {Effect, Layer, Path} from 'effect';
import {CommandExecutor} from './src/effect/command.ts';
import {SystemInfo} from './src/effect/system.ts';
import {codeGraphLayout} from './src/code_graph/layout.ts';
import {resolveRepositoryIdentity} from './src/code_graph/repository.ts';
import {CodeGraphStore} from './src/code_graph/store.ts';
import {makeLiveCodeGraphWorktreeReconciler} from './src/code_graph/worktree_reconciliation.ts';

const layer = Layer.merge(CodeGraphStore.layer, CommandExecutor.layer).pipe(
  Layer.provideMerge(SystemInfo.layer),
  Layer.provideMerge(BunServices.layer),
);
const result = await Effect.runPromise(
  Effect.gen(function* () {
    const home = process.env.THREADNOTE_E4_CONTENDER_HOME;
    const anchorPath = process.env.THREADNOTE_E4_CONTENDER_ANCHOR;
    const barrier = process.env.THREADNOTE_E4_CONTENDER_BARRIER;
    const contender = process.env.THREADNOTE_E4_CONTENDER_ID;
    if (!home || !anchorPath || !barrier || !contender) {
      return yield* Effect.fail(new Error('E4 contender fixture is unavailable.'));
    }
    const anchor = yield* resolveRepositoryIdentity(anchorPath);
    const path = yield* Path.Path;
    const layout = codeGraphLayout(path, home, anchor.checkoutId, anchor.worktreeId);
    const reconciler = yield* makeLiveCodeGraphWorktreeReconciler();
    yield* Effect.promise(async () => {
      await Bun.write(barrier + '/' + contender + '.ready', 'ready\n');
      while (!(await Bun.file(barrier + '/release').exists())) await Bun.sleep(5);
    });
    return yield* reconciler.tick({
      anchorIdentity: anchor,
      checkoutId: anchor.checkoutId,
      databasePath: layout.databasePath,
      threadnoteHome: home,
      writerLockPath: layout.databaseWriteLockPath,
    });
  }).pipe(Effect.provide(layer)),
);
process.stdout.write('THREADNOTE_E4_RESULT=' + JSON.stringify(result) + '\n');
`;

function authoritySequence(
  initial: CodeGraphWorktreeReconciliationAuthorityObservation,
  final: CodeGraphWorktreeReconciliationAuthorityObservation,
): () => Effect.Effect<CodeGraphWorktreeReconciliationAuthorityObservation> {
  let calls = 0;
  return () =>
    Effect.sync(() => {
      calls += 1;
      return calls === 1 ? initial : final;
    });
}

function successfulDependencies(
  overrides: Partial<CodeGraphWorktreeReconciliationDependencies> = {},
): CodeGraphWorktreeReconciliationDependencies {
  return {
    listCandidates: () => Effect.succeed([candidate]),
    maintenanceIntentActive: () => Effect.succeed(false),
    observeAuthority: () => Effect.succeed(absentBatch),
    readEvidenceCandidate: () => Effect.succeed(linkedEvidence),
    removeView: () => Effect.succeed(removedResult()),
    resolveAnchor: () => Effect.succeed(anchor),
    withTargetLock: (_input, _worktreeId, effect) => effect,
    ...overrides,
  };
}

function removedResult(): CodeGraphViewRemovalResult {
  return {expectedSnapshotId, retiredSnapshots: 1, state: 'removed'};
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

function append(ref: Ref.Ref<string[]>, event: string) {
  return Ref.update(ref, events => [...events, event]);
}

function seedCandidateViews(databasePath: string, worktreeIds: readonly string[], tombstoneLast = true): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database
      .query(
        `INSERT INTO repositories (id, display_name, object_format, created_at, last_used_at)
         VALUES (?, 'threadnote/reconciliation-cursor', 'sha1', ?, ?)`,
      )
      .run(repositoryId, new Date(0).toISOString(), new Date(0).toISOString());
    const insertSnapshot = database.prepare(
      `INSERT INTO snapshots (
         id, repository_id, worktree_id, commit_id, graph_content_id, base_snapshot_id, extractor_set,
         dirty, overlay_fingerprint, state, file_count, symbol_count, edge_count, started_at, completed_at,
         failure_summary
       ) VALUES (?, ?, ?, ?, ?, NULL, 'reconciliation-test', 0, NULL, 'ready', 0, 0, 0, ?, ?, NULL)`,
    );
    const insertGeneration = database.prepare(
      'INSERT INTO snapshot_extractor_generations (snapshot_id, generation) VALUES (?, ?)',
    );
    const insertView = database.prepare(
      'INSERT INTO active_snapshots (worktree_id, snapshot_id, activated_at) VALUES (?, ?, ?)',
    );
    database.transaction(() => {
      for (const [index, worktreeId] of worktreeIds.entries()) {
        const snapshotId = `cgsn_${index.toString(16).padStart(40, '0')}`;
        insertSnapshot.run(
          snapshotId,
          repositoryId,
          worktreeId,
          index.toString(16).padStart(40, '0'),
          `content-${index}`,
          new Date(index).toISOString(),
          new Date(index + 1).toISOString(),
        );
        insertGeneration.run(snapshotId, CODE_GRAPH_EXTRACTOR_GENERATION);
        insertView.run(worktreeId, snapshotId, new Date(index + 100).toISOString());
      }
      if (tombstoneLast) {
        database
          .query('INSERT INTO removed_views (worktree_id, expected_snapshot_id, removed_at) VALUES (?, ?, ?)')
          .run(
            worktreeIds.at(-1)!,
            `cgsn_${(worktreeIds.length - 1).toString(16).padStart(40, '0')}`,
            new Date().toISOString(),
          );
      }
    })();
  } finally {
    database.close(false);
  }
}

function tombstoneEveryActiveView(databasePath: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database.run(`INSERT INTO removed_views (worktree_id, expected_snapshot_id, removed_at)
      SELECT worktree_id, snapshot_id, '2026-08-08T00:00:00.000Z'
      FROM active_snapshots
      WHERE 1
      ON CONFLICT(worktree_id) DO UPDATE SET expected_snapshot_id = excluded.expected_snapshot_id`);
  } finally {
    database.close(false);
  }
}

function removeViewTombstone(databasePath: string, worktreeId: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database.query('DELETE FROM removed_views WHERE worktree_id = ?').run(worktreeId);
  } finally {
    database.close(false);
  }
}

function readReconciliationCursor(databasePath: string): string | undefined {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    const row = database
      .query("SELECT value FROM schema_metadata WHERE key = 'worktree_reconciliation_cursor'")
      .get() as {readonly value: string} | null;
    return row?.value;
  } finally {
    database.close(false);
  }
}

function republishLegacyActivePointer(
  databasePath: string,
  worktreeId: string,
  snapshotId: string,
  exactTombstone: boolean,
): void {
  const database = new Database(databasePath, {strict: true});
  try {
    if (!exactTombstone) {
      database
        .query('UPDATE removed_views SET expected_snapshot_id = ? WHERE worktree_id = ?')
        .run(`cgsn_${'f'.repeat(40)}`, worktreeId);
    }
    database
      .query('INSERT INTO active_snapshots (worktree_id, snapshot_id, activated_at) VALUES (?, ?, ?)')
      .run(worktreeId, snapshotId, '2026-08-08T00:00:00.000Z');
  } finally {
    database.close(false);
  }
}

function readLegacyRepublishState(
  databasePath: string,
  worktreeId: string,
  snapshotId: string,
): {readonly activeSnapshotId?: string; readonly removedSnapshotId?: string; readonly snapshotState?: string} {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    const active = database.query('SELECT snapshot_id FROM active_snapshots WHERE worktree_id = ?').get(worktreeId) as {
      readonly snapshot_id: string;
    } | null;
    const removed = database
      .query('SELECT expected_snapshot_id FROM removed_views WHERE worktree_id = ?')
      .get(worktreeId) as {readonly expected_snapshot_id: string} | null;
    const snapshot = database.query('SELECT state FROM snapshots WHERE id = ?').get(snapshotId) as {
      readonly state: string;
    } | null;
    return {
      activeSnapshotId: active?.snapshot_id,
      removedSnapshotId: removed?.expected_snapshot_id,
      snapshotState: snapshot?.state,
    };
  } finally {
    database.close(false);
  }
}

function seedBlockedDescendantChain(databasePath: string, baseSnapshotId: string, count: number): void {
  const database = new Database(databasePath, {strict: true});
  try {
    const insert = database.prepare(
      `INSERT INTO snapshots (
         id, repository_id, worktree_id, commit_id, graph_content_id, base_snapshot_id, extractor_set,
         dirty, overlay_fingerprint, state, file_count, symbol_count, edge_count, started_at, completed_at,
         failure_summary
       ) VALUES (?, ?, ?, ?, ?, ?, 'reconciliation-test', 0, NULL, 'ready', 0, 0, 0, ?, ?, NULL)`,
    );
    database.transaction(() => {
      let parent = baseSnapshotId;
      for (let index = 1; index <= count; index += 1) {
        const snapshotId = `cgsn_${index.toString(16).padStart(40, '0')}`;
        insert.run(
          snapshotId,
          repositoryId,
          (index + 20_000).toString(16).padStart(64, '0'),
          index.toString(16).padStart(40, '0'),
          `descendant-content-${index}`,
          parent,
          new Date(index).toISOString(),
          new Date(index + 1).toISOString(),
        );
        parent = snapshotId;
      }
    })();
  } finally {
    database.close(false);
  }
}

function queryPlan(
  databasePath: string,
  statement: {readonly parameters: readonly (number | string)[]; readonly text: string},
): readonly {readonly detail: string}[] {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return database.query(`EXPLAIN QUERY PLAN ${statement.text}`).all(...statement.parameters) as readonly {
      readonly detail: string;
    }[];
  } finally {
    database.close(false);
  }
}

function seedIncompatibleDeleteJournalDatabase(databasePath: string): void {
  const database = new Database(databasePath, {create: true, strict: true});
  try {
    database.run('PRAGMA journal_mode = DELETE');
    database.run('CREATE TABLE schema_metadata (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)');
    database.query('INSERT INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '3');
  } finally {
    database.close(false);
  }
}

function readJournalMode(databasePath: string): string {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    const row = database.query('PRAGMA journal_mode').get() as {readonly journal_mode: string};
    return row.journal_mode;
  } finally {
    database.close(false);
  }
}

function executeDatabaseSql(databasePath: string, sql: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database.run(sql);
  } finally {
    database.close(false);
  }
}

function rebuildCanonicalTableDefinition(
  databasePath: string,
  tableName: string,
  mutate: (definition: string) => string,
): void {
  const database = new Database(databasePath, {strict: true});
  try {
    const row = database.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName) as {
      readonly sql: string;
    } | null;
    if (row === null) throw new Error(`missing canonical table ${tableName}`);
    const changed = mutate(row.sql);
    if (changed === row.sql) throw new Error(`canonical table mutation did not change ${tableName}`);
    const temporaryTable = `${tableName}_drift_fixture`;
    const temporaryDefinition = changed.replace(
      new RegExp(`^CREATE TABLE(?: IF NOT EXISTS)? "?${tableName}"?`, 'u'),
      `CREATE TABLE ${temporaryTable}`,
    );
    if (temporaryDefinition === changed) throw new Error(`cannot derive temporary table for ${tableName}`);
    const columns = (
      database.query(`PRAGMA table_xinfo('${tableName}')`).all() as readonly {
        readonly hidden: number;
        readonly name: string;
      }[]
    )
      .filter(column => column.hidden === 0)
      .map(column => `"${column.name.replaceAll('"', '""')}"`)
      .join(', ');
    const dependentDefinitions = database
      .query<{readonly sql: string}, [string]>(
        `SELECT sql FROM sqlite_master
         WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL
         ORDER BY type, name`,
      )
      .all(tableName)
      .map(dependent => dependent.sql);
    database.run('PRAGMA foreign_keys = OFF');
    database.run('PRAGMA ignore_check_constraints = ON');
    database.run('BEGIN IMMEDIATE');
    try {
      database.run(temporaryDefinition);
      database.run(`INSERT INTO "${temporaryTable}" (${columns}) SELECT ${columns} FROM "${tableName}"`);
      database.run(`DROP TABLE "${tableName}"`);
      database.run(changed);
      database.run(`INSERT INTO "${tableName}" (${columns}) SELECT ${columns} FROM "${temporaryTable}"`);
      database.run(`DROP TABLE "${temporaryTable}"`);
      for (const dependent of dependentDefinitions) database.run(dependent);
      database.run('COMMIT');
    } catch (error) {
      if (database.inTransaction) database.run('ROLLBACK');
      throw error;
    } finally {
      database.run('PRAGMA ignore_check_constraints = OFF');
      database.run('PRAGMA foreign_keys = ON');
    }
  } finally {
    database.close(false);
  }
}

function indexDefinition(databasePath: string, index: string): string | undefined {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    const row = database.query("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(index) as {
      readonly sql: string;
    } | null;
    return row?.sql;
  } finally {
    database.close(false);
  }
}

function extensionDefinitionAndRows(databasePath: string): {
  readonly definition: string | undefined;
  readonly rows: readonly {readonly payload: string; readonly sentinel: string}[];
} {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    const definition = database
      .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'snapshot_analysis_summary_receipts'")
      .get() as {readonly sql: string} | null;
    const rows = database
      .query('SELECT sentinel, payload FROM snapshot_analysis_summary_receipts ORDER BY sentinel')
      .all() as readonly {readonly payload: string; readonly sentinel: string}[];
    return {definition: definition?.sql, rows};
  } finally {
    database.close(false);
  }
}

function seedReadyOrphanSnapshots(databasePath: string, count: number, startIndex: number): void {
  const database = new Database(databasePath, {strict: true});
  try {
    const insertSnapshot = database.prepare(
      `INSERT INTO snapshots (
         id, repository_id, worktree_id, commit_id, graph_content_id, base_snapshot_id, extractor_set,
         dirty, overlay_fingerprint, state, file_count, symbol_count, edge_count, started_at, completed_at,
         failure_summary
       ) VALUES (?, ?, ?, ?, ?, NULL, 'reconciliation-test', 0, NULL, 'ready', 0, 0, 0, ?, ?, NULL)`,
    );
    const insertGeneration = database.prepare(
      'INSERT INTO snapshot_extractor_generations (snapshot_id, generation) VALUES (?, ?)',
    );
    database.transaction(() => {
      for (let offset = 0; offset < count; offset += 1) {
        const index = startIndex + offset;
        const snapshotId = `cgsn_${index.toString(16).padStart(40, '0')}`;
        insertSnapshot.run(
          snapshotId,
          repositoryId,
          (index + 10_000).toString(16).padStart(64, '0'),
          index.toString(16).padStart(40, '0'),
          `orphan-content-${index}`,
          new Date(index).toISOString(),
          new Date(index + 1).toISOString(),
        );
        insertGeneration.run(snapshotId, CODE_GRAPH_EXTRACTOR_GENERATION);
      }
    })();
  } finally {
    database.close(false);
  }
}

function seedRetirementProtectionGraph(databasePath: string, snapshotIds: readonly string[]): void {
  const database = new Database(databasePath, {strict: true});
  try {
    const insertSnapshot = database.prepare(
      `INSERT INTO snapshots (
         id, repository_id, worktree_id, commit_id, graph_content_id, base_snapshot_id, extractor_set,
         dirty, overlay_fingerprint, state, file_count, symbol_count, edge_count, started_at, completed_at,
         failure_summary
       ) VALUES (?, ?, ?, ?, ?, ?, 'reconciliation-test', 0, NULL, ?, 0, 0, 0, ?, ?, NULL)`,
    );
    const insertGeneration = database.prepare(
      'INSERT INTO snapshot_extractor_generations (snapshot_id, generation) VALUES (?, ?)',
    );
    const insertActive = database.prepare(
      'INSERT INTO active_snapshots (worktree_id, snapshot_id, activated_at) VALUES (?, ?, ?)',
    );
    const insertDerived = (id: string, worktreeId: string, baseSnapshotId: string, state: 'ready' | 'retired') => {
      insertSnapshot.run(
        id,
        repositoryId,
        worktreeId,
        'f'.repeat(40),
        `derived-${id}`,
        baseSnapshotId,
        state,
        new Date(20_000).toISOString(),
        new Date(20_001).toISOString(),
      );
      insertGeneration.run(id, CODE_GRAPH_EXTRACTOR_GENERATION);
    };
    database.transaction(() => {
      const warmChild = `cgsn_${'a'.repeat(40)}`;
      insertDerived(warmChild, '6'.repeat(64), snapshotIds[1]!, 'ready');

      insertActive.run('9'.repeat(64), snapshotIds[2]!, new Date(30_000).toISOString());

      const retiredIntermediate = `cgsn_${'b'.repeat(40)}`;
      const activeGrandchild = `cgsn_${'c'.repeat(40)}`;
      insertDerived(retiredIntermediate, '7'.repeat(64), snapshotIds[3]!, 'retired');
      insertDerived(activeGrandchild, '8'.repeat(64), retiredIntermediate, 'ready');
      insertActive.run('8'.repeat(64), activeGrandchild, new Date(30_001).toISOString());

      database
        .query(
          `INSERT INTO snapshot_leases (token, snapshot_id, expires_at, retire_when_inactive)
           VALUES ('expired-only', ?, ?, 0)`,
        )
        .run(snapshotIds[4]!, Date.now() - 1);
    })();
  } finally {
    database.close(false);
  }
}

function seedReadySnapshotChild(databasePath: string, baseSnapshotId: string, childSnapshotId: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database
      .query(
        `INSERT INTO snapshots (
           id, repository_id, worktree_id, commit_id, graph_content_id, base_snapshot_id, extractor_set,
           dirty, overlay_fingerprint, state, file_count, symbol_count, edge_count, started_at, completed_at,
           failure_summary
         ) SELECT ?, repository_id, ?, commit_id, ?, ?, extractor_set,
             dirty, overlay_fingerprint, 'ready', 0, 0, 0, started_at, completed_at, NULL
           FROM snapshots WHERE id = ?`,
      )
      .run(childSnapshotId, 'e'.repeat(64), `child-${childSnapshotId}`, baseSnapshotId, baseSnapshotId);
    database
      .query('INSERT INTO snapshot_extractor_generations (snapshot_id, generation) VALUES (?, ?)')
      .run(childSnapshotId, CODE_GRAPH_EXTRACTOR_GENERATION);
  } finally {
    database.close(false);
  }
}

function seedLeaseReleaseCounterexample(
  databasePath: string,
  baseSnapshotId: string,
  targetSnapshotId: string,
  blockingChildId: string,
): void {
  const database = new Database(databasePath, {strict: true});
  try {
    const clone = database.prepare(
      `INSERT INTO snapshots (
         id, repository_id, worktree_id, commit_id, graph_content_id, base_snapshot_id, extractor_set,
         dirty, overlay_fingerprint, state, file_count, symbol_count, edge_count, started_at, completed_at,
         failure_summary
       ) SELECT ?, repository_id, ?, commit_id, ?, ?, extractor_set,
           dirty, overlay_fingerprint, 'ready', 0, 0, 0, started_at, completed_at, NULL
         FROM snapshots WHERE id = ?`,
    );
    const generation = database.prepare(
      'INSERT INTO snapshot_extractor_generations (snapshot_id, generation) VALUES (?, ?)',
    );
    database.transaction(() => {
      clone.run(baseSnapshotId, '3'.repeat(64), `base-${baseSnapshotId}`, null, targetSnapshotId);
      generation.run(baseSnapshotId, CODE_GRAPH_EXTRACTOR_GENERATION);
      database.query('UPDATE snapshots SET base_snapshot_id = ? WHERE id = ?').run(baseSnapshotId, targetSnapshotId);
      clone.run(blockingChildId, '4'.repeat(64), `child-${blockingChildId}`, targetSnapshotId, targetSnapshotId);
      generation.run(blockingChildId, CODE_GRAPH_EXTRACTOR_GENERATION);
    })();
  } finally {
    database.close(false);
  }
}

function readExactRetirementState(databasePath: string, selectedSnapshotId: string) {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    const active = database
      .query('SELECT snapshot_id FROM active_snapshots WHERE worktree_id = ?')
      .get(targetWorktreeId) as {readonly snapshot_id: string} | null;
    const removed = database
      .query('SELECT expected_snapshot_id FROM removed_views WHERE worktree_id = ?')
      .get(targetWorktreeId) as {readonly expected_snapshot_id: string} | null;
    const selected = database.query('SELECT state FROM snapshots WHERE id = ?').get(selectedSnapshotId) as {
      readonly state: string;
    } | null;
    const ready = database
      .query("SELECT COUNT(*) AS count FROM snapshots WHERE id <> ? AND state = 'ready'")
      .get(selectedSnapshotId) as {readonly count: number};
    return {
      activeSnapshotId: active?.snapshot_id,
      readyOrphans: Number(ready.count),
      removedSnapshotId: removed?.expected_snapshot_id,
      selectedState: selected?.state,
    };
  } finally {
    database.close(false);
  }
}

function readSnapshotStates(databasePath: string, snapshotIds: readonly string[]) {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    const rows = database.query('SELECT id, state FROM snapshots').all() as readonly {
      readonly id: string;
      readonly state: string;
    }[];
    const stateById = new Map(rows.map(row => [row.id, row.state]));
    return snapshotIds.map(id => ({id, state: stateById.get(id)}));
  } finally {
    database.close(false);
  }
}
