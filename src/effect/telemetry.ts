import * as FetchHttpClient from 'effect/unstable/http/FetchHttpClient';
import * as HttpClient from 'effect/unstable/http/HttpClient';
import * as HttpClientResponse from 'effect/unstable/http/HttpClientResponse';
import {OtlpSerialization, OtlpTracer} from 'effect/unstable/observability';
import {Cause, Clock, ConfigProvider, Context, Effect, Exit, Layer, Result, Tracer} from 'effect';
import type * as Headers from 'effect/unstable/http/Headers';
import type * as Duration from 'effect/Duration';
import {SystemInfo, type SystemInfoShape} from './system.js';
import {
  anonymousTelemetryDiagnosticFromError,
  closedTelemetryErrorType,
  projectAnonymousTelemetryDiagnostic,
  readAnonymousTelemetryDiagnostic,
  type AnonymousTelemetryReportedOutcome,
  type AnonymousTelemetryDiagnostic,
} from '../telemetry/diagnostic.js';
import {safeAnonymousTelemetryOperation} from '../telemetry/operations.js';

const TELEMETRY_SCHEMA_VERSION = 1;
const FIRST_CHECKPOINT_DELAY = '30 seconds';
const CHECKPOINT_INTERVAL = '60 seconds';

export const ANONYMOUS_TELEMETRY_PHASES = [
  'graph.activating',
  'graph.embedding',
  'graph.materializing',
  'graph.reclaiming',
  'graph.registering',
  'graph.resolving',
  'graph.scanning',
  'graph.waiting',
  'model.diagnostics',
  'model.embedding',
  'model.generation',
  'model.inference',
  'model.loading',
  'model.reranking',
  'recall.lexical-ranking',
  'recall.obsidian-sync',
  'recall.semantic-retrieval',
  'recall.shared-sync',
  'storage.reading',
  'storage.writing',
] as const;

export type AnonymousTelemetryPhase = (typeof ANONYMOUS_TELEMETRY_PHASES)[number];

export const ANONYMOUS_TELEMETRY_SUBPHASES = [
  'complete',
  'promoting',
  'references',
  'structural-ready',
  'summarizing-analysis',
  'validating-input',
  'writing-and-checkpointing',
] as const;

export type AnonymousTelemetrySubphase = (typeof ANONYMOUS_TELEMETRY_SUBPHASES)[number];

export const ANONYMOUS_TELEMETRY_STAGES = [
  'attributing',
  'checkpointing-snapshot',
  'committing',
  'committing-snapshot',
  'copying-edges',
  'copying-files',
  'copying-lookup-keys',
  'copying-reexports',
  'copying-symbols',
  'copying-terms',
  'copying-workspace',
  'extracting',
  'loading-cache',
  'persisting',
  'preparing-rows',
  'reading',
  'recording-completion',
  'validating-input',
  'writing-analysis',
  'writing-candidates',
  'writing-edges',
  'writing-facts',
  'writing-lookups',
  'writing-receipt',
  'writing-references',
  'writing-symbols',
  'writing-terms',
] as const;

export type AnonymousTelemetryStage = (typeof ANONYMOUS_TELEMETRY_STAGES)[number];

export const ANONYMOUS_TELEMETRY_WAITING_REASONS = [
  'database-writer',
  'disk-capacity',
  'repository-lock',
  'request-lock',
  'snapshot-build',
] as const;

export type AnonymousTelemetryWaitingReason = (typeof ANONYMOUS_TELEMETRY_WAITING_REASONS)[number];

export interface AnonymousTelemetryFields {
  readonly batchesCompleted?: number;
  readonly batchesTotal?: number;
  readonly completed?: number;
  readonly degradedFiles?: number;
  readonly degradationReason?:
    | 'abort'
    | 'allocation'
    | 'exit'
    | 'fact-bytes'
    | 'operation'
    | 'protocol'
    | 'rss'
    | 'source-bytes'
    | 'spawn'
    | 'symbols'
    | 'timeout'
    | 'write';
  readonly elapsedMilliseconds?: number;
  readonly extractionMilliseconds?: number;
  readonly factsBytesCompleted?: number;
  readonly factsBytesTotal?: number;
  readonly operationElapsedMilliseconds?: number;
  readonly persistenceMilliseconds?: number;
  readonly phase?: AnonymousTelemetryPhase;
  readonly phaseOutcome?: 'failure' | 'interrupted' | 'success' | 'timed-out' | 'unavailable';
  readonly readingMilliseconds?: number;
  readonly sourceBytesCompleted?: number;
  readonly sourceBytesTotal?: number;
  readonly stage?: AnonymousTelemetryStage;
  readonly stageElapsedMilliseconds?: number;
  readonly subphase?: AnonymousTelemetrySubphase;
  readonly total?: number;
  readonly transactionMilliseconds?: number;
  readonly workUnitsCompleted?: number;
  readonly workUnitsTotal?: number;
  readonly waitingReason?: AnonymousTelemetryWaitingReason;
}

