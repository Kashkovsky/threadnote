import {Effect, Result, Schedule} from 'effect';
import {resolveRepositoryIdentity} from '../code_graph/repository.js';
import {sha256HexSync} from '../crypto/sha256.js';
import {readMemoryRecordsByUri} from '../memory/index.js';
import {captureMemoryCodeCitations, MemoryCodeCitationCaptureError} from '../memory/code_citation_capture.js';
import {finalizeDeferredCodeAnchorsForRoute} from '../memory/deferred_code_anchor.js';
import type {MemoryRecord} from '../memory/document.js';
import {isMemoryId} from '../memory/identity_alias.js';
import {uriSegment} from '../manifest.js';
import {
  expireRecallIndexValidation,
  loadRecallCodeLinks,
  loadRecallIndexData,
  loadRecallMemoryIdentities,
} from '../recall/index.js';
import {classifyMemoryIdentityCandidates} from '../recall/memory_identity.js';
import {withCodeAnchorFinalizationAnonymousTelemetry} from '../telemetry/code_anchor_finalization.js';
import type {RuntimeConfig} from '../types.js';
import type {
  ContextBriefFreshness,
  ContextBriefMemoryCandidateV1,
  ContextBriefMemoryRetrievalV1,
  ContextBriefPlanV1,
  ContextBriefPreciseEvidenceStatus,
  ContextBriefSnapshotV1,
} from './types.js';

const MEMORY_EXCERPT_BYTES = 240;
const MEMORY_RETRIEVAL_MULTIPLIER = 4;
const CONTEXT_BRIEF_DEFERRED_CODE_ANCHOR_FINALIZE_LIMIT = 4;
const CONTEXT_BRIEF_DEFERRED_CODE_ANCHOR_WAIT_MILLISECONDS = 1_000;
const CONTEXT_BRIEF_CODE_ANCHOR_READ_RETRIES = 2;
const CONTEXT_BRIEF_CODE_ANCHOR_RETRY_MILLISECONDS = 25;
const MEMORY_RECALL_EMPTY_GAP = 'memory-recall-no-active-durable-or-handoff';
const THREADNOTE_MEMORY_URI = /^threadnote:\/\/user\/[^/]+\/memories\//u;
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const CONTENT_HASH = /^[0-9a-f]{64}$/u;
const NODE_ID = /^cgs_(?:[0-9a-f]{32}|[0-9a-f]{40}|[0-9a-f]{64})$/u;

export interface ContextBriefPreciseCodeEvidenceV1 {
  readonly contentHash: string;
  readonly nodeId?: string;
  readonly path: string;
  readonly repositoryId: string;
  readonly sourceCommit: string;
}

export interface ContextBriefPreciseCodeObservationV1 {
  readonly contentHash?: string;
  readonly exists: boolean;
  readonly nodeId?: string;
  readonly path?: string;
  readonly repositoryId: string;
  readonly snapshotCommit: string;
}

/** Pure classification boundary shared by citation validation and focused tests. */
export function validateContextBriefPreciseCodeEvidence(input: {
  readonly evidence: ContextBriefPreciseCodeEvidenceV1;
  readonly observation?: ContextBriefPreciseCodeObservationV1;
}): ContextBriefPreciseEvidenceStatus {
  const evidence = parsePreciseEvidence(input.evidence);
  if (input.observation === undefined) return 'unknown';
  const observation = parsePreciseObservation(input.observation);
  if (observation.repositoryId !== evidence.repositoryId) return 'unknown';
  if (!observation.exists) return 'deleted';
  if (observation.contentHash === undefined) return 'unknown';
  if (observation.contentHash !== evidence.contentHash) return 'changed';
  if (observation.path === undefined) return 'unknown';
  if (observation.path !== evidence.path) return 'relocated';
  if (evidence.nodeId !== undefined) {
    if (observation.nodeId === undefined) return 'unknown';
    if (observation.nodeId !== evidence.nodeId) return 'relocated';
  }
  return 'exact';
}

