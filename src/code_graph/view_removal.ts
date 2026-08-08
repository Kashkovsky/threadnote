import {Effect, FileSystem, Option, Path, PlatformError} from 'effect';
import {cleanupMissingCodeGraphLocalProvenance} from './local_provenance.js';
import {withCodeGraphTargetWorktreeLock} from './maintenance_gate.js';
import {
  CodeGraphStore,
  type CodeGraphViewObservationResult,
  type CodeGraphViewRemovalResult as CodeGraphStoreViewRemovalResult,
} from './store.js';
import {
  cleanupCodeGraphVectorPointers,
  type CodeGraphVectorCleanupWarningCode,
  type CodeGraphVectorPointerCleanupResult,
} from './vector_maintenance.js';
import {CODE_GRAPH_SCHEMA_VERSION} from './types.js';

const HASH_ID = /^[0-9a-f]{64}$/;
const SNAPSHOT_ID = /^cgsn_[0-9a-f]{40}(?:-direct|-full-[0-9a-f]{16})?$/;

export type CodeGraphViewRemovalWarningCode = CodeGraphVectorCleanupWarningCode | 'provenance-cleanup-unavailable';

export interface CodeGraphViewRemovalWarning {
  readonly code: CodeGraphViewRemovalWarningCode;
  readonly message: string;
  readonly occurrences: number;
  readonly retryable: boolean;
}

export interface CodeGraphViewRemovalCleanup {
  readonly provenance: {
    readonly observedState?: string;
    readonly state: 'not-found' | 'preserved' | 'removed' | 'unavailable';
  } | null;
  readonly vectors: Omit<CodeGraphVectorPointerCleanupResult, 'warnings'> | null;
}

export interface CodeGraphViewRemovalActionResult {
  readonly applied: boolean;
  readonly checkoutId: string;
  readonly cleanup: CodeGraphViewRemovalCleanup;
  readonly observedSnapshotId?: string;
  readonly observedState?: 'active' | 'removed';
  readonly retiredSnapshots?: number;
  readonly snapshotId: string;
  readonly state: 'already-removed' | 'not-found' | 'ready' | 'removed' | 'stale-target';
  readonly type: 'code-graph-view-removal';
  readonly version: 1;
  readonly warnings: readonly CodeGraphViewRemovalWarning[];
  readonly worktreeId: string;
}

export interface CodeGraphViewRemovalTarget {
  readonly checkoutId: string;
  readonly snapshotId: string;
  readonly worktreeId: string;
}

export const removeCodeGraphView = Effect.fn('codeGraph.removeViewAction')(function* (
  threadnoteHome: string,
  target: CodeGraphViewRemovalTarget,
  options: {readonly apply?: boolean} = {},
) {
  yield* validateCodeGraphViewRemovalTarget(target);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const store = yield* CodeGraphStore;
  const inspected = yield* inspectCodeGraphViewDatabaseTarget(threadnoteHome, target.checkoutId);
  if (inspected.state === 'missing') {
    return actionResult(
      target,
      options.apply === true,
      {expectedSnapshotId: target.snapshotId, state: 'not-found'},
      {provenance: null, vectors: null},
      [],
    );
  }
  if (!options.apply) {
    const observation = yield* store.observeView(inspected.databasePath, target.worktreeId, target.snapshotId);
    return actionResult(target, false, observation, {provenance: null, vectors: null}, []);
  }

  return yield* withCodeGraphTargetWorktreeLock(
    inspected.canonicalHome,
    target.checkoutId,
    target.worktreeId,
    Effect.gen(function* () {
      const core = yield* store.removeView(inspected.databasePath, target.worktreeId, target.snapshotId, {
        beforeDatabaseOpen: () =>
          inspectCodeGraphViewDatabaseTarget(inspected.canonicalHome, target.checkoutId).pipe(
            Effect.flatMap(current =>
              current.state === 'ready' && current.databasePath === inspected.databasePath
                ? Effect.void
                : Effect.fail(new Error('Code graph database target changed before removal.')),
            ),
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
          ),
        waitTimeoutMilliseconds: 0,
      });
      if (core.state !== 'removed' && core.state !== 'already-removed') {
        return actionResult(target, true, core, {provenance: null, vectors: null}, []);
      }

      const vectors = yield* cleanupCodeGraphVectorPointers(
        inspected.canonicalHome,
        target.checkoutId,
        target.worktreeId,
        target.snapshotId,
      );
      const provenance = yield* cleanupMissingCodeGraphLocalProvenance(inspected.canonicalHome, {
        checkoutId: target.checkoutId,
        worktreeId: target.worktreeId,
      });
      const warnings: CodeGraphViewRemovalWarning[] = vectors.warnings.map(warning => ({...warning}));
      if (provenance.state === 'unavailable') {
        warnings.push({
          code: 'provenance-cleanup-unavailable',
          message: 'Local provenance cleanup was unavailable; rerun the command to retry residual cleanup.',
          occurrences: 1,
          retryable: true,
        });
      }
      warnings.sort((left, right) => left.code.localeCompare(right.code));
      return actionResult(
        target,
        true,
        core,
        {
          provenance,
          vectors: {
            databasesInspected: vectors.databasesInspected,
            databasesProcessed: vectors.databasesProcessed,
            pointersRemoved: vectors.pointersRemoved,
          },
        },
        warnings,
      );
    }),
  );
});

type CodeGraphViewDatabaseTargetInspection =
  | {readonly state: 'missing'}
  | {readonly canonicalHome: string; readonly databasePath: string; readonly state: 'ready'};