export interface AnonymousTelemetryRuntimeOptions {
  readonly correlationScope: 'broker' | 'invocation' | 'provider-session';
  readonly endpoint: string;
  /** @internal Deterministic exporter controls for focused tests. */
  readonly exportInterval?: Duration.Input;
  readonly headers?: Headers.Input;
  readonly isEnabled?: Effect.Effect<boolean, never>;
  /** @internal Deterministic exporter controls for focused tests. */
  readonly maxBatchSize?: number;
  readonly serviceVersion: string;
  readonly sessionId: string;
  /** @internal Entry-point-specific final flush budget. */
  readonly shutdownTimeout?: Duration.Input;
}

export interface AnonymousTelemetryInvocationOptions<A = unknown> {
  readonly component: 'cli' | 'mcp';
  readonly operation: string;
  readonly reportedFailure?: (value: A) => boolean;
  readonly reportedFailureType?: string;
  readonly reportedOutcome?: (value: A) => AnonymousTelemetryReportedOutcome | undefined;
}

interface MutableAnonymousTelemetryRecorder {
  active: boolean;
  readonly component: 'cli' | 'mcp';
  fields: AnonymousTelemetryFields;
  readonly invocationId?: string;
  readonly operation: string;
}

interface AnonymousTelemetryService {
  readonly emit: (options: AnonymousTelemetryEventOptions) => Effect.Effect<void>;
  readonly instrument: <A, E, R>(
    options: AnonymousTelemetryInvocationOptions<A>,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}

interface AnonymousTelemetryEventOptions {
  readonly component: 'cli' | 'mcp';
  readonly errorType?: string;
  readonly event?: 'checkpoint' | 'lifecycle';
  readonly fields?: AnonymousTelemetryFields;
  readonly invocationId?: string;
  readonly operation: string;
  readonly outcome?: 'failure' | 'interrupted' | 'success' | 'timed-out' | 'unavailable';
}

const noOpService: AnonymousTelemetryService = {
  emit: () => Effect.void,
  instrument: (_options, effect) => effect,
};

const AnonymousTelemetry = Context.Reference<AnonymousTelemetryService>('threadnote/AnonymousTelemetry', {
  defaultValue: () => noOpService,
});

const CurrentAnonymousTelemetryRecorder = Context.Reference<MutableAnonymousTelemetryRecorder | undefined>(
  'threadnote/CurrentAnonymousTelemetryRecorder',
  {defaultValue: () => undefined},
);

/**
 * Installs a private traces-only OTLP exporter. The tracer is captured by the
 * service layer and never merged into Threadnote's application context.
 */
export function anonymousTelemetryLayer(options?: AnonymousTelemetryRuntimeOptions) {
  if (options === undefined) return Layer.succeed(AnonymousTelemetry, noOpService);
  const isEnabled = (options.isEnabled ?? Effect.succeed(true)).pipe(Effect.catchCause(() => Effect.succeed(false)));
  const transportLayer = anonymousTelemetryHttpClientLayer(isEnabled);
  const privateTracerLayer = OtlpTracer.layer({
    exportInterval: options.exportInterval ?? '5 seconds',
    ...(options.headers === undefined ? {} : {headers: options.headers}),
    maxBatchSize: options.maxBatchSize ?? 64,
    resource: {
      attributes: {
        'session.id': safeAgentSessionId(options.sessionId),
        'threadnote.session.scope': safeCorrelationScope(options.correlationScope),
        'threadnote.telemetry.schema_version': TELEMETRY_SCHEMA_VERSION,
      },
      serviceName: 'threadnote',
      serviceVersion: safeVersion(options.serviceVersion),
    },
    shutdownTimeout: options.shutdownTimeout ?? '3 seconds',
    url: options.endpoint,
  }).pipe(
    Layer.provide(OtlpSerialization.layerProtobuf),
    Layer.provide(transportLayer),
    // OtlpResource otherwise merges ambient OTEL_RESOURCE_ATTRIBUTES and
    // OTEL_SERVICE_* values, which are outside Threadnote's consent allowlist.
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
  );
  return Layer.effect(
    AnonymousTelemetry,
    Effect.gen(function* () {
      const tracer = yield* Tracer.Tracer;
      const system = yield* SystemInfo;
      return AnonymousTelemetry.of(makeAnonymousTelemetryService(tracer, system, isEnabled));
    }),
  ).pipe(Layer.provide(privateTracerLayer));
}

/**
 * Captures a redirect-denying fetch client and gates every actual OTLP request
 * on current consent. Returning a synthetic success when consent was revoked
 * makes Effect's exporter discard its already-dequeued batch without sending,
 * retrying, or entering its temporary failure backoff.
 */
function anonymousTelemetryHttpClientLayer(isEnabled: Effect.Effect<boolean, never>) {
  const fetchLayer = FetchHttpClient.layer.pipe(
    Layer.provide(
      Layer.succeed(FetchHttpClient.RequestInit, {
        redirect: 'error',
      }),
    ),
  );
  return Layer.effect(
    HttpClient.HttpClient,
    Effect.map(HttpClient.HttpClient, client =>
      HttpClient.transform(client, (requestEffect, request) =>
        Effect.flatMap(isEnabled, enabled =>
          enabled
            ? requestEffect
            : Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, {status: 204}))),
        ),
      ),
    ),
  ).pipe(Layer.provide(fetchLayer));
}