/** Precise cited bytes supersede commit-only freshness; unknown evidence never guesses. */
export function reconcileContextBriefMemoryFreshness(
  coarse: ContextBriefFreshness,
  precise: ContextBriefPreciseEvidenceStatus,
): ContextBriefFreshness {
  switch (precise) {
    case 'changed':
    case 'deleted':
      return 'stale';
    case 'unknown':
      return 'unknown';
    case 'exact':
    case 'relocated':
      return 'fresh';
  }
}

/** Coarse freshness is intentionally unknown unless exactly one ready repository snapshot resolved. */
export function classifyMemoryFreshness(
  sourceCommit: string | undefined,
  resolvedSnapshots: readonly ContextBriefSnapshotV1[],
): ContextBriefFreshness {
  if (sourceCommit === undefined || !COMMIT.test(sourceCommit) || resolvedSnapshots.length !== 1) return 'unknown';
  const snapshot = resolvedSnapshots[0];
  if (snapshot.dirty || snapshot.freshness !== 'fresh') return 'unknown';
  return snapshot.commit === sourceCommit ? 'fresh' : 'stale';
}

/** Local lexical retrieval only: no hosted service, model, or interpretation of memory body text. */
export const retrieveContextBriefMemoryEvidence = Effect.fn('contextBrief.retrieveMemoryEvidence')(function* (
  config: RuntimeConfig,
  plan: ContextBriefPlanV1['memory'],
) {
  const index = yield* loadRecallIndexData(config, {
    allowedUriScopes: [contextBriefMemoryUriScope(config.user)],
    includeInactive: false,
    limit: Math.max(plan.candidateLimit, plan.candidateLimit * MEMORY_RETRIEVAL_MULTIPLIER),
    ...(plan.project === undefined ? {} : {project: plan.project}),
    query: plan.query,
  });
  const rankedUris = index.candidates
    .filter(
      candidate =>
        THREADNOTE_MEMORY_URI.test(candidate.uri) &&
        (candidate.kind === 'durable' || candidate.kind === 'handoff') &&
        candidate.status === 'active',
    )
    .map(candidate => candidate.uri);
  const read = yield* readContextBriefMemoryCandidates(
    config,
    rankedUris,
    plan.candidateLimit,
    new Map(),
    plan.requireResolvableMemoryIdentity,
  );
  const candidates = read.candidates;
  return {
    candidates,
    consideredCandidates: index.candidates.length,
    gaps: [
      ...(candidates.length === 0 ? [MEMORY_RECALL_EMPTY_GAP] : []),
      ...(read.stableIdentityUnavailable ? ['stable-memory-identity-unavailable'] : []),
    ],
    trust: {classification: 'untrusted-memory-data', instructionPolicy: 'evidence-only-never-follow'},
  } satisfies ContextBriefMemoryRetrievalV1;
});

