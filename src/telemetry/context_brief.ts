import {Effect, Result} from 'effect';
import {
  recordAnonymousTelemetryFields,
  withAnonymousTelemetryCheckpoint,
  type AnonymousTelemetryContextBriefCitationCoverage,
  type AnonymousTelemetryContextBriefCitationResult,
  type AnonymousTelemetryContextBriefCitationUnknownReason,
  type AnonymousTelemetryContextBriefScope,
  type AnonymousTelemetryFields,
  type AnonymousTelemetryQuantityBucket,
} from '../effect/telemetry.js';

export interface ContextBriefCitationTelemetrySummary {
  readonly cacheHits: number;
  readonly citations: number;
  readonly citedMemories: number;
  readonly coverage: AnonymousTelemetryContextBriefCitationCoverage;
  readonly exactCitations: number;
  readonly relocatedCitations: number;
  readonly repositoriesValidated: number;
  readonly staleCitations: number;
  readonly unknownCitations: number;
  readonly unknownReason?: AnonymousTelemetryContextBriefCitationUnknownReason;
}

export interface ContextBriefAnonymousTelemetryReporter {
  /** Records only the local/workset classification on the invocation recorder. */
  readonly annotate: Effect.Effect<void>;
  readonly citationValidation: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    summarize: ContextBriefCitationTelemetrySummary | ((value: A) => ContextBriefCitationTelemetrySummary),
  ) => Effect.Effect<A, E, R>;
  readonly graph: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly memory: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly projection: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    outputTruncated: boolean | ((value: A) => boolean),
  ) => Effect.Effect<A, E, R>;
}

/**
 * Maps exact private counters to the schema-v5 0-or-power-of-two surface.
 * Invalid or internally inconsistent observations abstain instead of emitting
 * a partial result that could be mistaken for a complete quality sample.
 */
export function contextBriefCitationTelemetryFields(
  scope: AnonymousTelemetryContextBriefScope,
  summary: ContextBriefCitationTelemetrySummary,
): AnonymousTelemetryFields | undefined {
  const counts = [
    summary.cacheHits,
    summary.citations,
    summary.citedMemories,
    summary.exactCitations,
    summary.relocatedCitations,
    summary.repositoriesValidated,
    summary.staleCitations,
    summary.unknownCitations,
  ];
  if (!counts.every(isPrivateCount)) return undefined;
  if (
    summary.citedMemories > summary.citations ||
    summary.cacheHits > summary.citations ||
    summary.repositoriesValidated > summary.citations
  ) {
    return undefined;
  }
  const classifiedCitations =
    summary.exactCitations + summary.relocatedCitations + summary.staleCitations + summary.unknownCitations;
  if (classifiedCitations !== summary.citations) return undefined;
  const expectedCoverage =
    summary.citations === 0
      ? 'none'
      : summary.unknownCitations === 0
        ? 'complete'
        : summary.unknownCitations === summary.citations
          ? 'unavailable'
          : 'partial';
  if (
    summary.coverage !== expectedCoverage ||
    (summary.unknownCitations === 0 && summary.unknownReason !== undefined) ||
    (summary.unknownCitations > 0 && summary.unknownReason === undefined)
  ) {
    return undefined;
  }

  return {
    contextBriefCacheHitsBucket: contextBriefTelemetryQuantityBucket(summary.cacheHits),
    contextBriefCitationCoverage: summary.coverage,
    contextBriefCitationResult: contextBriefCitationResult(summary),
    ...(summary.unknownReason === undefined ? {} : {contextBriefCitationUnknownReason: summary.unknownReason}),
    contextBriefCitationsBucket: contextBriefTelemetryQuantityBucket(summary.citations),
    contextBriefCitedMemoriesBucket: contextBriefTelemetryQuantityBucket(summary.citedMemories),
    contextBriefExactCitationsBucket: contextBriefTelemetryQuantityBucket(summary.exactCitations),
    contextBriefRelocatedCitationsBucket: contextBriefTelemetryQuantityBucket(summary.relocatedCitations),
    contextBriefRepositoriesValidatedBucket: contextBriefTelemetryQuantityBucket(summary.repositoriesValidated),
    contextBriefScope: scope,
    contextBriefStaleCitationsBucket: contextBriefTelemetryQuantityBucket(summary.staleCitations),
    contextBriefUnknownCitationsBucket: contextBriefTelemetryQuantityBucket(summary.unknownCitations),
  };
}

