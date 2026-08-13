import {Clock, Effect} from 'effect';
import {
  emitAnonymousTelemetryEvent,
  recordAnonymousTelemetryFields,
  type AnonymousTelemetryFields,
} from '../effect/telemetry.js';
import type {CodeGraphProgress} from './types.js';

const CHECKPOINT_INTERVAL_MILLISECONDS = 60_000;

export type CodeGraphAnonymousTelemetryComponent = 'cli' | 'mcp';
export type CodeGraphBackgroundFailureOperation = 'graph-maintenance' | 'graph-refresh';

export function codeGraphAnonymousTelemetryComponent(
  environment: Readonly<Record<string, string | undefined>>,
): CodeGraphAnonymousTelemetryComponent {
  return environment.THREADNOTE_MCP_BROKER_CHILD === '1' ? 'mcp' : 'cli';
}

/** Emits a closed, fail-soft terminal observation for detached graph work. */
export function emitCodeGraphBackgroundFailure(
  component: CodeGraphAnonymousTelemetryComponent,
  operation: CodeGraphBackgroundFailureOperation,
): Effect.Effect<void> {
  return emitAnonymousTelemetryEvent({
    component,
    errorType: 'CodeGraphStoreError',
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
