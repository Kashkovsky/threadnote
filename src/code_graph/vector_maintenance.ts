import {Crypto, Effect, Encoding, FileSystem, Option, Path, PlatformError, Result} from 'effect';
import {sha256HexSync} from '../crypto/sha256.js';
import {isFileLockTimeout, withExclusiveFileLock} from '../effect/file_lock.js';
import {runtimeTextDirectoryNamePage, SystemInfo, type SystemInfoShape} from '../effect/system.js';
import type {CodeGraphDirectPersistentCapacityBoundary} from './disk_capacity.js';
import {codeGraphVectorRetirementCursorLockPath, codeGraphVectorWriteLockPath} from './layout.js';
import {
  type CodeGraphVectorPageStorage,
  commitCodeGraphVectorRetirementAdmission,
  commitCodeGraphVectorPointerRetirement,
  commitCodeGraphVectorRetirementPage,
  commitCodeGraphVectorRetirementPreparation,
  deleteCodeGraphVectorPointerWithRetirement,
  inspectCodeGraphVectorPageStorage,
  inspectCodeGraphVectorRetirementWork,
  makeCodeGraphVectorRetirementCapacityProtector,
  planCodeGraphVectorPointerRetirement,
  planCodeGraphVectorRetirementAdmission,
  planCodeGraphVectorRetirementPage,
  planCodeGraphVectorRetirementPreparation,
  selectCodeGraphVectorRetirementMarkerCandidate,
} from './vector_retirement.js';

export {
  type CodeGraphVectorRetirementCapacityProtector,
  CODE_GRAPH_VECTOR_RETIREMENT_ASSOCIATION_INDEX_SQL,
  CODE_GRAPH_VECTOR_RETIREMENT_LEGACY_POINTER_BYTES,
  CODE_GRAPH_VECTOR_RETIREMENT_LEGACY_POINTER_ROWS,
  CODE_GRAPH_VECTOR_RETIREMENT_PAGE_BYTES,
  CODE_GRAPH_VECTOR_RETIREMENT_PAGE_FIXED_ROWS,
  CODE_GRAPH_VECTOR_RETIREMENT_PAGE_ROWS,
  CODE_GRAPH_VECTOR_RETIREMENT_SCHEMA_FIXED_BYTES,
  CODE_GRAPH_VECTOR_RETIREMENT_SCHEMA_FIXED_ROWS,
  CODE_GRAPH_VECTOR_RETIREMENT_STATE_TABLE_SQL,
  CODE_GRAPH_VECTOR_RETIREMENT_TRIGGER_DEFINITIONS,
  CODE_GRAPH_VECTOR_RETIREMENTS_TABLE_SQL,
  codeGraphVectorRetirementLegacyPointerProbeStatement,
  codeGraphVectorRetirementMarkerPageStatement,
  codeGraphVectorRetirementPageStatement,
  admitOneCodeGraphVectorRetirementWithCapacity,
  commitCodeGraphVectorRetirementAdmission,
  commitCodeGraphVectorRetirementPage,
  commitCodeGraphVectorRetirementPreparation,
  commitCodeGraphVectorPointerRetirement,
  deleteCodeGraphVectorPointerWithRetirement,
  makeCodeGraphVectorRetirementCapacityProtector,
  planCodeGraphVectorRetirementAdmission,
  planCodeGraphVectorRetirementPage,
  planCodeGraphVectorRetirementPreparation,
  planCodeGraphVectorPointerRetirement,
  prepareCodeGraphVectorRetirement,
  retireCodeGraphVectorPointerWithCapacity,
  retireCodeGraphVectorGenerationPage,
  selectCodeGraphVectorRetirementMarkerCandidate,
} from './vector_retirement.js';

