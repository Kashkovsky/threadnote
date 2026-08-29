import {Clock, Effect, FileSystem, Option} from 'effect';
import {SystemInfo} from '../src/effect/system.js';
import {
  linuxClockTicksPerSecond,
  readProcessTreeSample,
  samplerProcessTelemetryContract,
  type BenchmarkProcessTreeSample,
} from './code-graph-benchmark-sampler.js';
import {ScriptError} from './effect/errors.js';

export const CONTEXT_BRIEF_CITATION_RSS_OBSERVER_MODE = '--internal-context-brief-citation-rss-observer';

const ARTIFACT_VERSION = 1 as const;
const MAXIMUM_OBSERVATIONS = 256;
const MAXIMUM_PROTOCOL_SEQUENCE = MAXIMUM_OBSERVATIONS * 2 + 1;
const MAXIMUM_REQUEST_BYTES = 4 * 1_024;
const MAXIMUM_RUNTIME_MILLISECONDS = 3 * 60 * 60 * 1_000;

export type ContextBriefCitationRssSource = 'darwin-ps' | 'linux-proc';
export type ContextBriefCitationRssRootIdentityValidation = 'darwin-ps-lstart' | 'linux-proc-starttime';

export type ContextBriefCitationRssRequestV1 =
  | {
      readonly observationId: string;
      readonly operation: 'begin' | 'end';
      readonly sequence: number;
      readonly version: typeof ARTIFACT_VERSION;
    }
  | {
      readonly operation: 'stop';
      readonly sequence: number;
      readonly version: typeof ARTIFACT_VERSION;
    };

export type ContextBriefCitationRssAcknowledgementV1 =
  | {
      readonly observationId: string;
      readonly sequence: number;
      readonly state: 'begun' | 'ended';
      readonly version: typeof ARTIFACT_VERSION;
    }
  | {
      readonly sequence: number;
      readonly state: 'stopped';
      readonly version: typeof ARTIFACT_VERSION;
    };

export interface ContextBriefCitationRssReadyV1 {
  readonly intervalMilliseconds: number;
  readonly observerExcluded: true;
  readonly rootIdentityValidation: ContextBriefCitationRssRootIdentityValidation;
  readonly rootStartIdentity: string;
  readonly scope: 'recursive-process-tree';
  readonly source: ContextBriefCitationRssSource;
  readonly state: 'ready';
  readonly version: typeof ARTIFACT_VERSION;
}

export interface ContextBriefCitationRssObservationV1 {
  readonly durationMilliseconds: number;
  readonly maximumSampleGapMilliseconds: number;
  readonly observationId: string;
  readonly processCountBaseline: number;
  readonly processCountPeakObserved: number;
  readonly rootRssBaselineBytes: number;
  readonly rootRssGrowthObservedBytes: number;
  readonly rootRssPeakObservedBytes: number;
  readonly sampleAttempts: number;
  readonly sampleFailures: number;
  readonly successfulSamples: number;
  readonly treeRssBaselineBytes: number;
  readonly treeRssGrowthObservedBytes: number;
  readonly treeRssPeakObservedBytes: number;
}

export interface ContextBriefCitationRssFinalSampleV1 {
  readonly processCount: number;
  readonly rootRssBytes: number;
  readonly sampleAttempts: number;
  readonly sampleFailures: number;
  readonly treeRssBytes: number;
}

export interface ContextBriefCitationRssArtifactV1 {
  readonly finalSample: ContextBriefCitationRssFinalSampleV1;
  readonly intervalMilliseconds: number;
  readonly maximumSampleGapMilliseconds: number;
  readonly observations: readonly ContextBriefCitationRssObservationV1[];
  readonly observerExcluded: true;
  readonly processCountPeakObserved: number;
  readonly rootIdentityValidation: ContextBriefCitationRssRootIdentityValidation;
  readonly rootStartIdentity: string;
  readonly sampleAttempts: number;
  readonly sampleFailures: number;
  readonly scope: 'recursive-process-tree';
  readonly source: ContextBriefCitationRssSource;
  readonly successfulSamples: number;
  readonly version: typeof ARTIFACT_VERSION;
}

export interface ContextBriefCitationRssSampleAttempt {
  readonly attempts: number;
  readonly failures: number;
  readonly observedAtMilliseconds: number;
  readonly sample?: BenchmarkProcessTreeSample;
}

interface ActiveObservation {
  readonly lastSuccessfulSampleAtMilliseconds: number;
  readonly maximumSampleGapMilliseconds: number;
  readonly observationId: string;
  readonly processCountBaseline: number;
  readonly processCountPeakObserved: number;
  readonly rootRssBaselineBytes: number;
  readonly rootRssPeakObservedBytes: number;
  readonly sampleAttempts: number;
  readonly sampleFailures: number;
  readonly startedAtMilliseconds: number;
  readonly successfulSamples: number;
  readonly treeRssBaselineBytes: number;
  readonly treeRssPeakObservedBytes: number;
}

