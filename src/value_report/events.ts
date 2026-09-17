import {Crypto, Effect, FileSystem, Option, Path, Predicate} from 'effect';
import {withExclusiveFileLock} from '../effect/file_lock.js';
import type {CandidateReview} from '../memory/candidate.js';
import type {ValueReportCountsInputV1} from './index.js';

const VALUE_EVENT_VERSION = 1 as const;
const VALUE_EVENT_FILE = 'value-events-v1.jsonl';
const MAX_VALUE_EVENTS = 10_000;
const VALUE_EVENT_RETENTION_MILLISECONDS = 365 * 24 * 60 * 60 * 1_000;
const LOCK_OPTIONS = {
  retryIntervalMilliseconds: 25,
  staleAfterMilliseconds: 5 * 60 * 1_000,
  waitTimeoutMilliseconds: 5_000,
} as const;

export interface ContextBriefValueEventV1 {
  readonly coverageGaps: number;
  readonly durationMilliseconds: number;
  readonly estimatedTokens: number;
  readonly kind: 'context-brief';
  readonly project?: string;
  readonly requestedCodeAnchors: number;
  readonly resolvedCodeAnchors: number;
  readonly successful: boolean;
  readonly timestamp: string;
  readonly version: typeof VALUE_EVENT_VERSION;
}

export interface HealthValueEventV1 {
  readonly activeFindings: number;
  readonly kind: 'health';
  readonly opened: number;
  readonly project: string;
  readonly resolved: number;
  readonly timestamp: string;
  readonly version: typeof VALUE_EVENT_VERSION;
}

export type LocalValueEventV1 = ContextBriefValueEventV1 | HealthValueEventV1;

export const recordContextBriefValueEvent = Effect.fn('valueReport.recordContextBrief')(function* (
  agentContextHome: string,
  event: Omit<ContextBriefValueEventV1, 'kind' | 'version'>,
) {
  yield* appendValueEvent(agentContextHome, {kind: 'context-brief', version: VALUE_EVENT_VERSION, ...event});
});

export const recordHealthValueSnapshot = Effect.fn('valueReport.recordHealthSnapshot')(function* (
  agentContextHome: string,
  input: {readonly activeFindings: number; readonly project: string; readonly timestamp: string},
) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const path = valueEventPath(pathService, agentContextHome);
  yield* withExclusiveFileLock(
    fs,
    `${path}.lock`,
    LOCK_OPTIONS,
    Effect.gen(function* () {
      const existing = yield* readValueEvents(fs, path);
      const previous = [...existing]
        .reverse()
        .find((event): event is HealthValueEventV1 => event.kind === 'health' && event.project === input.project);
      const activeFindings = boundedCount(input.activeFindings);
      const previousActive = previous?.activeFindings ?? 0;
      const event: HealthValueEventV1 = {
        activeFindings,
        kind: 'health',
        opened: Math.max(0, activeFindings - previousActive),
        project: input.project,
        resolved: Math.max(0, previousActive - activeFindings),
        timestamp: input.timestamp,
        version: VALUE_EVENT_VERSION,
      };
      yield* writeValueEvents(fs, path, retainEvents([...existing, event], event.timestamp));
    }),
  );
});

export const readLocalValueEvents = Effect.fn('valueReport.readEvents')(function* (agentContextHome: string) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  return yield* readValueEvents(fs, valueEventPath(pathService, agentContextHome));
});

export function summarizeLocalValueEvents(
  events: readonly LocalValueEventV1[],
  options: {readonly from: Date; readonly project?: string; readonly to: Date},
): ValueReportCountsInputV1 {
  const contextBriefEvents = events.filter(
    (event): event is ContextBriefValueEventV1 => event.kind === 'context-brief' && eventMatches(event, options),
  );
  const healthEvents = events.filter(
    (event): event is HealthValueEventV1 => event.kind === 'health' && eventMatches(event, options),
  );
  return {
    contextBrief: {
      attempts: contextBriefEvents.length,
      coverageGaps: sum(contextBriefEvents.map(event => event.coverageGaps)),
      estimatedTokens: sum(contextBriefEvents.map(event => event.estimatedTokens)),
      requestedCodeAnchors: sum(contextBriefEvents.map(event => event.requestedCodeAnchors)),
      resolvedCodeAnchors: sum(contextBriefEvents.map(event => event.resolvedCodeAnchors)),
      successful: contextBriefEvents.filter(event => event.successful).length,
      timeToFirstSuccessfulMillisecondsSamples: contextBriefEvents
        .filter(event => event.successful)
        .map(event => event.durationMilliseconds)
        .sort((left, right) => left - right),
    },
    health: {
      opened: sum(healthEvents.map(event => event.opened)),
      resolved: sum(healthEvents.map(event => event.resolved)),
    },
  };
}

