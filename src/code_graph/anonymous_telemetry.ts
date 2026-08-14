import {Cause, Clock, Effect, Exit} from 'effect';
import {
  emitAnonymousTelemetryEvent,
  recordAnonymousTelemetryFields,
  type AnonymousTelemetryFields,
} from '../effect/telemetry.js';
import {anonymousTelemetryDiagnosticFromError, type AnonymousTelemetryDiagnostic} from '../telemetry/diagnostic.js';
import {
  codeGraphBuildAnonymousTelemetryFields,
  type CodeGraphBuildAnonymousTelemetryInput,
} from './build_anonymous_telemetry.js';
import type {CodeGraphInventory} from './inventory.js';
import type {CodeGraphIndexSummary, CodeGraphProgress} from './types.js';

const CHECKPOINT_INTERVAL_MILLISECONDS = 60_000;

export type CodeGraphAnonymousTelemetryComponent = 'cli' | 'mcp';
export type CodeGraphBackgroundFailureOperation = 'graph-maintenance' | 'graph-refresh';

export interface CodeGraphBuildAnonymousTelemetryReporter {
  readonly observeExtractedFactBytes: (bytes: number) => Effect.Effect<void>;
  readonly observeInventory: (inventory: CodeGraphInventory) => Effect.Effect<void>;
  readonly observeOverlay: (dirty: boolean) => Effect.Effect<void>;
  readonly progress: (progress: CodeGraphProgress) => Effect.Effect<void>;
  readonly terminal: <E>(exit: Exit.Exit<CodeGraphIndexSummary, E>) => Effect.Effect<void>;
}

export function codeGraphAnonymousTelemetryComponent(
  environment: Readonly<Record<string, string | undefined>>,
): CodeGraphAnonymousTelemetryComponent {
  return environment.THREADNOTE_MCP_BROKER_CHILD === '1' ? 'mcp' : 'cli';
}

/** Emits a closed, fail-soft terminal observation for detached graph work. */
export function emitCodeGraphBackgroundFailure(
  component: CodeGraphAnonymousTelemetryComponent,
  operation: CodeGraphBackgroundFailureOperation,
  diagnostic: AnonymousTelemetryDiagnostic | undefined,
): Effect.Effect<void> {
  return emitAnonymousTelemetryEvent({
    component,
    diagnostic,
    errorType: diagnostic?.errorType ?? 'CodeGraphStoreError',
    event: 'lifecycle',
    operation,
    outcome: 'failure',
  });
}

/**
 * Captures path-free graph progress on the enclosing operation and emits a
 * bounded checkpoint at phase changes or once per minute. This leaves useful
 * evidence even when a build stalls, crashes, or is killed before completion.
 */
export function makeCodeGraphAnonymousTelemetryReporter(component: CodeGraphAnonymousTelemetryComponent) {
  let lastEmittedAt = Number.NEGATIVE_INFINITY;
  let lastPhase: CodeGraphProgress['phase'] | undefined;
  return (progress: CodeGraphProgress): Effect.Effect<void> =>
    Effect.gen(function* () {
      const fields = codeGraphAnonymousTelemetryFields(progress);
      yield* recordAnonymousTelemetryFields(fields);
      const now = yield* Clock.currentTimeMillis;
      if (progress.phase === lastPhase && now - lastEmittedAt < CHECKPOINT_INTERVAL_MILLISECONDS) return;
      lastPhase = progress.phase;
      lastEmittedAt = now;
      yield* emitAnonymousTelemetryEvent({
        component,
        event: 'checkpoint',
        fields,
        operation: 'graph-build',
      });
    });
}

/**
 * Retains one build's terminal, path-free evidence separately from generic
 * invocation progress. The terminal claim is shared across retry attempts.
 */