export interface ContextBriefCitationRssObserverState {
  readonly active?: ActiveObservation;
  readonly finalSample?: ContextBriefCitationRssFinalSampleV1;
  readonly intervalMilliseconds: number;
  readonly lastAcknowledgement?: ContextBriefCitationRssAcknowledgementV1;
  readonly lastRequest?: ContextBriefCitationRssRequestV1;
  readonly nextSequence: number;
  readonly observations: readonly ContextBriefCitationRssObservationV1[];
  readonly rootIdentityValidation: ContextBriefCitationRssRootIdentityValidation;
  readonly rootStartIdentity: string;
  readonly source: ContextBriefCitationRssSource;
  readonly stopped: boolean;
}

export interface ContextBriefCitationRssProtocolTransition {
  readonly acknowledgement: ContextBriefCitationRssAcknowledgementV1;
  readonly replayed: boolean;
  readonly state: ContextBriefCitationRssObserverState;
}

export interface ContextBriefCitationRssObserverProcessOptions {
  readonly acknowledgementPath: string;
  readonly barrierTimeoutMilliseconds: number;
  readonly intervalMilliseconds: number;
  readonly outputPath: string;
  readonly readyPath: string;
  readonly requestPath: string;
  readonly rootProcessId: number;
}

/** Return true only for the reserved child mode dispatched by the bundled benchmark target. */
export function isContextBriefCitationRssObserverMode(args: readonly string[]): boolean {
  return args[0] === CONTEXT_BRIEF_CITATION_RSS_OBSERVER_MODE;
}

/** Build arguments for spawning the exact same bundled target as its observer child. */
export function contextBriefCitationRssObserverArguments(
  options: ContextBriefCitationRssObserverProcessOptions,
): readonly string[] {
  return [
    CONTEXT_BRIEF_CITATION_RSS_OBSERVER_MODE,
    '--pid',
    String(options.rootProcessId),
    '--request',
    options.requestPath,
    '--acknowledgement',
    options.acknowledgementPath,
    '--ready',
    options.readyPath,
    '--output',
    options.outputPath,
    '--interval-ms',
    String(options.intervalMilliseconds),
    '--barrier-timeout-ms',
    String(options.barrierTimeoutMilliseconds),
  ];
}

export function parseContextBriefCitationRssRequest(value: unknown): ContextBriefCitationRssRequestV1 {
  const request = record(value, 'RSS observer request');
  const operation = request.operation;
  if (operation !== 'begin' && operation !== 'end' && operation !== 'stop') {
    invalid('RSS observer request operation is invalid.');
  }
  exactKeys(
    request,
    operation === 'stop' ? ['operation', 'sequence', 'version'] : ['observationId', 'operation', 'sequence', 'version'],
    'RSS observer request',
  );
  if (request.version !== ARTIFACT_VERSION) invalid('RSS observer request version is invalid.');
  const sequence = protocolSequence(request.sequence, 'RSS observer request sequence');
  if (operation === 'stop') return {operation, sequence, version: ARTIFACT_VERSION};
  const observationId = boundedIdentifier(request.observationId, 'RSS observer observation ID');
  return {observationId, operation, sequence, version: ARTIFACT_VERSION};
}

export function parseContextBriefCitationRssAcknowledgement(value: unknown): ContextBriefCitationRssAcknowledgementV1 {
  const acknowledgement = record(value, 'RSS observer acknowledgement');
  if (acknowledgement.state !== 'begun' && acknowledgement.state !== 'ended' && acknowledgement.state !== 'stopped') {
    invalid('RSS observer acknowledgement state is invalid.');
  }
  exactKeys(
    acknowledgement,
    acknowledgement.state === 'stopped'
      ? ['sequence', 'state', 'version']
      : ['observationId', 'sequence', 'state', 'version'],
    'RSS observer acknowledgement',
  );
  if (acknowledgement.version !== ARTIFACT_VERSION) invalid('RSS observer acknowledgement version is invalid.');
  const sequence = protocolSequence(acknowledgement.sequence, 'RSS observer acknowledgement sequence');
  if (acknowledgement.state === 'stopped') {
    return {sequence, state: 'stopped', version: ARTIFACT_VERSION};
  }
  return {
    observationId: boundedIdentifier(acknowledgement.observationId, 'RSS observer observation ID'),
    sequence,
    state: acknowledgement.state,
    version: ARTIFACT_VERSION,
  };
}

export function parseContextBriefCitationRssReady(value: unknown): ContextBriefCitationRssReadyV1 {
  const ready = record(value, 'RSS observer ready evidence');
  exactKeys(
    ready,
    [
      'intervalMilliseconds',
      'observerExcluded',
      'rootIdentityValidation',
      'rootStartIdentity',
      'scope',
      'source',
      'state',
      'version',
    ],
    'RSS observer ready evidence',
  );
  const contract = parseObserverContract(ready);
  if (ready.state !== 'ready') invalid('RSS observer ready state is invalid.');
  return {...contract, state: 'ready'};
}