/** @internal Focused tests can observe the exact private tracer envelope. */
export function anonymousTelemetryTestLayer(options: {
  readonly invocationId?: () => string | undefined;
  readonly isEnabled?: Effect.Effect<boolean, never>;
  readonly system: SystemInfoShape;
  readonly tracer: Tracer.Tracer;
}) {
  return Layer.succeed(
    AnonymousTelemetry,
    makeAnonymousTelemetryService(
      options.tracer,
      options.system,
      options.isEnabled ?? Effect.succeed(true),
      options.invocationId,
    ),
  );
}

function makeAnonymousTelemetryService(
  tracer: Tracer.Tracer,
  system: SystemInfoShape,
  enabled: Effect.Effect<boolean, never>,
  invocationId: () => string | undefined = safeAnonymousInvocationId,
): AnonymousTelemetryService {
  const isEnabled = enabled.pipe(Effect.catchCause(() => Effect.succeed(false)));
  const emit = (event: AnonymousTelemetryEventOptions) =>
    isEnabled.pipe(
      Effect.flatMap(enabled =>
        enabled
          ? emitSafeSpan(
              tracer,
              system,
              event,
              event.outcome === undefined
                ? undefined
                : {
                    durationMilliseconds: event.fields?.elapsedMilliseconds ?? 0,
                    ...(event.errorType === undefined ? {} : {errorType: closedTelemetryErrorType(event.errorType)}),
                    outcome: event.outcome,
                  },
              undefined,
            )
          : Effect.void,
      ),
      Effect.catchCause(() => Effect.void),
      Effect.withTracerEnabled(false),
    );
  return {
    emit,
    instrument: <A, E, R>(
      invocation: AnonymousTelemetryInvocationOptions<A>,
      applicationEffect: Effect.Effect<A, E, R>,
    ) =>
      Effect.flatMap(isEnabled, initiallyEnabled => {
        if (!initiallyEnabled) return applicationEffect;
        return Effect.uninterruptibleMask(restore =>
          Effect.scoped(
            Effect.gen(function* () {
              const recorder: MutableAnonymousTelemetryRecorder = {
                active: true,
                component: invocation.component,
                fields: {},
                invocationId: optionalInvocationId(invocationId),
                operation: invocation.operation,
              };
              const startedAt = yield* Clock.currentTimeMillis;
              const startMemory = safeMemoryUsage(system);
              yield* Effect.forkScoped(
                restore(
                  telemetryCheckpoints(emit, invocation, recorder, startedAt).pipe(Effect.withTracerEnabled(false)),
                ),
              );
              const exit = yield* Effect.exit(
                restore(
                  applicationEffect.pipe(
                    Effect.provideService(CurrentAnonymousTelemetryRecorder, recorder),
                    Effect.withTracerEnabled(false),
                  ),
                ),
              );
              recorder.active = false;
              const finishedAt = yield* Clock.currentTimeMillis;
              const endMemory = safeMemoryUsage(system);
              const classification = completionClassification(exit, invocation);
              if (yield* isEnabled) {
                yield* Effect.suspend(() =>
                  emitSafeSpan(
                    tracer,
                    system,
                    {
                      component: invocation.component,
                      fields: recorder.fields,
                      invocationId: recorder.invocationId,
                      operation: invocation.operation,
                    },
                    {
                      durationMilliseconds: Math.max(0, finishedAt - startedAt),
                      ...classification,
                    },
                    {end: endMemory, start: startMemory},
                  ),
                ).pipe(Effect.catchCause(() => Effect.void));
              }
              return Exit.isSuccess(exit) ? exit.value : yield* Effect.failCause(exit.cause);
            }),
          ),
        );
      }),
  };
}

