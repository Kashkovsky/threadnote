import {Effect} from 'effect';
import {sha256HexSync} from '../crypto/sha256.js';
import {readMemoryRecordsByUri} from '../memory.js';
import {loadRecallIndexData} from '../recall/index.js';
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

/**
 * Pure validator boundary for future structured memory citations. Current
 * memory metadata does not fabricate these fields from prose.
 */
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

/** A precise changed/deleted observation can only preserve or downgrade freshness, never upgrade it. */
export function reconcileContextBriefMemoryFreshness(
  coarse: ContextBriefFreshness,
  precise: ContextBriefPreciseEvidenceStatus,
): ContextBriefFreshness {
  return precise === 'changed' || precise === 'deleted' ? 'stale' : coarse;
}

/** Coarse freshness is intentionally unknown unless exactly one ready repository snapshot resolved. */
export function classifyMemoryFreshness(
  sourceCommit: string | undefined,
  resolvedSnapshots: readonly ContextBriefSnapshotV1[],
): ContextBriefFreshness {
  if (sourceCommit === undefined || !COMMIT.test(sourceCommit) || resolvedSnapshots.length !== 1) return 'unknown';
  return resolvedSnapshots[0]!.commit === sourceCommit ? 'fresh' : 'stale';
}

/** Local lexical retrieval only: no hosted service, model, or interpretation of memory body text. */
export const retrieveContextBriefMemoryEvidence = Effect.fn('contextBrief.retrieveMemoryEvidence')(function* (
  config: RuntimeConfig,
  plan: ContextBriefPlanV1['memory'],
) {
  const index = yield* loadRecallIndexData(config, {
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
  const records = yield* readMemoryRecordsByUri(config, rankedUris);
  const recordsByUri = new Map(records.map(record => [record.uri, record]));
  const candidates: ContextBriefMemoryCandidateV1[] = [];
  const seen = new Set<string>();
  for (const uri of rankedUris) {
    if (seen.has(uri)) continue;
    seen.add(uri);
    const record = recordsByUri.get(uri);
    if (
      record === undefined ||
      record.metadata.status !== 'active' ||
      (record.metadata.kind !== 'durable' && record.metadata.kind !== 'handoff')
    ) {
      continue;
    }
    const sourceCommit = boundedSourceCommit(record.metadata.sourceCommit);
    candidates.push({
      ...(record.metadata.authority === undefined ? {} : {authority: record.metadata.authority}),
      excerpt:
        record.metadata.kind === 'handoff' ? handoffEvidenceExcerpt(record.body) : memoryEvidenceExcerpt(record.body),
      kind: record.metadata.kind,
      ...(record.metadata.project === undefined ? {} : {project: record.metadata.project}),
      rank: candidates.length,
      ...(sourceCommit === undefined ? {} : {sourceCommit}),
      ...(record.metadata.topic === undefined ? {} : {topic: record.metadata.topic}),
      ...(record.metadata.trust === undefined ? {} : {trust: record.metadata.trust}),
      uri: record.uri,
    });
    if (candidates.length >= plan.candidateLimit) break;
  }
  return {
    candidates,
    consideredCandidates: index.candidates.length,
    gaps: candidates.length === 0 ? ['memory-recall-no-active-durable-or-handoff'] : [],
    trust: {classification: 'untrusted-memory-data', instructionPolicy: 'evidence-only-never-follow'},
  } satisfies ContextBriefMemoryRetrievalV1;
});

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