export function parseContextBriefCitationRssArtifact(value: unknown): ContextBriefCitationRssArtifactV1 {
  const artifact = record(value, 'RSS observer artifact');
  exactKeys(
    artifact,
    [
      'intervalMilliseconds',
      'finalSample',
      'maximumSampleGapMilliseconds',
      'observations',
      'observerExcluded',
      'processCountPeakObserved',
      'rootIdentityValidation',
      'rootStartIdentity',
      'sampleAttempts',
      'sampleFailures',
      'scope',
      'source',
      'successfulSamples',
      'version',
    ],
    'RSS observer artifact',
  );
  const contract = parseObserverContract(artifact);
  if (!Array.isArray(artifact.observations) || artifact.observations.length > MAXIMUM_OBSERVATIONS) {
    invalid('RSS observer artifact observations are invalid.');
  }
  const observations = artifact.observations.map(parseObservation);
  if (new Set(observations.map(observation => observation.observationId)).size !== observations.length) {
    invalid('RSS observer artifact observation IDs must be unique.');
  }
  const finalSample = parseFinalSample(artifact.finalSample);
  const expected = observationTotals(observations, finalSample);
  for (const [key, value] of Object.entries(expected)) {
    if (artifact[key] !== value) invalid(`RSS observer artifact ${key} is inconsistent.`);
  }
  return {...contract, ...expected, finalSample, observations};
}

export function makeContextBriefCitationRssObserverState(
  ready: Omit<ContextBriefCitationRssReadyV1, 'observerExcluded' | 'scope' | 'state' | 'version'>,
): ContextBriefCitationRssObserverState {
  const parsed = parseContextBriefCitationRssReady({
    ...ready,
    observerExcluded: true,
    scope: 'recursive-process-tree',
    state: 'ready',
    version: ARTIFACT_VERSION,
  });
  return {
    intervalMilliseconds: parsed.intervalMilliseconds,
    nextSequence: 1,
    observations: [],
    rootIdentityValidation: parsed.rootIdentityValidation,
    rootStartIdentity: parsed.rootStartIdentity,
    source: parsed.source,
    stopped: false,
  };
}

/**
 * Apply one acknowledged protocol barrier. Replaying the exact last request is
 * idempotent; a conflicting duplicate, gap, stale sequence, or invalid state
 * transition fails closed.
 */
export function applyContextBriefCitationRssRequest(
  current: ContextBriefCitationRssObserverState,
  input: ContextBriefCitationRssRequestV1,
  barrierSample?: ContextBriefCitationRssSampleAttempt,
): ContextBriefCitationRssProtocolTransition {
  const request = parseContextBriefCitationRssRequest(input);
  if (current.lastRequest && request.sequence === current.lastRequest.sequence) {
    if (stableJson(request) !== stableJson(current.lastRequest) || current.lastAcknowledgement === undefined) {
      invalid('RSS observer protocol received a conflicting duplicate sequence.');
    }
    return {acknowledgement: current.lastAcknowledgement, replayed: true, state: current};
  }
  if (current.stopped) invalid('RSS observer protocol is already stopped.');
  if (request.sequence !== current.nextSequence) invalid('RSS observer protocol sequence is not contiguous.');
  let state: ContextBriefCitationRssObserverState;
  let acknowledgement: ContextBriefCitationRssAcknowledgementV1;
  if (request.operation === 'begin') {
    if (current.active !== undefined) invalid('RSS observer cannot begin while another observation is active.');
    if (current.observations.length >= MAXIMUM_OBSERVATIONS) invalid('RSS observer observation bound exceeded.');
    if (current.observations.some(observation => observation.observationId === request.observationId)) {
      invalid('RSS observer observation ID was reused.');
    }
    const attempted = requiredBarrierSample(current, barrierSample);
    const sample = attempted.sample!;
    state = {
      ...current,
      active: {
        lastSuccessfulSampleAtMilliseconds: attempted.observedAtMilliseconds,
        maximumSampleGapMilliseconds: 0,
        observationId: request.observationId,
        processCountBaseline: sample.processIds.length,
        processCountPeakObserved: sample.processIds.length,
        rootRssBaselineBytes: sample.rootRssBytes,
        rootRssPeakObservedBytes: sample.rootRssBytes,
        sampleAttempts: attempted.attempts,
        sampleFailures: attempted.failures,
        startedAtMilliseconds: attempted.observedAtMilliseconds,
        successfulSamples: 1,
        treeRssBaselineBytes: sample.rssBytes,
        treeRssPeakObservedBytes: sample.rssBytes,
      },
    };
    acknowledgement = {
      observationId: request.observationId,
      sequence: request.sequence,
      state: 'begun',
      version: ARTIFACT_VERSION,
    };
  } else if (request.operation === 'end') {
    if (current.active?.observationId !== request.observationId) {
      invalid('RSS observer end barrier does not match the active observation.');
    }
    const withFinalSample = observeContextBriefCitationRssSample(
      current,
      requiredBarrierSample(current, barrierSample),
    );
    const active = withFinalSample.active!;
    const observation = finalizeObservation(active, barrierSample!.observedAtMilliseconds);
    state = {
      ...withFinalSample,
      active: undefined,
      observations: [...current.observations, observation],
    };
    acknowledgement = {
      observationId: request.observationId,
      sequence: request.sequence,
      state: 'ended',
      version: ARTIFACT_VERSION,
    };
  } else {
    if (current.active !== undefined) invalid('RSS observer cannot stop with an active observation.');
    const attempted = requiredBarrierSample(current, barrierSample);
    state = {
      ...current,
      finalSample: parseFinalSample({
        processCount: attempted.sample.processIds.length,
        rootRssBytes: attempted.sample.rootRssBytes,
        sampleAttempts: attempted.attempts,
        sampleFailures: attempted.failures,
        treeRssBytes: attempted.sample.rssBytes,
      }),
      stopped: true,
    };
    acknowledgement = {sequence: request.sequence, state: 'stopped', version: ARTIFACT_VERSION};
  }
  state = {
    ...state,
    lastAcknowledgement: acknowledgement,
    lastRequest: request,
    nextSequence: request.sequence + 1,
  };
  return {acknowledgement, replayed: false, state};
}