const VECTOR_DATABASE_VERSION = 2;
const VECTOR_DATABASE_NAME = `vectors-v${VECTOR_DATABASE_VERSION}.sqlite`;
const VECTOR_DATABASE_LIMIT = 64;
const VECTOR_DIRECTORY_ENTRY_LIMIT = 66;
const MODEL_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const HASH_ID = /^[0-9a-f]{64}$/;
const VECTOR_PHASE_CURSOR =
  /^vp1:(r|n|a):([0-9a-f]{64})(?::([a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?))?(?::([0-9]+))?$/u;
const ORDINARY_VECTOR_CURSOR = /^ov1:([0-9a-f]{64}):([-_A-Za-z0-9]+)$/u;
const ORDINARY_VECTOR_CURSOR_LIMIT = 64 * 1_024;
const ORDINARY_VECTOR_CURSOR_FILE = '.ordinary-vector-retirement-v1.cursor';
const ORDINARY_VECTOR_CURSOR_TEMPORARY = '.ordinary-vector-retirement-v1.cursor.tmp';
const ORDINARY_VECTOR_CURSOR_METADATA_BYTES = 1_024;
const VECTOR_UNIT_RETRY_MILLISECONDS = 1_000;
const VECTOR_UNIT_INVALID_RETRY_MILLISECONDS = 30_000;
const ORDINARY_VECTOR_GENERATION_BYTES = 256;
export const CODE_GRAPH_ORDINARY_VECTOR_UNIT_DEADLINE_MILLISECONDS = 250;

export type CodeGraphVectorCleanupWarningCode =
  | 'vector-inventory-truncated'
  | 'vector-inventory-unavailable'
  | 'vector-inventory-unsafe'
  | 'vector-store-busy'
  | 'vector-store-unreadable';

export interface CodeGraphVectorCleanupWarning {
  readonly code: CodeGraphVectorCleanupWarningCode;
  readonly message: string;
  readonly occurrences: number;
  readonly retryable: boolean;
}

export interface CodeGraphVectorPointerCleanupResult {
  readonly databasesInspected: number;
  readonly databasesProcessed: number;
  readonly pointersRemoved: number;
  readonly warnings: readonly CodeGraphVectorCleanupWarning[];
}

interface VectorDatabaseCandidate {
  readonly databasePath: string;
  readonly fileIdentity: VectorDatabaseFileIdentity;
  readonly modelKey: string;
  readonly modelName: string;
  readonly modelRoot: string;
  readonly vectorRoot: string;
}

interface VectorDatabaseFileIdentity {
  readonly dev: number;
  readonly ino?: string;
}

interface VectorDatabaseInventory {
  readonly candidates: readonly VectorDatabaseCandidate[];
  readonly truncated: boolean;
  readonly unsafeEntries: number;
  readonly vectorRoot?: string;
}

type VectorPhaseCursor =
  | {readonly digest: string; readonly mode: 'reset'}
  | {readonly digest: string; readonly mode: 'next'; readonly modelName: string}
  | {readonly digest: string; readonly mode: 'active'; readonly modelName: string; readonly step: number};

interface OrdinaryVectorModelCursor {
  readonly admissionWrapped: boolean;
  readonly afterGeneration: string;
  readonly phase: 'admission' | 'marker' | 'verified';
}

interface OrdinaryVectorPhaseCursor {
  readonly digest: string;
  readonly models: ReadonlyMap<string, OrdinaryVectorModelCursor>;
  readonly nextModelName?: string;
  readonly roundDeferred: boolean;
  readonly roundProgressed: boolean;
}

export interface CodeGraphRemovedViewVectorUnitInput {
  readonly checkoutId: string;
  readonly threadnoteHome: string;
}

export interface CodeGraphRemovedViewVectorUnitEntry {
  readonly cursorToken?: string;
  readonly expectedSnapshotId: string;
  readonly phase: 'vector-pointers';
  readonly worktreeId: string;
}

export interface CodeGraphRemovedViewVectorUnitPreparation {
  readonly deadlineMonotonicMilliseconds: number;
  /** @internal Deterministic deadline seam for focused scheduling tests. */
  readonly monotonicMilliseconds?: () => number;
  readonly reservationMode: 'nonblocking-one-attempt';
}

export type CodeGraphRemovedViewVectorUnitResult =
  | {readonly state: 'complete'}
  | {readonly cursorToken: string; readonly retryAfterMilliseconds?: number; readonly state: 'progress'}
  | {
      readonly blockedCode: 'invalid-sidecar' | 'io-error';
      readonly retryAfterMilliseconds: number;
      readonly state: 'deferred';
    };

export interface CodeGraphOrdinaryVectorMaintenanceUnitInput {
  readonly checkoutId: string;
  readonly threadnoteHome: string;
}

export interface CodeGraphOrdinaryVectorMaintenanceUnitPreparation {
  /** @internal Deterministic capacity seam for focused nonblocking tests. */
  readonly availableDiskBytes?: (
    path: string,
    boundary: CodeGraphDirectPersistentCapacityBoundary,
  ) => Effect.Effect<number | undefined, unknown>;
  /** @internal Deterministic containment seam before the first cursor lock. */
  readonly beforeInitialCursorLock?: () => Effect.Effect<void, unknown>;
  /** @internal Crash/receipt seam after protected intent and before the model lock. */
  readonly beforeModelCommit?: () => Effect.Effect<void, unknown>;
  /** @internal Crash seam after the exact DB commit and before final cursor publication. */
  readonly afterModelCommitBeforeFinalCursorCas?: () => Effect.Effect<void, unknown>;
  /** @internal Counts exact nonblocking capacity attempts in focused tests. */
  readonly beforeCapacityAttempt?: (
    boundary: CodeGraphDirectPersistentCapacityBoundary,
  ) => Effect.Effect<void, unknown>;
  /** @internal Deterministic race seam immediately before the sealed wrap. */
  readonly beforeFinalVerification?: () => Effect.Effect<void, unknown>;
  /** @internal Interlock after the clean proof while every model lock remains held. */
  readonly afterFinalVerificationBeforeCursorCas?: () => Effect.Effect<void, unknown>;
  readonly deadlineMonotonicMilliseconds: number;
  /** @internal Deterministic deadline seam for focused scheduling tests. */
  readonly monotonicMilliseconds?: () => number;
  readonly reservationMode: 'nonblocking-one-attempt';
}

export type CodeGraphOrdinaryVectorMaintenanceUnitResult =
  | {readonly state: 'complete'}
  | {
      readonly cursorToken: string;
      readonly remaining: true;
      readonly state: 'progress';
    }
  | {
      readonly blockedCode: 'invalid-sidecar' | 'io-error' | 'model-unavailable';
      readonly cursorToken?: string;
      readonly retryAfterMilliseconds: number;
      readonly state: 'deferred';
    };

/**
 * Plans one vector-model unit and enters its receipt before the worker takes
 * the target lock. The commit supplied to `use` owns the zero-wait model lock
 * and releases it before `use` performs the Store CAS.
 */
export const withPreparedCodeGraphRemovedViewVectorUnit = Effect.fn('codeGraph.withPreparedRemovedViewVectorUnit')(
  function* <A, E, R>(
    input: CodeGraphRemovedViewVectorUnitInput,
    entry: CodeGraphRemovedViewVectorUnitEntry,
    preparation: CodeGraphRemovedViewVectorUnitPreparation,
    use: (commit: Effect.Effect<CodeGraphRemovedViewVectorUnitResult, unknown>) => Effect.Effect<A, E, R>,
  ) {
    const useBeforeDeadline = (commit: Effect.Effect<CodeGraphRemovedViewVectorUnitResult, unknown>) =>
      ensureVectorUnitDeadline(preparation).pipe(Effect.andThen(Effect.suspend(() => use(commit))));
    if (
      !HASH_ID.test(input.checkoutId) ||
      !HASH_ID.test(entry.worktreeId) ||
      !validSnapshotId(entry.expectedSnapshotId) ||
      !Number.isFinite(preparation.deadlineMonotonicMilliseconds) ||
      preparation.reservationMode !== 'nonblocking-one-attempt'
    ) {
      return yield* useBeforeDeadline(Effect.succeed(invalidVectorUnit()));
    }
    yield* ensureVectorUnitDeadline(preparation);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const system = yield* SystemInfo;
    const inventory = yield* inspectVectorDatabases(fs, path, input.threadnoteHome, input.checkoutId).pipe(
      Effect.match({onFailure: () => undefined, onSuccess: value => value}),
    );
    if (inventory === undefined) return yield* useBeforeDeadline(Effect.succeed(unavailableVectorUnit()));
    if (inventory.truncated || inventory.unsafeEntries > 0) {
      return yield* useBeforeDeadline(Effect.succeed(invalidVectorUnit()));
    }
    const digest = vectorInventoryDigest(inventory.candidates);
    const cursor = parseVectorPhaseCursor(entry.cursorToken);
    if (entry.cursorToken !== undefined && cursor === undefined) {
      return yield* useBeforeDeadline(Effect.succeed(invalidVectorUnit()));
    }
    if (cursor !== undefined && cursor.digest !== digest) {
      return yield* useBeforeDeadline(Effect.succeed({cursorToken: vectorResetCursor(digest), state: 'progress'}));
    }
    const candidate = selectVectorUnitCandidate(inventory.candidates, cursor);
    if (candidate === undefined) {
      return yield* useBeforeDeadline(
        verifyVectorUnitInventory(fs, path, crypto, system, input, entry, digest, preparation),
      );
    }
    const step = cursor?.mode === 'active' && cursor.modelName === candidate.modelName ? cursor.step : 0;
    const nextStep = safeVectorCursorStep(step);
    if (nextStep === undefined) return yield* useBeforeDeadline(Effect.succeed(invalidVectorUnit()));
    const activeResult = (): CodeGraphRemovedViewVectorUnitResult => ({
      cursorToken: vectorActiveCursor(digest, candidate.modelName, nextStep),
      state: 'progress',
    });
    const preservedResult = (): CodeGraphRemovedViewVectorUnitResult => ({
      cursorToken: vectorNextCursor(digest, candidate.modelName),
      retryAfterMilliseconds: VECTOR_UNIT_RETRY_MILLISECONDS,
      state: 'progress',
    });
    const modelCommit = <B>(
      effect: Effect.Effect<B, unknown>,
      onSuccess: (value: B) => CodeGraphRemovedViewVectorUnitResult,
    ) =>
      withExclusiveFileLock(
        fs,
        codeGraphVectorWriteLockPath(path, input.threadnoteHome, input.checkoutId, candidate.modelKey),
        {
          retryIntervalMilliseconds: 1,
          staleAfterMilliseconds: 120_000,
          waitTimeoutMilliseconds: 0,
        },
        validateVectorDatabaseCandidate(fs, path, candidate).pipe(Effect.andThen(effect)),
      ).pipe(
        Effect.map(onSuccess),
        Effect.catch(() => Effect.succeed(preservedResult())),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(Path.Path, path),
        Effect.provideService(SystemInfo, system),
      );
    const enterReceipt = <B>(
      boundary: CodeGraphDirectPersistentCapacityBoundary,
      storage: CodeGraphVectorPageStorage,
      commit: Effect.Effect<B, unknown>,
      onSuccess: (value: B) => CodeGraphRemovedViewVectorUnitResult,
    ) =>
      Effect.gen(function* () {
        yield* ensureVectorUnitDeadline(preparation);
        const protector = yield* makeCodeGraphVectorRetirementCapacityProtector({
          claimMode: preparation.reservationMode,
          databasePath: candidate.databasePath,
          threadnoteHome: input.threadnoteHome,
        });
        return yield* protector(boundary, useBeforeDeadline(modelCommit(commit, onSuccess)), storage);
      });

    yield* ensureVectorUnitDeadline(preparation);
    const schemaPlan = yield* planCodeGraphVectorRetirementPreparation(candidate.databasePath).pipe(
      Effect.match({onFailure: () => undefined, onSuccess: value => value}),
    );
    if (schemaPlan === undefined) return yield* useBeforeDeadline(Effect.succeed(preservedResult()));
    if (schemaPlan.state === 'planned') {
      return yield* enterReceipt(
        schemaPlan.boundary,
        schemaPlan.storage,
        commitCodeGraphVectorRetirementPreparation(candidate.databasePath, schemaPlan),
        activeResult,
      );
    }

    yield* ensureVectorUnitDeadline(preparation);
    const pointerPlan = yield* planCodeGraphVectorPointerRetirement(candidate.databasePath, {
      expectedSnapshotId: entry.expectedSnapshotId,
      worktreeId: entry.worktreeId,
    }).pipe(Effect.match({onFailure: () => undefined, onSuccess: value => value}));
    if (pointerPlan === undefined) return yield* useBeforeDeadline(Effect.succeed(preservedResult()));
    if (pointerPlan.state === 'planned') {
      return yield* enterReceipt(
        pointerPlan.boundary,
        pointerPlan.storage,
        commitCodeGraphVectorPointerRetirement(candidate.databasePath, pointerPlan),
        activeResult,
      );
    }

    yield* ensureVectorUnitDeadline(preparation);
    const marker = yield* selectCodeGraphVectorRetirementMarkerCandidate(candidate.databasePath, {
      retiredByWorktreeId: entry.worktreeId,
      snapshotId: entry.expectedSnapshotId,
    }).pipe(Effect.match({onFailure: () => undefined, onSuccess: value => value}));
    if (marker === undefined) {
      return yield* useBeforeDeadline(
        Effect.succeed({cursorToken: vectorNextCursor(digest, candidate.modelName), state: 'progress'}),
      );
    }
    yield* ensureVectorUnitDeadline(preparation);
    const pagePlan = yield* planCodeGraphVectorRetirementPage(candidate.databasePath, {
      generation: marker.generation,
      requestedLimit: 1_000,
      retirementId: marker.retirementId,
    }).pipe(Effect.match({onFailure: () => undefined, onSuccess: value => value}));
    if (pagePlan === undefined) return yield* useBeforeDeadline(Effect.succeed(preservedResult()));
    if (pagePlan.state === 'stale') return yield* useBeforeDeadline(Effect.succeed(activeResult()));
    return yield* enterReceipt(
      pagePlan.boundary,
      pagePlan.storage,
      commitCodeGraphVectorRetirementPage(candidate.databasePath, pagePlan),
      () => activeResult(),
    );
  },
);

/**
 * Advances one home-global vector-retirement unit without taking a graph
 * target lock or consulting Store queue authority. Capacity planning and the
 * nonblocking receipt happen before the zero-wait model lock; the selected
 * commit then revalidates the contained database while that lock is owned.
 */
export const runCodeGraphOrdinaryVectorMaintenanceUnit = Effect.fn('codeGraph.runOrdinaryVectorMaintenanceUnit')(
  function* (
    input: CodeGraphOrdinaryVectorMaintenanceUnitInput,
    preparation: CodeGraphOrdinaryVectorMaintenanceUnitPreparation,
  ) {
    const startedAt = ordinaryVectorMonotonicMilliseconds(preparation);
    if (
      !HASH_ID.test(input.checkoutId) ||
      !Number.isFinite(preparation.deadlineMonotonicMilliseconds) ||
      !Number.isFinite(startedAt) ||
      preparation.deadlineMonotonicMilliseconds - startedAt > CODE_GRAPH_ORDINARY_VECTOR_UNIT_DEADLINE_MILLISECONDS ||
      preparation.reservationMode !== 'nonblocking-one-attempt'
    ) {
      return invalidOrdinaryVectorUnit();
    }
    yield* ensureOrdinaryVectorUnitDeadline(preparation);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const system = yield* SystemInfo;
    const firstInventory = yield* inspectVectorDatabases(fs, path, input.threadnoteHome, input.checkoutId).pipe(
      Effect.match({onFailure: () => undefined, onSuccess: value => value}),
    );
    if (firstInventory === undefined) return unavailableOrdinaryVectorUnit();
    if (firstInventory.truncated || firstInventory.unsafeEntries > 0) return invalidOrdinaryVectorUnit();
    if (firstInventory.vectorRoot === undefined) return {state: 'complete'} as const;
    if (firstInventory.candidates.length === 0) return {state: 'complete'} as const;
    const authority = yield* inspectOrdinaryVectorCursorAuthority(
      fs,
      path,
      firstInventory.vectorRoot,
      codeGraphVectorRetirementCursorLockPath(path, input.threadnoteHome, input.checkoutId),
    );
    if (preparation.beforeInitialCursorLock !== undefined) yield* preparation.beforeInitialCursorLock();
    const loaded = yield* withExclusiveFileLock(
      fs,
      authority.lockPath,
      {
        retryIntervalMilliseconds: 1,
        staleAfterMilliseconds: 120_000,
        waitTimeoutMilliseconds: 0,
      },
      Effect.gen(function* () {
        yield* ensureOrdinaryVectorUnitDeadline(preparation);
        yield* revalidateOrdinaryVectorCursorAuthority(fs, path, authority);
        yield* recoverOrdinaryVectorCursorTemporary(fs, path, authority);
        return yield* readOrdinaryVectorCursor(fs, authority.cursorPath);
      }),
    ).pipe(Effect.match({onFailure: () => undefined, onSuccess: value => value}));
    if (loaded === undefined) return unavailableOrdinaryVectorUnit();
    if (loaded.state === 'invalid') return invalidOrdinaryVectorUnit();
    const expectedToken = loaded.state === 'cursor' ? loaded.cursorToken : undefined;
    const inventory = yield* inspectVectorDatabases(fs, path, input.threadnoteHome, input.checkoutId);
    if (inventory.truncated || inventory.unsafeEntries > 0 || inventory.vectorRoot !== firstInventory.vectorRoot) {
      return invalidOrdinaryVectorUnit();
    }
    if (inventory.candidates.length === 0) return {state: 'complete'} as const;
    return yield* runCodeGraphOrdinaryVectorMaintenanceWithCursor(
      fs,
      path,
      crypto,
      system,
      input,
      inventory,
      expectedToken,
      preparation,
      authority,
    );
  },
);

function runCodeGraphOrdinaryVectorMaintenanceWithCursor(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  crypto: Crypto.Crypto,
  system: SystemInfoShape,
  input: CodeGraphOrdinaryVectorMaintenanceUnitInput,
  inventory: VectorDatabaseInventory,
  cursorToken: string | undefined,
  preparation: CodeGraphOrdinaryVectorMaintenanceUnitPreparation,
  authority: OrdinaryVectorCursorAuthority,
  workingCursor?: OrdinaryVectorPhaseCursor,
  remainingSteps = VECTOR_DATABASE_LIMIT * 8 + 1,
): Effect.Effect<
  CodeGraphOrdinaryVectorMaintenanceUnitResult,
  unknown,
  Crypto.Crypto | FileSystem.FileSystem | Path.Path | SystemInfo
> {
  return Effect.gen(function* () {
    if (remainingSteps <= 0) return ordinaryVectorModelUnavailable();
    const digest = vectorInventoryDigest(inventory.candidates);
    const parsed = workingCursor ?? parseOrdinaryVectorPhaseCursor(cursorToken);
    if (workingCursor === undefined && cursorToken !== undefined && parsed === undefined) {
      return invalidOrdinaryVectorUnit();
    }
    if (parsed !== undefined && parsed.digest === digest && !ordinaryVectorCursorMatchesInventory(parsed, inventory)) {
      return invalidOrdinaryVectorUnit();
    }
    const admittedCursor =
      parsed === undefined || parsed.digest !== digest ? initialOrdinaryVectorCursor(digest) : parsed;
    // A deferred wrap is a terminal condition for one public invocation. A
    // later external tick may retry the sealed round, but recursion in the
    // same tick must not hot-loop its nonblocking protector.
    const persistedDeferred = workingCursor === undefined && admittedCursor.roundDeferred;
    const deferredHasLaterModel =
      persistedDeferred &&
      admittedCursor.nextModelName !== undefined &&
      inventory.candidates.some(model => model.modelName > admittedCursor.nextModelName!);
    const cursor = persistedDeferred
      ? deferredHasLaterModel
        ? clearOrdinaryVectorRoundFlags(admittedCursor)
        : restartOrdinaryVectorRound(admittedCursor)
      : admittedCursor;
    const continueWith = (next: OrdinaryVectorPhaseCursor) =>
      runCodeGraphOrdinaryVectorMaintenanceWithCursor(
        fs,
        path,
        crypto,
        system,
        input,
        inventory,
        cursorToken,
        preparation,
        authority,
        next,
        remainingSteps - 1,
      );
    const candidate = inventory.candidates.find(
      model => cursor.nextModelName === undefined || model.modelName > cursor.nextModelName,
    );
    if (candidate === undefined) {
      if (cursor.roundDeferred) return ordinaryVectorModelUnavailable();
      return yield* continueWith(restartOrdinaryVectorRound(cursor));
    }
    const modelCursor = cursor.models.get(candidate.modelName) ?? ordinaryVectorAdmissionCursor();
    const scanSame = (nextModelCursor: OrdinaryVectorModelCursor, progressed: boolean, deferred: boolean) =>
      continueWith({
        digest: cursor.digest,
        models: setOrdinaryVectorModelCursor(cursor.models, candidate.modelName, nextModelCursor),
        ...(cursor.nextModelName === undefined ? {} : {nextModelName: cursor.nextModelName}),
        roundDeferred: cursor.roundDeferred || deferred,
        roundProgressed: cursor.roundProgressed || progressed,
      });
    const scanNext = (nextModelCursor: OrdinaryVectorModelCursor, progressed: boolean, deferred: boolean) =>
      continueWith(updateOrdinaryVectorCursor(cursor, candidate.modelName, nextModelCursor, progressed, deferred));
    const modelCommit = <B>(commit: Effect.Effect<B, unknown>) =>
      ensureOrdinaryVectorUnitDeadline(preparation).pipe(
        Effect.andThen(
          withExclusiveFileLock(
            fs,
            codeGraphVectorWriteLockPath(path, input.threadnoteHome, input.checkoutId, candidate.modelKey),
            {
              retryIntervalMilliseconds: 1,
              staleAfterMilliseconds: 120_000,
              waitTimeoutMilliseconds: 0,
            },
            validateVectorDatabaseCandidate(fs, path, candidate).pipe(
              Effect.andThen(ensureOrdinaryVectorUnitDeadline(preparation)),
              Effect.andThen(commit),
            ),
          ),
        ),
      );
    const enterReceipt = <B>(
      boundary: CodeGraphDirectPersistentCapacityBoundary,
      storage: CodeGraphVectorPageStorage,
      commit: Effect.Effect<B, unknown>,
      onSuccess: (value: B) => OrdinaryVectorModelCursor,
      possibleSuccessStates: readonly OrdinaryVectorModelCursor[],
    ) =>
      Effect.gen(function* () {
        yield* ensureOrdinaryVectorUnitDeadline(preparation);
        if (candidate.fileIdentity.dev !== authority.directoryIdentity.dev) {
          return yield* scanNext(modelCursor, false, true);
        }
        const intentCursor = updateOrdinaryVectorCursor(cursor, candidate.modelName, modelCursor, false, true);
        const intentToken = encodeOrdinaryVectorPhaseCursor(intentCursor);
        const possibleFinalTokens = possibleSuccessStates.map(state =>
          encodeOrdinaryVectorPhaseCursor(updateOrdinaryVectorCursor(cursor, candidate.modelName, state, true, false)),
        );
        const combinedBoundary = codeGraphOrdinaryVectorMaintenanceBoundary(boundary, intentToken, possibleFinalTokens);
        if (preparation.beforeCapacityAttempt !== undefined) {
          yield* preparation.beforeCapacityAttempt(combinedBoundary);
        }
        const protector = yield* makeCodeGraphVectorRetirementCapacityProtector({
          ...(preparation.availableDiskBytes === undefined ? {} : {availableDiskBytes: preparation.availableDiskBytes}),
          claimMode: preparation.reservationMode,
          databasePath: candidate.databasePath,
          threadnoteHome: input.threadnoteHome,
        });
        let intentPublished = false;
        return yield* protector(
          combinedBoundary,
          withExclusiveFileLock(
            fs,
            authority.lockPath,
            {
              retryIntervalMilliseconds: 1,
              staleAfterMilliseconds: 120_000,
              waitTimeoutMilliseconds: 0,
            },
            Effect.gen(function* () {
              yield* ensureOrdinaryVectorUnitDeadline(preparation);
              yield* revalidateOrdinaryVectorCursorAuthority(fs, path, authority);
              const directoryInfo = yield* fs.stat(authority.directory);
              const databaseInfo = yield* fs.stat(candidate.databasePath);
              if (
                directoryInfo.dev !== databaseInfo.dev ||
                !sameVectorDatabaseFileIdentity(candidate.fileIdentity, vectorDatabaseFileIdentity(databaseInfo))
              ) {
                return yield* Effect.fail(new Error('Code graph ordinary vector cursor filesystem changed.'));
              }
              yield* writeOrdinaryVectorCursorCas(fs, path, crypto, authority, cursorToken, intentToken);
              intentPublished = true;
              if (preparation.beforeModelCommit !== undefined) yield* preparation.beforeModelCommit();
              const committed = yield* modelCommit(commit);
              if (preparation.afterModelCommitBeforeFinalCursorCas !== undefined) {
                yield* preparation.afterModelCommitBeforeFinalCursorCas();
              }
              const finalCursor = updateOrdinaryVectorCursor(
                cursor,
                candidate.modelName,
                onSuccess(committed),
                true,
                false,
              );
              const finalToken = encodeOrdinaryVectorPhaseCursor(finalCursor);
              yield* writeOrdinaryVectorCursorCas(fs, path, crypto, authority, intentToken, finalToken);
              return ordinaryVectorProgress(finalCursor);
            }),
          ),
          storage,
        ).pipe(
          Effect.catch(() =>
            ensureOrdinaryVectorUnitDeadline(preparation).pipe(
              Effect.andThen(
                intentPublished
                  ? Effect.succeed(ordinaryVectorProgress(intentCursor))
                  : scanNext(modelCursor, false, true),
              ),
            ),
          ),
        );
      });

    const publishCheckpoint = (
      nextCursor: OrdinaryVectorPhaseCursor,
      result: CodeGraphOrdinaryVectorMaintenanceUnitResult,
      verifyCompletion = false,
    ) =>
      Effect.gen(function* () {
        yield* ensureOrdinaryVectorUnitDeadline(preparation);
        if (candidate.fileIdentity.dev !== authority.directoryIdentity.dev) {
          return ordinaryVectorModelUnavailable();
        }
        const nextToken = encodeOrdinaryVectorPhaseCursor(nextCursor);
        const boundary = codeGraphOrdinaryVectorMaintenanceBoundary(
          {finalFactBytes: 0, operation: 'maintain code graph vector retirement', rowCount: 0},
          nextToken,
          [nextToken],
        );
        if (preparation.beforeCapacityAttempt !== undefined) yield* preparation.beforeCapacityAttempt(boundary);
        const storage = yield* inspectCodeGraphVectorPageStorage(candidate.databasePath);
        const protector = yield* makeCodeGraphVectorRetirementCapacityProtector({
          ...(preparation.availableDiskBytes === undefined ? {} : {availableDiskBytes: preparation.availableDiskBytes}),
          claimMode: preparation.reservationMode,
          databasePath: candidate.databasePath,
          threadnoteHome: input.threadnoteHome,
        });
        return yield* protector(
          boundary,
          withExclusiveFileLock(
            fs,
            authority.lockPath,
            {
              retryIntervalMilliseconds: 1,
              staleAfterMilliseconds: 120_000,
              waitTimeoutMilliseconds: 0,
            },
            Effect.gen(function* () {
              yield* ensureOrdinaryVectorUnitDeadline(preparation);
              yield* revalidateOrdinaryVectorCursorAuthority(fs, path, authority);
              const directoryInfo = yield* fs.stat(authority.directory);
              const databaseInfo = yield* fs.stat(candidate.databasePath);
              if (
                directoryInfo.dev !== databaseInfo.dev ||
                !sameVectorDatabaseFileIdentity(candidate.fileIdentity, vectorDatabaseFileIdentity(databaseInfo)) ||
                !sameOrdinaryVectorPageStorage(
                  storage,
                  yield* inspectCodeGraphVectorPageStorage(candidate.databasePath),
                )
              ) {
                return yield* Effect.fail(new Error('Code graph ordinary vector checkpoint authority changed.'));
              }
              if (!verifyCompletion) {
                yield* writeOrdinaryVectorCursorCas(fs, path, crypto, authority, cursorToken, nextToken);
                return result;
              }
              if (preparation.beforeFinalVerification !== undefined) yield* preparation.beforeFinalVerification();
              return yield* withAllOrdinaryVectorModelLocks(
                fs,
                path,
                input,
                inventory.candidates,
                preparation,
                Effect.gen(function* () {
                  const before = yield* inspectVectorDatabases(fs, path, input.threadnoteHome, input.checkoutId);
                  if (
                    before.truncated ||
                    before.unsafeEntries > 0 ||
                    vectorInventoryDigest(before.candidates) !== cursor.digest ||
                    !sameVectorDatabaseInventory(inventory, before)
                  ) {
                    return yield* Effect.fail(new Error('Code graph ordinary vector inventory changed.'));
                  }
                  let observedDirty = false;
                  for (const lockedCandidate of before.candidates) {
                    yield* ensureOrdinaryVectorUnitDeadline(preparation);
                    const inspection = yield* inspectCodeGraphVectorRetirementWork(lockedCandidate.databasePath);
                    if (inspection.state !== 'clean') observedDirty = true;
                  }
                  const after = yield* inspectVectorDatabases(fs, path, input.threadnoteHome, input.checkoutId);
                  if (
                    after.truncated ||
                    after.unsafeEntries > 0 ||
                    vectorInventoryDigest(after.candidates) !== cursor.digest ||
                    !sameVectorDatabaseInventory(before, after)
                  ) {
                    return yield* Effect.fail(new Error('Code graph ordinary vector inventory changed.'));
                  }
                  if (preparation.afterFinalVerificationBeforeCursorCas !== undefined) {
                    yield* preparation.afterFinalVerificationBeforeCursorCas();
                  }
                  yield* writeOrdinaryVectorCursorCas(fs, path, crypto, authority, cursorToken, nextToken);
                  return observedDirty ? ordinaryVectorProgress(nextCursor) : ({state: 'complete'} as const);
                }),
              );
            }),
          ),
          storage,
        ).pipe(Effect.catch(() => Effect.succeed(ordinaryVectorModelUnavailable())));
      });

    if (modelCursor.phase === 'verified') {
      const next = updateOrdinaryVectorCursor(cursor, candidate.modelName, modelCursor, false, false);
      return yield* publishCheckpoint(next, ordinaryVectorProgress(next));
    }

    yield* ensureOrdinaryVectorUnitDeadline(preparation);
    const schemaPlan = yield* planCodeGraphVectorRetirementPreparation(candidate.databasePath).pipe(
      Effect.match({onFailure: () => undefined, onSuccess: value => value}),
    );
    if (schemaPlan === undefined) return yield* scanNext(modelCursor, false, true);
    if (schemaPlan.state === 'planned') {
      return yield* enterReceipt(
        schemaPlan.boundary,
        schemaPlan.storage,
        commitCodeGraphVectorRetirementPreparation(candidate.databasePath, schemaPlan),
        () => modelCursor,
        [modelCursor],
      );
    }

    if (modelCursor.phase === 'admission') {
      yield* ensureOrdinaryVectorUnitDeadline(preparation);
      const admissionPlan = yield* planCodeGraphVectorRetirementAdmission(candidate.databasePath).pipe(
        Effect.match({onFailure: () => undefined, onSuccess: value => value}),
      );
      if (admissionPlan === undefined) return yield* scanNext(modelCursor, false, true);
      if (admissionPlan.state === 'empty') {
        return yield* scanSame(ordinaryVectorMarkerCursor(modelCursor.afterGeneration, true), true, false);
      }
      return yield* enterReceipt(
        admissionPlan.boundary,
        admissionPlan.storage,
        commitCodeGraphVectorRetirementAdmission(candidate.databasePath, admissionPlan),
        result => ordinaryVectorMarkerCursor(modelCursor.afterGeneration, result.state === 'wrapped'),
        [
          ordinaryVectorMarkerCursor(modelCursor.afterGeneration, false),
          ordinaryVectorMarkerCursor(modelCursor.afterGeneration, true),
        ],
      );
    }

    yield* ensureOrdinaryVectorUnitDeadline(preparation);
    const markerSelection = yield* selectCodeGraphVectorRetirementMarkerCandidate(candidate.databasePath, {
      ...(modelCursor.afterGeneration === '' ? {} : {afterGeneration: modelCursor.afterGeneration}),
    }).pipe(
      Effect.match({
        onFailure: () => ({state: 'failed'}) as const,
        onSuccess: marker => ({marker, state: 'selected'}) as const,
      }),
    );
    if (markerSelection.state === 'failed') return yield* scanNext(modelCursor, false, true);
    const marker = markerSelection.marker;
    if (marker === undefined) {
      if (!modelCursor.admissionWrapped) return yield* scanSame(ordinaryVectorAdmissionCursor(), true, false);
      const verified: OrdinaryVectorModelCursor = {
        admissionWrapped: true,
        afterGeneration: '',
        phase: 'verified',
      };
      const next = updateOrdinaryVectorCursor(cursor, candidate.modelName, verified, true, false);
      const allVerified = inventory.candidates.every(model => {
        if (model.modelName === candidate.modelName) return true;
        return next.models.get(model.modelName)?.phase === 'verified';
      });
      if (allVerified) {
        const reset = initialOrdinaryVectorCursor(cursor.digest);
        return yield* publishCheckpoint(reset, {state: 'complete'}, true);
      }
      return yield* publishCheckpoint(next, ordinaryVectorProgress(next));
    }
    yield* ensureOrdinaryVectorUnitDeadline(preparation);
    const pagePlan = yield* planCodeGraphVectorRetirementPage(candidate.databasePath, {
      generation: marker.generation,
      requestedLimit: 1_000,
      retirementId: marker.retirementId,
    }).pipe(
      Effect.match({
        onFailure: () => ({state: 'failed'}) as const,
        onSuccess: plan => ({plan, state: 'planned'}) as const,
      }),
    );
    if (pagePlan.state === 'failed') return yield* scanNext(modelCursor, false, true);
    if (pagePlan.plan.state === 'stale') {
      return yield* scanSame(ordinaryVectorAdmissionCursor(marker.generation), true, false);
    }
    return yield* enterReceipt(
      pagePlan.plan.boundary,
      pagePlan.plan.storage,
      commitCodeGraphVectorRetirementPage(candidate.databasePath, pagePlan.plan),
      () => ordinaryVectorAdmissionCursor(marker.generation),
      [ordinaryVectorAdmissionCursor(marker.generation)],
    );
  });
}

function ordinaryVectorAdmissionCursor(afterGeneration = ''): OrdinaryVectorModelCursor {
  return {admissionWrapped: false, afterGeneration, phase: 'admission'};
}

function ordinaryVectorMarkerCursor(afterGeneration: string, admissionWrapped: boolean): OrdinaryVectorModelCursor {
  return {admissionWrapped, afterGeneration, phase: 'marker'};
}

function initialOrdinaryVectorCursor(digest: string): OrdinaryVectorPhaseCursor {
  return {digest, models: new Map(), roundDeferred: false, roundProgressed: false};
}

function restartOrdinaryVectorRound(cursor: OrdinaryVectorPhaseCursor): OrdinaryVectorPhaseCursor {
  return {
    digest: cursor.digest,
    models: cursor.models,
    roundDeferred: false,
    roundProgressed: false,
  };
}

function clearOrdinaryVectorRoundFlags(cursor: OrdinaryVectorPhaseCursor): OrdinaryVectorPhaseCursor {
  return {
    digest: cursor.digest,
    models: cursor.models,
    ...(cursor.nextModelName === undefined ? {} : {nextModelName: cursor.nextModelName}),
    roundDeferred: false,
    roundProgressed: false,
  };
}

function withAllOrdinaryVectorModelLocks<A, E, R>(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  input: CodeGraphOrdinaryVectorMaintenanceUnitInput,
  candidates: readonly VectorDatabaseCandidate[],
  preparation: CodeGraphOrdinaryVectorMaintenanceUnitPreparation,
  use: Effect.Effect<A, E, R>,
  index = 0,
): Effect.Effect<A, unknown, R | Crypto.Crypto | Path.Path | SystemInfo> {
  const candidate = candidates[index];
  if (candidate === undefined) return use;
  return withExclusiveFileLock(
    fs,
    codeGraphVectorWriteLockPath(path, input.threadnoteHome, input.checkoutId, candidate.modelKey),
    {
      retryIntervalMilliseconds: 1,
      staleAfterMilliseconds: 120_000,
      waitTimeoutMilliseconds: 0,
    },
    validateVectorDatabaseCandidate(fs, path, candidate).pipe(
      Effect.andThen(ensureOrdinaryVectorUnitDeadline(preparation)),
      Effect.andThen(withAllOrdinaryVectorModelLocks(fs, path, input, candidates, preparation, use, index + 1)),
    ),
  );
}

function updateOrdinaryVectorCursor(
  cursor: OrdinaryVectorPhaseCursor,
  modelName: string,
  modelCursor: OrdinaryVectorModelCursor,
  progressed: boolean,
  deferred: boolean,
): OrdinaryVectorPhaseCursor {
  return {
    digest: cursor.digest,
    models: setOrdinaryVectorModelCursor(cursor.models, modelName, modelCursor),
    nextModelName: modelName,
    roundDeferred: cursor.roundDeferred || deferred,
    roundProgressed: cursor.roundProgressed || progressed,
  };
}

function setOrdinaryVectorModelCursor(
  current: ReadonlyMap<string, OrdinaryVectorModelCursor>,
  modelName: string,
  modelCursor: OrdinaryVectorModelCursor,
): Map<string, OrdinaryVectorModelCursor> {
  const updated = new Map(current);
  if (modelCursor.phase === 'admission' && !modelCursor.admissionWrapped && modelCursor.afterGeneration === '') {
    updated.delete(modelName);
  } else {
    updated.set(modelName, modelCursor);
  }
  return updated;
}

function ordinaryVectorProgress(cursor: OrdinaryVectorPhaseCursor): CodeGraphOrdinaryVectorMaintenanceUnitResult {
  return {
    cursorToken: encodeOrdinaryVectorPhaseCursor(cursor),
    remaining: true,
    state: 'progress',
  };
}

function ordinaryVectorModelUnavailable(): CodeGraphOrdinaryVectorMaintenanceUnitResult {
  return {
    blockedCode: 'model-unavailable',
    retryAfterMilliseconds: VECTOR_UNIT_RETRY_MILLISECONDS,
    state: 'deferred',
  };
}

function sameOrdinaryVectorPageStorage(left: CodeGraphVectorPageStorage, right: CodeGraphVectorPageStorage): boolean {
  return (
    left.freelistBytes === right.freelistBytes &&
    left.journalMode === right.journalMode &&
    left.pageSize === right.pageSize &&
    left.walAutoCheckpointPages === right.walAutoCheckpointPages
  );
}

export function codeGraphOrdinaryVectorMaintenanceBoundary(
  databaseBoundary: CodeGraphDirectPersistentCapacityBoundary,
  intentToken: string,
  possibleFinalTokens: readonly string[],
): CodeGraphDirectPersistentCapacityBoundary {
  const intentBytes = new TextEncoder().encode(`${intentToken}\n`).byteLength;
  const finalBytes = Math.max(...possibleFinalTokens.map(token => new TextEncoder().encode(`${token}\n`).byteLength));
  const finalFactBytes =
    databaseBoundary.finalFactBytes + intentBytes + finalBytes + ORDINARY_VECTOR_CURSOR_METADATA_BYTES * 2;
  const rowCount = databaseBoundary.rowCount + 4;
  if (
    possibleFinalTokens.length === 0 ||
    !Number.isSafeInteger(finalFactBytes) ||
    !Number.isSafeInteger(rowCount) ||
    finalFactBytes <= 0 ||
    rowCount <= 0
  ) {
    throw new Error('Code graph ordinary vector capacity boundary is invalid.');
  }
  return {finalFactBytes, operation: 'maintain code graph vector retirement', rowCount};
}

function encodeOrdinaryVectorPhaseCursor(cursor: OrdinaryVectorPhaseCursor): string {
  const models = [...cursor.models.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([modelName, state]) => [
      modelName,
      state.phase === 'admission' ? 'a' : state.phase === 'marker' ? 'm' : 'v',
      state.admissionWrapped ? 1 : 0,
      state.afterGeneration,
    ]);
  const payload = Encoding.encodeBase64Url(
    JSON.stringify({
      v: 1,
      d: cursor.digest,
      ...(cursor.nextModelName === undefined ? {} : {n: cursor.nextModelName}),
      m: models,
      p: cursor.roundProgressed ? 1 : 0,
      x: cursor.roundDeferred ? 1 : 0,
    }),
  );
  const seal = sha256HexSync(`code-graph-ordinary-vector-cursor-v1\n${payload}`);
  return `ov1:${seal}:${payload}`;
}

function parseOrdinaryVectorPhaseCursor(cursorToken: string | undefined): OrdinaryVectorPhaseCursor | undefined {
  if (cursorToken === undefined || cursorToken.length > ORDINARY_VECTOR_CURSOR_LIMIT) return undefined;
  const match = ORDINARY_VECTOR_CURSOR.exec(cursorToken);
  if (match === null) return undefined;
  const [, seal, payload] = match;
  if (sha256HexSync(`code-graph-ordinary-vector-cursor-v1\n${payload}`) !== seal) return undefined;
  const decoded = Encoding.decodeBase64UrlString(payload!);
  if (!Result.isSuccess(decoded) || Encoding.encodeBase64Url(decoded.success) !== payload) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(decoded.success);
  } catch {
    return undefined;
  }
  const cursor = decodeOrdinaryVectorCursorPayload(raw);
  return cursor !== undefined && encodeOrdinaryVectorPhaseCursor(cursor) === cursorToken ? cursor : undefined;
}