/** Adds a privacy-safe diagnostic envelope around one application Effect. */
export function withAnonymousTelemetry<A, E, R>(
  options: AnonymousTelemetryInvocationOptions<A>,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.flatMap(AnonymousTelemetry, service => service.instrument(options, effect));
}

/** Emits a successful immediate checkpoint with only closed telemetry fields. */
export function emitAnonymousTelemetryEvent(options: AnonymousTelemetryEventOptions): Effect.Effect<void> {
  return Effect.flatMap(CurrentAnonymousTelemetryRecorder, recorder =>
    Effect.flatMap(AnonymousTelemetry, service =>
      service.emit({
        ...options,
        invocationId: options.invocationId ?? recorder?.invocationId,
      }),
    ),
  );
}

/** Records bounded progress on the current operation without network I/O. */
export function recordAnonymousTelemetryFields(fields: AnonymousTelemetryFields): Effect.Effect<void> {
  return Effect.flatMap(CurrentAnonymousTelemetryRecorder, recorder =>
    recorder === undefined || !recorder.active
      ? Effect.void
      : Effect.sync(() => {
          recorder.fields = mergeTelemetryFields(recorder.fields, fields);
        }),
  );
}

/**
 * Removes an invocation-local recorder before a long-lived service captures
 * the surrounding context for later requests.
 */
export function omitAnonymousTelemetryRecorder<R>(context: Context.Context<R>): Context.Context<R> {
  return Context.omit(CurrentAnonymousTelemetryRecorder)(context) as Context.Context<R>;
}

export function withAnonymousTelemetryPhase<A, E, R>(
  phase: AnonymousTelemetryPhase,
  effect: Effect.Effect<A, E, R>,
  successOutcome?: (value: A) => 'failure' | 'success' | 'timed-out' | 'unavailable',
): Effect.Effect<A, E, R> {
  return Effect.flatMap(CurrentAnonymousTelemetryRecorder, recorder => {
    if (recorder === undefined || !recorder.active) return effect;
    return Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis;
      return yield* effect.pipe(
        Effect.onExit(exit =>
          Effect.suspend(() =>
            Effect.gen(function* () {
              if (!recorder.active) return;
              const finishedAt = yield* Clock.currentTimeMillis;
              const elapsedMilliseconds = Math.max(0, finishedAt - startedAt);
              const classified = safePhaseOutcome(exit, successOutcome);
              const fields = {elapsedMilliseconds, phase, phaseOutcome: classified.outcome} as const;
              yield* recordAnonymousTelemetryFields(fields);
              yield* emitAnonymousTelemetryEvent({
                component: recorder.component,
                ...(classified.errorType === undefined ? {} : {errorType: classified.errorType}),
                event: 'checkpoint',
                fields,
                invocationId: recorder.invocationId,
                operation: recorder.operation,
                outcome: classified.outcome,
              });
            }),
          ).pipe(Effect.catchCause(() => Effect.void)),
        ),
      );
    });
  });
}

function safePhaseOutcome<A, E>(
  exit: Exit.Exit<A, E>,
  successOutcome: ((value: A) => 'failure' | 'success' | 'timed-out' | 'unavailable') | undefined,
) {
  const classified = Result.try(() => phaseOutcome(exit, successOutcome));
  if (Result.isSuccess(classified)) return classified.success;
  return {errorType: 'UnknownError', outcome: Exit.isSuccess(exit) ? ('success' as const) : ('failure' as const)};
}

function phaseOutcome<A, E>(
  exit: Exit.Exit<A, E>,
  successOutcome: ((value: A) => 'failure' | 'success' | 'timed-out' | 'unavailable') | undefined,
) {
  if (Exit.isSuccess(exit)) {
    const outcome = Result.try(() => successOutcome?.(exit.value) ?? 'success');
    return {outcome: Result.isSuccess(outcome) ? outcome.success : ('success' as const)};
  }
  if (Cause.hasInterruptsOnly(exit.cause)) return {outcome: 'interrupted' as const};
  return {
    errorType: anonymousTelemetryDiagnosticFromError(Cause.squash(exit.cause))?.errorType ?? 'UnknownError',
    outcome: 'failure' as const,
  };
}