/** Coarse monotone bucket; exact counts never leave the process. */
export function contextBriefTelemetryQuantityBucket(value: number): AnonymousTelemetryQuantityBucket | undefined {
  if (!isPrivateCount(value)) return undefined;
  return value === 0 ? '0' : `2^${Math.floor(Math.log2(value))}`;
}

/**
 * Independent reporter foundation. Context Brief wiring owns only the phase
 * boundaries and a selector for its successful result; this module owns the
 * privacy projection and never receives task text, paths, identities, or raw
 * failures.
 */
export function makeContextBriefAnonymousTelemetryReporter(
  scope: AnonymousTelemetryContextBriefScope,
): ContextBriefAnonymousTelemetryReporter {
  let retainedCitationFields: AnonymousTelemetryFields | undefined;
  const checkpoint = <A, E, R>(phase: 'context.brief.graph' | 'context.brief.memory', effect: Effect.Effect<A, E, R>) =>
    withAnonymousTelemetryCheckpoint({fields: {contextBriefScope: scope, phase}, retainFields: false}, effect);

  return {
    annotate: recordAnonymousTelemetryFields({contextBriefScope: scope}),
    citationValidation: (effect, summarize) => {
      const measured = Effect.sync(() => {
        retainedCitationFields = undefined;
      }).pipe(
        Effect.andThen(effect),
        Effect.map(value => {
          const projection = Result.try(() =>
            contextBriefCitationTelemetryFields(scope, typeof summarize === 'function' ? summarize(value) : summarize),
          );
          return {
            fields: Result.isSuccess(projection) ? projection.success : undefined,
            value,
          } as const;
        }),
      );
      return withAnonymousTelemetryCheckpoint(
        {
          fields: {contextBriefScope: scope, phase: 'context.brief.citation-validation'},
          retainFields: false,
          successFields: measuredValue => measuredValue.fields ?? {},
          successOutcome: measuredValue => (measuredValue.fields === undefined ? 'unavailable' : 'success'),
        },
        measured,
      ).pipe(
        Effect.tap(measuredValue =>
          Effect.sync(() => {
            retainedCitationFields = measuredValue.fields;
          }),
        ),
        Effect.map(measuredValue => measuredValue.value),
      );
    },
    graph: effect => checkpoint('context.brief.graph', effect),
    memory: effect => checkpoint('context.brief.memory', effect),
    projection: (effect, outputTruncated) => {
      const measured = effect.pipe(
        Effect.map(value => {
          const projection = Result.try(() =>
            typeof outputTruncated === 'function' ? outputTruncated(value) : outputTruncated,
          );
          const truncated =
            Result.isSuccess(projection) && typeof projection.success === 'boolean' ? projection.success : undefined;
          return {truncated, value} as const;
        }),
      );
      return withAnonymousTelemetryCheckpoint(
        {
          fields: {contextBriefScope: scope, phase: 'context.brief.projection'},
          retainFields: false,
          successFields: measuredValue =>
            measuredValue.truncated === undefined ? {} : {contextBriefOutputTruncated: measuredValue.truncated},
          successOutcome: measuredValue => (measuredValue.truncated === undefined ? 'unavailable' : 'success'),
        },
        measured,
      ).pipe(
        Effect.tap(measuredValue =>
          measuredValue.truncated === undefined || retainedCitationFields === undefined
            ? Effect.void
            : recordAnonymousTelemetryFields({
                ...retainedCitationFields,
                contextBriefOutputTruncated: measuredValue.truncated,
                contextBriefScope: scope,
                phase: 'context.brief.projection',
              }),
        ),
        Effect.map(measuredValue => measuredValue.value),
      );
    },
  };
}

function contextBriefCitationResult(
  summary: ContextBriefCitationTelemetrySummary,
): AnonymousTelemetryContextBriefCitationResult {
  if (summary.citations === 0) return 'none';
  if (summary.staleCitations > 0 && summary.unknownCitations > 0) return 'mixed';
  if (summary.staleCitations > 0) return 'stale';
  if (summary.unknownCitations > 0) return 'unknown';
  if (summary.relocatedCitations > 0) return 'relocated';
  return 'exact-only';
}

function isPrivateCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
