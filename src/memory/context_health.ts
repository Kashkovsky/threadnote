import type {
  ContextBriefCitationValidationReceiptV2,
  ContextBriefMemoryCitationValidationV2,
} from '../context_brief/types.js';
import {buildCompactPlan} from './hygiene.js';
import type {CandidateComparison} from './candidate.js';
import type {MemoryRecord} from './document.js';
import {
  analyzeContextHealthSemantics,
  type ContextHealthSemanticCompletenessV1,
  type ContextHealthSemanticContradictionV1,
} from './context_health_semantic.js';

export const CONTEXT_HEALTH_REPORT_VERSION = 1 as const;
export const DEFAULT_CONTEXT_HEALTH_FINDING_LIMIT = 100 as const;
export const MAXIMUM_CONTEXT_HEALTH_FINDING_LIMIT = 500 as const;

export type ContextHealthFindingCategoryV1 =
  | 'candidate-contradiction'
  | 'candidate-possible-duplicate'
  | 'citation-changed'
  | 'citation-missing'
  | 'citation-unknown'
  | 'exact-duplicate'
  | 'guidance-locally-modified'
  | 'guidance-missing-block'
  | 'guidance-stale-sources'
  | 'guidance-unavailable'
  | 'relation-target-conflicted'
  | 'relation-target-inactive'
  | 'relation-target-missing'
  | 'review-overdue'
  | 'semantic-contradiction'
  | 'validity-expired';

export type ContextHealthSeverityV1 = 'critical' | 'high' | 'low' | 'medium';
export type ContextHealthConfidenceV1 = 'high' | 'low' | 'medium';
export type ContextHealthRepairabilityV1 = 'manual-review' | 'requires-evidence' | 'reviewable';

export interface ContextHealthRepairDescriptorV1 {
  readonly kind:
    | 'archive-memory'
    | 'deduplicate-memory'
    | 'repair-guidance'
    | 'repair-citation'
    | 'repair-relation'
    | 'review-candidate'
    | 'review-memory';
  readonly subjectUri?: string;
  readonly summary: string;
  readonly targetUri?: string;
}

export interface ContextHealthFindingV1 {
  readonly category: ContextHealthFindingCategoryV1;
  readonly confidence: ContextHealthConfidenceV1;
  readonly id: string;
  readonly repair: ContextHealthRepairDescriptorV1;
  readonly repairability: ContextHealthRepairabilityV1;
  readonly semanticEvidence?: ContextHealthSemanticContradictionV1;
  readonly severity: ContextHealthSeverityV1;
  readonly summary: string;
  readonly uris: readonly string[];
}

export interface ContextHealthRelationEvidenceV1 {
  readonly sourceUri: string;
  readonly status: 'active' | 'conflicted' | 'inactive' | 'missing';
  readonly targetUri: string;
}

export interface ContextHealthCandidateEvidenceV1 {
  readonly candidateId: string;
  readonly comparison: CandidateComparison;
  readonly project: string;
  readonly targetUri?: string;
}

export interface ContextHealthGuidanceEvidenceV1 {
  readonly sourceUris: readonly string[];
  readonly state: 'locally-modified' | 'missing-block' | 'stale-sources' | 'unavailable';
}

export interface ContextHealthReportInputV1 {
  readonly candidateEvidence?: readonly ContextHealthCandidateEvidenceV1[];
  readonly guidanceEvidence?: readonly ContextHealthGuidanceEvidenceV1[];
  readonly citationValidations?: readonly ContextBriefMemoryCitationValidationV2[];
  readonly includeFindingCategories?: readonly ContextHealthFindingCategoryV1[];
  readonly includeFindingUris?: readonly string[];
  readonly limit?: number;
  readonly now: Date;
  readonly project: string;
  readonly records: readonly MemoryRecord[];
  readonly relationEvidence?: readonly ContextHealthRelationEvidenceV1[];
}

export interface ContextHealthReportV1 {
  readonly findings: readonly ContextHealthFindingV1[];
  readonly limit: number;
  readonly omittedFindings: number;
  readonly project: string;
  readonly recordsScanned: number;
  readonly semanticCompleteness: ContextHealthSemanticCompletenessV1;
  readonly status: 'clean' | 'findings' | 'unknown';
  readonly version: typeof CONTEXT_HEALTH_REPORT_VERSION;
}

