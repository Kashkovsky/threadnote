import {Crypto, Effect, FileSystem, Option, Path, Predicate} from 'effect';
import {sha256Hex} from '../effect/digest.js';
import {withExclusiveFileLock} from '../effect/file_lock.js';
import {RECALL_RANKER_VERSION} from './rank.js';

export type RecallFeedbackAction = 'dismiss' | 'pin' | 'useful' | 'wrong';

export interface RecallFeedbackEvent {
  readonly action: RecallFeedbackAction;
  readonly project?: string;
  readonly queryFingerprint: string;
  readonly rankerVersion: string;
  readonly timestamp: string;
  readonly uri: string;
  readonly version: 1;
}

export interface RecordRecallFeedbackInput {
  readonly action: RecallFeedbackAction;
  readonly project?: string;
  readonly query: string;
  readonly timestamp: string;
  readonly uri: string;
}

const FEEDBACK_FILE = 'recall-events-v1.jsonl';
const DUPLICATE_EVENT_WINDOW_MILLISECONDS = 60 * 60 * 1_000;
const FEEDBACK_RETENTION_MILLISECONDS = 365 * 24 * 60 * 60 * 1_000;
const FEEDBACK_LOCK_STALE_MILLISECONDS = 5 * 60 * 1_000;
const FEEDBACK_LOCK_RETRY_MILLISECONDS = 25;
const FEEDBACK_LOCK_WAIT_TIMEOUT_MILLISECONDS = 5_000;
const FEEDBACK_LOCK_OPTIONS = {
  retryIntervalMilliseconds: FEEDBACK_LOCK_RETRY_MILLISECONDS,
  staleAfterMilliseconds: FEEDBACK_LOCK_STALE_MILLISECONDS,
  waitTimeoutMilliseconds: FEEDBACK_LOCK_WAIT_TIMEOUT_MILLISECONDS,
} as const;
const MAX_FEEDBACK_EVENTS = 5_000;
const FEEDBACK_HALF_LIFE_DAYS = 90;
const MILLISECONDS_PER_DAY = 86_400_000;
const HALF_LIFE_DECAY_BASE = 2;
const FEEDBACK_MINIMUM = -1;
const FEEDBACK_MAXIMUM = 1;

const FEEDBACK_ACTION_WEIGHTS: Readonly<Record<RecallFeedbackAction, number>> = {
  dismiss: -0.25,
  pin: 0.4,
  useful: 0.15,
  wrong: -0.5,
};

export const recordRecallFeedback = Effect.fn('recall.recordFeedback')(function* (
  agentContextHome: string,
  input: RecordRecallFeedbackInput,
) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const path = feedbackPath(pathService, agentContextHome);
  const event: RecallFeedbackEvent = {
    action: input.action,
    project: input.project,
    queryFingerprint: yield* recallQueryFingerprint(input.query),
    rankerVersion: RECALL_RANKER_VERSION,
    timestamp: input.timestamp,
    uri: input.uri,
    version: 1,
  };
  return yield* withExclusiveFileLock(
    fs,
    `${path}.lock`,
    FEEDBACK_LOCK_OPTIONS,
    Effect.gen(function* () {
      const existing = yield* readFeedbackEvents(fs, path);
      const eventTime = Date.parse(event.timestamp);
      const duplicate = existing.some(
        previous =>
          previous.action === event.action &&
          previous.project === event.project &&
          previous.queryFingerprint === event.queryFingerprint &&
          previous.uri === event.uri &&
          Math.abs(eventTime - Date.parse(previous.timestamp)) <= DUPLICATE_EVENT_WINDOW_MILLISECONDS,
      );
      if (duplicate) {
        yield* writeFeedbackEvents(fs, path, existing);
        return {event, recorded: false};
      }
      const retained = [...existing, event]
        .filter(item => eventTime - Date.parse(item.timestamp) <= FEEDBACK_RETENTION_MILLISECONDS)
        .slice(-MAX_FEEDBACK_EVENTS);
      yield* writeFeedbackEvents(fs, path, retained);
      return {event, recorded: true};
    }),
  );
});