function telemetryCheckpoints<A>(
  emit: AnonymousTelemetryService['emit'],
  invocation: AnonymousTelemetryInvocationOptions<A>,
  recorder: MutableAnonymousTelemetryRecorder,
  startedAt: number,
) {
  return Effect.sleep(FIRST_CHECKPOINT_DELAY).pipe(
    Effect.andThen(
      Effect.forever(
        Clock.currentTimeMillis.pipe(
          Effect.flatMap(now =>
            emit({
              component: invocation.component,
              event: 'checkpoint',
              fields: {...recorder.fields, operationElapsedMilliseconds: Math.max(0, now - startedAt)},
              invocationId: recorder.invocationId,
              operation: invocation.operation,
            }),
          ),
          Effect.andThen(Effect.sleep(CHECKPOINT_INTERVAL)),
        ),
      ),
    ),
  );
}

function emitSafeSpan(
  tracer: Tracer.Tracer,
  system: SystemInfoShape,
  event: AnonymousTelemetryEventOptions,
  completion?: Readonly<{
    durationMilliseconds: number;
    errorType?: string;
    outcome: 'failure' | 'interrupted' | 'success' | 'timed-out' | 'unavailable';
    diagnostic?: AnonymousTelemetryDiagnostic;
  }>,
  memory?: Readonly<{end: ReturnType<typeof safeMemoryUsage>; start: ReturnType<typeof safeMemoryUsage>}>,
): Effect.Effect<void> {
  const operation = safeAnonymousTelemetryOperation(event.operation);
  const attributes: Record<string, unknown> = {
    'threadnote.component': safeComponent(event.component),
    'threadnote.event': safeEvent(event.event),
    ...(event.invocationId === undefined ? {} : {'threadnote.invocation.id': safeInvocationId(event.invocationId)}),
    'threadnote.operation': operation,
    'threadnote.runtime.architecture': safeRuntimeLabel(system.architecture),
    'threadnote.runtime.platform': safeRuntimeLabel(system.platform),
    'threadnote.runtime.version': safeVersion(system.runtimeVersion),
    ...telemetryFieldAttributes(event.fields),
    ...(memory === undefined
      ? currentMemoryAttributes(safeMemoryUsage(system))
      : memoryAttributes(memory.start, memory.end)),
  };
  if (completion !== undefined) {
    attributes['threadnote.duration_ms'] = boundedNumber(completion.durationMilliseconds);
    attributes['threadnote.outcome'] = safeOutcome(completion.outcome);
    if (completion.errorType !== undefined) attributes['error.type'] = closedTelemetryErrorType(completion.errorType);
    const diagnostic = projectAnonymousTelemetryDiagnostic(completion.diagnostic);
    if (diagnostic?.domain !== undefined) attributes['threadnote.failure.domain'] = diagnostic.domain;
    if (diagnostic?.code !== undefined) attributes['threadnote.failure.code'] = diagnostic.code;
    if (diagnostic?.operation !== undefined)
      attributes['threadnote.failure.operation'] = diagnostic.operation.replaceAll(' ', '-');
    if (diagnostic?.recovery !== undefined) attributes['threadnote.failure.recovery'] = diagnostic.recovery;
    if (diagnostic?.reason !== undefined) attributes['threadnote.failure.reason'] = diagnostic.reason;
    if (diagnostic?.retryable !== undefined) attributes['threadnote.failure.retryable'] = diagnostic.retryable;
  }
  return Effect.withSpan(Effect.annotateCurrentSpan(attributes), 'threadnote.anonymous-diagnostic', {
    attributes: {},
    captureStackTrace: false,
    root: true,
  }).pipe(
    Effect.provideService(Tracer.Tracer, tracer),
    Effect.withTracerEnabled(true),
    Effect.catchCause(() => Effect.void),
    Effect.withTracerEnabled(false),
  );
}

function completionClassification<A, E>(
  exit: Exit.Exit<A, E>,
  options: AnonymousTelemetryInvocationOptions<A>,
): {
  readonly diagnostic?: AnonymousTelemetryDiagnostic;
  readonly errorType?: string;
  readonly outcome: 'failure' | 'interrupted' | 'success' | 'timed-out' | 'unavailable';
} {
  const result = Result.try(() => unsafeCompletionClassification(exit, options));
  return Result.isSuccess(result) ? result.success : {outcome: Exit.isSuccess(exit) ? 'success' : 'failure'};
}