/** A pure, evidence-driven maintenance planner. It only describes reviewable repairs. */
export function buildContextHealthReport(input: ContextHealthReportInputV1): ContextHealthReportV1 {
  const records = input.records
    .filter(record => record.metadata.status === 'active' && record.metadata.project === input.project)
    .sort(compareRecords);
  const recordUris = new Set(records.map(record => record.uri));
  const includeFindingCategories =
    input.includeFindingCategories === undefined ? undefined : new Set(input.includeFindingCategories);
  const includeFindingUris = input.includeFindingUris === undefined ? undefined : new Set(input.includeFindingUris);
  const semanticAnalysis = analyzeContextHealthSemantics({project: input.project, records});
  const findings = deduplicateFindings(
    [
      ...validityFindings(records, input.now),
      ...reviewFindings(records, input.now),
      ...citationFindings(input.citationValidations ?? [], recordUris),
      ...relationFindings(input.relationEvidence ?? [], records),
      ...duplicateFindings(records, input.project, input.now),
      ...candidateFindings(input.candidateEvidence ?? [], input.project),
      ...guidanceFindings(input.guidanceEvidence ?? []),
      ...semanticFindings(semanticAnalysis.contradictions),
    ].sort(compareFindings),
  ).filter(
    finding =>
      (includeFindingUris === undefined && includeFindingCategories === undefined) ||
      includeFindingCategories?.has(finding.category) === true ||
      finding.uris.some(uri => includeFindingUris?.has(uri) === true),
  );
  const limit = findingLimit(input.limit);
  const filtered = includeFindingUris !== undefined || includeFindingCategories !== undefined;
  return {
    findings: findings.slice(0, limit),
    limit,
    omittedFindings: Math.max(0, findings.length - limit),
    project: input.project,
    recordsScanned: records.length,
    semanticCompleteness: semanticAnalysis.completeness,
    status:
      semanticAnalysis.completeness.state !== 'complete' || (filtered && findings.length === 0)
        ? 'unknown'
        : findings.length > 0
          ? 'findings'
          : 'clean',
    version: CONTEXT_HEALTH_REPORT_VERSION,
  };
}

function semanticFindings(
  contradictions: readonly ContextHealthSemanticContradictionV1[],
): readonly ContextHealthFindingV1[] {
  return contradictions.map(semanticEvidence => ({
    ...finding(
      'semantic-contradiction',
      [semanticEvidence.left.recordUri, semanticEvidence.right.recordUri],
      `claims ${semanticEvidence.left.claimId} and ${semanticEvidence.right.claimId} have opposing assertions`,
      {
        confidence: 'medium',
        kind: 'review-memory',
        repairability: 'manual-review',
        severity: 'medium',
        summary: 'Review both durable claims, designate which assertion is stale, then supersede or correct it.',
      },
    ),
    semanticEvidence,
  }));
}

function guidanceFindings(evidence: readonly ContextHealthGuidanceEvidenceV1[]): readonly ContextHealthFindingV1[] {
  return evidence.flatMap(item => {
    const uris = [...new Set(item.sourceUris)].sort(compareText);
    if (uris.length === 0) return [];
    return [
      finding(`guidance-${item.state}`, uris, `project guidance is ${item.state}`, {
        confidence: 'high',
        kind: 'repair-guidance',
        repairability: item.state === 'unavailable' ? 'requires-evidence' : 'reviewable',
        severity: item.state === 'stale-sources' ? 'medium' : 'high',
        summary: `Review projected project guidance: ${item.state}.`,
      }),
    ];
  });
}

function validityFindings(records: readonly MemoryRecord[], now: Date): readonly ContextHealthFindingV1[] {
  const nowMilliseconds = now.getTime();
  if (!Number.isFinite(nowMilliseconds)) return [];
  return records.flatMap(record => {
    const validTo = timestamp(record.metadata.validTo);
    if (validTo === undefined || validTo > nowMilliseconds) return [];
    return [
      finding('validity-expired', [record.uri], `valid_to expired at ${record.metadata.validTo}`, {
        confidence: 'high',
        kind: 'archive-memory',
        repairability: 'reviewable',
        severity: 'critical',
        subjectUri: record.uri,
        summary: 'Review whether this expired memory should be archived or replaced.',
      }),
    ];
  });
}

