import {Clock, Crypto, Effect, FileSystem, Option, Path} from 'effect';
import {sha256Hex} from '../effect/digest.js';
import {withExclusiveFileLock} from '../effect/file_lock.js';
import {safeChildDirectoryNames, scanFilesWithinBoundary} from '../effect/safe_scan.js';
import {SystemInfo} from '../effect/system.js';
import {uriSegment} from '../manifest.js';
import {canonicalMemoryDocumentContent, parseMemoryDocument, type MemoryRecord} from './document.js';
import {assertMemoryCodeCitation, formatMemoryCodeCitationLines, type MemoryCodeCitationV1} from './code_citation.js';
import type {MemoryKind} from '../types.js';

export type CandidateCategory = 'decision' | 'handoff' | 'invariant' | 'preference';
export type CandidateComparison = 'contradiction' | 'duplicate' | 'new' | 'possible_duplicate' | 'replacement';
export type CandidateRecommendation = 'create' | 'manual_review' | 'no_action' | 'replace';
export type CandidateReviewState = 'applied' | 'applying' | 'conflict' | 'deferred' | 'pending' | 'rejected';
export type CandidateApplyOperation = 'create' | 'replace';
export type CandidateApplyStage = 'cleanup_pending' | 'conflict' | 'prepared' | 'written';

export interface SessionCloseoutInput {
  readonly codeCitations?: readonly MemoryCodeCitationV1[];
  readonly decisions?: readonly string[];
  readonly evidence?: readonly string[];
  readonly handoff?: readonly string[];
  readonly invariants?: readonly string[];
  readonly outcome: string;
  readonly preferences?: readonly string[];
  readonly project: string;
  readonly sourceAgentClient: string;
  readonly sourceCommit?: string;
  readonly sourceSessionId?: string;
  readonly task: string;
  readonly topic: string;
}

export interface MemoryCandidate {
  readonly applyApprovedAt?: string;
  readonly applyContentHash?: string;
  readonly applyOperation?: CandidateApplyOperation;
  readonly applyReplaceUri?: string;
  readonly applyStage?: CandidateApplyStage;
  readonly applyTargetUri?: string;
  readonly candidateId: string;
  readonly categories: readonly CandidateCategory[];
  readonly comparison: CandidateComparison;
  readonly confidence: number;
  readonly evidence: readonly string[];
  readonly kind: Extract<MemoryKind, 'durable' | 'handoff' | 'preference'>;
  readonly project: string;
  readonly proposedText: string;
  readonly reason: string;
  readonly recommendation: CandidateRecommendation;
  readonly state: CandidateReviewState;
  readonly targetContentHash?: string;
  readonly targetUri?: string;
  readonly topic: string;
}

export interface CandidateReview {
  readonly auditEvents: readonly CandidateAuditEvent[];
  readonly candidates: readonly MemoryCandidate[];
  readonly codeCitations: readonly MemoryCodeCitationV1[];
  readonly createdAt: string;
  readonly outcome: string;
  readonly project: string;
  readonly reviewId: string;
  readonly revision: number;
  readonly sourceAgentClient: string;
  readonly sourceCommit?: string;
  readonly sourceSessionId?: string;
  readonly task: string;
  readonly topic: string;
  readonly version: 2;
}

export interface CandidateAuditEvent {
  readonly action: 'apply' | 'begin_apply' | 'conflict' | 'create_review' | 'defer' | 'reject';
  readonly at: string;
  readonly candidateId?: string;
  readonly memoryUri?: string;
  readonly reviewId: string;
  readonly revision: number;
}

interface CandidateDraft {
  readonly categories: readonly CandidateCategory[];
  readonly kind: MemoryCandidate['kind'];
  readonly proposedText: string;
}

interface CandidateAuditTransition {
  readonly action: CandidateAuditEvent['action'];
  readonly at: string;
  readonly memoryUri?: string;
}

class CandidateMemoryError extends Error {
  readonly _tag = 'CandidateMemoryError' as const;
}