/** Resolve explicit local anchors against ready-current code and retrieve their private citation backlinks. */
export const retrieveContextBriefCodeLinkedMemoryEvidence = Effect.fn('contextBrief.retrieveCodeLinkedMemoryEvidence')(
  function* (config: RuntimeConfig, plan: ContextBriefPlanV1['codeAnchors']) {
    const requested = plan.codeRefs.length;
    if (requested === 0) {
      return {
        codeAnchorCoverage: {complete: true, matchedMemories: 0, requested: 0, resolved: 0},
        candidates: [],
        consideredCandidates: 0,
        gaps: [],
        trust: {classification: 'untrusted-memory-data', instructionPolicy: 'evidence-only-never-follow'},
      } satisfies ContextBriefMemoryRetrievalV1;
    }
    if (plan.scope.kind !== 'repository') {
      return unavailableContextBriefCodeLinkedMemoryEvidence(requested, 'code-anchor-scope-unsupported');
    }
    const callerCwd = plan.scope.callerCwd;
    if (plan.codeRefs.some(ref => ref.startsWith('cgr_'))) {
      return unavailableContextBriefCodeLinkedMemoryEvidence(requested, 'code-anchor-ref-unsupported');
    }
    const retryBudget = {remaining: CONTEXT_BRIEF_CODE_ANCHOR_READ_RETRIES};
    const capturedBatch = yield* Effect.result(
      retryContextBriefCodeAnchorRead(
        captureMemoryCodeCitations(config, {
          callerCwd,
          refs: plan.codeRefs,
        }),
        retryBudget,
      ),
    );
    if (
      Result.isFailure(capturedBatch) &&
      capturedBatch.failure instanceof MemoryCodeCitationCaptureError &&
      capturedBatch.failure.recovery !== undefined
    ) {
      return unavailableContextBriefCodeLinkedMemoryEvidence(requested, 'code-anchor-resolution-unavailable');
    }
    const fallbackAttempts =
      Result.isSuccess(capturedBatch) && capturedBatch.success.length === requested
        ? undefined
        : Result.isSuccess(capturedBatch) || isUnresolvedContextBriefCodeAnchorFailure(capturedBatch.failure)
          ? yield* Effect.forEach(
              plan.codeRefs,
              ref =>
                Effect.result(
                  retryContextBriefCodeAnchorRead(
                    captureMemoryCodeCitations(config, {
                      callerCwd,
                      refs: [ref],
                    }),
                    retryBudget,
                  ),
                ),
              // A deterministic unresolved member is isolated serially; a
              // global or non-retryable batch failure never fans out 8x.
              {concurrency: 1},
            )
          : undefined;
    const resolvedAnchors =
      Result.isSuccess(capturedBatch) && capturedBatch.success.length === requested
        ? capturedBatch.success.map((anchor, anchorOrdinal) => ({anchor, anchorOrdinal}))
        : (fallbackAttempts ?? []).flatMap((attempt, anchorOrdinal) => {
            const anchor = Result.isSuccess(attempt) ? attempt.success[0] : undefined;
            return anchor === undefined ? [] : [{anchor, anchorOrdinal}];
          });
    const unresolvedCaptureFailures = (fallbackAttempts ?? []).flatMap(attempt =>
      Result.isFailure(attempt) ? [attempt.failure] : [],
    );
    const captureFailures = [
      ...(Result.isFailure(capturedBatch) ? [capturedBatch.failure] : []),
      ...unresolvedCaptureFailures,
    ];
    const captureUnavailable = captureFailures.some(failure => !isUnresolvedContextBriefCodeAnchorFailure(failure));
    if (resolvedAnchors.length === 0) {
      const unexpected = captureFailures.find(isUnexpectedContextBriefCodeAnchorFailure);
      if (unexpected !== undefined) return yield* Effect.fail(unexpected);
      return unavailableContextBriefCodeLinkedMemoryEvidence(requested, 'code-anchor-resolution-unavailable');
    }
    const resolvedOrdinals = resolvedAnchors.map(anchor => anchor.anchorOrdinal);
    const identity = yield* resolveRepositoryIdentity(callerCwd).pipe(Effect.option);
    const attemptedUris: string[] = [];
    if (identity._tag === 'Some') {
      yield* withCodeAnchorFinalizationAnonymousTelemetry(
        'context-brief',
        finalizeDeferredCodeAnchorsForRoute(
          config,
          {
            callerCwd,
            kind: 'repository',
            repositoryId: identity.value.repositoryId,
            worktreeId: identity.value.worktreeId,
          },
          {
            limit: CONTEXT_BRIEF_DEFERRED_CODE_ANCHOR_FINALIZE_LIMIT,
            onAttemptedUri: uri => {
              attemptedUris.push(uri);
            },
            preferredCodeRefs: plan.codeRefs,
            waitTimeoutMilliseconds: CONTEXT_BRIEF_DEFERRED_CODE_ANCHOR_WAIT_MILLISECONDS,
          },
        ),
      ).pipe(
        Effect.catchCause(() => Effect.void),
        Effect.asVoid,
      );
    }
    const forceRecallRefresh =
      attemptedUris.length === 0
        ? false
        : yield* expireRecallIndexValidation(config.agentContextHome, false, attemptedUris).pipe(
            Effect.as(false),
            Effect.catchCause(() => Effect.succeed(true)),
          );
    let truncatedSelectorCount = 0;
    const linked = yield* loadRecallCodeLinks(config, {
      allowedUriScopes: [contextBriefMemoryUriScope(config.user)],
      anchors: resolvedAnchors.map(resolved => resolved.anchor),
      ...(forceRecallRefresh ? {forceRefresh: true} : {}),
      includeInactive: false,
      limit: plan.candidateLimit,
      onSearchTruncated: count => {
        truncatedSelectorCount += count;
      },
      ...(plan.project === undefined ? {} : {project: plan.project}),
    }).pipe(Effect.option);
    if (linked._tag === 'None') {
      return unavailableContextBriefCodeLinkedMemoryEvidenceAfterCapture(
        requested,
        resolvedOrdinals,
        'code-anchor-recall-unavailable',
        captureUnavailable ? ['code-anchor-resolution-unavailable'] : [],
      );
    }
    const matchesByUri = mapContextBriefCodeLinkMatches(
      linked.value,
      resolvedAnchors.map(resolved => ({
        ...(resolved.anchor.target.kind === 'symbol' ? {anchorNodeId: resolved.anchor.target.nodeId} : {}),
        anchorOrdinal: resolved.anchorOrdinal,
        anchorPath: resolved.anchor.path,
      })),
    );
    const rankedUris = [...matchesByUri.keys()];
    const readCandidatesResult = yield* Effect.result(
      readContextBriefMemoryCandidates(config, rankedUris, plan.candidateLimit, matchesByUri, true),
    );
    if (Result.isFailure(readCandidatesResult)) {
      return unavailableContextBriefCodeLinkedMemoryEvidenceAfterCapture(
        requested,
        resolvedOrdinals,
        'code-anchor-recall-unavailable',
        captureUnavailable ? ['code-anchor-resolution-unavailable'] : [],
      );
    }
    const readCandidates = readCandidatesResult.success;
    const candidates = readCandidates.candidates.filter(candidate => (candidate.codeLinkMatches?.length ?? 0) > 0);
    const complete = resolvedAnchors.length === requested;
    const unresolvedOrdinals = unresolvedContextBriefCodeAnchorOrdinals(requested, resolvedOrdinals);
    return {
      codeAnchorCoverage: {
        complete,
        matchedMemories: candidates.length,
        requested,
        resolved: resolvedAnchors.length,
        ...(unresolvedOrdinals.length === 0 ? {} : {unresolvedOrdinals}),
      },
      candidates,
      consideredCandidates: linked.value.length,
      gaps: stableUnique([
        ...contextBriefCodeLinkRecallGaps(complete, candidates.length, truncatedSelectorCount),
        ...(captureUnavailable ? ['code-anchor-resolution-unavailable'] : []),
        ...(readCandidates.stableIdentityUnavailable ? ['stable-memory-identity-unavailable'] : []),
      ]),
      trust: {classification: 'untrusted-memory-data', instructionPolicy: 'evidence-only-never-follow'},
    } satisfies ContextBriefMemoryRetrievalV1;
  },
);