function decodeOrdinaryVectorCursorPayload(raw: unknown): OrdinaryVectorPhaseCursor | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const candidate = raw as {
    readonly d?: unknown;
    readonly m?: unknown;
    readonly n?: unknown;
    readonly p?: unknown;
    readonly v?: unknown;
    readonly x?: unknown;
  };
  if (
    candidate.v !== 1 ||
    typeof candidate.d !== 'string' ||
    !HASH_ID.test(candidate.d) ||
    (candidate.p !== 0 && candidate.p !== 1) ||
    (candidate.x !== 0 && candidate.x !== 1)
  ) {
    return undefined;
  }
  if (candidate.n !== undefined && (typeof candidate.n !== 'string' || !MODEL_ID.test(candidate.n))) return undefined;
  if (!Array.isArray(candidate.m) || candidate.m.length > VECTOR_DATABASE_LIMIT) return undefined;
  const models = new Map<string, OrdinaryVectorModelCursor>();
  let previous = '';
  for (const entry of candidate.m) {
    if (!Array.isArray(entry) || entry.length !== 4) return undefined;
    const [modelName, phase, wrapped, afterGeneration] = entry;
    if (
      typeof modelName !== 'string' ||
      !MODEL_ID.test(modelName) ||
      modelName <= previous ||
      (phase !== 'a' && phase !== 'm' && phase !== 'v') ||
      (wrapped !== 0 && wrapped !== 1) ||
      typeof afterGeneration !== 'string' ||
      (afterGeneration !== '' && !validOrdinaryVectorGeneration(afterGeneration)) ||
      (phase === 'a' && wrapped !== 0) ||
      (phase === 'v' && (wrapped !== 1 || afterGeneration !== ''))
    ) {
      return undefined;
    }
    const state: OrdinaryVectorModelCursor = {
      admissionWrapped: wrapped === 1,
      afterGeneration,
      phase: phase === 'a' ? 'admission' : phase === 'm' ? 'marker' : 'verified',
    };
    if (state.phase === 'admission' && state.afterGeneration === '') return undefined;
    models.set(modelName, state);
    previous = modelName;
  }
  return {
    digest: candidate.d,
    models,
    ...(candidate.n === undefined ? {} : {nextModelName: candidate.n as string}),
    roundDeferred: candidate.x === 1,
    roundProgressed: candidate.p === 1,
  };
}

