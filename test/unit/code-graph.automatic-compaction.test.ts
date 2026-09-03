import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Deferred, Effect, Fiber, FileSystem, Layer, Path, Ref, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  CODE_GRAPH_AUTOMATIC_COMPACTION_INPUT_BYTES_MAXIMUM,
  automaticCompactionWorkerEnvironment,
  claimCodeGraphAutomaticCompactionCandidate,
  codeGraphAutomaticCompactionCandidateAllowed,
  codeGraphAutomaticCompactionCheckoutWindow,
  codeGraphAutomaticCompactionWorkerInvocation,
  compactCodeGraphStorageIsolated,
  decodeAutomaticCompactionWorkerRequest,
  decodeAutomaticCompactionWorkerResponse,
  listCodeGraphAutomaticCompactionCheckoutIds,
  recordCodeGraphAutomaticCompactionAttempt,
  runCodeGraphAutomaticCompactionLoopWith,
  runCodeGraphAutomaticCompactionPassWith,
  selectCodeGraphAutomaticCompactionCandidate,
  type CodeGraphAutomaticCompactionCandidate,
  type CodeGraphAutomaticCompactionResult,
} from '../../src/code_graph/automatic_compaction.js';
import {codeGraphRepositoriesRoot, codeGraphRepositoryRoot} from '../../src/code_graph/layout.js';
import {managerGraphStorageStatusCheckoutIds, managerGraphStorageSummary} from '../../src/code_graph/manager_status.js';
import {compactCodeGraphStorage, type CodeGraphActiveStorage} from '../../src/code_graph/storage.js';
import {CODE_GRAPH_SCHEMA_VERSION} from '../../src/code_graph/types.js';
import {CommandExecutor} from '../../src/effect/command.js';
import {SystemInfo} from '../../src/effect/system.js';

const GIB = 1024 * 1024 * 1024;
const AUTOMATIC_COMPACTION_RECEIPT_FILE = 'automatic-compaction-v1.json';
const AutomaticCompactionReceiptTestLayer = Layer.mergeAll(BunServices.layer, SystemInfo.layer);
const AutomaticCompactionIsolatedTestLayer = CommandExecutor.layer.pipe(
  Layer.provideMerge(SystemInfo.layer),
  Layer.provideMerge(BunServices.layer),
);

class AutomaticCompactionTestError extends Schema.TaggedError<AutomaticCompactionTestError>()(
  'AutomaticCompactionTestError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
  },
) {}

function availableStorage(
  checkoutId: string,
  options: {
    readonly availableBytes?: number;
    readonly opportunityBytes: number;
    readonly reason?: 'freelist' | 'freelist-and-fragmentation';
    readonly reclaimableBytes?: number;
    readonly recommended?: boolean;
  },
): CodeGraphActiveStorage {
  const databaseBytes = 4 * GIB;
  const reclaimableBytes = options.reclaimableBytes ?? options.opportunityBytes;
  return {
    ...(options.availableBytes === undefined ? {} : {availableBytes: options.availableBytes}),
    checkoutId,
    databaseBytes,
    databasePath: `/redacted/${checkoutId}`,
    filesystemBytes: databaseBytes,
    journalBytes: 0,
    pageStorage: {
      compactionOpportunityBytes: options.opportunityBytes,
      compactionOpportunityRatio: options.opportunityBytes / databaseBytes,
      freelistPages: reclaimableBytes / 4096,
      pageCount: databaseBytes / 4096,
      pageSize: 4096,
      reclaimableBytes,
      reclaimableRatio: reclaimableBytes / databaseBytes,
      state: 'available',
      threshold: {
        minimumReclaimableBytes: 512 * 1024 * 1024,
        minimumReclaimableRatio: 0.2,
        recommended: options.recommended ?? true,
        ...(options.recommended === false ? {} : {reason: options.reason ?? 'freelist'}),
      },
    },
    shmBytes: 0,
    state: 'available',
    temporaryBytes: 0,
    totalBytes: databaseBytes,
    walBytes: 0,
  };
}

