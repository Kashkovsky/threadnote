import {sha256HexSync} from '../crypto/sha256.js';
import type {MemoryRecord} from './document.js';

export const CONTEXT_HEALTH_SEMANTIC_ANALYZER_VERSION = 1 as const;
export const MAXIMUM_CONTEXT_HEALTH_SEMANTIC_RECORDS = 128 as const;
export const MAXIMUM_CONTEXT_HEALTH_SEMANTIC_CLAIMS = 256 as const;
export const MAXIMUM_CONTEXT_HEALTH_SEMANTIC_CLAIMS_PER_RECORD = 16 as const;
export const MAXIMUM_CONTEXT_HEALTH_SEMANTIC_CONTRADICTIONS = 100 as const;

const MAXIMUM_BODY_CODE_UNITS = 65_536;
const MAXIMUM_CLAIM_CODE_UNITS = 512;
const CONTRADICTION_SIMILARITY_MILLI = 550;
const NEGATION = /\b(?:cannot|disabled|doesn't|do not|must not|never|no|not)\b/iu;
const TOKEN = /[a-z0-9][a-z0-9_.-]{2,}/gu;

export type ContextHealthSemanticUnknownReasonV1 =
  | 'body-limit'
  | 'claim-budget'
  | 'claim-limit'
  | 'claim-too-large'
  | 'contradiction-limit'
  | 'no-claims'
  | 'record-limit';

export interface ContextHealthSemanticClaimReferenceV1 {
  readonly claimFingerprint: string;
  readonly claimId: string;
  readonly recordUri: string;
}

export interface ContextHealthSemanticContradictionV1 {
  readonly basisFingerprint: string;
  readonly contradictionId: string;
  readonly left: ContextHealthSemanticClaimReferenceV1;
  readonly right: ContextHealthSemanticClaimReferenceV1;
  readonly similarityMilli: number;
}

export interface ContextHealthSemanticCompletenessV1 {
  readonly analyzedRecords: number;
  readonly claimsAnalyzed: number;
  readonly contradictionCount: number;
  readonly eligibleRecords: number;
  readonly omittedContradictions: number;
  readonly pairsCompared: number;
  readonly state: 'complete' | 'partial' | 'unavailable';
  readonly unknownReasons: readonly {
    readonly count: number;
    readonly reason: ContextHealthSemanticUnknownReasonV1;
  }[];
  readonly unknownRecords: number;
  readonly version: typeof CONTEXT_HEALTH_SEMANTIC_ANALYZER_VERSION;
}

export interface ContextHealthSemanticAnalysisV1 {
  readonly completeness: ContextHealthSemanticCompletenessV1;
  readonly contradictions: readonly ContextHealthSemanticContradictionV1[];
}

export interface ContextHealthSemanticAnalysisInputV1 {
  readonly project: string;
  readonly records: readonly MemoryRecord[];
}

interface SemanticClaim extends ContextHealthSemanticClaimReferenceV1 {
  readonly basisTokens: readonly string[];
  readonly denied: boolean;
}

interface ExtractedClaims {
  readonly claims: readonly SemanticClaim[];
  readonly reasons: readonly ContextHealthSemanticUnknownReasonV1[];
}

/** Deterministic local heuristic. Results are review evidence, never an automatic lifecycle decision. */
export function analyzeContextHealthSemantics(
  input: ContextHealthSemanticAnalysisInputV1,
): ContextHealthSemanticAnalysisV1 {
  const eligible = input.records
    .filter(
      record =>
        record.metadata.kind === 'durable' &&
        record.metadata.status === 'active' &&
        record.metadata.project === input.project,
    )
    .sort(compareRecords);
  const selected = eligible.slice(0, MAXIMUM_CONTEXT_HEALTH_SEMANTIC_RECORDS);
  const unknownByRecord = new Map<string, Set<ContextHealthSemanticUnknownReasonV1>>();
  for (const record of eligible.slice(MAXIMUM_CONTEXT_HEALTH_SEMANTIC_RECORDS)) {
    addUnknown(unknownByRecord, record.uri, 'record-limit');
  }

  const claims: SemanticClaim[] = [];
  let analyzedRecords = 0;
  for (const record of selected) {
    const extracted = extractClaims(record);
    for (const reason of extracted.reasons) addUnknown(unknownByRecord, record.uri, reason);
    const available = Math.max(0, MAXIMUM_CONTEXT_HEALTH_SEMANTIC_CLAIMS - claims.length);
    claims.push(...extracted.claims.slice(0, available));
    if (extracted.claims.length > available) addUnknown(unknownByRecord, record.uri, 'claim-budget');
    if (!unknownByRecord.has(record.uri)) analyzedRecords += 1;
  }
  claims.sort(compareClaims);

  const found: ContextHealthSemanticContradictionV1[] = [];
  let pairsCompared = 0;
  for (let leftIndex = 0; leftIndex < claims.length; leftIndex += 1) {
    const left = claims[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < claims.length; rightIndex += 1) {
      const right = claims[rightIndex];
      if (left.recordUri === right.recordUri) continue;
      pairsCompared += 1;
      if (left.denied === right.denied) continue;
      const similarityMilli = tokenSimilarityMilli(left.basisTokens, right.basisTokens);
      if (similarityMilli < CONTRADICTION_SIMILARITY_MILLI) continue;
      found.push(contradiction(left, right, similarityMilli));
    }
  }
  found.sort((left, right) => compareText(left.contradictionId, right.contradictionId));
  const contradictions = found.slice(0, MAXIMUM_CONTEXT_HEALTH_SEMANTIC_CONTRADICTIONS);
  const omittedContradictions = found.length - contradictions.length;
  const unknownReasonCounts = reasonCounts(unknownByRecord);
  if (omittedContradictions > 0) {
    unknownReasonCounts.set('contradiction-limit', omittedContradictions);
  }
  const unknownRecords = unknownByRecord.size;
  const state =
    unknownRecords === 0 && omittedContradictions === 0
      ? 'complete'
      : analyzedRecords === 0 && eligible.length > 0
        ? 'unavailable'
        : 'partial';
  return {
    completeness: {
      analyzedRecords,
      claimsAnalyzed: claims.length,
      contradictionCount: found.length,
      eligibleRecords: eligible.length,
      omittedContradictions,
      pairsCompared,
      state,
      unknownReasons: [...unknownReasonCounts]
        .map(([reason, count]) => ({count, reason}))
        .sort((left, right) => compareText(left.reason, right.reason)),
      unknownRecords,
      version: CONTEXT_HEALTH_SEMANTIC_ANALYZER_VERSION,
    },
    contradictions,
  };
}

function extractClaims(record: MemoryRecord): ExtractedClaims {
  const reasons = new Set<ContextHealthSemanticUnknownReasonV1>();
  if (record.body.length > MAXIMUM_BODY_CODE_UNITS) reasons.add('body-limit');
  const body = record.body.slice(0, MAXIMUM_BODY_CODE_UNITS).replace(/\r\n?/gu, '\n');
  const normalized = new Map<string, string>();
  let fenced = false;
  for (const line of body.split('\n')) {
    if (/^\s*```/u.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || /^\s*#/u.test(line)) continue;
    for (const sentence of line.split(/(?<=[.!?])\s+/u)) {
      const claim = sentence
        .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|>\s*)/u, '')
        .replace(/\s+/gu, ' ')
        .trim();
      if (!claim) continue;
      if (claim.length > MAXIMUM_CLAIM_CODE_UNITS) {
        reasons.add('claim-too-large');
        continue;
      }
      const key = claim.toLowerCase();
      if (tokens(key).length >= 2) normalized.set(key, claim);
    }
  }
  const values = [...normalized].sort(([left], [right]) => compareText(left, right));
  if (values.length === 0) reasons.add('no-claims');
  if (values.length > MAXIMUM_CONTEXT_HEALTH_SEMANTIC_CLAIMS_PER_RECORD) reasons.add('claim-limit');
  const claims = values.slice(0, MAXIMUM_CONTEXT_HEALTH_SEMANTIC_CLAIMS_PER_RECORD).map(([key, claim]) => {
    const claimFingerprint = sha256HexSync(key);
    return {
      basisTokens: tokens(withoutNegation(claim)),
      claimFingerprint,
      claimId: `tnclaim_${sha256HexSync(`${record.uri}\u0000${claimFingerprint}`).slice(0, 32)}`,
      denied: NEGATION.test(claim),
      recordUri: record.uri,
    };
  });
  return {claims, reasons: [...reasons].sort(compareText)};
}

function contradiction(
  first: SemanticClaim,
  second: SemanticClaim,
  similarityMilli: number,
): ContextHealthSemanticContradictionV1 {
  const [left, right] = compareClaims(first, second) <= 0 ? [first, second] : [second, first];
  const sharedTokens = left.basisTokens.filter(token => right.basisTokens.includes(token));
  const basisFingerprint = sha256HexSync([...new Set(sharedTokens)].sort(compareText).join('\u0000'));
  const contradictionId = sha256HexSync(
    ['threadnote-semantic-contradiction-v1', left.claimId, right.claimId, basisFingerprint].join('\u0000'),
  );
  return {
    basisFingerprint,
    contradictionId,
    left: claimReference(left),
    right: claimReference(right),
    similarityMilli,
  };
}

function claimReference(claim: SemanticClaim): ContextHealthSemanticClaimReferenceV1 {
  return {
    claimFingerprint: claim.claimFingerprint,
    claimId: claim.claimId,
    recordUri: claim.recordUri,
  };
}

function withoutNegation(value: string): string {
  return value
    .replace(/\bcannot\b/giu, 'can')
    .replace(/\bdisabled\b/giu, 'enabled')
    .replace(/\bdoesn't\b/giu, 'does')
    .replace(/\bdo not\b/giu, 'do')
    .replace(/\bmust not\b/giu, 'must')
    .replace(/\b(?:never|no|not)\b/giu, '');
}

function tokens(value: string): readonly string[] {
  return [...new Set([...value.toLowerCase().matchAll(TOKEN)].map(match => match[0]))].sort(compareText);
}

function tokenSimilarityMilli(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const leftSet = new Set(left);
  const intersection = right.filter(token => leftSet.has(token)).length;
  const union = new Set([...left, ...right]).size;
  return Math.round((intersection / union) * 1_000);
}

function addUnknown(
  target: Map<string, Set<ContextHealthSemanticUnknownReasonV1>>,
  uri: string,
  reason: ContextHealthSemanticUnknownReasonV1,
): void {
  const reasons = target.get(uri) ?? new Set();
  reasons.add(reason);
  target.set(uri, reasons);
}

function reasonCounts(
  unknownByRecord: ReadonlyMap<string, ReadonlySet<ContextHealthSemanticUnknownReasonV1>>,
): Map<ContextHealthSemanticUnknownReasonV1, number> {
  const counts = new Map<ContextHealthSemanticUnknownReasonV1, number>();
  for (const reasons of unknownByRecord.values()) {
    for (const reason of reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return counts;
}

function compareRecords(left: MemoryRecord, right: MemoryRecord): number {
  return compareText(left.uri, right.uri);
}

function compareClaims(left: SemanticClaim, right: SemanticClaim): number {
  return compareText(`${left.recordUri}\u0000${left.claimId}`, `${right.recordUri}\u0000${right.claimId}`);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