function validOrdinaryVectorGeneration(generation: string): boolean {
  const bytes = new TextEncoder().encode(generation).byteLength;
  return bytes > 0 && bytes <= ORDINARY_VECTOR_GENERATION_BYTES && !generation.includes('\0');
}

function ordinaryVectorCursorMatchesInventory(
  cursor: OrdinaryVectorPhaseCursor,
  inventory: VectorDatabaseInventory,
): boolean {
  const models = new Set(inventory.candidates.map(candidate => candidate.modelName));
  return (
    (cursor.nextModelName === undefined || models.has(cursor.nextModelName)) &&
    [...cursor.models.keys()].every(modelName => models.has(modelName))
  );
}

function sameVectorDatabaseInventory(left: VectorDatabaseInventory, right: VectorDatabaseInventory): boolean {
  return (
    left.truncated === right.truncated &&
    left.unsafeEntries === right.unsafeEntries &&
    left.vectorRoot === right.vectorRoot &&
    left.candidates.length === right.candidates.length &&
    left.candidates.every((candidate, index) => {
      const observed = right.candidates[index];
      return (
        observed !== undefined &&
        candidate.databasePath === observed.databasePath &&
        candidate.modelName === observed.modelName &&
        sameVectorDatabaseFileIdentity(candidate.fileIdentity, observed.fileIdentity)
      );
    })
  );
}