/** Add one scheduled external sample attempt to the active observation. */
export function observeContextBriefCitationRssSample(
  current: ContextBriefCitationRssObserverState,
  attempt: ContextBriefCitationRssSampleAttempt,
): ContextBriefCitationRssObserverState {
  if (current.active === undefined) return current;
  const parsed = parseSampleAttempt(current, attempt, false);
  const active = current.active;
  if (parsed.observedAtMilliseconds < active.lastSuccessfulSampleAtMilliseconds) {
    invalid('RSS observer sample time moved backwards.');
  }
  if (parsed.sample === undefined) {
    return {
      ...current,
      active: {
        ...active,
        sampleAttempts: active.sampleAttempts + parsed.attempts,
        sampleFailures: active.sampleFailures + parsed.failures,
      },
    };
  }
  const gap = parsed.observedAtMilliseconds - active.lastSuccessfulSampleAtMilliseconds;
  return {
    ...current,
    active: {
      ...active,
      lastSuccessfulSampleAtMilliseconds: parsed.observedAtMilliseconds,
      maximumSampleGapMilliseconds: Math.max(active.maximumSampleGapMilliseconds, gap),
      processCountPeakObserved: Math.max(active.processCountPeakObserved, parsed.sample.processIds.length),
      rootRssPeakObservedBytes: Math.max(active.rootRssPeakObservedBytes, parsed.sample.rootRssBytes),
      sampleAttempts: active.sampleAttempts + parsed.attempts,
      sampleFailures: active.sampleFailures + parsed.failures,
      successfulSamples: active.successfulSamples + 1,
      treeRssPeakObservedBytes: Math.max(active.treeRssPeakObservedBytes, parsed.sample.rssBytes),
    },
  };
}

export function contextBriefCitationRssArtifact(
  state: ContextBriefCitationRssObserverState,
): ContextBriefCitationRssArtifactV1 {
  if (!state.stopped || state.active !== undefined || state.finalSample === undefined) {
    invalid('RSS observer artifact requires a sampled clean stop barrier.');
  }
  return parseContextBriefCitationRssArtifact({
    finalSample: state.finalSample,
    intervalMilliseconds: state.intervalMilliseconds,
    observations: state.observations,
    observerExcluded: true,
    rootIdentityValidation: state.rootIdentityValidation,
    rootStartIdentity: state.rootStartIdentity,
    scope: 'recursive-process-tree',
    source: state.source,
    version: ARTIFACT_VERSION,
    ...observationTotals(state.observations, state.finalSample),
  });
}

/** Write one request atomically so the observer never parses a partial barrier. */
export const writeContextBriefCitationRssRequest = Effect.fn('contextBriefCitationRss.writeRequest')(function* (
  requestPath: string,
  input: ContextBriefCitationRssRequestV1,
) {
  const request = parseContextBriefCitationRssRequest(input);
  yield* atomicWrite(requestPath, `${JSON.stringify(request)}\n`);
});

/** Wait for the exact sequence acknowledgement; stale acks are ignored and future acks fail closed. */
export const waitForContextBriefCitationRssAcknowledgement = Effect.fn(
  'contextBriefCitationRss.waitForAcknowledgement',
)(function* (acknowledgementPath: string, sequence: number, timeoutMilliseconds: number) {
  protocolSequence(sequence, 'RSS observer acknowledgement sequence');
  positiveSafeInteger(timeoutMilliseconds, 'RSS observer acknowledgement timeout');
  const startedAt = yield* Clock.currentTimeMillis;
  while (true) {
    const text = yield* readOptionalText(acknowledgementPath);
    if (text !== undefined) {
      if (text.length > MAXIMUM_REQUEST_BYTES) invalid('RSS observer acknowledgement exceeds its byte bound.');
      const acknowledgement = parseContextBriefCitationRssAcknowledgement(parseJson(text, 'acknowledgement'));
      if (acknowledgement.sequence === sequence) return acknowledgement;
      if (acknowledgement.sequence > sequence) invalid('RSS observer acknowledgement skipped the expected sequence.');
    }
    if ((yield* Clock.currentTimeMillis) - startedAt >= timeoutMilliseconds) {
      return yield* Effect.fail(new ScriptError('Timed out waiting for the RSS observer acknowledgement.'));
    }
    yield* Effect.sleep(5);
  }
});