export const makeCodeGraphBuildAnonymousTelemetryReporter = Effect.fn('codeGraph.makeBuildAnonymousTelemetryReporter')(
  function* (component: CodeGraphAnonymousTelemetryComponent) {
    const startedAt = yield* Clock.currentTimeMillis;
    const checkpoint = makeCodeGraphAnonymousTelemetryReporter(component);
    let buildKind: CodeGraphBuildAnonymousTelemetryInput['buildKind'] = 'clean';
    let extractedFactBytes: number | undefined;
    let changedFiles: number | undefined;
    let deletedFiles: number | undefined;
    let materializationMetrics: Extract<CodeGraphProgress, {readonly phase: 'materializing'}>['metrics'];
    let previousProgressPhase: CodeGraphProgress['phase'] | undefined;
    let scanningMetrics: Extract<CodeGraphProgress, {readonly phase: 'scanning'}>['metrics'];
    let terminalEmitted = false;

    const observeOverlay = (dirty: boolean) =>
      Effect.sync(() => {
        buildKind = dirty ? 'dirty' : 'clean';
        changedFiles = undefined;
        deletedFiles = undefined;
        extractedFactBytes = undefined;
        materializationMetrics = undefined;
        previousProgressPhase = undefined;
        scanningMetrics = undefined;
      });
    const observeInventory = (inventory: CodeGraphInventory) =>
      Effect.sync(() => {
        buildKind = inventory.dirty ? 'dirty' : 'clean';
        const delta = codeGraphInventoryDelta(inventory);
        changedFiles = delta.changedFiles;
        deletedFiles = delta.deletedFiles;
      });
    const observeExtractedFactBytes = (bytes: number) =>
      Effect.sync(() => {
        extractedFactBytes = Number.isFinite(bytes) && bytes >= 0 ? bytes : undefined;
      });
    const progress = (current: CodeGraphProgress) =>
      Effect.sync(() => {
        if (current.phase === 'materializing') {
          if (previousProgressPhase !== 'materializing') materializationMetrics = undefined;
          if (current.metrics !== undefined) materializationMetrics = current.metrics;
        }
        if (current.phase === 'scanning' && current.metrics !== undefined) scanningMetrics = current.metrics;
        previousProgressPhase = current.phase;
      }).pipe(Effect.andThen(checkpoint(current)));
    const terminal = <E>(exit: Exit.Exit<CodeGraphIndexSummary, E>) =>
      Effect.gen(function* () {
        const claimed = yield* Effect.sync(() => {
          if (terminalEmitted) return false;
          terminalEmitted = true;
          return true;
        });
        if (!claimed) return;
        if (Exit.isFailure(exit)) {
          if (Cause.hasInterruptsOnly(exit.cause)) {
            yield* emitAnonymousTelemetryEvent({
              component,
              durationMilliseconds: Math.max(0, (yield* Clock.currentTimeMillis) - startedAt),
              event: 'lifecycle',
              operation: 'graph-build',
              outcome: 'interrupted',
            });
            return;
          }
          const error = Cause.squash(exit.cause);
          const diagnostic = anonymousTelemetryDiagnosticFromError(error);
          yield* emitAnonymousTelemetryEvent({
            component,
            ...(diagnostic === undefined ? {} : {diagnostic}),
            durationMilliseconds: Math.max(0, (yield* Clock.currentTimeMillis) - startedAt),
            errorType: diagnostic?.errorType ?? 'UnknownError',
            event: 'lifecycle',
            operation: 'graph-build',
            outcome: 'failure',
          });
          return;
        }
        const summary = exit.value;
        const materialization = summary.materialization;
        const fields = codeGraphBuildAnonymousTelemetryFields({
          buildKind: buildKind === 'dirty' || summary.snapshot.dirty ? 'dirty' : 'clean',
          cachedFactReplayBytes: materializationMetrics?.cachedFactReplayBytesCompleted,
          changedFactBytes:
            summary.incrementalWork?.factBytes ??
            materializationMetrics?.changedFactBytesCompleted ??
            extractedFactBytes ??
            scanningMetrics?.factsBytesCompleted,
          changedFiles,
          deletedFiles,
          extractedFiles:
            materialization === undefined ? undefined : Math.max(0, materialization.totalFiles - summary.reusedFiles),
          fallbackReason: materialization?.fallbackReason,
          finalFactBytes: materializationMetrics?.factsBytesTotal ?? materializationMetrics?.factsBytesCompleted,
          mode: materialization?.mode ?? 'reused-snapshot',
          resolutionClosure: materialization?.resolutionClosure,
          reusedFiles: summary.reusedFiles,
          stagedFiles: materialization?.stagedFiles,
          totalFiles: materialization?.totalFiles,
        });
        yield* emitAnonymousTelemetryEvent({
          component,
          durationMilliseconds: Math.max(0, (yield* Clock.currentTimeMillis) - startedAt),
          event: 'lifecycle',
          fields,
          operation: 'graph-build',
          outcome: 'success',
        });
      });

    return {
      observeExtractedFactBytes,
      observeInventory,
      observeOverlay,
      progress,
      terminal,
    } satisfies CodeGraphBuildAnonymousTelemetryReporter;
  },
);

/** Attaches exactly one terminal lifecycle observation without changing the build exit. */
export function withCodeGraphBuildAnonymousTelemetry<A extends CodeGraphIndexSummary, E, R>(
  reporter: CodeGraphBuildAnonymousTelemetryReporter,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return effect.pipe(Effect.onExit(exit => reporter.terminal(exit)));
}