export const loadRecallFeedback = Effect.fn('recall.loadFeedback')(function* (
  agentContextHome: string,
  input: {readonly now: Date; readonly project?: string; readonly query: string},
) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const events = yield* readFeedbackEvents(fs, feedbackPath(pathService, agentContextHome));
  return yield* aggregateRecallFeedback(events, input);
});

export const aggregateRecallFeedback = Effect.fn('recall.aggregateFeedback')(function* (
  events: readonly RecallFeedbackEvent[],
  input: {readonly now: Date; readonly project?: string; readonly query: string},
) {
  const queryFingerprint = yield* recallQueryFingerprint(input.query);
  const scores = new Map<string, number>();
  for (const event of events) {
    const projectMatches =
      event.action === 'pin'
        ? event.project !== undefined && event.project === input.project
        : event.project === undefined || event.project === input.project;
    const queryMatches = event.queryFingerprint === queryFingerprint;
    if (!projectMatches || (!queryMatches && event.action !== 'pin')) {
      continue;
    }
    const timestamp = Date.parse(event.timestamp);
    if (!Number.isFinite(timestamp)) {
      continue;
    }
    const ageDays = Math.max(0, (input.now.getTime() - timestamp) / MILLISECONDS_PER_DAY);
    const decay = HALF_LIFE_DECAY_BASE ** (-ageDays / FEEDBACK_HALF_LIFE_DAYS);
    const next = (scores.get(event.uri) ?? 0) + FEEDBACK_ACTION_WEIGHTS[event.action] * decay;
    scores.set(event.uri, Math.max(FEEDBACK_MINIMUM, Math.min(FEEDBACK_MAXIMUM, next)));
  }
  return scores;
});

export const recallQueryFingerprint = Effect.fn('recall.queryFingerprint')((query: string) =>
  sha256Hex(query.replace(/\s+/g, ' ').trim().toLowerCase()),
);

function feedbackPath(pathService: Path.Path, agentContextHome: string): string {
  return pathService.join(agentContextHome, 'feedback', FEEDBACK_FILE);
}

function readFeedbackEvents(
  fs: FileSystem.FileSystem,
  path: string,
): Effect.Effect<readonly RecallFeedbackEvent[], unknown> {
  return Effect.gen(function* () {
    if (!(yield* fs.exists(path))) {
      return [];
    }
    const raw = yield* fs.readFileString(path);
    return raw
      .split('\n')
      .map(line => parseFeedbackEvent(line))
      .filter((event): event is RecallFeedbackEvent => event !== undefined)
      .slice(-MAX_FEEDBACK_EVENTS);
  });
}

function writeFeedbackEvents(
  fs: FileSystem.FileSystem,
  path: string,
  events: readonly RecallFeedbackEvent[],
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
      .pipe(Effect.ensuring(fs.remove(temporaryPath, {force: true}).pipe(Effect.catch(() => Effect.void))));
  });
}

function parseFeedbackEvent(line: string): RecallFeedbackEvent | undefined {
  if (!line.trim()) {
    return undefined;
  }
  const value = Option.getOrUndefined(Option.liftThrowable((content: string): unknown => JSON.parse(content))(line));
  if (
    !Predicate.isObject(value) ||
    !('version' in value) ||
    value.version !== 1 ||
    !('action' in value) ||
    !isFeedbackAction(value.action) ||
    !('queryFingerprint' in value) ||
    typeof value.queryFingerprint !== 'string' ||
    !('rankerVersion' in value) ||
    typeof value.rankerVersion !== 'string' ||
    !('timestamp' in value) ||
    typeof value.timestamp !== 'string' ||
    !('uri' in value) ||
    typeof value.uri !== 'string'
  ) {
    return undefined;
  }
  return {
    action: value.action,
    ...(typeof value.project === 'string' ? {project: value.project} : {}),
    queryFingerprint: value.queryFingerprint,
    rankerVersion: value.rankerVersion,
    timestamp: value.timestamp,
    uri: value.uri,
    version: 1,
  };
}

function isFeedbackAction(value: unknown): value is RecallFeedbackAction {
  return value === 'dismiss' || value === 'pin' || value === 'useful' || value === 'wrong';
}