const MEMORY_READ_CONCURRENCY = 16;
const MAX_CANDIDATE_AUDIT_EVENTS = 5_000;
const MAX_CANDIDATE_REVIEW_AUDIT_EVENTS = 100;
const MAX_CANDIDATE_REVIEW_BYTES = 512 * 1_024;
const MAX_CANDIDATE_REVIEWS = 500;
const MAX_CLOSEOUT_ITEMS_PER_FIELD = 32;
const MAX_CLOSEOUT_ITEM_CHARACTERS = 2_000;
const MAX_CLOSEOUT_SCALAR_CHARACTERS = 4_000;
const MAX_CLOSEOUT_EVIDENCE_POINTERS = 32;
const MAX_CLOSEOUT_TOTAL_BYTES = 64 * 1_024;
const TERMINAL_REVIEW_RETENTION_MILLISECONDS = 30 * 24 * 60 * 60 * 1_000;
const CANDIDATE_LOCK_STALE_MILLISECONDS = 5 * 60 * 1_000;
const CANDIDATE_LOCK_RETRY_MILLISECONDS = 25;
const CANDIDATE_LOCK_WAIT_TIMEOUT_MILLISECONDS = 5_000;
const CANDIDATE_LOCK_OPTIONS = {
  retryIntervalMilliseconds: CANDIDATE_LOCK_RETRY_MILLISECONDS,
  staleAfterMilliseconds: CANDIDATE_LOCK_STALE_MILLISECONDS,
  waitTimeoutMilliseconds: CANDIDATE_LOCK_WAIT_TIMEOUT_MILLISECONDS,
} as const;

export const buildCandidateReview = Effect.fn('candidate.buildReview')(function* (
  input: SessionCloseoutInput,
  existing: readonly MemoryRecord[],
  now: Date,
) {
  const createdAt = now.toISOString();
  const reviewId = `review-${(yield* sha256Hex(
    [input.project, input.topic, input.sourceSessionId ?? '', input.task, createdAt].join('\n'),
  )).slice(0, 16)}`;
  const evidence = candidateEvidence(input);
  const candidates =
    evidence.length === 0
      ? []
      : yield* Effect.forEach(
          candidateDrafts(input).slice(0, 3),
          (draft, index) => compareCandidate(reviewId, index, input, draft, existing, evidence),
          {concurrency: 3},
        );
  return {
    auditEvents: [
      {
        action: 'create_review',
        at: createdAt,
        reviewId,
        revision: 1,
      },
    ],
    candidates,
    codeCitations: input.codeCitations ?? [],
    createdAt,
    outcome: input.outcome,
    project: input.project,
    reviewId,
    revision: 1,
    sourceAgentClient: input.sourceAgentClient,
    sourceCommit: input.sourceCommit,
    sourceSessionId: input.sourceSessionId,
    task: input.task,
    topic: input.topic,
    version: 2,
  } satisfies CandidateReview;
});

export function candidateReviewWithState(
  review: CandidateReview,
  candidateId: string,
  state: CandidateReviewState,
  audit?: CandidateAuditTransition,
): CandidateReview {
  if (review.candidates.find(candidate => candidate.candidateId === candidateId)?.state === state) {
    return review;
  }
  const revision = review.revision + 1;
  const updated = {
    ...review,
    candidates: review.candidates.map(candidate =>
      candidate.candidateId === candidateId ? {...candidate, state} : candidate,
    ),
    revision,
  };
  return audit
    ? candidateReviewWithAuditEvent(updated, {
        ...audit,
        candidateId,
        reviewId: review.reviewId,
        revision,
      })
    : updated;
}

export function candidateReviewWithApplying(
  review: CandidateReview,
  candidateId: string,
  apply: {
    readonly contentHash: string;
    readonly operation: CandidateApplyOperation;
    readonly replaceUri?: string;
    readonly targetUri: string;
  },
  at: string,
): CandidateReview {
  return candidateReviewWithAuditEvent(
    {
      ...review,
      candidates: review.candidates.map(candidate =>
        candidate.candidateId === candidateId
          ? {
              ...candidate,
              applyApprovedAt: at,
              applyContentHash: apply.contentHash,
              applyOperation: apply.operation,
              applyReplaceUri: apply.replaceUri,
              applyStage: 'prepared',
              applyTargetUri: apply.targetUri,
              state: 'applying',
            }
          : candidate,
      ),
    },
    {
      action: 'begin_apply',
      at,
      candidateId,
      memoryUri: apply.targetUri,
      reviewId: review.reviewId,
      revision: review.revision,
    },
  );
}

export function candidateReviewWithApplyStage(
  review: CandidateReview,
  candidateId: string,
  applyStage: CandidateApplyStage,
): CandidateReview {
  return {
    ...review,
    candidates: review.candidates.map(candidate =>
      candidate.candidateId === candidateId ? {...candidate, applyStage} : candidate,
    ),
  };
}

