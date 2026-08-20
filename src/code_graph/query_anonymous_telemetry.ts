import {Effect} from 'effect';
import {
  recordAnonymousTelemetryFields,
  withAnonymousTelemetryCheckpoint,
  type AnonymousTelemetryFields,
  type AnonymousTelemetryGraphRequestKind,
  type AnonymousTelemetryGraphRequestScope,
  type AnonymousTelemetryGraphSnapshotFreshness,
  type AnonymousTelemetryGraphSnapshotSelection,
  type AnonymousTelemetryPhase,
  type AnonymousTelemetryQuantityBucket,
} from '../effect/telemetry.js';
import {observationFromCodeGraphStatus} from './query.js';
import type {CodeGraphQueryResult, CodeGraphSnapshot, CodeGraphStatus} from './types.js';

export type CodeGraphInspectAnonymousTelemetryOperation = CodeGraphQueryResult['operation'] | 'topology';
export type CodeGraphAnalyzeAnonymousTelemetryOperation =
  'communities' | 'community' | 'confidence' | 'full' | 'groups' | 'hubs' | 'stats' | 'surprises';

type PublishedSnapshotCounts = Pick<CodeGraphSnapshot, 'edgeCount' | 'fileCount' | 'symbolCount'>;

export type CodeGraphQueryAnonymousTelemetrySnapshotSurface =
  | Readonly<{selection: 'none'}>
  | Readonly<{
      freshness: AnonymousTelemetryGraphSnapshotFreshness;
      selection: Exclude<AnonymousTelemetryGraphSnapshotSelection, 'none'>;
      snapshot: PublishedSnapshotCounts;
    }>;

export interface CodeGraphQueryAnonymousTelemetryProjection {
  readonly phase: Extract<AnonymousTelemetryPhase, `graph.query.${string}`>;
  readonly requestKind: AnonymousTelemetryGraphRequestKind;
  readonly requestScope: AnonymousTelemetryGraphRequestScope;
  readonly snapshot?: CodeGraphQueryAnonymousTelemetrySnapshotSurface;
}

export interface CodeGraphQueryAnonymousTelemetryReporter {
  readonly annotate: Effect.Effect<void>;
  readonly execute: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    snapshot?:
      CodeGraphQueryAnonymousTelemetrySnapshotSurface | ((value: A) => CodeGraphQueryAnonymousTelemetrySnapshotSurface),
  ) => Effect.Effect<A, E, R>;
  readonly snapshot: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    select:
      CodeGraphQueryAnonymousTelemetrySnapshotSurface | ((value: A) => CodeGraphQueryAnonymousTelemetrySnapshotSurface),
  ) => Effect.Effect<A, E, R>;
  readonly status: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

export function codeGraphInspectAnonymousTelemetryRequestKind(
  operation: CodeGraphInspectAnonymousTelemetryOperation,
): AnonymousTelemetryGraphRequestKind {
  return `inspect.${operation}`;
}

export function codeGraphAnalyzeAnonymousTelemetryRequestKind(
  operation: CodeGraphAnalyzeAnonymousTelemetryOperation,
): AnonymousTelemetryGraphRequestKind {
  return `analyze.${operation}`;
}

/**
 * Projects only the schema-v3 allowlist. Workset calls and status checkpoints
 * cannot acquire local single-snapshot fields through this boundary.
 */