function codeGraphInventoryDelta(inventory: CodeGraphInventory): {changedFiles: number; deletedFiles: number} {
  const committedByPath = new Map(inventory.committedFiles.map(file => [file.path, file.contentHash]));
  const currentPaths = new Set(inventory.files.map(file => file.path));
  return {
    changedFiles: inventory.files.reduce(
      (total, file) => total + (committedByPath.get(file.path) === file.contentHash ? 0 : 1),
      0,
    ),
    deletedFiles: inventory.committedFiles.reduce((total, file) => total + (currentPaths.has(file.path) ? 0 : 1), 0),
  };
}

export function codeGraphAnonymousTelemetryFields(progress: CodeGraphProgress): AnonymousTelemetryFields {
  const phase = `graph.${progress.phase}` as AnonymousTelemetryFields['phase'];
  switch (progress.phase) {
    case 'registering':
      return {phase};
    case 'waiting':
      return {phase, ...(progress.reason === undefined ? {} : {waitingReason: progress.reason})};
    case 'reclaiming':
      return {completed: progress.completed, phase, total: progress.total};
    case 'scanning':
      return {
        completed: progress.completed,
        phase,
        total: progress.total,
        ...(progress.activity === undefined
          ? {}
          : {
              ...(progress.activity.degradationReason === undefined
                ? {}
                : {degradationReason: progress.activity.degradationReason}),
              stage: progress.activity.stage,
            }),
        ...(progress.metrics === undefined
          ? {}
          : {
              factsBytesCompleted: progress.metrics.factsBytesCompleted,
              degradedFiles: progress.metrics.degradedFiles,
              sourceBytesCompleted: progress.metrics.sourceBytesCompleted,
              sourceBytesTotal: progress.metrics.sourceBytesTotal,
              workUnitsCompleted: progress.metrics.workUnitsCompleted,
              workUnitsTotal: progress.metrics.workUnitsTotal,
            }),
        ...(progress.timings === undefined
          ? {}
          : {
              extractionMilliseconds: progress.timings.extractionMilliseconds,
              persistenceMilliseconds: progress.timings.persistenceMilliseconds,
              readingMilliseconds: progress.timings.readingMilliseconds,
            }),
      };
    case 'materializing':
      return {
        completed: progress.completed,
        phase,
        total: progress.total,
        ...(progress.activity === undefined
          ? {}
          : {
              stage: progress.activity.stage,
              ...(progress.activity.stageElapsedMilliseconds === undefined
                ? {}
                : {stageElapsedMilliseconds: progress.activity.stageElapsedMilliseconds}),
              ...(progress.activity.transactionMilliseconds === undefined
                ? {}
                : {transactionMilliseconds: progress.activity.transactionMilliseconds}),
            }),
        ...(progress.metrics === undefined
          ? {}
          : {
              batchesCompleted: progress.metrics.batchesCompleted,
              batchesTotal: progress.metrics.batchesTotal,
              factsBytesCompleted: progress.metrics.factsBytesCompleted,
              factsBytesTotal: progress.metrics.factsBytesTotal,
              sourceBytesCompleted: progress.metrics.sourceBytesCompleted,
              sourceBytesTotal: progress.metrics.sourceBytesTotal,
              ...(progress.metrics.transactionMilliseconds === undefined
                ? {}
                : {transactionMilliseconds: progress.metrics.transactionMilliseconds}),
            }),
      };
    case 'resolving':
      return progress.subphase === 'complete'
        ? {completed: progress.resolved, phase, subphase: 'complete', total: progress.edges}
        : {
            phase,
            subphase: 'references',
            ...(progress.activity === undefined
              ? {}
              : {
                  completed: progress.activity.referencesCompleted,
                  elapsedMilliseconds: progress.activity.elapsedMilliseconds,
                  total: progress.activity.referencesTotal,
                  transactionMilliseconds: progress.activity.transactionMilliseconds,
                }),
          };
    case 'activating':
      return {
        phase,
        ...(progress.subphase === undefined ? {} : {subphase: progress.subphase}),
        ...(progress.activity === undefined
          ? {}
          : {
              elapsedMilliseconds: progress.activity.elapsedMilliseconds,
              stage: progress.activity.stage,
              stageElapsedMilliseconds: progress.activity.stageElapsedMilliseconds,
              ...(progress.activity.transactionMilliseconds === undefined
                ? {}
                : {transactionMilliseconds: progress.activity.transactionMilliseconds}),
            }),
      };
    case 'embedding':
      return {completed: progress.completed, phase, total: progress.total};
  }
}