export function validateSessionCloseoutInput(input: SessionCloseoutInput): string | undefined {
  const scalarFields = [
    ['task', input.task],
    ['outcome', input.outcome],
    ['project', input.project],
    ['topic', input.topic],
    ['sourceAgentClient', input.sourceAgentClient],
    ['sourceCommit', input.sourceCommit],
    ['sourceSessionId', input.sourceSessionId],
  ] as const;
  for (const [name, value] of scalarFields) {
    if ((value?.length ?? 0) > MAX_CLOSEOUT_SCALAR_CHARACTERS) {
      return `${name} exceeds ${MAX_CLOSEOUT_SCALAR_CHARACTERS} characters.`;
    }
  }
  const listFields = [
    ['decisions', input.decisions, MAX_CLOSEOUT_ITEMS_PER_FIELD],
    ['evidence', input.evidence, MAX_CLOSEOUT_EVIDENCE_POINTERS],
    ['handoff', input.handoff, MAX_CLOSEOUT_ITEMS_PER_FIELD],
    ['invariants', input.invariants, MAX_CLOSEOUT_ITEMS_PER_FIELD],
    ['preferences', input.preferences, MAX_CLOSEOUT_ITEMS_PER_FIELD],
  ] as const;
  for (const [name, values, maximumItems] of listFields) {
    if ((values?.length ?? 0) > maximumItems) {
      return `${name} exceeds ${maximumItems} items.`;
    }
    if ((values ?? []).some(value => value.length > MAX_CLOSEOUT_ITEM_CHARACTERS)) {
      return `${name} contains an item exceeding ${MAX_CLOSEOUT_ITEM_CHARACTERS} characters.`;
    }
  }
  const totalBytes = new TextEncoder().encode(JSON.stringify(input)).byteLength;
  return totalBytes > MAX_CLOSEOUT_TOTAL_BYTES
    ? `session closeout exceeds ${MAX_CLOSEOUT_TOTAL_BYTES} UTF-8 bytes.`
    : undefined;
}

export function candidateReviewWithAuditEvent(review: CandidateReview, event: CandidateAuditEvent): CandidateReview {
  const duplicate = review.auditEvents.some(
    item =>
      item.action === event.action &&
      item.candidateId === event.candidateId &&
      item.reviewId === event.reviewId &&
      item.revision === event.revision,
  );
  if (duplicate) {
    return review;
  }
  const appended = [...review.auditEvents, event];
  const creationEvent = appended.find(item => item.action === 'create_review');
  const recentEvents = appended
    .filter(item => item !== creationEvent)
    .slice(-(MAX_CANDIDATE_REVIEW_AUDIT_EVENTS - (creationEvent ? 1 : 0)));
  return {
    ...review,
    auditEvents: creationEvent ? [creationEvent, ...recentEvents] : recentEvents,
  };
}

export const readActiveProjectMemories = Effect.fn('candidate.readActiveProjectMemories')(function* (
  config: {readonly account: string; readonly agentContextHome: string; readonly user: string},
  project: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const root = pathService.join(
    config.agentContextHome,
    'data',
    config.account,
    'user',
    uriSegment(config.user),
    'memories',
  );
  const projectSegment = uriSegment(project);
  const directDirectories = [
    pathService.join(root, 'durable', 'projects', projectSegment),
    pathService.join(root, 'handoffs', 'active', projectSegment),
  ];
  const paths: string[] = [];
  for (const directory of directDirectories) {
    paths.push(...(yield* markdownFiles(fs, directory, root)));
  }
  paths.push(...(yield* markdownFiles(fs, pathService.join(root, 'preferences'), root, false)));
  const sharedRoot = pathService.join(root, 'shared');
  const teams = yield* safeChildDirectoryNames(fs, sharedRoot, root);
  if (teams.length > 0) {
    const sharedPaths = yield* Effect.forEach(
      teams,
      team => markdownFiles(fs, pathService.join(sharedRoot, team, 'durable', 'projects', projectSegment), root),
      {concurrency: MEMORY_READ_CONCURRENCY},
    );
    paths.push(...sharedPaths.flat());
  }
  const records = yield* Effect.forEach(
    [...new Set(paths)],
    path =>
      Effect.gen(function* () {
        const content = yield* fs.readFileString(path);
        const relative = pathService.relative(root, path).split(pathService.sep).join('/');
        const record = parseMemoryDocument(
          `threadnote://user/${uriSegment(config.user)}/memories/${relative}`,
          content,
        );
        return record?.metadata.status === 'active' &&
          (record.metadata.project === project || record.metadata.kind === 'preference')
          ? record
          : undefined;
      }),
    {concurrency: MEMORY_READ_CONCURRENCY},
  );
  return records.filter((record): record is MemoryRecord => record !== undefined);
});