function unsafeCompletionClassification<A, E>(
  exit: Exit.Exit<A, E>,
  options: AnonymousTelemetryInvocationOptions<A>,
): {
  readonly diagnostic?: AnonymousTelemetryDiagnostic;
  readonly errorType?: string;
  readonly outcome: 'failure' | 'interrupted' | 'success' | 'timed-out' | 'unavailable';
} {
  if (Exit.isSuccess(exit)) {
    const reportedOutcome = Result.try(() => options.reportedOutcome?.(exit.value));
    if (Result.isSuccess(reportedOutcome) && reportedOutcome.success !== undefined) {
      const diagnostic = projectAnonymousTelemetryDiagnostic(readAnonymousTelemetryDiagnostic(exit.value));
      return {
        ...(diagnostic === undefined ? {} : {diagnostic}),
        errorType: diagnostic?.errorType ?? closedTelemetryErrorType(options.reportedFailureType ?? 'ReportedError'),
        outcome: reportedOutcome.success,
      };
    }
    const reported = Result.try(() => options.reportedFailure?.(exit.value) === true);
    if (!Result.isSuccess(reported) || !reported.success) return {outcome: 'success'};
    const diagnostic = projectAnonymousTelemetryDiagnostic(readAnonymousTelemetryDiagnostic(exit.value));
    return {
      ...(diagnostic === undefined ? {} : {diagnostic}),
      errorType: diagnostic?.errorType ?? closedTelemetryErrorType(options.reportedFailureType ?? 'ReportedError'),
      outcome: 'failure',
    };
  }
  if (Cause.hasInterruptsOnly(exit.cause)) return {outcome: 'interrupted'};
  const error = Cause.squash(exit.cause);
  const diagnostic = projectAnonymousTelemetryDiagnostic(
    readAnonymousTelemetryDiagnostic(error) ?? anonymousTelemetryDiagnosticFromError(error),
  );
  return {
    ...(diagnostic === undefined ? {} : {diagnostic}),
    errorType: diagnostic?.errorType ?? 'UnknownError',
    outcome: 'failure',
  };
}

function telemetryFieldAttributes(fields: AnonymousTelemetryFields | undefined): Record<string, unknown> {
  if (fields === undefined) return {};
  const attributes: Record<string, unknown> = {};
  if (fields.phase !== undefined && ANONYMOUS_TELEMETRY_PHASES.includes(fields.phase)) {
    attributes['threadnote.phase'] = fields.phase;
  }
  if (fields.subphase !== undefined && ANONYMOUS_TELEMETRY_SUBPHASES.includes(fields.subphase)) {
    attributes['threadnote.subphase'] = fields.subphase;
  }
  if (
    fields.phaseOutcome !== undefined &&
    ['failure', 'interrupted', 'success', 'timed-out', 'unavailable'].includes(fields.phaseOutcome)
  ) {
    attributes['threadnote.phase.outcome'] = fields.phaseOutcome;
  }
  if (fields.stage !== undefined && ANONYMOUS_TELEMETRY_STAGES.includes(fields.stage)) {
    attributes['threadnote.stage'] = fields.stage;
  }
  if (fields.degradationReason !== undefined && isDegradationReason(fields.degradationReason)) {
    attributes['threadnote.graph.degradation_reason'] = fields.degradationReason;
  }
  if (fields.waitingReason !== undefined && ANONYMOUS_TELEMETRY_WAITING_REASONS.includes(fields.waitingReason)) {
    attributes['threadnote.waiting_reason'] = fields.waitingReason;
  }
  for (const [key, value] of Object.entries(fields)) {
    if (
      key === 'phase' ||
      key === 'phaseOutcome' ||
      key === 'degradationReason' ||
      key === 'stage' ||
      key === 'subphase' ||
      key === 'waitingReason' ||
      value === undefined
    )
      continue;
    if (!Number.isFinite(value) || value < 0) continue;
    const attribute = FIELD_ATTRIBUTE_KEYS[key as NumericTelemetryField];
    if (attribute === undefined) continue;
    attributes[attribute] = QUANTITY_FIELD_KEYS.has(key as NumericTelemetryField)
      ? quantityBucket(value)
      : boundedNumber(value);
  }
  return attributes;
}

type NumericTelemetryField = Exclude<
  keyof AnonymousTelemetryFields,
  'degradationReason' | 'phase' | 'phaseOutcome' | 'stage' | 'subphase' | 'waitingReason'