function retryContextBriefCodeAnchorRead<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  budget: {remaining: number},
): Effect.Effect<A, E, R> {
  return effect.pipe(
    Effect.retry({
      schedule: Schedule.spaced(CONTEXT_BRIEF_CODE_ANCHOR_RETRY_MILLISECONDS),
      times: CONTEXT_BRIEF_CODE_ANCHOR_READ_RETRIES,
      while: error => {
        if (!(error instanceof MemoryCodeCitationCaptureError) || !error.retryable || budget.remaining === 0) {
          return false;
        }
        budget.remaining -= 1;
        return true;
      },
    }),
  );
}

function isUnresolvedContextBriefCodeAnchorFailure(error: unknown): boolean {
  return error instanceof MemoryCodeCitationCaptureError && error.failureCode === 'code-reference-unresolved';
}

function isUnexpectedContextBriefCodeAnchorFailure(error: unknown): boolean {
  return (
    !(error instanceof MemoryCodeCitationCaptureError) ||
    (error.failureCode === undefined && error.recovery === undefined)
  );
}

/** Explicitly distinguish bounded inverse-search abstention from evidence of no backlink. */
export function contextBriefCodeLinkRecallGaps(
  complete: boolean,
  candidateCount: number,
  truncatedSelectorCount: number,
): readonly string[] {
  return stableUnique([
    ...(complete ? [] : ['code-anchors-unresolved']),
    ...(truncatedSelectorCount > 0 ? ['code-anchor-recall-truncated'] : []),
    ...(candidateCount === 0 ? ['code-anchor-recall-no-active-memory'] : []),
  ]);
}