interface OrdinaryVectorCursorAuthority {
  readonly cursorPath: string;
  readonly directory: string;
  readonly directoryIdentity: VectorDatabaseFileIdentity;
  readonly lockPath: string;
  readonly temporaryPath: string;
  readonly vectorRoot: string;
}

type OrdinaryVectorCursorRead =
  {readonly state: 'absent'} | {readonly cursorToken: string; readonly state: 'cursor'} | {readonly state: 'invalid'};

function inspectOrdinaryVectorCursorAuthority(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  vectorRoot: string,
  lockPath: string,
): Effect.Effect<OrdinaryVectorCursorAuthority, unknown> {
  return Effect.gen(function* () {
    const directory = vectorRoot;
    const info = yield* fs.stat(directory);
    if (info.type !== 'Directory' || (yield* fs.realPath(directory)) !== directory) {
      return yield* Effect.fail(new Error('Code graph ordinary vector cursor directory is invalid.'));
    }
    const authority = {
      cursorPath: path.join(directory, ORDINARY_VECTOR_CURSOR_FILE),
      directory,
      directoryIdentity: vectorDatabaseFileIdentity(info),
      lockPath,
      temporaryPath: path.join(directory, ORDINARY_VECTOR_CURSOR_TEMPORARY),
      vectorRoot,
    } satisfies OrdinaryVectorCursorAuthority;
    for (const target of [authority.cursorPath, authority.temporaryPath]) {
      if (Option.isSome(yield* fs.readLink(target).pipe(Effect.option))) {
        return yield* Effect.fail(new Error('Code graph ordinary vector cursor authority contains a symbolic link.'));
      }
    }
    return authority;
  });
}

