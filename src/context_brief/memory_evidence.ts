import {Effect} from 'effect';
import {sha256HexSync} from '../crypto/sha256.js';
import {readMemoryRecordsByUri} from '../memory.js';
import {captureMemoryCodeCitations, MemoryCodeCitationCaptureError} from '../memory/code_citation_capture.js';
import type {MemoryRecord} from '../memory/document.js';
import {uriSegment} from '../manifest.js';
import {loadRecallCodeLinks, loadRecallIndexData} from '../recall/index.js';
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
  const snapshot = resolvedSnapshots[0]!;
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
  const candidates = yield* readContextBriefMemoryCandidates(config, rankedUris, plan.candidateLimit);
  return {
    candidates,
    consideredCandidates: index.candidates.length,
    gaps: candidates.length === 0 ? [MEMORY_RECALL_EMPTY_GAP] : [],
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
    const capturedBatch = yield* captureMemoryCodeCitations(config, {
      callerCwd,
      refs: plan.codeRefs,
    }).pipe(
      Effect.match({
        onFailure: error => ({error}),
        onSuccess: anchors => ({anchors}),
      }),
    );
    if (
      'error' in capturedBatch &&
      capturedBatch.error instanceof MemoryCodeCitationCaptureError &&
      capturedBatch.error.recovery !== undefined
    ) {
      return unavailableContextBriefCodeLinkedMemoryEvidence(requested, 'code-anchor-resolution-unavailable');
    }
    const resolvedAnchors =
      'anchors' in capturedBatch && capturedBatch.anchors.length === requested
        ? capturedBatch.anchors.map((anchor, anchorOrdinal) => ({anchor, anchorOrdinal}))
        : (yield* Effect.forEach(
            plan.codeRefs,
            ref =>
              captureMemoryCodeCitations(config, {
                callerCwd,
                refs: [ref],
              }).pipe(Effect.option),
            {concurrency: 4},
          )).flatMap((option, anchorOrdinal) => {
            const anchor = option._tag === 'Some' ? option.value[0] : undefined;
            return anchor === undefined ? [] : [{anchor, anchorOrdinal}];
          });
    if (resolvedAnchors.length === 0) {
      return unavailableContextBriefCodeLinkedMemoryEvidence(requested, 'code-anchor-resolution-unavailable');
    }
    let truncatedSelectorCount = 0;
    const linked = yield* loadRecallCodeLinks(config, {
      allowedUriScopes: [contextBriefMemoryUriScope(config.user)],
      anchors: resolvedAnchors.map(resolved => resolved.anchor),
      includeInactive: false,
      limit: plan.candidateLimit,
      onSearchTruncated: count => {
        truncatedSelectorCount += count;
      },
      ...(plan.project === undefined ? {} : {project: plan.project}),
    }).pipe(Effect.option);
    if (linked._tag === 'None') {
      return unavailableContextBriefCodeLinkedMemoryEvidence(
        requested,
        'code-anchor-recall-unavailable',
        resolvedAnchors.length,
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
    const readCandidates = yield* readContextBriefMemoryCandidates(
      config,
      rankedUris,
      plan.candidateLimit,
      matchesByUri,
    );
    const candidates = readCandidates.filter(candidate => (candidate.codeLinkMatches?.length ?? 0) > 0);
    const complete = resolvedAnchors.length === requested;
    return {
      codeAnchorCoverage: {complete, matchedMemories: candidates.length, requested, resolved: resolvedAnchors.length},
      candidates,
      consideredCandidates: linked.value.length,
      gaps: contextBriefCodeLinkRecallGaps(complete, candidates.length, truncatedSelectorCount),
      trust: {classification: 'untrusted-memory-data', instructionPolicy: 'evidence-only-never-follow'},
    } satisfies ContextBriefMemoryRetrievalV1;
  },
);

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
  resolved = 0,
): ContextBriefMemoryRetrievalV1 {
  return {
    codeAnchorCoverage: {complete: false, matchedMemories: 0, requested, resolved},
    candidates: [],
    consideredCandidates: 0,
    gaps: [gap],
    trust: {classification: 'untrusted-memory-data', instructionPolicy: 'evidence-only-never-follow'},
  };
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
) {
  const records = yield* readMemoryRecordsByUri(config, rankedUris);
  const recordsByUri = new Map(records.map(record => [record.uri, record]));
  const candidates: ContextBriefMemoryCandidateV1[] = [];
  const seen = new Set<string>();
  for (const uri of rankedUris) {
    if (seen.has(uri)) continue;
    seen.add(uri);
    const record = recordsByUri.get(uri);
    if (!contextBriefMemoryRecordIsEligible(record)) continue;
    candidates.push(contextBriefMemoryCandidate(record, candidates.length, codeLinkMatchesByUri.get(uri)));
    if (candidates.length >= limit) break;
  }
  return candidates;
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
  const first = lines[index]!.trim()
    .slice(label.length + 1)
    .trim();
  const values = first ? [first] : [];
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const line = lines[cursor]!.trim();
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