>;

const FIELD_ATTRIBUTE_KEYS: Readonly<Record<NumericTelemetryField, string>> = {
  batchesCompleted: 'threadnote.work.batches_completed_bucket',
  batchesTotal: 'threadnote.work.batches_total_bucket',
  completed: 'threadnote.work.completed_bucket',
  degradedFiles: 'threadnote.work.degraded_files_bucket',
  elapsedMilliseconds: 'threadnote.phase.elapsed_ms',
  extractionMilliseconds: 'threadnote.phase.extraction_ms',
  factsBytesCompleted: 'threadnote.work.facts_bytes_completed_bucket',
  factsBytesTotal: 'threadnote.work.facts_bytes_total_bucket',
  operationElapsedMilliseconds: 'threadnote.operation.elapsed_ms',
  persistenceMilliseconds: 'threadnote.phase.persistence_ms',
  readingMilliseconds: 'threadnote.phase.reading_ms',
  sourceBytesCompleted: 'threadnote.work.source_bytes_completed_bucket',
  sourceBytesTotal: 'threadnote.work.source_bytes_total_bucket',
  stageElapsedMilliseconds: 'threadnote.phase.stage_elapsed_ms',
  total: 'threadnote.work.total_bucket',
  transactionMilliseconds: 'threadnote.phase.transaction_ms',
  workUnitsCompleted: 'threadnote.work.units_completed_bucket',
  workUnitsTotal: 'threadnote.work.units_total_bucket',
};

const QUANTITY_FIELD_KEYS = new Set<NumericTelemetryField>([
  'batchesCompleted',
  'batchesTotal',
  'completed',
  'degradedFiles',
  'factsBytesCompleted',
  'factsBytesTotal',
  'sourceBytesCompleted',
  'sourceBytesTotal',
  'total',
  'workUnitsCompleted',
  'workUnitsTotal',
]);

function mergeTelemetryFields(
  current: AnonymousTelemetryFields,
  next: AnonymousTelemetryFields,
): AnonymousTelemetryFields {
  const phaseChanged = next.phase !== undefined && next.phase !== current.phase;
  const stageChanged = next.stage !== undefined && next.stage !== current.stage;
  const merged: Record<string, unknown> = {
    ...current,
    ...(phaseChanged
      ? {
          elapsedMilliseconds: undefined,
          extractionMilliseconds: undefined,
          persistenceMilliseconds: undefined,
          phaseOutcome: undefined,
          readingMilliseconds: undefined,
          stage: undefined,
          stageElapsedMilliseconds: undefined,
          subphase: undefined,
          transactionMilliseconds: undefined,
          waitingReason: undefined,
        }
      : {}),
    ...(stageChanged ? {stageElapsedMilliseconds: undefined, transactionMilliseconds: undefined} : {}),
  };
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined) continue;
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || value < 0) continue;
      const previous = merged[key];
      merged[key] = typeof previous === 'number' ? Math.max(previous, value) : value;
    } else if (
      (key === 'phase' && ANONYMOUS_TELEMETRY_PHASES.includes(value as AnonymousTelemetryPhase)) ||
      (key === 'subphase' && ANONYMOUS_TELEMETRY_SUBPHASES.includes(value as AnonymousTelemetrySubphase)) ||
      (key === 'phaseOutcome' &&
        ['failure', 'interrupted', 'success', 'timed-out', 'unavailable'].includes(value as string)) ||
      (key === 'degradationReason' && isDegradationReason(value)) ||
      (key === 'stage' && ANONYMOUS_TELEMETRY_STAGES.includes(value as AnonymousTelemetryStage)) ||
      (key === 'waitingReason' &&
        ANONYMOUS_TELEMETRY_WAITING_REASONS.includes(value as AnonymousTelemetryWaitingReason))
    ) {
      merged[key] = value;
    }
  }
  return merged as AnonymousTelemetryFields;
}

function safeMemoryUsage(system: SystemInfoShape) {
  const result = Result.try(() => system.memoryUsage());
  if (!Result.isSuccess(result)) return undefined;
  return {
    external: boundedNumber(result.success.external),
    heapUsed: boundedNumber(result.success.heapUsed),
    peakRss: boundedNumber(result.success.peakRss ?? result.success.rss),
    rss: boundedNumber(result.success.rss),
  };
}