/** @internal Restore requested-ref ordinals after unresolved anchors are omitted from the reverse lookup. */
export function mapContextBriefCodeLinkMatches(
  matches: readonly {
    readonly anchorOrdinal: number;
    readonly citationId: string;
    readonly matchKind: NonNullable<ContextBriefMemoryCandidateV1['codeLinkMatches']>[number]['matchKind'];
    readonly uri: string;
  }[],
  resolvedAnchors: readonly {
    readonly anchorNodeId?: string;
    readonly anchorOrdinal: number;
    readonly anchorPath: string;
  }[],
): ReadonlyMap<string, NonNullable<ContextBriefMemoryCandidateV1['codeLinkMatches']>> {
  const matchesByUri = new Map<string, NonNullable<ContextBriefMemoryCandidateV1['codeLinkMatches']>>();
  const seen = new Set<string>();
  for (const match of matches) {
    const anchor = resolvedAnchors[match.anchorOrdinal];
    if (anchor === undefined) continue;
    const identity = `${match.uri}\u0000${anchor.anchorOrdinal}\u0000${match.citationId}\u0000${match.matchKind}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const uriMatches = matchesByUri.get(match.uri) ?? [];
    matchesByUri.set(match.uri, [
      ...uriMatches,
      {
        ...(anchor.anchorNodeId === undefined ? {} : {anchorNodeId: anchor.anchorNodeId}),
        anchorOrdinal: anchor.anchorOrdinal,
        anchorPath: anchor.anchorPath,
        citationId: match.citationId,
        matchKind: match.matchKind,
      },
    ]);
  }
  for (const [uri, uriMatches] of matchesByUri) {
    matchesByUri.set(
      uri,
      [...uriMatches].sort(
        (left, right) =>
          left.anchorOrdinal - right.anchorOrdinal ||
          contextBriefCodeLinkMatchPriority(left.matchKind) - contextBriefCodeLinkMatchPriority(right.matchKind) ||
          compareText(left.citationId, right.citationId),
      ),
    );
  }
  return matchesByUri;
}

function contextBriefCodeLinkMatchPriority(
  matchKind: NonNullable<ContextBriefMemoryCandidateV1['codeLinkMatches']>[number]['matchKind'],
): number {
  switch (matchKind) {
    case 'symbol-node':
      return 0;
    case 'symbol-locator':
      return 1;
    case 'file-path':
      return 2;
    case 'file-content':
      return 3;
  }
}

export function unavailableContextBriefMemoryEvidence(
  gap = 'memory-recall-unavailable',
): ContextBriefMemoryRetrievalV1 {
  return {
    candidates: [],
    consideredCandidates: 0,
    gaps: [gap],
    trust: {classification: 'untrusted-memory-data', instructionPolicy: 'evidence-only-never-follow'},
  };
}

export function unavailableContextBriefCodeLinkedMemoryEvidence(
  requested: number,
  gap = 'code-anchor-recall-unavailable',
  resolvedOrdinals: readonly number[] = [],
): ContextBriefMemoryRetrievalV1 {
  const unresolvedOrdinals = unresolvedContextBriefCodeAnchorOrdinals(requested, resolvedOrdinals);
  return {
    codeAnchorCoverage: {
      complete: unresolvedOrdinals.length === 0,
      matchedMemories: 0,
      requested,
      resolved: requested - unresolvedOrdinals.length,
      ...(unresolvedOrdinals.length === 0 ? {} : {unresolvedOrdinals}),
    },
    candidates: [],
    consideredCandidates: 0,
    gaps: [gap],
    trust: {classification: 'untrusted-memory-data', instructionPolicy: 'evidence-only-never-follow'},
  };
}

/** Preserve successful anchor resolution when inverse recall or canonical reads abstain. */
function unavailableContextBriefCodeLinkedMemoryEvidenceAfterCapture(
  requested: number,
  resolvedOrdinals: readonly number[],
  gap: string,
  additionalGaps: readonly string[] = [],
): ContextBriefMemoryRetrievalV1 {
  const evidence = unavailableContextBriefCodeLinkedMemoryEvidence(requested, gap, resolvedOrdinals);
  return {
    ...evidence,
    gaps: stableUnique([
      ...evidence.gaps,
      ...additionalGaps,
      ...(evidence.codeAnchorCoverage?.complete === false ? ['code-anchors-unresolved'] : []),
    ]),
  };
}

/** Return a deterministic, privacy-safe complement of resolved request positions. */
export function unresolvedContextBriefCodeAnchorOrdinals(
  requested: number,
  resolvedOrdinals: readonly number[],
): readonly number[] {
  const resolved = new Set(
    resolvedOrdinals.filter(ordinal => Number.isSafeInteger(ordinal) && ordinal >= 0 && ordinal < requested),
  );
  return Array.from({length: requested}, (_, ordinal) => ordinal).filter(ordinal => !resolved.has(ordinal));
}

/** Keep direct citation matches ahead of topical recall without mixing their ranking semantics. */
export function mergeContextBriefMemoryEvidence(
  lexical: ContextBriefMemoryRetrievalV1,
  codeLinked: ContextBriefMemoryRetrievalV1 | undefined,
  candidateLimit: number,
  directCandidateLimit = candidateLimit,
): ContextBriefMemoryRetrievalV1 {
  if (codeLinked === undefined) return lexical;
  const candidates: ContextBriefMemoryCandidateV1[] = [];
  const seen = new Set<string>();
  const lexicalUris = new Set(lexical.candidates.map(candidate => candidate.uri));
  const boundedDirectCandidateLimit = Math.max(0, Math.min(candidateLimit, directCandidateLimit));
  for (const candidate of codeLinked.candidates) {
    if (candidates.length >= boundedDirectCandidateLimit) break;
    if (seen.has(candidate.uri)) continue;
    seen.add(candidate.uri);
    candidates.push({
      ...candidate,
      ...(lexicalUris.has(candidate.uri) ? {lexicallySelected: true as const} : {}),
      rank: candidates.length,
    });
    if (candidates.length >= candidateLimit) break;
  }
  for (const candidate of lexical.candidates) {
    if (candidates.length >= candidateLimit) break;
    if (seen.has(candidate.uri)) continue;
    seen.add(candidate.uri);
    candidates.push({...candidate, rank: candidates.length});
    if (candidates.length >= candidateLimit) break;
  }
  const lexicalGaps =
    candidates.length === 0 ? lexical.gaps : lexical.gaps.filter(gap => gap !== MEMORY_RECALL_EMPTY_GAP);
  return {
    ...(codeLinked.codeAnchorCoverage === undefined ? {} : {codeAnchorCoverage: codeLinked.codeAnchorCoverage}),
    candidates,
    consideredCandidates: lexical.consideredCandidates + codeLinked.consideredCandidates,
    gaps: stableUnique([...lexicalGaps, ...codeLinked.gaps]),
    trust: lexical.trust,
  };
}

/** Restrict code backlinks to the current user's canonical memory namespace before SQL bounds apply. */
export function contextBriefMemoryUriScope(user: string): string {
  return `threadnote://user/${uriSegment(user)}/memories`;
}

const readContextBriefMemoryCandidates = Effect.fn('contextBrief.readMemoryCandidates')(function* (
  config: RuntimeConfig,
  rankedUris: readonly string[],
  limit: number,
  codeLinkMatchesByUri: ReadonlyMap<string, NonNullable<ContextBriefMemoryCandidateV1['codeLinkMatches']>> = new Map(),
  requireResolvableMemoryIdentity = false,
) {
  const records = yield* readMemoryRecordsByUri(config, rankedUris);
  const recordsByUri = new Map(records.map(record => [record.uri, record]));
  const memoryIds = [
    ...new Set(
      records.flatMap(record =>
        record.metadata.memoryId !== undefined && isMemoryId(record.metadata.memoryId)
          ? [record.metadata.memoryId]
          : [],
      ),
    ),
  ];
  const allowedUriScopes = [contextBriefMemoryUriScope(config.user)];
  const identityCandidates =
    requireResolvableMemoryIdentity && memoryIds.length > 0
      ? yield* loadRecallMemoryIdentities(config, {allowedUriScopes, memoryIds})
      : [];
  const resolvableMemoryIds = new Set(
    memoryIds.filter(
      memoryId => classifyMemoryIdentityCandidates(identityCandidates, memoryId, allowedUriScopes).state === 'resolved',
    ),
  );
  const candidates: ContextBriefMemoryCandidateV1[] = [];
  const seen = new Set<string>();
  let stableIdentityUnavailable = false;
  for (const uri of rankedUris) {
    if (seen.has(uri)) continue;
    seen.add(uri);
    const record = recordsByUri.get(uri);
    if (!contextBriefMemoryRecordIsEligible(record)) continue;
    const memoryId = record.metadata.memoryId;
    const identityResolvable =
      !requireResolvableMemoryIdentity ||
      (memoryId !== undefined && isMemoryId(memoryId) && resolvableMemoryIds.has(memoryId));
    if (!identityResolvable) stableIdentityUnavailable = true;
    candidates.push(
      contextBriefMemoryCandidate(record, candidates.length, codeLinkMatchesByUri.get(uri), identityResolvable),
    );
    if (candidates.length >= limit) break;
  }
  return {candidates, stableIdentityUnavailable};
});

function contextBriefMemoryRecordIsEligible(record: MemoryRecord | undefined): record is MemoryRecord {
  return (
    record !== undefined &&
    record.metadata.status === 'active' &&
    (record.metadata.kind === 'durable' || record.metadata.kind === 'handoff')
  );
}

function contextBriefMemoryCandidate(
  record: MemoryRecord,
  rank: number,
  codeLinkMatches: ContextBriefMemoryCandidateV1['codeLinkMatches'],
  memoryIdentityResolvable = true,
): ContextBriefMemoryCandidateV1 {
  if (record.metadata.kind !== 'durable' && record.metadata.kind !== 'handoff') {
    throw new Error('Context Brief memory candidate must be durable or handoff.');
  }
  const sourceCommit = boundedSourceCommit(record.metadata.sourceCommit);
  const citationIds = new Set((record.metadata.codeCitations ?? []).map(citation => citation.id));
  const currentCodeLinkMatches = codeLinkMatches?.filter(match => citationIds.has(match.citationId));
  return {
    ...(record.metadata.authority === undefined ? {} : {authority: record.metadata.authority}),
    citationErrorCount: record.metadata.citationErrors?.length ?? 0,
    codeCitations: record.metadata.codeCitations ?? [],
    ...(currentCodeLinkMatches === undefined || currentCodeLinkMatches.length === 0
      ? {}
      : {codeLinkMatches: currentCodeLinkMatches}),
    excerpt:
      record.metadata.kind === 'handoff' ? handoffEvidenceExcerpt(record.body) : memoryEvidenceExcerpt(record.body),
    kind: record.metadata.kind,
    ...(memoryIdentityResolvable && record.metadata.memoryId !== undefined && isMemoryId(record.metadata.memoryId)
      ? {memoryId: record.metadata.memoryId}
      : {}),
    ...(record.metadata.project === undefined ? {} : {project: record.metadata.project}),
    rank,
    ...(sourceCommit === undefined ? {} : {sourceCommit}),
    ...(record.metadata.topic === undefined ? {} : {topic: record.metadata.topic}),
    ...(record.metadata.trust === undefined ? {} : {trust: record.metadata.trust}),
    uri: record.uri,
  };
}

export function memoryEvidenceExcerpt(body: string): string {
  const evidence = body
    .split(/\r?\n/gu)
    .map(line => line.replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/u, '').trim())
    .filter(line => line && !line.startsWith('```'))
    .slice(0, 3)
    .join(' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return utf8Prefix(evidence, MEMORY_EXCERPT_BYTES);
}

/** Select only explicit handoff task/blocker/next-step fields; local paths and raw diffs stay out of the brief. */
export function handoffEvidenceExcerpt(body: string): string {
  const sections = [
    labeledHandoffSection(body, 'task'),
    labeledHandoffSection(body, 'blockers'),
    labeledHandoffSection(body, 'next_step'),
  ].filter((section): section is string => section !== undefined);
  return sections.length > 0 ? utf8Prefix(sections.join(' '), MEMORY_EXCERPT_BYTES) : memoryEvidenceExcerpt(body);
}

function labeledHandoffSection(body: string, label: 'blockers' | 'next_step' | 'task'): string | undefined {
  const lines = body.split(/\r?\n/gu);
  const index = lines.findIndex(line => line.trimStart().startsWith(`${label}:`));
  if (index < 0) return undefined;
  const first = lines[index]
    .trim()
    .slice(label.length + 1)
    .trim();
  const values = first ? [first] : [];
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const line = lines[cursor].trim();
    if (!line) break;
    values.push(line.replace(/^[-*+]\s+/u, '').trim());
  }
  const value = values.filter(Boolean).join(' ');
  return value ? `${label}: ${value}` : undefined;
}