/** Run the reserved observer child mode from the exact same bundled target. */
export const runContextBriefCitationRssObserverMode = Effect.fn('contextBriefCitationRss.runObserverMode')(function* (
  args: readonly string[],
) {
  const options = parseObserverArguments(args);
  const fs = yield* FileSystem.FileSystem;
  const system = yield* SystemInfo;
  if (options.rootProcessId === system.processId) {
    return yield* Effect.fail(new ScriptError('RSS observer cannot observe itself as the benchmark root.'));
  }
  if (system.platform !== 'linux' && system.platform !== 'darwin') {
    return yield* Effect.fail(new ScriptError(`RSS observer does not support ${system.platform}.`));
  }
  const clockTicksPerSecond = yield* linuxClockTicksPerSecond();
  const initial = yield* requiredProcessTreeSample(
    options.rootProcessId,
    clockTicksPerSecond,
    undefined,
    options.barrierTimeoutMilliseconds,
    [system.processId],
  );
  const telemetry = samplerProcessTelemetryContract(
    system.platform,
    initial.sample!.rootStartIdentity,
    options.intervalMilliseconds,
  );
  if (
    telemetry.availability !== 'available' ||
    telemetry.scope !== 'recursive-process-tree' ||
    (telemetry.source !== 'linux-proc' && telemetry.source !== 'darwin-ps')
  ) {
    return yield* Effect.fail(new ScriptError('RSS observer process-tree inspection is unavailable.'));
  }
  const ready = parseContextBriefCitationRssReady({
    intervalMilliseconds: options.intervalMilliseconds,
    observerExcluded: true,
    rootIdentityValidation: telemetry.parentIdentityValidation,
    rootStartIdentity: initial.sample!.rootStartIdentity,
    scope: 'recursive-process-tree',
    source: telemetry.source,
    state: 'ready',
    version: ARTIFACT_VERSION,
  });
  let state = makeContextBriefCitationRssObserverState(ready);
  let lastRequestText: string | undefined;
  const startedAt = yield* Clock.currentTimeMillis;
  yield* atomicWrite(options.readyPath, `${JSON.stringify(ready)}\n`);
  while (!state.stopped) {
    if ((yield* Clock.currentTimeMillis) - startedAt > MAXIMUM_RUNTIME_MILLISECONDS) {
      return yield* Effect.fail(new ScriptError('RSS observer exceeded its bounded runtime.'));
    }
    if (!system.isProcessRunning(options.rootProcessId)) {
      return yield* Effect.fail(new ScriptError('RSS observer benchmark root exited before the stop barrier.'));
    }
    const requestText = yield* readOptionalText(options.requestPath);
    let handledBarrier = false;
    if (requestText !== undefined && requestText !== lastRequestText) {
      if (requestText.length > MAXIMUM_REQUEST_BYTES) {
        return yield* Effect.fail(new ScriptError('RSS observer request exceeds its byte bound.'));
      }
      const request = parseContextBriefCitationRssRequest(parseJson(requestText, 'request'));
      const barrierSample = yield* requiredProcessTreeSample(
        options.rootProcessId,
        clockTicksPerSecond,
        state.rootStartIdentity,
        options.barrierTimeoutMilliseconds,
        [system.processId],
      );
      const transition = applyContextBriefCitationRssRequest(state, request, barrierSample);
      state = transition.state;
      lastRequestText = requestText;
      handledBarrier = request.operation !== 'stop';
      yield* atomicWrite(options.acknowledgementPath, `${JSON.stringify(transition.acknowledgement)}\n`);
      if (state.stopped) {
        const artifact = contextBriefCitationRssArtifact(state);
        yield* atomicWrite(options.outputPath, `${JSON.stringify(artifact)}\n`);
        break;
      }
    }
    if (state.active !== undefined && !handledBarrier) {
      const sample = yield* readProcessTreeSample(options.rootProcessId, clockTicksPerSecond, [system.processId]);
      const observedAtMilliseconds = yield* Clock.currentTimeMillis;
      if (sample !== undefined && sample.rootStartIdentity !== state.rootStartIdentity) {
        return yield* Effect.fail(new ScriptError('RSS observer benchmark root identity changed.'));
      }
      state = observeContextBriefCitationRssSample(state, {
        attempts: 1,
        failures: sample === undefined ? 1 : 0,
        observedAtMilliseconds,
        ...(sample === undefined ? {} : {sample}),
      });
    }
    yield* Effect.sleep(options.intervalMilliseconds);
  }
  // Keep the dependency explicit for bundlers and ensure the final path exists.
  yield* fs.stat(options.outputPath);
});