export const saveCandidateReview = Effect.fn('candidate.saveReview')(function* (
  agentContextHome: string,
  review: CandidateReview,
) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const path = candidateReviewPath(pathService, agentContextHome, review.reviewId);
  const serialized = `${JSON.stringify(review, undefined, 2)}\n`;
  if (new TextEncoder().encode(serialized).byteLength > MAX_CANDIDATE_REVIEW_BYTES) {
    return yield* Effect.fail(
      new CandidateMemoryError(`Candidate review exceeds the ${MAX_CANDIDATE_REVIEW_BYTES}-byte persistence limit.`),
    );
  }
  yield* writePrivateFileAtomically(fs, path, serialized);
  yield* syncCandidateAudit(agentContextHome, review.auditEvents);
  yield* pruneCandidateReviews(fs, pathService.dirname(path), review.reviewId);
  return path;
});

export const loadCandidateReview = Effect.fn('candidate.loadReview')(function* (
  agentContextHome: string,
  reviewId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const path = candidateReviewPath(pathService, agentContextHome, reviewId);
  const raw = yield* fs.readFileString(path);
  const review = yield* Effect.try({
    try: () => parseCandidateReview(JSON.parse(raw)),
    catch: cause => new CandidateMemoryError(`Invalid candidate review ${reviewId}: ${errorText(cause)}`),
  });
  yield* syncCandidateAudit(agentContextHome, review.auditEvents);
  return review;
});

export const appendCandidateAudit = Effect.fn('candidate.appendAudit')(function* (
  agentContextHome: string,
  event: CandidateAuditEvent,
) {
  return yield* syncCandidateAudit(agentContextHome, [event]);
});

const syncCandidateAudit = Effect.fn('candidate.syncAudit')(function* (
  agentContextHome: string,
  events: readonly CandidateAuditEvent[],
) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const path = pathService.join(agentContextHome, 'threadnote', 'candidates', 'v1', 'audit.jsonl');
  yield* withExclusiveFileLock(
    fs,
    `${path}.lock`,
    CANDIDATE_LOCK_OPTIONS,
    Effect.gen(function* () {
      const existing = yield* readCandidateAudit(fs, path);
      const eventKeys = new Set(existing.map(candidateAuditEventKey));
      const additions = events.filter(event => {
        const key = candidateAuditEventKey(event);
        if (eventKeys.has(key)) {
          return false;
        }
        eventKeys.add(key);
        return true;
      });
      if (additions.length > 0) {
        const bounded = [...existing, ...additions]
          .sort((left, right) => candidateAuditTimestamp(left) - candidateAuditTimestamp(right))
          .slice(-MAX_CANDIDATE_AUDIT_EVENTS);
        if (bounded.map(candidateAuditEventKey).join('\n') !== existing.map(candidateAuditEventKey).join('\n')) {
          yield* writePrivateFileAtomically(fs, path, `${bounded.map(item => JSON.stringify(item)).join('\n')}\n`);
        }
      }
    }),
  );
  return path;
});

function candidateAuditEventKey(event: CandidateAuditEvent): string {
  return [event.action, event.candidateId ?? '', event.reviewId, event.revision].join('\n');
}

function candidateAuditTimestamp(event: CandidateAuditEvent): number {
  const timestamp = Date.parse(event.at);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function withCandidateReviewLock<A, E, R>(
  agentContextHome: string,
  reviewId: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | unknown, Crypto.Crypto | R | FileSystem.FileSystem | Path.Path | SystemInfo> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const lockDirectory = pathService.join(agentContextHome, 'threadnote', 'candidates', 'v1', 'locks');
    const lockPath = pathService.join(lockDirectory, `${reviewId.replace(/[^a-zA-Z0-9._-]/g, '')}.lock`);
    return yield* withExclusiveFileLock(fs, lockPath, CANDIDATE_LOCK_OPTIONS, effect);
  });
}