function revalidateOrdinaryVectorCursorAuthority(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  authority: OrdinaryVectorCursorAuthority,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const info = yield* fs.stat(authority.directory);
    if (
      info.type !== 'Directory' ||
      (yield* fs.realPath(authority.directory)) !== authority.directory ||
      authority.vectorRoot !== authority.directory ||
      !sameVectorDatabaseFileIdentity(authority.directoryIdentity, vectorDatabaseFileIdentity(info))
    ) {
      return yield* Effect.fail(new Error('Code graph ordinary vector cursor directory changed identity.'));
    }
    for (const target of [authority.cursorPath, authority.temporaryPath]) {
      if (Option.isSome(yield* fs.readLink(target).pipe(Effect.option))) {
        return yield* Effect.fail(new Error('Code graph ordinary vector cursor authority became a symbolic link.'));
      }
      const targetInfo = yield* optionalVectorFileInfo(fs, target);
      if (Option.isSome(targetInfo) && targetInfo.value.type !== 'File') {
        return yield* Effect.fail(new Error('Code graph ordinary vector cursor authority changed type.'));
      }
    }
  });
}

function recoverOrdinaryVectorCursorTemporary(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  authority: OrdinaryVectorCursorAuthority,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    yield* revalidateOrdinaryVectorCursorAuthority(fs, path, authority);
    const info = yield* optionalVectorFileInfo(fs, authority.temporaryPath);
    if (Option.isNone(info)) return;
    if (info.value.type !== 'File') {
      return yield* Effect.fail(new Error('Code graph ordinary vector cursor temporary is invalid.'));
    }
    yield* removeOrdinaryVectorCursorFileIfOwned(
      fs,
      path,
      authority,
      authority.temporaryPath,
      vectorDatabaseFileIdentity(info.value),
    );
  });
}

function readOrdinaryVectorCursor(
  fs: FileSystem.FileSystem,
  cursorPath: string,
): Effect.Effect<OrdinaryVectorCursorRead, unknown> {
  return Effect.gen(function* () {
    if (Option.isSome(yield* fs.readLink(cursorPath).pipe(Effect.option))) return {state: 'invalid'} as const;
    const info = yield* optionalVectorFileInfo(fs, cursorPath);
    if (Option.isNone(info)) return {state: 'absent'} as const;
    if (info.value.type !== 'File' || info.value.size > ORDINARY_VECTOR_CURSOR_LIMIT + 1) {
      return {state: 'invalid'} as const;
    }
    const content = yield* fs.readFileString(cursorPath);
    if (
      new TextEncoder().encode(content).byteLength > ORDINARY_VECTOR_CURSOR_LIMIT + 1 ||
      !content.endsWith('\n') ||
      content.slice(0, -1).includes('\n')
    ) {
      return {state: 'invalid'} as const;
    }
    const cursorToken = content.slice(0, -1);
    return parseOrdinaryVectorPhaseCursor(cursorToken) === undefined
      ? ({state: 'invalid'} as const)
      : ({cursorToken, state: 'cursor'} as const);
  });
}

function writeOrdinaryVectorCursorCas(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  crypto: Crypto.Crypto,
  authority: OrdinaryVectorCursorAuthority,
  expectedToken: string | undefined,
  nextToken: string | undefined,
): Effect.Effect<void, unknown> {
  let temporaryIdentity: VectorDatabaseFileIdentity | undefined;
  return Effect.gen(function* () {
    void crypto;
    yield* revalidateOrdinaryVectorCursorAuthority(fs, path, authority);
    const observed = yield* readOrdinaryVectorCursor(fs, authority.cursorPath);
    if (
      observed.state === 'invalid' ||
      (observed.state === 'cursor' ? observed.cursorToken : undefined) !== expectedToken
    ) {
      return yield* Effect.fail(new Error('Code graph ordinary vector cursor CAS changed.'));
    }
    if (nextToken === undefined) {
      if (observed.state === 'cursor') {
        const info = yield* fs.stat(authority.cursorPath);
        if (info.type !== 'File') {
          return yield* Effect.fail(new Error('Code graph ordinary vector cursor changed type.'));
        }
        yield* removeOrdinaryVectorCursorFileIfOwned(
          fs,
          path,
          authority,
          authority.cursorPath,
          vectorDatabaseFileIdentity(info),
        );
      }
      yield* syncOrdinaryVectorDirectory(fs, authority.directory);
      return;
    }
    const content = `${nextToken}\n`;
    if (
      parseOrdinaryVectorPhaseCursor(nextToken) === undefined ||
      new TextEncoder().encode(content).byteLength > ORDINARY_VECTOR_CURSOR_LIMIT + 1
    ) {
      return yield* Effect.fail(new Error('Code graph ordinary vector cursor exceeded its exact bound.'));
    }
    yield* recoverOrdinaryVectorCursorTemporary(fs, path, authority);
    yield* revalidateOrdinaryVectorCursorAuthority(fs, path, authority);
    yield* fs.writeFileString(authority.temporaryPath, content, {flag: 'wx', mode: 0o600});
    const temporaryInfo = yield* fs.stat(authority.temporaryPath);
    if (temporaryInfo.type !== 'File') {
      return yield* Effect.fail(new Error('Code graph ordinary vector cursor temporary changed type.'));
    }
    temporaryIdentity = vectorDatabaseFileIdentity(temporaryInfo);
    yield* syncOrdinaryVectorFile(fs, authority.temporaryPath);
    yield* revalidateOrdinaryVectorCursorAuthority(fs, path, authority);
    const reobserved = yield* readOrdinaryVectorCursor(fs, authority.cursorPath);
    if (
      reobserved.state === 'invalid' ||
      (reobserved.state === 'cursor' ? reobserved.cursorToken : undefined) !== expectedToken
    ) {
      return yield* Effect.fail(new Error('Code graph ordinary vector cursor CAS changed before publication.'));
    }
    yield* revalidateOrdinaryVectorCursorAuthority(fs, path, authority);
    const finalTemporaryInfo = yield* fs.stat(authority.temporaryPath);
    if (
      finalTemporaryInfo.type !== 'File' ||
      temporaryIdentity === undefined ||
      !sameVectorDatabaseFileIdentity(temporaryIdentity, vectorDatabaseFileIdentity(finalTemporaryInfo))
    ) {
      return yield* Effect.fail(new Error('Code graph ordinary vector cursor temporary changed identity.'));
    }
    yield* fs.rename(authority.temporaryPath, authority.cursorPath);
    temporaryIdentity = undefined;
    yield* revalidateOrdinaryVectorCursorAuthority(fs, path, authority);
    yield* syncOrdinaryVectorDirectory(fs, authority.directory);
  }).pipe(
    Effect.onError(() =>
      cleanupOrdinaryVectorCursorTemporary(fs, path, authority, temporaryIdentity).pipe(
        Effect.catch(() => Effect.void),
      ),
    ),
  );
}

function cleanupOrdinaryVectorCursorTemporary(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  authority: OrdinaryVectorCursorAuthority,
  expectedIdentity: VectorDatabaseFileIdentity | undefined,
): Effect.Effect<void, unknown> {
  if (expectedIdentity === undefined) return Effect.void;
  return removeOrdinaryVectorCursorFileIfOwned(fs, path, authority, authority.temporaryPath, expectedIdentity);
}

function removeOrdinaryVectorCursorFileIfOwned(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  authority: OrdinaryVectorCursorAuthority,
  file: string,
  expectedIdentity: VectorDatabaseFileIdentity,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    yield* revalidateOrdinaryVectorCursorAuthority(fs, path, authority);
    if (Option.isSome(yield* fs.readLink(file).pipe(Effect.option))) {
      return yield* Effect.fail(new Error('Code graph ordinary vector cursor file became a symbolic link.'));
    }
    const observed = yield* optionalVectorFileInfo(fs, file);
    if (Option.isNone(observed)) return;
    if (
      observed.value.type !== 'File' ||
      !sameVectorDatabaseFileIdentity(expectedIdentity, vectorDatabaseFileIdentity(observed.value))
    ) {
      return yield* Effect.fail(new Error('Code graph ordinary vector cursor file changed identity.'));
    }
    yield* revalidateOrdinaryVectorCursorAuthority(fs, path, authority);
    if (Option.isSome(yield* fs.readLink(file).pipe(Effect.option))) {
      return yield* Effect.fail(new Error('Code graph ordinary vector cursor file became a symbolic link.'));
    }
    const confirmed = yield* optionalVectorFileInfo(fs, file);
    if (
      Option.isNone(confirmed) ||
      confirmed.value.type !== 'File' ||
      !sameVectorDatabaseFileIdentity(expectedIdentity, vectorDatabaseFileIdentity(confirmed.value))
    ) {
      return yield* Effect.fail(new Error('Code graph ordinary vector cursor file changed before removal.'));
    }
    yield* fs.remove(file, {force: false});
  });
}

function syncOrdinaryVectorFile(fs: FileSystem.FileSystem, file: string): Effect.Effect<void, never> {
  return Effect.scoped(
    fs.open(file, {flag: 'r'}).pipe(
      Effect.flatMap(handle => handle.sync),
      Effect.catch(() => Effect.void),
    ),
  );
}