function compactedSummary(checkoutId: string): CodeGraphAutomaticCompactionResult {
  return {
    action: 'compacted',
    checkoutId,
    reclaimedBytes: GIB,
  };
}

function compactionCandidate(checkoutId: string): CodeGraphAutomaticCompactionCandidate {
  return {
    checkoutId,
    opportunityBytes: GIB,
    opportunityRatio: 0.25,
  };
}

function makeCompactionReceiptFixture(checkoutId: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-automatic-compaction-receipt-'});
    const repositoryRoot = codeGraphRepositoryRoot(path, home, checkoutId);
    yield* fs.makeDirectory(repositoryRoot, {mode: 0o700, recursive: true});
    return {fs, home, path, repositoryRoot};
  });
}

describe('automatic code graph compaction', () => {
  it('reports physical, in-use, and reusable bytes without exposing a local path', () => {
    const storage = availableStorage('a'.repeat(64), {
      availableBytes: 16 * GIB,
      opportunityBytes: GIB,
    });
    const summary = managerGraphStorageSummary(storage);

    expect(summary).toMatchObject({
      databaseBytes: 4 * GIB,
      pageStorage: {
        allocatedBytes: 4 * GIB,
        automaticCompaction: 'eligible',
        inUseBytes: 3 * GIB,
        reusableBytes: GIB,
        state: 'available',
      },
      physicalBytes: 4 * GIB,
      state: 'available',
    });
    expect(JSON.stringify(summary)).not.toContain('/redacted/');
  });

  it('distinguishes unknown disk capacity from verified insufficient space', () => {
    const unknown = managerGraphStorageSummary(availableStorage('a'.repeat(64), {opportunityBytes: GIB}));
    const insufficient = managerGraphStorageSummary(
      availableStorage('b'.repeat(64), {availableBytes: GIB, opportunityBytes: GIB}),
    );

    expect(unknown).toMatchObject({pageStorage: {automaticCompaction: 'space-unknown'}});
    expect(insufficient).toMatchObject({pageStorage: {automaticCompaction: 'waiting-for-space'}});
  });

  it('prioritizes an active repository beyond the bounded lexical prefix', () => {
    const statuses = Array.from({length: 10}, (_, index) => ({
      identity: {checkoutId: index.toString(16).padStart(64, '0')},
      state: index === 9 ? ('running' as const) : ('completed' as const),
      timestamps: {lastProgressAt: `2026-08-12T00:00:${index.toString().padStart(2, '0')}.000Z`},
    }));
    const selected = managerGraphStorageStatusCheckoutIds(statuses);

    expect(selected).toHaveLength(8);
    expect(selected[0]).toBe('9'.padStart(64, '0'));
  });

  effectIt.layer(AutomaticCompactionReceiptTestLayer)(it => {
    it.effect('fails explicitly instead of scanning an unbounded repository inventory', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-automatic-compaction-inventory-'});
        const repositories = codeGraphRepositoriesRoot(path, home);
        yield* fs.makeDirectory(repositories, {mode: 0o700, recursive: true});
        yield* Effect.forEach(
          Array.from({length: 129}, (_, index) => index.toString(16).padStart(64, '0')),
          checkoutId => fs.makeDirectory(path.join(repositories, checkoutId), {mode: 0o700}),
          {concurrency: 8},
        );

        expect(yield* Effect.exit(listCodeGraphAutomaticCompactionCheckoutIds(home))).toMatchObject({
          _tag: 'Failure',
        });
      }),
    );

    it.effect('excludes a checkout symlink before automatic storage inspection', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const checkoutId = 'f'.repeat(64);
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-automatic-compaction-list-link-'});
        const external = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-automatic-compaction-external-'});
        const repositories = codeGraphRepositoriesRoot(path, home);
        yield* fs.makeDirectory(repositories, {mode: 0o700, recursive: true});
        yield* fs.writeFileString(path.join(external, `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`), '', {mode: 0o600});
        yield* fs.symlink(external, codeGraphRepositoryRoot(path, home, checkoutId));

        expect(yield* listCodeGraphAutomaticCompactionCheckoutIds(home)).toEqual([]);
      }),
    );

    it.effect('allows exactly one winner when two Managers concurrently claim the same repository', () =>
      Effect.gen(function* () {
        const checkoutId = '1'.repeat(64);
        const candidate = compactionCandidate(checkoutId);
        const {home} = yield* makeCompactionReceiptFixture(checkoutId);

        const claims = yield* Effect.all(
          [
            claimCodeGraphAutomaticCompactionCandidate(home, candidate),
            claimCodeGraphAutomaticCompactionCandidate(home, candidate),
          ],
          {concurrency: 'unbounded'},
        );

        expect(claims.filter(Boolean)).toHaveLength(1);
        expect(yield* codeGraphAutomaticCompactionCandidateAllowed(home, candidate)).toBe(false);
      }),
    );

    it.effect('persists low-yield success and failure cooldowns across fresh scheduler passes', () =>
      Effect.gen(function* () {
        const lowYieldId = '2'.repeat(64);
        const failedId = '3'.repeat(64);
        const lowYield = compactionCandidate(lowYieldId);
        const failed = compactionCandidate(failedId);
        const {fs, home, path} = yield* makeCompactionReceiptFixture(lowYieldId);
        yield* fs.makeDirectory(codeGraphRepositoryRoot(path, home, failedId), {mode: 0o700, recursive: true});
        yield* recordCodeGraphAutomaticCompactionAttempt(home, lowYield, {
          action: 'compacted',
          reclaimedBytes: 1,
        });
        yield* recordCodeGraphAutomaticCompactionAttempt(home, failed, undefined);
        const compacted = yield* Ref.make<string[]>([]);

        for (const candidate of [lowYield, failed]) {
          const outcome = yield* runCodeGraphAutomaticCompactionPassWith(
            {
              candidateAllowed: codeGraphAutomaticCompactionCandidateAllowed,
              claimCandidate: claimCodeGraphAutomaticCompactionCandidate,
              compact: (_threadnoteHome, checkoutId) =>
                Ref.update(compacted, current => [...current, checkoutId]).pipe(
                  Effect.as(compactedSummary(checkoutId)),
                ),
              inspect: () =>
                Effect.succeed(
                  availableStorage(candidate.checkoutId, {availableBytes: 16 * GIB, opportunityBytes: GIB}),
                ),
              listCheckoutIds: () => Effect.succeed([candidate.checkoutId]),
            },
            home,
          );

          expect(outcome).toMatchObject({state: 'no-candidate'});
          expect(yield* claimCodeGraphAutomaticCompactionCandidate(home, candidate)).toBe(false);
        }
        expect(yield* Ref.get(compacted)).toEqual([]);
      }),
    );

    it.effect('fails closed for malformed and oversized receipts', () =>
      Effect.gen(function* () {
        const malformedId = '4'.repeat(64);
        const oversizedId = '5'.repeat(64);
        const malformed = compactionCandidate(malformedId);
        const oversized = compactionCandidate(oversizedId);
        const {fs, home, path, repositoryRoot} = yield* makeCompactionReceiptFixture(malformedId);
        const oversizedRoot = codeGraphRepositoryRoot(path, home, oversizedId);
        yield* fs.makeDirectory(oversizedRoot, {mode: 0o700, recursive: true});
        yield* fs.writeFileString(path.join(repositoryRoot, AUTOMATIC_COMPACTION_RECEIPT_FILE), '{\n', {
          flag: 'wx',
          mode: 0o600,
        });
        yield* fs.writeFileString(path.join(oversizedRoot, AUTOMATIC_COMPACTION_RECEIPT_FILE), 'x'.repeat(4_097), {
          flag: 'wx',
          mode: 0o600,
        });

        expect(yield* codeGraphAutomaticCompactionCandidateAllowed(home, malformed)).toBe(false);
        expect(yield* claimCodeGraphAutomaticCompactionCandidate(home, malformed)).toBe(false);
        expect(yield* codeGraphAutomaticCompactionCandidateAllowed(home, oversized)).toBe(false);
        expect(yield* claimCodeGraphAutomaticCompactionCandidate(home, oversized)).toBe(false);
      }),
    );

    it.effect('fails closed when either the checkout root or repositories parent is a symbolic link', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const checkoutLinkId = '6'.repeat(64);
        const parentLinkId = '7'.repeat(64);

        const checkoutLinkHome = yield* fs.makeTempDirectoryScoped({
          prefix: 'threadnote-automatic-compaction-checkout-link-',
        });
        const checkoutLinkTarget = yield* fs.makeTempDirectoryScoped({
          prefix: 'threadnote-automatic-compaction-checkout-target-',
        });
        const checkoutRepositoriesRoot = codeGraphRepositoriesRoot(path, checkoutLinkHome);
        yield* fs.makeDirectory(checkoutRepositoriesRoot, {mode: 0o700, recursive: true});
        yield* fs.symlink(checkoutLinkTarget, codeGraphRepositoryRoot(path, checkoutLinkHome, checkoutLinkId));

        const parentLinkHome = yield* fs.makeTempDirectoryScoped({
          prefix: 'threadnote-automatic-compaction-parent-link-',
        });
        const parentLinkTarget = yield* fs.makeTempDirectoryScoped({
          prefix: 'threadnote-automatic-compaction-parent-target-',
        });
        yield* fs.makeDirectory(path.dirname(codeGraphRepositoriesRoot(path, parentLinkHome)), {
          mode: 0o700,
          recursive: true,
        });
        yield* fs.makeDirectory(path.join(parentLinkTarget, parentLinkId), {mode: 0o700});
        yield* fs.symlink(parentLinkTarget, codeGraphRepositoriesRoot(path, parentLinkHome));

        for (const [home, candidate, externalRoot] of [
          [checkoutLinkHome, compactionCandidate(checkoutLinkId), checkoutLinkTarget],
          [parentLinkHome, compactionCandidate(parentLinkId), path.join(parentLinkTarget, parentLinkId)],
        ] as const) {
          expect(yield* codeGraphAutomaticCompactionCandidateAllowed(home, candidate)).toBe(false);
          expect(yield* claimCodeGraphAutomaticCompactionCandidate(home, candidate)).toBe(false);
          expect(yield* fs.exists(path.join(externalRoot, AUTOMATIC_COMPACTION_RECEIPT_FILE))).toBe(false);
        }
      }),
    );

    it.effect('shares a recorded manual compaction outcome with the automatic candidate fence', () =>
      Effect.gen(function* () {
        const checkoutId = '8'.repeat(64);
        const {home} = yield* makeCompactionReceiptFixture(checkoutId);
        expect(yield* compactCodeGraphStorage(home, checkoutId, {dryRun: false})).toMatchObject({
          action: 'missing',
          checkoutId,
        });
        const compacted = yield* Ref.make(false);

        const outcome = yield* runCodeGraphAutomaticCompactionPassWith(
          {
            candidateAllowed: codeGraphAutomaticCompactionCandidateAllowed,
            claimCandidate: claimCodeGraphAutomaticCompactionCandidate,
            compact: () => Ref.set(compacted, true).pipe(Effect.as(compactedSummary(checkoutId))),
            inspect: () =>
              Effect.succeed(availableStorage(checkoutId, {availableBytes: 16 * GIB, opportunityBytes: GIB})),
            listCheckoutIds: () => Effect.succeed([checkoutId]),
          },
          home,
        );

        expect(outcome).toMatchObject({state: 'no-candidate'});
        expect(yield* Ref.get(compacted)).toBe(false);
      }),
    );

    it.effect('propagates an explicit force request across the isolated worker boundary', () =>
      Effect.gen(function* () {
        const checkoutId = '9'.repeat(64);
        const baseSystem = yield* SystemInfo;
        const system = SystemInfo.of({
          ...baseSystem,
          environment: () => ({
            ...baseSystem.environment(),
            ARBITRARY_PARENT_VALUE: 'omit-me',
            HOME: '/bootstrap-home',
            THREADNOTE_TEST_SECRET: 'omit-me-too',
          }),
        });
        const observed = yield* Ref.make<
          {readonly environment: NodeJS.ProcessEnv | undefined; readonly request: unknown} | undefined
        >(undefined);
        const command = CommandExecutor.of({
          execute: (_executable, _arguments, options) =>
            Ref.set(observed, {
              environment: options?.env,
              request: JSON.parse(new TextDecoder().decode(options?.input)) as unknown,
            }).pipe(
              Effect.as({
                exitCode: 0,
                stderr: '',
                stdout: JSON.stringify({
                  ok: true,
                  protocol: 1,
                  result: compactedSummary(checkoutId),
                }),
              }),
            ),
          executeStreaming: () =>
            Effect.die(AutomaticCompactionTestError.make({message: 'unexpected streaming command'})),
        });

        expect(
          yield* compactCodeGraphStorageIsolated('/threadnote-home', checkoutId, {force: true}).pipe(
            Effect.provideService(CommandExecutor, command),
            Effect.provideService(SystemInfo, system),
          ),
        ).toEqual(compactedSummary(checkoutId));
        expect((yield* Ref.get(observed))?.request).toEqual({
          checkoutId,
          force: true,
          operation: 'compact',
          protocol: 1,
          threadnoteHome: '/threadnote-home',
        });
        expect((yield* Ref.get(observed))?.environment).toEqual(
          automaticCompactionWorkerEnvironment(system.environment(), '/threadnote-home'),
        );
        expect((yield* Ref.get(observed))?.environment).toMatchObject({
          HOME: '/bootstrap-home',
          THREADNOTE_CODE_GRAPH_COMPACTION_WORKER: '1',
          THREADNOTE_HOME: '/threadnote-home',
        });
        expect((yield* Ref.get(observed))?.environment).not.toHaveProperty('ARBITRARY_PARENT_VALUE');
        expect((yield* Ref.get(observed))?.environment).not.toHaveProperty('THREADNOTE_TEST_SECRET');
      }),
    );
  });

  effectIt.layer(AutomaticCompactionIsolatedTestLayer)(it => {
    it.effect(
      'boots the real isolated worker with a bounded missing-checkout response',
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-automatic-compaction-worker-'});
          const checkoutId = 'a'.repeat(64);

          expect(
            yield* compactCodeGraphStorageIsolated(home, checkoutId).pipe(
              Effect.timeout('10 seconds'),
              TestClock.withLive,
            ),
          ).toEqual({action: 'missing', checkoutId, reclaimedBytes: 0});
        }),
      15_000,
    );
  });

  effectIt.effect('compacts only the largest eligible database in one pass', () =>
    Effect.gen(function* () {
      const first = 'a'.repeat(64);
      const largest = 'b'.repeat(64);
      const compacted: string[] = [];
      const result = yield* runCodeGraphAutomaticCompactionPassWith(
        {
          compact: (_home, checkoutId) =>
            Effect.sync(() => {
              compacted.push(checkoutId);
              return compactedSummary(checkoutId);
            }),
          inspect: (_home, checkoutId) =>
            Effect.succeed(
              availableStorage(checkoutId, {
                availableBytes: 16 * GIB,
                opportunityBytes: checkoutId === largest ? 3 * GIB : GIB,
              }),
            ),
          listCheckoutIds: () => Effect.succeed([largest, first, largest, 'not-a-checkout']),
        },
        '/threadnote-home',
      );

      expect(compacted).toEqual([largest]);
      expect(result).toMatchObject({
        candidate: {checkoutId: largest, opportunityBytes: 3 * GIB},
        result: {action: 'compacted', checkoutId: largest},
        state: 'attempted',
      });
    }),
  );

  effectIt.effect('waits when the reviewed threshold or disk-headroom gate is not satisfied', () =>
    Effect.gen(function* () {
      const lowSpace = 'c'.repeat(64);
      const belowThreshold = 'd'.repeat(64);
      const compacted: string[] = [];
      const result = yield* runCodeGraphAutomaticCompactionPassWith(
        {
          compact: (_home, checkoutId) =>
            Effect.sync(() => {
              compacted.push(checkoutId);
              return compactedSummary(checkoutId);
            }),
          inspect: (_home, checkoutId) =>
            Effect.succeed(
              availableStorage(checkoutId, {
                availableBytes: checkoutId === lowSpace ? GIB : 16 * GIB,
                opportunityBytes: GIB,
                recommended: checkoutId !== belowThreshold,
              }),
            ),
          listCheckoutIds: () => Effect.succeed([lowSpace, belowThreshold]),
        },
        '/threadnote-home',
      );

      expect(result).toEqual({
        inspected: 2,
        inspectionFailures: 0,
        nextOffset: 1,
        state: 'no-candidate',
      });
      expect(compacted).toEqual([]);
    }),
  );

  effectIt.effect('does not select a structural-slack-only recommendation for automatic compaction', () =>
    Effect.gen(function* () {
      const checkoutId = 'c'.repeat(64);
      const compacted = yield* Ref.make(false);
      const result = yield* runCodeGraphAutomaticCompactionPassWith(
        {
          compact: () => Ref.set(compacted, true).pipe(Effect.as(compactedSummary(checkoutId))),
          inspect: () =>
            Effect.succeed(
              availableStorage(checkoutId, {
                availableBytes: 16 * GIB,
                opportunityBytes: GIB,
                reason: 'freelist-and-fragmentation',
                reclaimableBytes: 0,
              }),
            ),
          listCheckoutIds: () => Effect.succeed([checkoutId]),
        },
        '/threadnote-home',
      );

      expect(result).toMatchObject({state: 'no-candidate'});
      expect(yield* Ref.get(compacted)).toBe(false);
    }),
  );

  effectIt.effect('advances its bounded scan so large homes cannot starve later databases', () =>
    Effect.gen(function* () {
      const checkoutIds = Array.from({length: 130}, (_, index) => index.toString(16).padStart(64, '0'));
      const target = checkoutIds.at(-1)!;
      const compacted: string[] = [];
      const dependencies = {
        compact: (_home: string, checkoutId: string) =>
          Effect.sync(() => {
            compacted.push(checkoutId);
            return compactedSummary(checkoutId);
          }),
        inspect: (_home: string, checkoutId: string) =>
          Effect.succeed(
            availableStorage(checkoutId, {
              availableBytes: 16 * GIB,
              opportunityBytes: GIB,
              recommended: checkoutId === target,
            }),
          ),
        listCheckoutIds: () => Effect.succeed(checkoutIds),
      };

      const first = yield* runCodeGraphAutomaticCompactionPassWith(dependencies, '/threadnote-home');
      expect(first).toEqual({
        inspected: 128,
        inspectionFailures: 0,
        nextOffset: 1,
        state: 'no-candidate',
      });
      const second = yield* runCodeGraphAutomaticCompactionPassWith(dependencies, '/threadnote-home', {
        offset: first.nextOffset,
      });
      expect(second).toMatchObject({nextOffset: 2, state: 'no-candidate'});
      const third = yield* runCodeGraphAutomaticCompactionPassWith(dependencies, '/threadnote-home', {
        offset: second.nextOffset,
      });
      expect(third).toMatchObject({candidate: {checkoutId: target}, nextOffset: 3, state: 'attempted'});
      expect(compacted).toEqual([target]);
    }),
  );

  it('selects the same largest opportunity for every enumeration order', () => {
    const candidate = fc.record({
      checkoutId: fc.stringMatching(/^[0-9a-f]{1,16}$/u),
      opportunityBytes: fc.integer({max: Number.MAX_SAFE_INTEGER, min: 0}),
      opportunityRatio: fc.double({max: 1, min: 0, noNaN: true}),
    });
    fc.assert(
      fc.property(fc.array(candidate, {maxLength: 64}), fc.array(fc.integer()), (candidates, ordering) => {
        const permuted = candidates
          .map((value, index) => ({index, order: ordering[index] ?? 0, value}))
          .sort((left, right) => left.order - right.order || left.index - right.index)
          .map(entry => entry.value);
        expect(selectCodeGraphAutomaticCompactionCandidate(permuted)).toEqual(
          selectCodeGraphAutomaticCompactionCandidate(candidates),
        );
      }),
      {numRuns: 100},
    );
  });

  it('eventually starts the bounded inspection window with every database', () => {
    fc.assert(
      fc.property(fc.integer({max: 300, min: 1}), size => {
        const checkoutIds = Array.from({length: size}, (_, index) => String(index));
        const visited = new Set(
          Array.from(
            {length: size},
            (_, offset) => codeGraphAutomaticCompactionCheckoutWindow(checkoutIds, offset).checkoutIds[0],
          ),
        );
        expect(visited).toEqual(new Set(checkoutIds));
      }),
      {numRuns: 100},
    );
  });

  it('strictly validates the bounded worker protocol and target binding', () => {
    const checkoutId = 'a'.repeat(64);
    const request = JSON.stringify({
      checkoutId,
      force: true,
      operation: 'compact',
      protocol: 1,
      threadnoteHome: '/threadnote-home',
    });
    expect(decodeAutomaticCompactionWorkerRequest(request)).toEqual({
      checkoutId,
      force: true,
      operation: 'compact',
      protocol: 1,
      threadnoteHome: '/threadnote-home',
    });
    expect(decodeAutomaticCompactionWorkerRequest('{')).toBeUndefined();
    expect(
      decodeAutomaticCompactionWorkerRequest(
        JSON.stringify({checkoutId, force: false, operation: 'probe', protocol: 1, threadnoteHome: 'relative/home'}),
      ),
    ).toBeUndefined();
    expect(
      decodeAutomaticCompactionWorkerRequest(
        JSON.stringify({checkoutId, force: 'yes', operation: 'compact', protocol: 1, threadnoteHome: '/home'}),
      ),
    ).toBeUndefined();
    expect(
      decodeAutomaticCompactionWorkerRequest(
        JSON.stringify({
          checkoutId,
          force: false,
          operation: 'compact',
          protocol: 1,
          threadnoteHome: 'x'.repeat(CODE_GRAPH_AUTOMATIC_COMPACTION_INPUT_BYTES_MAXIMUM + 1),
        }),
      ),
    ).toBeUndefined();

    const response = JSON.stringify({
      ok: true,
      protocol: 1,
      result: {action: 'compacted', checkoutId, reclaimedBytes: GIB},
    });
    expect(decodeAutomaticCompactionWorkerResponse(response, checkoutId)).toMatchObject({
      ok: true,
      result: {action: 'compacted', checkoutId},
    });
    expect(decodeAutomaticCompactionWorkerResponse(response, 'b'.repeat(64))).toBeUndefined();
    expect(
      decodeAutomaticCompactionWorkerResponse(
        JSON.stringify({
          ok: true,
          protocol: 1,
          result: {action: 'compacted', checkoutId, reason: 'active-build', reclaimedBytes: GIB},
        }),
      ),
    ).toBeUndefined();
    expect(
      decodeAutomaticCompactionWorkerResponse(
        JSON.stringify({
          ok: true,
          protocol: 1,
          result: {action: 'unexpected', checkoutId, reclaimedBytes: 0},
        }),
      ),
    ).toBeUndefined();
  });

  it('launches the compiled binary directly and the development standalone through Bun', () => {
    expect(
      codeGraphAutomaticCompactionWorkerInvocation({
        executablePath: '/opt/threadnote/bin/threadnote',
        processArguments: ['/opt/threadnote/bin/threadnote', 'manage'],
      }),
    ).toEqual({
      arguments: ['--threadnote-code-graph-compaction-worker'],
      executable: '/opt/threadnote/bin/threadnote',
    });
    expect(
      codeGraphAutomaticCompactionWorkerInvocation({
        executablePath: '/opt/bun/bin/bun',
        processArguments: ['/opt/bun/bin/bun', '/workspace/src/standalone.ts', 'manage'],
      }),
    ).toEqual({
      arguments: ['/workspace/src/standalone.ts', '--threadnote-code-graph-compaction-worker'],
      executable: '/opt/bun/bin/bun',
    });
  });

  effectIt.effect('publishes running status before a long compaction and interrupts it with Manager scope', () =>
    Effect.gen(function* () {
      const checkoutId = 'e'.repeat(64);
      const running = yield* Deferred.make<void>();
      const cancelled = yield* Ref.make(false);
      const statuses = yield* Ref.make<string[]>([]);
      const fiber = yield* runCodeGraphAutomaticCompactionLoopWith(
        {
          compact: () => Effect.never.pipe(Effect.ensuring(Ref.set(cancelled, true))),
          inspect: () =>
            Effect.succeed(availableStorage(checkoutId, {availableBytes: 16 * GIB, opportunityBytes: 2 * GIB})),
          listCheckoutIds: () => Effect.succeed([checkoutId]),
        },
        '/threadnote-home',
        status =>
          Ref.update(statuses, current => [...current, status.state]).pipe(
            Effect.andThen(status.state === 'running' ? Deferred.succeed(running, undefined) : Effect.void),
          ),
        {initialDelayMilliseconds: 0},
      ).pipe(Effect.forkChild({startImmediately: true}));

      yield* Deferred.await(running);
      expect(yield* Ref.get(statuses)).toEqual(['inspecting', 'running']);
      yield* Fiber.interrupt(fiber);
      expect(yield* Ref.get(cancelled)).toBe(true);
    }),
  );

  effectIt.effect('retains the failed candidate so Manager can render a human repository label', () =>
    Effect.gen(function* () {
      const checkoutId = 'd'.repeat(64);
      const failed = yield* Deferred.make<{readonly checkoutId?: string; readonly state: string}>();
      const fiber = yield* runCodeGraphAutomaticCompactionLoopWith(
        {
          compact: () => Effect.fail(AutomaticCompactionTestError.make({message: 'expected compaction failure'})),
          inspect: () =>
            Effect.succeed(availableStorage(checkoutId, {availableBytes: 16 * GIB, opportunityBytes: 2 * GIB})),
          listCheckoutIds: () => Effect.succeed([checkoutId]),
        },
        '/threadnote-home',
        status =>
          status.state === 'failed'
            ? Deferred.succeed(failed, {checkoutId: status.checkoutId, state: status.state})
            : Effect.void,
        {initialDelayMilliseconds: 0},
      ).pipe(Effect.forkChild({startImmediately: true}));

      expect(yield* Deferred.await(failed)).toEqual({checkoutId, state: 'failed'});
      yield* Fiber.interrupt(fiber);
    }),
  );
});