function memoryAttributes(
  start: ReturnType<typeof safeMemoryUsage>,
  end?: ReturnType<typeof safeMemoryUsage>,
): Record<string, unknown> {
  if (start === undefined) return {};
  return {
    'threadnote.memory.external.start_bucket': byteBucket(start.external),
    'threadnote.memory.heap.start_bucket': byteBucket(start.heapUsed),
    'threadnote.memory.peak_rss.start_bucket': byteBucket(start.peakRss),
    'threadnote.memory.rss.start_bucket': byteBucket(start.rss),
    ...(end === undefined
      ? {}
      : {
          'threadnote.memory.external.end_bucket': byteBucket(end.external),
          'threadnote.memory.heap.end_bucket': byteBucket(end.heapUsed),
          'threadnote.memory.peak_rss.end_bucket': byteBucket(end.peakRss),
          'threadnote.memory.rss.end_bucket': byteBucket(end.rss),
        }),
  };
}

function currentMemoryAttributes(current: ReturnType<typeof safeMemoryUsage>): Record<string, unknown> {
  if (current === undefined) return {};
  return {
    'threadnote.memory.external.current_bucket': byteBucket(current.external),
    'threadnote.memory.heap.current_bucket': byteBucket(current.heapUsed),
    'threadnote.memory.peak_rss.current_bucket': byteBucket(current.peakRss),
    'threadnote.memory.rss.current_bucket': byteBucket(current.rss),
  };
}

function byteBucket(bytes: number): string {
  const mebibytes = bytes / (1024 * 1024);
  if (mebibytes < 32) return '<32MiB';
  if (mebibytes < 64) return '32-64MiB';
  if (mebibytes < 128) return '64-128MiB';
  if (mebibytes < 256) return '128-256MiB';
  if (mebibytes < 512) return '256-512MiB';
  if (mebibytes < 1_024) return '512MiB-1GiB';
  if (mebibytes < 2_048) return '1-2GiB';
  if (mebibytes < 4_096) return '2-4GiB';
  return '>=4GiB';
}

function quantityBucket(value: number): string {
  if (value <= 0) return '0';
  const exponent = Math.min(52, Math.floor(Math.log2(value)));
  return `2^${exponent}`;
}

function boundedNumber(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.round(value))) : 0;
}

function safeRuntimeLabel(value: string): string {
  return /^[A-Za-z0-9_.-]{1,40}$/u.test(value) ? value : 'unknown';
}

function safeVersion(value: string): string {
  return /^(?:unknown|[0-9]+(?:\.[0-9]+){0,3}(?:[-+][0-9A-Za-z.-]{1,40})?|test)$/u.test(value) ? value : 'unknown';
}

function safeAgentSessionId(value: string): string {
  return /^tns_[\da-f]{32}$/u.test(value) ? value : 'tns_00000000000000000000000000000000';
}

function safeCorrelationScope(value: string): 'broker' | 'invocation' | 'provider-session' {
  return value === 'broker' || value === 'provider-session' ? value : 'invocation';
}

function safeAnonymousInvocationId(): string | undefined {
  const generated = Result.try(() => {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    return `tni_${[...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
  });
  return Result.isSuccess(generated) ? generated.success : undefined;
}

function optionalInvocationId(factory: () => string | undefined): string | undefined {
  const generated = Result.try(factory);
  if (!Result.isSuccess(generated) || generated.success === undefined) return undefined;
  return /^tni_[\da-f]{24}$/u.test(generated.success) ? generated.success : undefined;
}

function safeInvocationId(value: string): string {
  return /^tni_[\da-f]{24}$/u.test(value) ? value : 'tni_000000000000000000000000';
}

function safeComponent(value: unknown): 'cli' | 'mcp' {
  return value === 'mcp' ? 'mcp' : 'cli';
}

function safeEvent(value: unknown): 'checkpoint' | 'completion' | 'lifecycle' {
  return value === 'checkpoint' || value === 'lifecycle' ? value : 'completion';
}

function safeOutcome(value: unknown): 'failure' | 'interrupted' | 'success' | 'timed-out' | 'unavailable' {
  return value === 'failure' || value === 'interrupted' || value === 'timed-out' || value === 'unavailable'
    ? value
    : 'success';
}

function isDegradationReason(value: unknown): value is NonNullable<AnonymousTelemetryFields['degradationReason']> {
  return (
    value === 'abort' ||
    value === 'allocation' ||
    value === 'exit' ||
    value === 'fact-bytes' ||
    value === 'operation' ||
    value === 'protocol' ||
    value === 'rss' ||
    value === 'source-bytes' ||
    value === 'spawn' ||
    value === 'symbols' ||
    value === 'timeout' ||
    value === 'write'
  );
}