function requiredBarrierSample(
  state: ContextBriefCitationRssObserverState,
  attempt: ContextBriefCitationRssSampleAttempt | undefined,
): ContextBriefCitationRssSampleAttempt & {readonly sample: BenchmarkProcessTreeSample} {
  if (attempt === undefined) invalid('RSS observer barriers require a process-tree sample.');
  const parsed = parseSampleAttempt(state, attempt, true);
  return parsed as ContextBriefCitationRssSampleAttempt & {readonly sample: BenchmarkProcessTreeSample};
}

function parseSampleAttempt(
  state: ContextBriefCitationRssObserverState,
  attempt: ContextBriefCitationRssSampleAttempt,
  requireSample: boolean,
): ContextBriefCitationRssSampleAttempt {
  const attempts = positiveSafeInteger(attempt.attempts, 'RSS observer sample attempts');
  const failures = nonNegativeSafeInteger(attempt.failures, 'RSS observer sample failures');
  const observedAtMilliseconds = nonNegativeSafeInteger(
    attempt.observedAtMilliseconds,
    'RSS observer sample timestamp',
  );
  if (failures > attempts || (attempt.sample === undefined ? failures !== attempts : failures !== attempts - 1)) {
    invalid('RSS observer sample attempt accounting is inconsistent.');
  }
  if (requireSample && attempt.sample === undefined)
    invalid('RSS observer barrier did not obtain a process-tree sample.');
  if (attempt.sample !== undefined) validateProcessTreeSample(state, attempt.sample);
  return {attempts, failures, observedAtMilliseconds, ...(attempt.sample ? {sample: attempt.sample} : {})};
}

function validateProcessTreeSample(
  state: ContextBriefCitationRssObserverState,
  sample: BenchmarkProcessTreeSample,
): void {
  if (sample.rootStartIdentity !== state.rootStartIdentity) invalid('RSS observer benchmark root identity changed.');
  if (
    !Array.isArray(sample.processIds) ||
    sample.processIds.length < 1 ||
    new Set(sample.processIds).size !== sample.processIds.length ||
    sample.processIds.some(processId => !Number.isSafeInteger(processId) || processId <= 0)
  ) {
    invalid('RSS observer process-tree membership is invalid.');
  }
  const rootRssBytes = nonNegativeSafeInteger(sample.rootRssBytes, 'RSS observer root RSS');
  const treeRssBytes = nonNegativeSafeInteger(sample.rssBytes, 'RSS observer tree RSS');
  if (rootRssBytes > treeRssBytes) invalid('RSS observer root RSS exceeds its process-tree RSS.');
}

function finalizeObservation(
  active: ActiveObservation,
  endedAtMilliseconds: number,
): ContextBriefCitationRssObservationV1 {
  if (endedAtMilliseconds < active.startedAtMilliseconds) invalid('RSS observer observation time moved backwards.');
  return parseObservation({
    durationMilliseconds: endedAtMilliseconds - active.startedAtMilliseconds,
    maximumSampleGapMilliseconds: active.maximumSampleGapMilliseconds,
    observationId: active.observationId,
    processCountBaseline: active.processCountBaseline,
    processCountPeakObserved: active.processCountPeakObserved,
    rootRssBaselineBytes: active.rootRssBaselineBytes,
    rootRssGrowthObservedBytes: Math.max(0, active.rootRssPeakObservedBytes - active.rootRssBaselineBytes),
    rootRssPeakObservedBytes: active.rootRssPeakObservedBytes,
    sampleAttempts: active.sampleAttempts,
    sampleFailures: active.sampleFailures,
    successfulSamples: active.successfulSamples,
    treeRssBaselineBytes: active.treeRssBaselineBytes,
    treeRssGrowthObservedBytes: Math.max(0, active.treeRssPeakObservedBytes - active.treeRssBaselineBytes),
    treeRssPeakObservedBytes: active.treeRssPeakObservedBytes,
  });
}