export function summarizeCandidateReviewValue(
  reviews: readonly CandidateReview[],
  options: {readonly from: Date; readonly project?: string; readonly to: Date},
): NonNullable<ValueReportCountsInputV1['knowledgeDelta']> {
  let proposed = 0;
  let approved = 0;
  let edited = 0;
  let rejected = 0;
  let deferred = 0;
  for (const review of reviews) {
    if (options.project !== undefined && review.project !== options.project) continue;
    if (timestampInPeriod(review.createdAt, options)) proposed += review.candidates.length;
    const candidates = new Map(review.candidates.map(candidate => [candidate.candidateId, candidate]));
    for (const event of review.auditEvents) {
      if (!timestampInPeriod(event.at, options)) continue;
      if (event.action === 'apply') {
        approved += 1;
        const candidate = event.candidateId === undefined ? undefined : candidates.get(event.candidateId);
        if (candidate?.applyBodyText !== undefined && candidate.applyBodyText !== candidate.proposedText) edited += 1;
      } else if (event.action === 'reject') {
        rejected += 1;
      } else if (event.action === 'defer') {
        deferred += 1;
      }
    }
  }
  return {approved, deferred, edited, proposed, rejected};
}

const appendValueEvent = Effect.fn('valueReport.appendEvent')(function* (
  agentContextHome: string,
  event: LocalValueEventV1,
) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const path = valueEventPath(pathService, agentContextHome);
  yield* withExclusiveFileLock(
    fs,
    `${path}.lock`,
    LOCK_OPTIONS,
    Effect.gen(function* () {
      const existing = yield* readValueEvents(fs, path);
      yield* writeValueEvents(fs, path, retainEvents([...existing, event], event.timestamp));
    }),
  );
});

function eventMatches(
  event: LocalValueEventV1,
  options: {readonly from: Date; readonly project?: string; readonly to: Date},
): boolean {
  return (
    (options.project === undefined || event.project === options.project) && timestampInPeriod(event.timestamp, options)
  );
}

function timestampInPeriod(timestamp: string, options: {readonly from: Date; readonly to: Date}): boolean {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) && parsed >= options.from.getTime() && parsed <= options.to.getTime();
}

function retainEvents(events: readonly LocalValueEventV1[], now: string): readonly LocalValueEventV1[] {
  const nowMilliseconds = Date.parse(now);
  return events
    .filter(event => nowMilliseconds - Date.parse(event.timestamp) <= VALUE_EVENT_RETENTION_MILLISECONDS)
    .slice(-MAX_VALUE_EVENTS);
}

function valueEventPath(path: Path.Path, agentContextHome: string): string {
  return path.join(agentContextHome, 'value', VALUE_EVENT_FILE);
}

function readValueEvents(
  fs: FileSystem.FileSystem,
  path: string,
): Effect.Effect<readonly LocalValueEventV1[], unknown> {
  return Effect.gen(function* () {
    if (!(yield* fs.exists(path))) return [];
    const raw = yield* fs.readFileString(path);
    return raw
      .split('\n')
      .map(parseValueEvent)
      .filter((event): event is LocalValueEventV1 => event !== undefined)
      .slice(-MAX_VALUE_EVENTS);
  });
}

function writeValueEvents(
  fs: FileSystem.FileSystem,
  path: string,
  events: readonly LocalValueEventV1[],
): Effect.Effect<void, unknown, Crypto.Crypto | Path.Path> {
  return Effect.gen(function* () {
    const pathService = yield* Path.Path;
    yield* fs.makeDirectory(pathService.dirname(path), {recursive: true});
    const crypto = yield* Crypto.Crypto;
    const temporaryPath = `${path}.${yield* crypto.randomUUIDv4}.tmp`;
    const content = events.length === 0 ? '' : `${events.map(event => JSON.stringify(event)).join('\n')}\n`;
    yield* fs.writeFileString(temporaryPath, content, {mode: 0o600});
    yield* fs
      .rename(temporaryPath, path)
      .pipe(Effect.ensuring(fs.remove(temporaryPath, {force: true}).pipe(Effect.ignore)));
  });
}

function parseValueEvent(line: string): LocalValueEventV1 | undefined {
  if (!line.trim()) return undefined;
  const value = Option.getOrUndefined(Option.liftThrowable((text: string): unknown => JSON.parse(text))(line));
  if (
    !Predicate.isObject(value) ||
    value.version !== VALUE_EVENT_VERSION ||
    typeof value.timestamp !== 'string' ||
    (value.project !== undefined && typeof value.project !== 'string')
  )
    return undefined;
  if (
    value.kind === 'context-brief' &&
    typeof value.successful === 'boolean' &&
    validCount(value.coverageGaps) &&
    validCount(value.durationMilliseconds) &&
    validCount(value.estimatedTokens) &&
    validCount(value.requestedCodeAnchors) &&
    validCount(value.resolvedCodeAnchors)
  ) {
    return value as unknown as ContextBriefValueEventV1;
  }
  if (
    value.kind === 'health' &&
    typeof value.project === 'string' &&
    validCount(value.activeFindings) &&
    validCount(value.opened) &&
    validCount(value.resolved)
  ) {
    return value as unknown as HealthValueEventV1;
  }
  return undefined;
}

function boundedCount(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(10_000, value) : 0;
}

function validCount(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 604_800_000;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => Math.min(10_000, total + boundedCount(value)), 0);
}