function syncOrdinaryVectorDirectory(fs: FileSystem.FileSystem, directory: string): Effect.Effect<void, never> {
  return Effect.scoped(
    fs.open(directory, {flag: 'r'}).pipe(
      Effect.flatMap(handle => handle.sync),
      Effect.catch(() => Effect.void),
    ),
  );
}

function ordinaryVectorMonotonicMilliseconds(preparation: CodeGraphOrdinaryVectorMaintenanceUnitPreparation): number {
  return preparation.monotonicMilliseconds?.() ?? performance.now();
}

function ensureOrdinaryVectorUnitDeadline(
  preparation: CodeGraphOrdinaryVectorMaintenanceUnitPreparation,
): Effect.Effect<void, Error> {
  return Effect.suspend(() =>
    ordinaryVectorMonotonicMilliseconds(preparation) < preparation.deadlineMonotonicMilliseconds
      ? Effect.void
      : Effect.fail(new Error('Code graph ordinary vector maintenance deadline expired.')),
  );
}
function ensureVectorUnitDeadline(preparation: CodeGraphRemovedViewVectorUnitPreparation): Effect.Effect<void, Error> {
  return Effect.suspend(() =>
    (preparation.monotonicMilliseconds?.() ?? performance.now()) < preparation.deadlineMonotonicMilliseconds
      ? Effect.void
      : Effect.fail(new Error('Code graph vector cleanup deadline expired.')),
  );
}

function invalidOrdinaryVectorUnit(): CodeGraphOrdinaryVectorMaintenanceUnitResult {
  return {
    blockedCode: 'invalid-sidecar',
    retryAfterMilliseconds: VECTOR_UNIT_INVALID_RETRY_MILLISECONDS,
    state: 'deferred',
  };
}

function unavailableOrdinaryVectorUnit(): CodeGraphOrdinaryVectorMaintenanceUnitResult {
  return {
    blockedCode: 'io-error',
    retryAfterMilliseconds: VECTOR_UNIT_RETRY_MILLISECONDS,
    state: 'deferred',
  };
}

function invalidVectorUnit(): CodeGraphRemovedViewVectorUnitResult {
  return {
    blockedCode: 'invalid-sidecar',
    retryAfterMilliseconds: VECTOR_UNIT_INVALID_RETRY_MILLISECONDS,
    state: 'deferred',
  };
}

function unavailableVectorUnit(): CodeGraphRemovedViewVectorUnitResult {
  return {
    blockedCode: 'io-error',
    retryAfterMilliseconds: VECTOR_UNIT_RETRY_MILLISECONDS,
    state: 'deferred',
  };
}

function vectorInventoryDigest(candidates: readonly VectorDatabaseCandidate[]): string {
  return sha256HexSync(
    `code-graph-vector-inventory-v1\n${candidates.map(candidate => candidate.modelName).join('\n')}`,
  );
}

function parseVectorPhaseCursor(cursorToken: string | undefined): VectorPhaseCursor | undefined {
  if (cursorToken === undefined) return undefined;
  const match = VECTOR_PHASE_CURSOR.exec(cursorToken);
  if (match === null) return undefined;
  const [, mode, digest, modelName, stepText] = match;
  if (mode === 'r') {
    return modelName === undefined && stepText === undefined ? {digest, mode: 'reset'} : undefined;
  }
  if (mode === 'n') {
    return modelName !== undefined && stepText === undefined ? {digest, mode: 'next', modelName} : undefined;
  }
  if (mode !== 'a' || modelName === undefined || stepText === undefined || !/^[1-9][0-9]*$/u.test(stepText)) {
    return undefined;
  }
  const step = Number(stepText);
  return Number.isSafeInteger(step) && step > 0 && String(step) === stepText
    ? {digest, mode: 'active', modelName, step}
    : undefined;
}

function vectorResetCursor(digest: string): string {
  return `vp1:r:${digest}`;
}

function vectorNextCursor(digest: string, modelName: string): string {
  return `vp1:n:${digest}:${modelName}`;
}

function vectorActiveCursor(digest: string, modelName: string, step: number): string {
  return `vp1:a:${digest}:${modelName}:${step}`;
}

function safeVectorCursorStep(step: number): number | undefined {
  const next = step + 1;
  return Number.isSafeInteger(next) && next > 0 ? next : undefined;
}

function selectVectorUnitCandidate(
  candidates: readonly VectorDatabaseCandidate[],
  cursor: VectorPhaseCursor | undefined,
): VectorDatabaseCandidate | undefined {
  if (cursor === undefined || cursor.mode === 'reset') return candidates[0];
  if (cursor.mode === 'active') return candidates.find(candidate => candidate.modelName === cursor.modelName);
  return candidates.find(candidate => candidate.modelName > cursor.modelName);
}

function verifyVectorUnitInventory(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  crypto: Crypto.Crypto,
  system: SystemInfoShape,
  input: CodeGraphRemovedViewVectorUnitInput,
  entry: CodeGraphRemovedViewVectorUnitEntry,
  expectedDigest: string,
  preparation: CodeGraphRemovedViewVectorUnitPreparation,
): Effect.Effect<CodeGraphRemovedViewVectorUnitResult, unknown> {
  return Effect.gen(function* () {
    yield* ensureVectorUnitDeadline(preparation);
    const inventory = yield* inspectVectorDatabases(fs, path, input.threadnoteHome, input.checkoutId).pipe(
      Effect.match({onFailure: () => undefined, onSuccess: value => value}),
    );
    if (inventory === undefined) return unavailableVectorUnit();
    if (inventory.truncated || inventory.unsafeEntries > 0) return invalidVectorUnit();
    const digest = vectorInventoryDigest(inventory.candidates);
    if (digest !== expectedDigest) return {cursorToken: vectorResetCursor(digest), state: 'progress'} as const;

    for (const candidate of inventory.candidates) {
      yield* ensureVectorUnitDeadline(preparation);
      const outcome = yield* withExclusiveFileLock(
        fs,
        codeGraphVectorWriteLockPath(path, input.threadnoteHome, input.checkoutId, candidate.modelKey),
        {
          retryIntervalMilliseconds: 1,
          staleAfterMilliseconds: 120_000,
          waitTimeoutMilliseconds: 0,
        },
        Effect.gen(function* () {
          yield* validateVectorDatabaseCandidate(fs, path, candidate);
          const schemaPlan = yield* planCodeGraphVectorRetirementPreparation(candidate.databasePath);
          if (schemaPlan.state === 'planned') return true;
          const pointerPlan = yield* planCodeGraphVectorPointerRetirement(candidate.databasePath, {
            expectedSnapshotId: entry.expectedSnapshotId,
            worktreeId: entry.worktreeId,
          });
          if (pointerPlan.state === 'planned') return true;
          return (
            (yield* selectCodeGraphVectorRetirementMarkerCandidate(candidate.databasePath, {
              retiredByWorktreeId: entry.worktreeId,
              snapshotId: entry.expectedSnapshotId,
            })) !== undefined
          );
        }),
      ).pipe(Effect.match({onFailure: () => undefined, onSuccess: dirty => dirty}));
      if (outcome === undefined) {
        return {
          cursorToken: vectorResetCursor(digest),
          retryAfterMilliseconds: VECTOR_UNIT_RETRY_MILLISECONDS,
          state: 'progress',
        } as const;
      }
      if (outcome) return {cursorToken: vectorResetCursor(digest), state: 'progress'} as const;
    }
    return {state: 'complete'} as const;
  }).pipe(
    Effect.provideService(Crypto.Crypto, crypto),
    Effect.provideService(Path.Path, path),
    Effect.provideService(SystemInfo, system),
  );
}

/**
 * Remove only the selected worktree pointer when it still joins a generation
 * for the expected graph snapshot. Generation reclamation remains deferred so
 * this foreground action never cascades through a large vector table.
 */