function parseObservation(value: unknown): ContextBriefCitationRssObservationV1 {
  const observation = record(value, 'RSS observer observation');
  const keys = [
    'durationMilliseconds',
    'maximumSampleGapMilliseconds',
    'observationId',
    'processCountBaseline',
    'processCountPeakObserved',
    'rootRssBaselineBytes',
    'rootRssGrowthObservedBytes',
    'rootRssPeakObservedBytes',
    'sampleAttempts',
    'sampleFailures',
    'successfulSamples',
    'treeRssBaselineBytes',
    'treeRssGrowthObservedBytes',
    'treeRssPeakObservedBytes',
  ] as const;
  exactKeys(observation, keys, 'RSS observer observation');
  const parsed = Object.fromEntries(
    keys
      .filter(key => key !== 'observationId')
      .map(key => [key, nonNegativeSafeInteger(observation[key], `RSS observer observation ${key}`)]),
  ) as unknown as Omit<ContextBriefCitationRssObservationV1, 'observationId'>;
  const result = {
    ...parsed,
    observationId: boundedIdentifier(observation.observationId, 'RSS observer observation ID'),
  };
  if (result.processCountBaseline < 1 || result.processCountPeakObserved < result.processCountBaseline) {
    invalid('RSS observer observation process counts are invalid.');
  }
  if (
    result.rootRssBaselineBytes > result.treeRssBaselineBytes ||
    result.rootRssPeakObservedBytes > result.treeRssPeakObservedBytes ||
    result.rootRssPeakObservedBytes < result.rootRssBaselineBytes ||
    result.treeRssPeakObservedBytes < result.treeRssBaselineBytes
  ) {
    invalid('RSS observer observation RSS ordering is invalid.');
  }
  if (
    result.rootRssGrowthObservedBytes !== result.rootRssPeakObservedBytes - result.rootRssBaselineBytes ||
    result.treeRssGrowthObservedBytes !== result.treeRssPeakObservedBytes - result.treeRssBaselineBytes
  ) {
    invalid('RSS observer observation growth is inconsistent.');
  }
  if (
    result.successfulSamples < 2 ||
    result.sampleAttempts !== result.successfulSamples + result.sampleFailures ||
    result.maximumSampleGapMilliseconds > result.durationMilliseconds
  ) {
    invalid('RSS observer observation sample accounting is invalid.');
  }
  return result;
}

function parseFinalSample(value: unknown): ContextBriefCitationRssFinalSampleV1 {
  const sample = record(value, 'RSS observer final sample');
  exactKeys(
    sample,
    ['processCount', 'rootRssBytes', 'sampleAttempts', 'sampleFailures', 'treeRssBytes'],
    'RSS observer final sample',
  );
  const result = {
    processCount: positiveSafeInteger(sample.processCount, 'RSS observer final process count'),
    rootRssBytes: nonNegativeSafeInteger(sample.rootRssBytes, 'RSS observer final root RSS'),
    sampleAttempts: positiveSafeInteger(sample.sampleAttempts, 'RSS observer final sample attempts'),
    sampleFailures: nonNegativeSafeInteger(sample.sampleFailures, 'RSS observer final sample failures'),
    treeRssBytes: nonNegativeSafeInteger(sample.treeRssBytes, 'RSS observer final tree RSS'),
  };
  if (result.rootRssBytes > result.treeRssBytes) invalid('RSS observer final root RSS exceeds tree RSS.');
  if (result.sampleFailures !== result.sampleAttempts - 1) {
    invalid('RSS observer final sample accounting is inconsistent.');
  }
  return result;
}

function observationTotals(
  observations: readonly ContextBriefCitationRssObservationV1[],
  finalSample: ContextBriefCitationRssFinalSampleV1,
) {
  return {
    maximumSampleGapMilliseconds: Math.max(0, ...observations.map(value => value.maximumSampleGapMilliseconds)),
    processCountPeakObserved: Math.max(
      finalSample.processCount,
      ...observations.map(value => value.processCountPeakObserved),
    ),
    sampleAttempts: boundedSum([...observations.map(value => value.sampleAttempts), finalSample.sampleAttempts]),
    sampleFailures: boundedSum([...observations.map(value => value.sampleFailures), finalSample.sampleFailures]),
    successfulSamples: boundedSum([...observations.map(value => value.successfulSamples), 1]),
  };
}

function parseObserverContract(value: Readonly<Record<string, unknown>>) {
  if (value.version !== ARTIFACT_VERSION) invalid('RSS observer evidence version is invalid.');
  if (value.scope !== 'recursive-process-tree' || value.observerExcluded !== true) {
    invalid('RSS observer scope is invalid.');
  }
  const intervalMilliseconds = positiveSafeInteger(value.intervalMilliseconds, 'RSS observer interval');
  if (intervalMilliseconds < 10 || intervalMilliseconds > 1_000) invalid('RSS observer interval is out of bounds.');
  const source = value.source;
  const rootIdentityValidation = value.rootIdentityValidation;
  if (
    (source !== 'linux-proc' && source !== 'darwin-ps') ||
    (source === 'linux-proc' && rootIdentityValidation !== 'linux-proc-starttime') ||
    (source === 'darwin-ps' && rootIdentityValidation !== 'darwin-ps-lstart')
  ) {
    invalid('RSS observer source and root identity validation do not match.');
  }
  const rootStartIdentity = boundedText(value.rootStartIdentity, 'RSS observer root identity', 128);
  return {
    intervalMilliseconds,
    observerExcluded: true as const,
    rootIdentityValidation: rootIdentityValidation as ContextBriefCitationRssRootIdentityValidation,
    rootStartIdentity,
    scope: 'recursive-process-tree' as const,
    source: source as ContextBriefCitationRssSource,
    version: ARTIFACT_VERSION,
  };
}