function parsePreciseEvidence(value: ContextBriefPreciseCodeEvidenceV1): ContextBriefPreciseCodeEvidenceV1 {
  exactKeys(value, ['contentHash', 'nodeId', 'path', 'repositoryId', 'sourceCommit'], 'precise evidence');
  if (!CONTENT_HASH.test(value.contentHash)) throw invalid('contentHash');
  if (value.nodeId !== undefined && !NODE_ID.test(value.nodeId)) throw invalid('nodeId');
  repositoryPath(value.path);
  if (!CONTENT_HASH.test(value.repositoryId)) throw invalid('repositoryId');
  if (!COMMIT.test(value.sourceCommit)) throw invalid('sourceCommit');
  return value;
}

function parsePreciseObservation(value: ContextBriefPreciseCodeObservationV1): ContextBriefPreciseCodeObservationV1 {
  exactKeys(
    value,
    ['contentHash', 'exists', 'nodeId', 'path', 'repositoryId', 'snapshotCommit'],
    'precise observation',
  );
  if (value.contentHash !== undefined && !CONTENT_HASH.test(value.contentHash)) throw invalid('observed contentHash');
  if (typeof value.exists !== 'boolean') throw invalid('exists');
  if (value.nodeId !== undefined && !NODE_ID.test(value.nodeId)) throw invalid('observed nodeId');
  if (value.path !== undefined) repositoryPath(value.path);
  if (!CONTENT_HASH.test(value.repositoryId)) throw invalid('observed repositoryId');
  if (!COMMIT.test(value.snapshotCommit)) throw invalid('snapshotCommit');
  return value;
}