function reviewFindings(records: readonly MemoryRecord[], now: Date): readonly ContextHealthFindingV1[] {
  const nowMilliseconds = now.getTime();
  return records.flatMap(record => {
    const reviewAfter = record.metadata.reviewAfter;
    const reviewAfterMilliseconds = timestamp(reviewAfter) ?? timestamp(`${reviewAfter}T00:00:00.000Z`);
    if (reviewAfterMilliseconds === undefined || reviewAfterMilliseconds > nowMilliseconds) return [];
    return [
      finding('review-overdue', [record.uri], `review_after ${reviewAfter} is due`, {
        confidence: 'high',
        kind: 'review-memory',
        repairability: 'reviewable',
        severity: 'medium',
        subjectUri: record.uri,
        summary: 'Review this memory and record its maintenance outcome.',
      }),
    ];
  });
}

function citationFindings(
  validations: readonly ContextBriefMemoryCitationValidationV2[],
  recordUris: ReadonlySet<string>,
): readonly ContextHealthFindingV1[] {
  return validations
    .filter(validation => recordUris.has(validation.uri))
    .flatMap(validation => validation.receipts.flatMap(receipt => citationFinding(validation.uri, receipt)));
}

function citationFinding(
  uri: string,
  receipt: ContextBriefCitationValidationReceiptV2,
): readonly ContextHealthFindingV1[] {
  const citationUri = `${uri}#${receipt.citationId}`;
  if (receipt.status === 'changed') {
    return [
      finding('citation-changed', [uri], `citation ${receipt.citationId} no longer matches current source`, {
        confidence: receipt.coverage === 'current-complete' ? 'high' : 'medium',
        kind: 'repair-citation',
        repairability: 'reviewable',
        severity: 'high',
        subjectUri: uri,
        summary: `Review and recapture citation ${receipt.citationId}.`,
        targetUri: citationUri,
      }),
    ];
  }
  if (receipt.status === 'deleted') {
    return [
      finding('citation-missing', [uri], `citation ${receipt.citationId} target is missing`, {
        confidence: receipt.coverage === 'current-complete' ? 'high' : 'medium',
        kind: 'repair-citation',
        repairability: 'reviewable',
        severity: 'high',
        subjectUri: uri,
        summary: `Review the missing target for citation ${receipt.citationId}.`,
        targetUri: citationUri,
      }),
    ];
  }
  if (receipt.status === 'unknown') {
    return [
      finding('citation-unknown', [uri], `citation ${receipt.citationId} could not be validated: ${receipt.reason}`, {
        confidence: 'low',
        kind: 'repair-citation',
        repairability: 'requires-evidence',
        severity: 'low',
        subjectUri: uri,
        summary: `Restore validation evidence before repairing citation ${receipt.citationId}.`,
        targetUri: citationUri,
      }),
    ];
  }
  return [];
}

function relationFindings(
  evidence: readonly ContextHealthRelationEvidenceV1[],
  records: readonly MemoryRecord[],
): readonly ContextHealthFindingV1[] {
  const relationsBySource = new Map(records.map(record => [record.uri, record.metadata.relations ?? []]));
  return evidence
    .filter(
      item =>
        item.status !== 'active' &&
        relationsBySource.get(item.sourceUri)?.some(relation => relation.uri === item.targetUri) === true,
    )
    .map(item => {
      const category = `relation-target-${item.status}` as Extract<
        ContextHealthFindingCategoryV1,
        `relation-target-${string}`
      >;
      return finding(category, [item.sourceUri, item.targetUri], `relation target is ${item.status}`, {
        confidence: item.status === 'conflicted' ? 'medium' : 'high',
        kind: 'repair-relation',
        repairability: item.status === 'conflicted' ? 'manual-review' : 'reviewable',
        severity: 'high',
        subjectUri: item.sourceUri,
        summary: `Review the relation target ${item.targetUri}.`,
        targetUri: item.targetUri,
      });
    });
}

function duplicateFindings(
  records: readonly MemoryRecord[],
  project: string,
  now: Date,
): readonly ContextHealthFindingV1[] {
  const plan = buildCompactPlan(records, {now, project});
  return plan.forgets.flatMap(action => {
    if (!action.reason.startsWith('exact duplicate of ')) return [];
    const survivor = action.reason.slice('exact duplicate of '.length);
    return [
      finding('exact-duplicate', [action.uri, survivor], `exact duplicate of ${survivor}`, {
        confidence: 'high',
        kind: 'deduplicate-memory',
        repairability: 'reviewable',
        severity: 'medium',
        subjectUri: action.uri,
        summary: `Review duplicate retirement against survivor ${survivor}.`,
        targetUri: survivor,
      }),
    ];
  });
}