function candidateDrafts(input: SessionCloseoutInput): readonly CandidateDraft[] {
  const decisions = normalizedItems(input.decisions);
  const invariants = normalizedItems(input.invariants);
  const preferences = normalizedItems(input.preferences);
  const handoff = normalizedItems(input.handoff);
  const drafts: CandidateDraft[] = [];
  if (decisions.length > 0 || invariants.length > 0) {
    drafts.push({
      categories: [
        ...(decisions.length > 0 ? (['decision'] as const) : []),
        ...(invariants.length > 0 ? (['invariant'] as const) : []),
      ],
      kind: 'durable',
      proposedText: formatSections([
        ['Decisions', decisions],
        ['Invariants', invariants],
      ]),
    });
  }
  if (preferences.length > 0) {
    drafts.push({
      categories: ['preference'],
      kind: 'preference',
      proposedText: formatSections([['Preferences', preferences]]),
    });
  }
  if (handoff.length > 0) {
    drafts.push({
      categories: ['handoff'],
      kind: 'handoff',
      proposedText: formatSections([['Handoff state', handoff]]),
    });
  }
  return drafts;
}

const compareCandidate = Effect.fn('candidate.compare')(function* (
  reviewId: string,
  index: number,
  input: SessionCloseoutInput,
  draft: CandidateDraft,
  existing: readonly MemoryRecord[],
  evidence: readonly string[],
) {
  const sameTarget = existing
    .filter(
      record =>
        record.metadata.kind === draft.kind &&
        (draft.kind === 'preference' || record.metadata.project === input.project) &&
        record.metadata.topic === input.topic,
    )
    .sort((left, right) => right.metadata.timestamp.localeCompare(left.metadata.timestamp))[0];
  const mostSimilar = bestSimilarRecord(draft.proposedText, existing, input.project, draft.kind);
  const comparison = classifyComparison(draft.proposedText, sameTarget, mostSimilar);
  const target = sameTarget ?? (comparison === 'possible_duplicate' ? mostSimilar?.record : undefined);
  const recommendation: CandidateRecommendation =
    comparison === 'duplicate'
      ? 'no_action'
      : comparison === 'replacement'
        ? 'replace'
        : comparison === 'contradiction' || comparison === 'possible_duplicate'
          ? 'manual_review'
          : 'create';
  return {
    candidateId: `${reviewId}-${index + 1}`,
    categories: draft.categories,
    comparison,
    confidence:
      comparison === 'duplicate' ? 0.99 : comparison === 'replacement' ? 0.9 : comparison === 'new' ? 0.82 : 0.65,
    evidence,
    kind: draft.kind,
    project: input.project,
    proposedText: draft.proposedText,
    reason: comparisonReason(comparison),
    recommendation,
    state: 'pending',
    targetContentHash: target ? yield* sha256Hex(canonicalMemoryDocumentContent(target.content)) : undefined,
    targetUri: target?.uri,
    topic: input.topic,
  } satisfies MemoryCandidate;
});

function classifyComparison(
  proposedText: string,
  sameTarget: MemoryRecord | undefined,
  mostSimilar: {readonly record: MemoryRecord; readonly similarity: number} | undefined,
): CandidateComparison {
  if (sameTarget) {
    if (textSimilarity(proposedText, sameTarget.body) >= 0.92) {
      return 'duplicate';
    }
    return looksContradictory(proposedText, sameTarget.body) ? 'contradiction' : 'replacement';
  }
  if (mostSimilar && mostSimilar.similarity >= 0.82) {
    return 'possible_duplicate';
  }
  return 'new';
}

function bestSimilarRecord(
  proposedText: string,
  existing: readonly MemoryRecord[],
  project: string,
  kind: MemoryCandidate['kind'],
): {readonly record: MemoryRecord; readonly similarity: number} | undefined {
  return existing
    .filter(record => record.metadata.kind === kind && (kind === 'preference' || record.metadata.project === project))
    .map(record => ({record, similarity: textSimilarity(proposedText, record.body)}))
    .sort((left, right) => right.similarity - left.similarity)[0];
}

function textSimilarity(left: string, right: string): number {
  const leftTokens = new Set(tokens(left));
  const rightTokens = new Set(tokens(right));
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }
  const intersection = [...leftTokens].filter(token => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return intersection / union;
}