export const cleanupCodeGraphVectorPointers = Effect.fn('codeGraph.cleanupVectorPointers')(function* (
  threadnoteHome: string,
  checkoutId: string,
  worktreeId: string,
  expectedSnapshotId: string,
) {
  if (!HASH_ID.test(checkoutId) || !HASH_ID.test(worktreeId) || !validSnapshotId(expectedSnapshotId)) {
    return yield* Effect.fail(new Error('Code graph vector cleanup target is invalid.'));
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const warnings = new Map<CodeGraphVectorCleanupWarningCode, number>();
  const inventory = yield* inspectVectorDatabases(fs, path, threadnoteHome, checkoutId).pipe(
    Effect.match({
      onFailure: () => undefined,
      onSuccess: value => value,
    }),
  );
  if (inventory === undefined) {
    incrementWarning(warnings, 'vector-inventory-unavailable');
    return vectorCleanupResult(0, 0, 0, warnings);
  }
  if (inventory.truncated) incrementWarning(warnings, 'vector-inventory-truncated');
  if (inventory.unsafeEntries > 0) incrementWarning(warnings, 'vector-inventory-unsafe', inventory.unsafeEntries);

  let processed = 0;
  let removed = 0;
  for (const candidate of inventory.candidates) {
    const outcome = yield* withExclusiveFileLock(
      fs,
      codeGraphVectorWriteLockPath(path, threadnoteHome, checkoutId, candidate.modelKey),
      {
        retryIntervalMilliseconds: 1,
        staleAfterMilliseconds: 120_000,
        waitTimeoutMilliseconds: 0,
      },
      validateVectorDatabaseCandidate(fs, path, candidate).pipe(
        Effect.andThen(removeExpectedVectorPointer(fs, path, candidate, worktreeId, expectedSnapshotId)),
      ),
    ).pipe(
      Effect.match({
        onFailure: cause => (isFileLockTimeout(cause) ? ({state: 'busy'} as const) : ({state: 'unreadable'} as const)),
        onSuccess: pointerCount => ({pointerCount, state: 'processed' as const}),
      }),
    );
    if (outcome.state === 'busy') {
      incrementWarning(warnings, 'vector-store-busy');
      continue;
    }
    if (outcome.state === 'unreadable') {
      incrementWarning(warnings, 'vector-store-unreadable');
      continue;
    }
    processed += 1;
    removed += outcome.pointerCount;
  }
  return vectorCleanupResult(inventory.candidates.length, processed, removed, warnings);
});

function inspectVectorDatabases(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  threadnoteHome: string,
  checkoutId: string,
): Effect.Effect<VectorDatabaseInventory, unknown> {
  return Effect.gen(function* () {
    const canonicalVectorRoot = yield* inspectCanonicalVectorRoot(fs, path, threadnoteHome, checkoutId);
    if (canonicalVectorRoot === undefined) return {candidates: [], truncated: false, unsafeEntries: 0};
    const page = yield* runtimeTextDirectoryNamePage(canonicalVectorRoot, VECTOR_DIRECTORY_ENTRY_LIMIT);
    if (page.overflow) {
      return {candidates: [], truncated: true, unsafeEntries: 0, vectorRoot: canonicalVectorRoot};
    }
    const names = [...page.names].sort();
    const candidates: VectorDatabaseCandidate[] = [];
    let modelDirectoryCount = 0;
    let unsafeEntries = 0;
    let truncated = false;
    for (const name of names) {
      if (name === ORDINARY_VECTOR_CURSOR_FILE || name === ORDINARY_VECTOR_CURSOR_TEMPORARY) {
        const ownedPath = path.join(canonicalVectorRoot, name);
        const ownedInfo = yield* optionalVectorFileInfo(fs, ownedPath);
        if (
          Option.isSome(yield* fs.readLink(ownedPath).pipe(Effect.option)) ||
          Option.isNone(ownedInfo) ||
          ownedInfo.value.type !== 'File'
        ) {
          unsafeEntries += 1;
        }
        continue;
      }
      if (!MODEL_ID.test(name)) {
        unsafeEntries += 1;
        continue;
      }
      const modelRoot = path.join(canonicalVectorRoot, name);
      if (Option.isSome(yield* fs.readLink(modelRoot).pipe(Effect.option))) {
        unsafeEntries += 1;
        continue;
      }
      const modelInfo = yield* fs.stat(modelRoot).pipe(Effect.option);
      if (Option.isNone(modelInfo) || modelInfo.value.type !== 'Directory') {
        unsafeEntries += 1;
        continue;
      }
      const canonicalModelRoot = yield* fs.realPath(modelRoot).pipe(Effect.option);
      if (
        Option.isNone(canonicalModelRoot) ||
        path.dirname(canonicalModelRoot.value) !== canonicalVectorRoot ||
        path.basename(canonicalModelRoot.value) !== name
      ) {
        unsafeEntries += 1;
        continue;
      }
      modelDirectoryCount += 1;
      if (modelDirectoryCount > VECTOR_DATABASE_LIMIT) {
        truncated = true;
        continue;
      }
      const databasePath = path.join(canonicalModelRoot.value, VECTOR_DATABASE_NAME);
      if (Option.isSome(yield* fs.readLink(databasePath).pipe(Effect.option))) {
        unsafeEntries += 1;
        continue;
      }
      const databaseInfo = yield* fs.stat(databasePath).pipe(Effect.option);
      if (Option.isNone(databaseInfo)) continue;
      if (databaseInfo.value.type !== 'File') {
        unsafeEntries += 1;
        continue;
      }
      candidates.push({
        databasePath,
        fileIdentity: vectorDatabaseFileIdentity(databaseInfo.value),
        modelKey: sha256HexSync(name),
        modelName: name,
        modelRoot: canonicalModelRoot.value,
        vectorRoot: canonicalVectorRoot,
      });
    }
    return {candidates, truncated, unsafeEntries, vectorRoot: canonicalVectorRoot};
  });
}

const inspectCanonicalVectorRoot = Effect.fn('codeGraph.inspectCanonicalVectorRoot')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  threadnoteHome: string,
  checkoutId: string,
) {
  if (Option.isSome(yield* fs.readLink(threadnoteHome).pipe(Effect.option))) {
    return yield* Effect.fail(new Error('Threadnote home is a symbolic link.'));
  }
  const homeInfo = yield* optionalVectorFileInfo(fs, threadnoteHome);
  if (Option.isNone(homeInfo)) return undefined;
  if (homeInfo.value.type !== 'Directory') return yield* Effect.fail(new Error('Threadnote home is invalid.'));
  let current = yield* fs.realPath(threadnoteHome);
  for (const segment of ['indexes', 'code-graph', 'repositories', checkoutId, 'vectors']) {
    const candidate = path.join(current, segment);
    if (Option.isSome(yield* fs.readLink(candidate).pipe(Effect.option))) {
      return yield* Effect.fail(new Error('Code graph vector containment contains a symbolic link.'));
    }
    const info = yield* optionalVectorFileInfo(fs, candidate);
    if (Option.isNone(info)) return undefined;
    if (info.value.type !== 'Directory') {
      return yield* Effect.fail(new Error('Code graph vector containment has an invalid entry type.'));
    }
    const canonical = yield* fs.realPath(candidate);
    if (canonical !== candidate || path.dirname(canonical) !== current || path.basename(canonical) !== segment) {
      return yield* Effect.fail(new Error('Code graph vector root escaped its derived-store containment.'));
    }
    current = canonical;
  }
  return current;
});

const validateVectorDatabaseCandidate = Effect.fn('codeGraph.validateVectorDatabaseCandidate')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  candidate: VectorDatabaseCandidate,
) {
  if (
    Option.isSome(yield* fs.readLink(candidate.vectorRoot).pipe(Effect.option)) ||
    Option.isSome(yield* fs.readLink(candidate.modelRoot).pipe(Effect.option)) ||
    Option.isSome(yield* fs.readLink(candidate.databasePath).pipe(Effect.option))
  ) {
    return yield* Effect.fail(new Error('Code graph vector cleanup target became a symbolic link.'));
  }
  const [vectorInfo, modelInfo, databaseInfo] = yield* Effect.all(
    [fs.stat(candidate.vectorRoot), fs.stat(candidate.modelRoot), fs.stat(candidate.databasePath)],
    {concurrency: 1},
  );
  if (vectorInfo.type !== 'Directory' || modelInfo.type !== 'Directory' || databaseInfo.type !== 'File') {
    return yield* Effect.fail(new Error('Code graph vector cleanup target changed type.'));
  }
  if (!sameVectorDatabaseFileIdentity(candidate.fileIdentity, vectorDatabaseFileIdentity(databaseInfo))) {
    return yield* Effect.fail(new Error('Code graph vector cleanup target changed identity.'));
  }
  const [canonicalVectorRoot, canonicalModelRoot, canonicalDatabasePath] = yield* Effect.all(
    [fs.realPath(candidate.vectorRoot), fs.realPath(candidate.modelRoot), fs.realPath(candidate.databasePath)],
    {concurrency: 1},
  );
  if (
    canonicalVectorRoot !== candidate.vectorRoot ||
    canonicalModelRoot !== candidate.modelRoot ||
    canonicalDatabasePath !== candidate.databasePath ||
    path.dirname(canonicalModelRoot) !== canonicalVectorRoot ||
    path.dirname(canonicalDatabasePath) !== canonicalModelRoot
  ) {
    return yield* Effect.fail(new Error('Code graph vector cleanup target escaped its derived-store root.'));
  }
});

function removeExpectedVectorPointer(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  candidate: VectorDatabaseCandidate,
  worktreeId: string,
  expectedSnapshotId: string,
) {
  return Effect.gen(function* () {
    // Revalidate the exact contained inode before opening the writer, closing
    // the validation/open swap window without mutating a replacement target.
    yield* validateVectorDatabaseCandidate(fs, path, candidate);
    return yield* deleteCodeGraphVectorPointerWithRetirement(candidate.databasePath, {
      expectedSnapshotId,
      worktreeId,
    });
  });
}

function vectorDatabaseFileIdentity(info: FileSystem.File.Info): VectorDatabaseFileIdentity {
  const ino = Option.getOrUndefined(info.ino);
  return {dev: info.dev, ...(ino === undefined ? {} : {ino: String(ino)})};
}

function sameVectorDatabaseFileIdentity(
  expected: VectorDatabaseFileIdentity,
  observed: VectorDatabaseFileIdentity,
): boolean {
  return expected.dev === observed.dev && (expected.ino === undefined || expected.ino === observed.ino);
}

function optionalVectorFileInfo(fs: FileSystem.FileSystem, candidate: string) {
  return fs.stat(candidate).pipe(
    Effect.map(Option.some),
    Effect.catch(error =>
      error instanceof PlatformError.PlatformError && error.reason._tag === 'NotFound'
        ? Effect.succeed(Option.none<FileSystem.File.Info>())
        : Effect.fail(error),
    ),
  );
}

function vectorCleanupResult(
  databasesInspected: number,
  databasesProcessed: number,
  pointersRemoved: number,
  warningCounts: ReadonlyMap<CodeGraphVectorCleanupWarningCode, number>,
): CodeGraphVectorPointerCleanupResult {
  const warnings = [...warningCounts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([code, occurrences]) => ({
      code,
      message: vectorCleanupWarningMessage(code),
      occurrences,
      retryable: code !== 'vector-inventory-truncated' && code !== 'vector-inventory-unsafe',
    }));
  return {databasesInspected, databasesProcessed, pointersRemoved, warnings};
}

function incrementWarning(
  warnings: Map<CodeGraphVectorCleanupWarningCode, number>,
  code: CodeGraphVectorCleanupWarningCode,
  occurrences = 1,
): void {
  warnings.set(code, (warnings.get(code) ?? 0) + occurrences);
}

function vectorCleanupWarningMessage(code: CodeGraphVectorCleanupWarningCode): string {
  switch (code) {
    case 'vector-inventory-truncated':
      return 'Vector cleanup reached its bounded database limit; remaining stores require routine maintenance.';
    case 'vector-inventory-unavailable':
      return 'Vector cleanup could not inspect the derived-store inventory; rerun the command.';
    case 'vector-inventory-unsafe':
      return 'Vector cleanup preserved one or more unsafe derived-store entries for manual inspection.';
    case 'vector-store-busy':
      return 'A vector store is busy; rerun the command to retry residual cleanup.';
    case 'vector-store-unreadable':
      return 'A vector store is unreadable; repair it and rerun the command.';
  }
}

function validSnapshotId(snapshotId: string): boolean {
  return snapshotId.length > 0 && snapshotId.length <= 1_024 && !snapshotId.includes('\0');
}