function candidateFindings(
  evidence: readonly ContextHealthCandidateEvidenceV1[],
  project: string,
): readonly ContextHealthFindingV1[] {
  return evidence
    .filter(
      item =>
        item.project === project && (item.comparison === 'contradiction' || item.comparison === 'possible_duplicate'),
    )
    .map(item => {
      const category = item.comparison === 'contradiction' ? 'candidate-contradiction' : 'candidate-possible-duplicate';
      const uris = item.targetUri === undefined ? [] : [item.targetUri];
      return finding(category, uris, `candidate ${item.candidateId} is ${item.comparison.replace('_', ' ')}`, {
        confidence: 'medium',
        kind: 'review-candidate',
        repairability: 'manual-review',
        severity: 'medium',
        summary: `Review candidate ${item.candidateId} before applying it.`,
        ...(item.targetUri === undefined ? {} : {targetUri: item.targetUri}),
      });
    });
}

function finding(
  category: ContextHealthFindingCategoryV1,
  uris: readonly string[],
  summary: string,
  repair: Omit<ContextHealthRepairDescriptorV1, 'summary'> & {
    readonly confidence: ContextHealthConfidenceV1;
    readonly repairability: ContextHealthRepairabilityV1;
    readonly severity: ContextHealthSeverityV1;
    readonly summary: string;
  },
): ContextHealthFindingV1 {
  const canonicalUris = [...new Set(uris)].sort(compareText);
  return {
    category,
    confidence: repair.confidence,
    id: [category, ...canonicalUris, summary].join('\u0000'),
    repair: {
      kind: repair.kind,
      ...(repair.subjectUri === undefined ? {} : {subjectUri: repair.subjectUri}),
      summary: repair.summary,
      ...(repair.targetUri === undefined ? {} : {targetUri: repair.targetUri}),
    },
    repairability: repair.repairability,
    severity: repair.severity,
    summary,
    uris: canonicalUris,
  };
}

function findingLimit(input: number | undefined): number {
  if (input === undefined) return DEFAULT_CONTEXT_HEALTH_FINDING_LIMIT;
  if (!Number.isFinite(input)) return DEFAULT_CONTEXT_HEALTH_FINDING_LIMIT;
  return Math.max(0, Math.min(MAXIMUM_CONTEXT_HEALTH_FINDING_LIMIT, Math.floor(input)));
}

function compareFindings(left: ContextHealthFindingV1, right: ContextHealthFindingV1): number {
  const severity = severityRank(left.severity) - severityRank(right.severity);
  if (severity !== 0) return severity;
  const category = categoryRank(left.category) - categoryRank(right.category);
  if (category !== 0) return category;
  return compareText(left.id, right.id);
}

function deduplicateFindings(findings: readonly ContextHealthFindingV1[]): readonly ContextHealthFindingV1[] {
  return [...new Map(findings.map(finding => [finding.id, finding])).values()];
}

function severityRank(severity: ContextHealthSeverityV1): number {
  return {critical: 0, high: 1, medium: 2, low: 3}[severity];
}

function categoryRank(category: ContextHealthFindingCategoryV1): number {
  const rank: Record<ContextHealthFindingCategoryV1, number> = {
    'validity-expired': 0,
    'citation-changed': 1,
    'citation-missing': 2,
    'relation-target-missing': 3,
    'relation-target-inactive': 4,
    'relation-target-conflicted': 5,
    'guidance-locally-modified': 6,
    'guidance-missing-block': 7,
    'guidance-unavailable': 8,
    'review-overdue': 9,
    'exact-duplicate': 10,
    'semantic-contradiction': 11,
    'candidate-contradiction': 12,
    'candidate-possible-duplicate': 13,
    'guidance-stale-sources': 14,
    'citation-unknown': 15,
  };
  return rank[category];
}

function compareRecords(left: MemoryRecord, right: MemoryRecord): number {
  return compareText(left.uri, right.uri);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function timestamp(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : undefined;
}