function looksContradictory(left: string, right: string): boolean {
  const negative = /\b(?:cannot|disabled|doesn't|do not|must not|never|no|not)\b/i;
  const leftNegative = negative.test(left);
  const rightNegative = negative.test(right);
  if (leftNegative === rightNegative) {
    return false;
  }
  const withoutNegation = (value: string) =>
    value.replace(/\b(?:cannot|disabled|doesn't|do not|must not|never|no|not)\b/gi, '');
  return textSimilarity(withoutNegation(left), withoutNegation(right)) >= 0.55;
}

function comparisonReason(comparison: CandidateComparison): string {
  switch (comparison) {
    case 'duplicate':
      return 'An active memory already contains substantially the same information.';
    case 'replacement':
      return 'An active memory has the same stable project, topic, and kind; replace it to keep one current fact.';
    case 'contradiction':
      return 'The candidate may contradict the active memory for the same stable project and topic.';
    case 'possible_duplicate':
      return 'A similar active memory exists under another topic; review before creating another copy.';
    case 'new':
      return 'No active memory with the same stable identity or substantially similar content was found.';
  }
}

function normalizedItems(items: readonly string[] | undefined): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items ?? []) {
    const normalized = item.replace(/\s+/g, ' ').trim();
    const key = normalized.toLowerCase();
    if (normalized && !seen.has(key)) {
      seen.add(key);
      result.push(normalized);
    }
  }
  return result;
}

function candidateEvidence(input: SessionCloseoutInput): readonly string[] {
  return normalizedItems([
    ...(input.evidence ?? []),
    ...(input.codeCitations ?? []).map(citation => `code-citation:${citation.id}`),
    ...(input.sourceSessionId ? [`session:${input.sourceSessionId}`] : []),
    ...(input.sourceCommit ? [`commit:${input.sourceCommit}`] : []),
  ]);
}

function formatSections(sections: ReadonlyArray<readonly [string, readonly string[]]>): string {
  return sections
    .filter(([, items]) => items.length > 0)
    .flatMap(([title, items]) => [`## ${title}`, ...items.map(item => `- ${item}`)])
    .join('\n');
}

function tokens(value: string): readonly string[] {
  return [...value.toLowerCase().matchAll(/[a-z0-9][a-z0-9_.-]{2,}/g)].map(match => match[0]);
}

function candidateReviewPath(pathService: Path.Path, agentContextHome: string, reviewId: string): string {
  const safeReviewId = reviewId.replace(/[^a-zA-Z0-9._-]/g, '');
  return pathService.join(agentContextHome, 'threadnote', 'candidates', 'v1', 'reviews', `${safeReviewId}.json`);
}

function writePrivateFileAtomically(
  fs: FileSystem.FileSystem,
  path: string,
  content: string,
): Effect.Effect<void, unknown, Crypto.Crypto | Path.Path> {
  return Effect.gen(function* () {
    const pathService = yield* Path.Path;
    yield* fs.makeDirectory(pathService.dirname(path), {recursive: true});
    const crypto = yield* Crypto.Crypto;
    const temporaryPath = `${path}.${yield* crypto.randomUUIDv4}.tmp`;
    yield* fs.writeFileString(temporaryPath, content, {mode: 0o600});
    yield* fs
      .rename(temporaryPath, path)
      .pipe(Effect.ensuring(fs.remove(temporaryPath, {force: true}).pipe(Effect.catch(() => Effect.void))));
  });
}

function markdownFiles(
  fs: FileSystem.FileSystem,
  root: string,
  boundaryRoot: string,
  recursive = true,
): Effect.Effect<readonly string[], unknown, Path.Path> {
  return scanFilesWithinBoundary(fs, root, boundaryRoot, {
    includeFile: (_path, name) => name.endsWith('.md') && !name.startsWith('.'),
    recursive,
  }).pipe(Effect.map(files => files.map(file => file.path)));
}

function readCandidateAudit(
  fs: FileSystem.FileSystem,
  path: string,
): Effect.Effect<readonly CandidateAuditEvent[], unknown> {
  return Effect.gen(function* () {
    if (!(yield* fs.exists(path))) {
      return [];
    }
    const raw = yield* fs.readFileString(path);
    return raw
      .split('\n')
      .map(line =>
        line.trim()
          ? Option.getOrUndefined(
              Option.liftThrowable((content: string) => JSON.parse(content) as CandidateAuditEvent)(line),
            )
          : undefined,
      )
      .filter((event): event is CandidateAuditEvent => event !== undefined)
      .slice(-MAX_CANDIDATE_AUDIT_EVENTS);
  });
}

function pruneCandidateReviews(
  fs: FileSystem.FileSystem,
  reviewDirectory: string,
  currentReviewId: string,
): Effect.Effect<void, unknown, Path.Path> {
  return Effect.gen(function* () {
    const pathService = yield* Path.Path;
    const now = yield* Clock.currentTimeMillis;
    const reviews = yield* Effect.forEach(
      (yield* fs.readDirectory(reviewDirectory)).filter(name => name.endsWith('.json')),
      name =>
        Effect.gen(function* () {
          const path = pathService.join(reviewDirectory, name);
          const info = yield* fs.stat(path);
          const modifiedAt = Option.getOrUndefined(info.mtime)?.getTime() ?? now;
          const raw = yield* fs.readFileString(path);
          const review = yield* Effect.try({
            try: () => parseCandidateReview(JSON.parse(raw)),
            catch: () => undefined,
          }).pipe(Effect.catch(() => Effect.succeed(undefined)));
          return {modifiedAt, path, review};
        }),
      {concurrency: MEMORY_READ_CONCURRENCY},
    );
    const removable = reviews
      .filter(item => item.review?.reviewId !== currentReviewId)
      .sort(
        (left, right) =>
          candidateReviewRetentionPriority(left.review) - candidateReviewRetentionPriority(right.review) ||
          left.modifiedAt - right.modifiedAt,
      );
    let remaining = reviews.length;
    for (const item of removable) {
      const expired =
        candidateReviewIsTerminal(item.review) && now - item.modifiedAt > TERMINAL_REVIEW_RETENTION_MILLISECONDS;
      if (!expired && remaining <= MAX_CANDIDATE_REVIEWS) {
        break;
      }
      yield* fs.remove(item.path, {force: true});
      remaining -= 1;
    }
  });
}

function candidateReviewIsTerminal(review: CandidateReview | undefined): boolean {
  return (
    review?.candidates.every(
      candidate => candidate.state === 'applied' || candidate.state === 'conflict' || candidate.state === 'rejected',
    ) === true
  );
}

function candidateReviewRetentionPriority(review: CandidateReview | undefined): number {
  if (!review || candidateReviewIsTerminal(review)) {
    return 0;
  }
  if (review.candidates.every(candidate => candidate.state === 'deferred')) {
    return 1;
  }
  if (review.candidates.some(candidate => candidate.state === 'applying')) {
    return 3;
  }
  return 2;
}

function parseCandidateReview(value: unknown): CandidateReview {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('version' in value) ||
    (value.version !== 1 && value.version !== 2) ||
    !('reviewId' in value) ||
    typeof value.reviewId !== 'string' ||
    !('revision' in value) ||
    typeof value.revision !== 'number' ||
    !('candidates' in value) ||
    !Array.isArray(value.candidates)
  ) {
    throw new CandidateMemoryError('unsupported review document');
  }
  const review = value as Omit<CandidateReview, 'codeCitations' | 'version'> & {
    readonly codeCitations?: readonly MemoryCodeCitationV1[];
    readonly version: 1 | 2;
  };
  let codeCitations: readonly MemoryCodeCitationV1[] = [];
  if (review.version === 2) {
    if (!Array.isArray(review.codeCitations)) throw new CandidateMemoryError('invalid v2 code citations');
    try {
      codeCitations = review.codeCitations.map(assertMemoryCodeCitation);
      formatMemoryCodeCitationLines(codeCitations);
    } catch {
      throw new CandidateMemoryError('invalid v2 code citations');
    }
  }
  return {
    ...review,
    auditEvents: Array.isArray(review.auditEvents)
      ? review.auditEvents.filter(event => candidateAuditEventIsValid(event))
      : [],
    codeCitations,
    version: 2,
  };
}

function candidateAuditEventIsValid(value: unknown): value is CandidateAuditEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    'action' in value &&
    (value.action === 'apply' ||
      value.action === 'begin_apply' ||
      value.action === 'conflict' ||
      value.action === 'create_review' ||
      value.action === 'defer' ||
      value.action === 'reject') &&
    'at' in value &&
    typeof value.at === 'string' &&
    'reviewId' in value &&
    typeof value.reviewId === 'string' &&
    'revision' in value &&
    typeof value.revision === 'number'
  );
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