function exactKeys(value: object, allowed: readonly string[], label: string): void {
  const keys = Object.keys(value);
  const extras = keys.filter(key => !allowed.includes(key));
  if (extras.length > 0) throw new Error(`Invalid Context Brief ${label}: unsupported field ${extras.sort()[0]}.`);
}

function repositoryPath(value: string): void {
  if (
    !value ||
    new TextEncoder().encode(value).byteLength > 4_096 ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.split('/').some(segment => !segment || segment === '.' || segment === '..')
  ) {
    throw invalid('repository-relative path');
  }
}

function boundedSourceCommit(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.normalize('NFKC').trim();
  return normalized && new TextEncoder().encode(normalized).byteLength <= 128 ? normalized : undefined;
}

function utf8Prefix(value: string, maximumBytes: number): string {
  if (new TextEncoder().encode(value).byteLength <= maximumBytes) return value;
  const suffix = '…';
  let output = '';
  for (const character of value) {
    const candidate = `${output}${character}${suffix}`;
    if (new TextEncoder().encode(candidate).byteLength > maximumBytes) break;
    output += character;
  }
  return `${output}${suffix}`;
}

function stableUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalid(field: string): Error {
  return new Error(`Invalid Context Brief precise code evidence ${field}.`);
}

/** Stable identity helper for future structured-evidence receipts. */
export function contextBriefPreciseEvidenceId(evidence: ContextBriefPreciseCodeEvidenceV1): string {
  const value = parsePreciseEvidence(evidence);
  return `cbpe_${sha256HexSync(
    `${value.repositoryId}\u0000${value.sourceCommit}\u0000${value.path}\u0000${value.nodeId ?? ''}\u0000${value.contentHash}`,
  ).slice(0, 24)}`;
}