export function codeGraphQueryAnonymousTelemetryFields(
  input: CodeGraphQueryAnonymousTelemetryProjection,
): AnonymousTelemetryFields {
  const base: AnonymousTelemetryFields = {
    phase: input.phase,
    requestKind: input.requestKind,
    requestScope: input.requestScope,
  };
  if (input.phase === 'graph.query.status' || input.requestScope !== 'local' || input.snapshot === undefined) {
    return base;
  }
  if (input.snapshot.selection === 'none') return {...base, snapshotSelection: 'none'};
  const snapshotEdgesBucket = codeGraphQueryAnonymousTelemetryQuantityBucket(input.snapshot.snapshot.edgeCount);
  const snapshotFilesBucket = codeGraphQueryAnonymousTelemetryQuantityBucket(input.snapshot.snapshot.fileCount);
  const snapshotSymbolsBucket = codeGraphQueryAnonymousTelemetryQuantityBucket(input.snapshot.snapshot.symbolCount);
  if (snapshotEdgesBucket === undefined || snapshotFilesBucket === undefined || snapshotSymbolsBucket === undefined) {
    return base;
  }
  return {
    ...base,
    snapshotEdgesBucket,
    snapshotFilesBucket,
    snapshotFreshness: input.snapshot.freshness,
    snapshotSelection: input.snapshot.selection,
    snapshotSymbolsBucket,
  };
}

/** 0-or-power-of-two bucket for published non-negative snapshot counts. */
export function codeGraphQueryAnonymousTelemetryQuantityBucket(
  value: number,
): AnonymousTelemetryQuantityBucket | undefined {
  if (!Number.isSafeInteger(value) || value < 0) return undefined;
  if (value === 0) return '0';
  return `2^${Math.floor(Math.log2(value))}`;
}

export function codeGraphQueryAnonymousTelemetrySnapshotSelection(
  before: CodeGraphStatus,
  after: CodeGraphStatus,
): AnonymousTelemetryGraphSnapshotSelection {
  if (after.readySnapshot === undefined) return 'none';
  if (observationFromCodeGraphStatus(after)?.borrowedSnapshotId === after.readySnapshot.id) return 'borrowed';
  return before.readySnapshot?.id === after.readySnapshot.id ? 'active' : 'promoted';
}

export function codeGraphQueryAnonymousTelemetrySnapshotSurface(
  status: CodeGraphStatus,
  selection: AnonymousTelemetryGraphSnapshotSelection,
): CodeGraphQueryAnonymousTelemetrySnapshotSurface {
  if (selection === 'none' || status.readySnapshot === undefined) return {selection: 'none'};
  return {
    freshness: status.freshness,
    selection,
    snapshot: status.readySnapshot,
  };
}

export function makeCodeGraphQueryAnonymousTelemetryReporter(input: {
  readonly requestKind: AnonymousTelemetryGraphRequestKind;
  readonly requestScope: AnonymousTelemetryGraphRequestScope;
}): CodeGraphQueryAnonymousTelemetryReporter {
  const requestFields: AnonymousTelemetryFields = {
    requestKind: input.requestKind,
    requestScope: input.requestScope,
  };
  const fields = (
    phase: CodeGraphQueryAnonymousTelemetryProjection['phase'],
    snapshot?: CodeGraphQueryAnonymousTelemetrySnapshotSurface,
  ) =>
    codeGraphQueryAnonymousTelemetryFields({
      phase,
      requestKind: input.requestKind,
      requestScope: input.requestScope,
      ...(snapshot === undefined ? {} : {snapshot}),
    });
  const checkpoint = <A, E, R>(
    phase: CodeGraphQueryAnonymousTelemetryProjection['phase'],
    effect: Effect.Effect<A, E, R>,
    retainFields: boolean,
    snapshot?:
      CodeGraphQueryAnonymousTelemetrySnapshotSurface | ((value: A) => CodeGraphQueryAnonymousTelemetrySnapshotSurface),
  ) =>
    withAnonymousTelemetryCheckpoint(
      {
        fields: fields(phase),
        retainFields,
        ...(snapshot === undefined
          ? {}
          : {
              successFields: (value: A) => fields(phase, typeof snapshot === 'function' ? snapshot(value) : snapshot),
            }),
      },
      effect,
    );
  return {
    annotate: recordAnonymousTelemetryFields(requestFields),
    execute: (effect, snapshot) => checkpoint('graph.query.execute', effect, true, snapshot),
    snapshot: (effect, select) => checkpoint('graph.query.snapshot', effect, false, select),
    status: effect => checkpoint('graph.query.status', effect, false),
  };
}