const inspectCodeGraphViewDatabaseTarget = Effect.fn('codeGraph.inspectViewDatabaseTarget')(function* (
  threadnoteHome: string,
  checkoutId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (Option.isSome(yield* fs.readLink(threadnoteHome).pipe(Effect.option))) {
    return yield* Effect.fail(new Error('Threadnote home is a symbolic link; graph view removal was refused.'));
  }
  const homeInfo = yield* optionalFileInfo(fs, threadnoteHome);
  if (Option.isNone(homeInfo)) return {state: 'missing'} as const satisfies CodeGraphViewDatabaseTargetInspection;
  if (homeInfo.value.type !== 'Directory') {
    return yield* Effect.fail(new Error('Threadnote home is not a directory; graph view removal was refused.'));
  }
  const canonicalHome = yield* fs.realPath(threadnoteHome);
  const segments = [
    'indexes',
    'code-graph',
    'repositories',
    checkoutId,
    `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`,
  ] as const;
  let current = canonicalHome;
  for (const [index, segment] of segments.entries()) {
    const candidate = path.join(current, segment);
    if (Option.isSome(yield* fs.readLink(candidate).pipe(Effect.option))) {
      return yield* Effect.fail(new Error('Code graph database containment contains a symbolic link.'));
    }
    const info = yield* optionalFileInfo(fs, candidate);
    if (Option.isNone(info)) return {state: 'missing'} as const satisfies CodeGraphViewDatabaseTargetInspection;
    const final = index === segments.length - 1;
    if ((final && info.value.type !== 'File') || (!final && info.value.type !== 'Directory')) {
      return yield* Effect.fail(new Error('Code graph database containment has an invalid entry type.'));
    }
    const canonical = yield* fs.realPath(candidate);
    if (canonical !== candidate || path.dirname(canonical) !== current || path.basename(canonical) !== segment) {
      return yield* Effect.fail(new Error('Code graph database target escaped its derived-store root.'));
    }
    current = canonical;
  }
  return {
    canonicalHome,
    databasePath: current,
    state: 'ready',
  } as const satisfies CodeGraphViewDatabaseTargetInspection;
});

function optionalFileInfo(fs: FileSystem.FileSystem, candidate: string) {
  return fs.stat(candidate).pipe(
    Effect.map(Option.some),
    Effect.catch(error =>
      error instanceof PlatformError.PlatformError && error.reason._tag === 'NotFound'
        ? Effect.succeed(Option.none<FileSystem.File.Info>())
        : Effect.fail(error),
    ),
  );
}

export function serializeCodeGraphViewRemovalResult(result: CodeGraphViewRemovalActionResult): string {
  return JSON.stringify(result);
}

export function renderCodeGraphViewRemovalResult(result: CodeGraphViewRemovalActionResult): string {
  const target = `checkout ${result.checkoutId.slice(0, 12)}, worktree ${result.worktreeId.slice(0, 12)}, snapshot ${result.snapshotId}`;
  const headline =
    result.state === 'ready'
      ? `Would remove native code graph view for ${target}.`
      : result.state === 'removed'
        ? `Removed native code graph view for ${target}.`
        : result.state === 'already-removed'
          ? `Native code graph view is already removed for ${target}.`
          : result.state === 'stale-target'
            ? `Refusing to remove native code graph view: the selected target is stale.`
            : `Refusing to remove native code graph view: the selected target was not found.`;
  const cleanup =
    result.cleanup.vectors === null
      ? []
      : [
          `Derived cleanup: ${result.cleanup.vectors.pointersRemoved} vector pointer(s) removed across ` +
            `${result.cleanup.vectors.databasesProcessed}/${result.cleanup.vectors.databasesInspected} store(s); ` +
            `provenance ${result.cleanup.provenance?.state ?? 'not-run'}.`,
        ];
  return [
    headline,
    ...cleanup,
    ...result.warnings.map(warning => `Warning [${warning.code}]: ${warning.message}`),
  ].join('\n');
}

export function codeGraphViewRemovalTargetFailure(result: CodeGraphViewRemovalActionResult): Error | undefined {
  if (result.state === 'stale-target') {
    return new Error('The selected code graph view changed; refresh the view inventory and retry.');
  }
  if (result.state === 'not-found') {
    return new Error('The selected code graph view does not exist; refresh the view inventory.');
  }
  return undefined;
}

function actionResult(
  target: CodeGraphViewRemovalTarget,
  applied: boolean,
  core: CodeGraphViewObservationResult | CodeGraphStoreViewRemovalResult,
  cleanup: CodeGraphViewRemovalCleanup,
  warnings: readonly CodeGraphViewRemovalWarning[],
): CodeGraphViewRemovalActionResult {
  return {
    applied,
    checkoutId: target.checkoutId,
    cleanup,
    ...('observedSnapshotId' in core ? {observedSnapshotId: core.observedSnapshotId} : {}),
    ...('observedState' in core ? {observedState: core.observedState} : {}),
    ...('retiredSnapshots' in core ? {retiredSnapshots: core.retiredSnapshots} : {}),
    snapshotId: target.snapshotId,
    state: core.state,
    type: 'code-graph-view-removal',
    version: 1,
    warnings,
    worktreeId: target.worktreeId,
  };
}

const validateCodeGraphViewRemovalTarget = Effect.fn('codeGraph.validateViewRemovalActionTarget')(function* (
  target: CodeGraphViewRemovalTarget,
) {
  if (!HASH_ID.test(target.checkoutId)) {
    return yield* Effect.fail(new Error('Code graph checkout identity must be 64 lowercase hexadecimal characters.'));
  }
  if (!HASH_ID.test(target.worktreeId)) {
    return yield* Effect.fail(new Error('Code graph worktree identity must be 64 lowercase hexadecimal characters.'));
  }
  if (!SNAPSHOT_ID.test(target.snapshotId)) {
    return yield* Effect.fail(new Error('Code graph snapshot identity is invalid.'));
  }
});