const requiredProcessTreeSample = Effect.fn('contextBriefCitationRss.requiredProcessTreeSample')(function* (
  rootProcessId: number,
  clockTicksPerSecond: number,
  expectedRootStartIdentity: string | undefined,
  timeoutMilliseconds: number,
  excludedDescendantRootProcessIds: readonly number[],
) {
  const startedAt = yield* Clock.currentTimeMillis;
  let attempts = 0;
  let failures = 0;
  while (true) {
    attempts += 1;
    const sample = yield* readProcessTreeSample(rootProcessId, clockTicksPerSecond, excludedDescendantRootProcessIds);
    const observedAtMilliseconds = yield* Clock.currentTimeMillis;
    if (sample !== undefined) {
      if (expectedRootStartIdentity !== undefined && sample.rootStartIdentity !== expectedRootStartIdentity) {
        return yield* Effect.fail(new ScriptError('RSS observer benchmark root identity changed.'));
      }
      return {attempts, failures, observedAtMilliseconds, sample} satisfies ContextBriefCitationRssSampleAttempt;
    }
    failures += 1;
    if (observedAtMilliseconds - startedAt >= timeoutMilliseconds) {
      return yield* Effect.fail(new ScriptError('RSS observer could not complete a process-tree barrier sample.'));
    }
    yield* Effect.sleep(10);
  }
});

function parseObserverArguments(args: readonly string[]): ContextBriefCitationRssObserverProcessOptions {
  if (!isContextBriefCitationRssObserverMode(args)) invalid('RSS observer mode flag is missing.');
  const values = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith('--') || value === undefined || values.has(flag)) {
      invalid(`RSS observer argument ${flag ?? '<missing>'} is invalid.`);
    }
    values.set(flag, value);
  }
  const required = (flag: string) => {
    const value = values.get(flag);
    if (!value) invalid(`RSS observer argument ${flag} is missing.`);
    return value;
  };
  const allowed = new Set([
    '--acknowledgement',
    '--barrier-timeout-ms',
    '--interval-ms',
    '--output',
    '--pid',
    '--ready',
    '--request',
  ]);
  if (values.size !== allowed.size || [...values.keys()].some(key => !allowed.has(key))) {
    invalid('RSS observer arguments do not match the bounded protocol.');
  }
  const paths = {
    acknowledgementPath: required('--acknowledgement'),
    outputPath: required('--output'),
    readyPath: required('--ready'),
    requestPath: required('--request'),
  };
  if (new Set(Object.values(paths)).size !== Object.keys(paths).length) {
    invalid('RSS observer protocol paths must be distinct.');
  }
  const intervalMilliseconds = positiveSafeInteger(Number(required('--interval-ms')), 'RSS observer interval');
  const barrierTimeoutMilliseconds = positiveSafeInteger(
    Number(required('--barrier-timeout-ms')),
    'RSS observer barrier timeout',
  );
  if (intervalMilliseconds < 10 || intervalMilliseconds > 1_000) invalid('RSS observer interval is out of bounds.');
  if (barrierTimeoutMilliseconds < 100 || barrierTimeoutMilliseconds > 30_000) {
    invalid('RSS observer barrier timeout is out of bounds.');
  }
  return {
    ...paths,
    barrierTimeoutMilliseconds,
    intervalMilliseconds,
    rootProcessId: positiveSafeInteger(Number(required('--pid')), 'RSS observer root PID'),
  };
}

const atomicWrite = Effect.fn('contextBriefCitationRss.atomicWrite')(function* (outputPath: string, contents: string) {
  const fs = yield* FileSystem.FileSystem;
  const temporaryPath = `${outputPath}.tmp`;
  yield* fs.writeFileString(temporaryPath, contents, {mode: 0o600});
  yield* fs.rename(temporaryPath, outputPath);
});

const readOptionalText = Effect.fn('contextBriefCitationRss.readOptionalText')(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(file).pipe(Effect.option, Effect.map(Option.getOrUndefined));
});

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new ScriptError(`RSS observer ${label} is not valid JSON.`, {cause});
  }
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(`${label} must be an object.`);
  return value as Readonly<Record<string, unknown>>;
}

function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    invalid(`${label} fields are invalid.`);
  }
}

function boundedIdentifier(value: unknown, label: string): string {
  const text = boundedText(value, label, 64);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(text)) invalid(`${label} is invalid.`);
  return text;
}

function boundedText(value: unknown, label: string, maximumLength: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumLength ||
    Array.from(value).some(character => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    invalid(`${label} is invalid.`);
  }
  return value;
}

function positiveSafeInteger(value: unknown, label: string): number {
  const parsed = nonNegativeSafeInteger(value, label);
  if (parsed < 1) invalid(`${label} must be positive.`);
  return parsed;
}

function protocolSequence(value: unknown, label: string): number {
  const sequence = positiveSafeInteger(value, label);
  if (sequence > MAXIMUM_PROTOCOL_SEQUENCE) invalid(`${label} exceeds the protocol bound.`);
  return sequence;
}

function nonNegativeSafeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid(`${label} is invalid.`);
  return value;
}

function boundedSum(values: readonly number[]): number {
  return values.reduce((total, value) => Math.min(Number.MAX_SAFE_INTEGER, total + value), 0);
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function invalid(message: string): never {
  throw new ScriptError(message);
}
