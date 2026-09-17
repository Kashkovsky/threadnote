import {sha256HexSync} from '../crypto/sha256.js';
import type {
  ContextHealthConfidenceV1,
  ContextHealthFindingCategoryV1,
  ContextHealthRepairabilityV1,
  ContextHealthReportV1,
  ContextHealthSeverityV1,
} from '../memory/context_health.js';

export const CONTEXT_CHECK_REPORT_VERSION = 1 as const;
export const DEFAULT_CONTEXT_CHECK_FINDING_LIMIT = 100 as const;
export const MAXIMUM_CONTEXT_CHECK_FINDING_LIMIT = 500 as const;

export type ContextCheckExitClassificationV1 = 'actionable' | 'clean' | 'invalid-or-required-evidence-unavailable';
export type ContextCheckEvidenceStatusV1 = 'complete' | 'invalid' | 'unavailable';
export type ContextCheckEvidenceReasonV1 =
  | 'affected-memory-evidence-unavailable'
  | 'changed-path-evidence-unavailable'
  | 'graph-impact-evidence-incomplete'
  | 'graph-impact-evidence-unavailable'
  | 'health-report-truncated';
export type ContextCheckFindingCategoryV1 =
  | ContextHealthFindingCategoryV1
  | 'capture-advisory'
  | 'cited-document-changed'
  | 'cited-document-missing'
  | 'cited-document-unknown'
  | 'graph-impact';

export interface ContextCheckAvailableSelectionV1 {
  readonly affectedMemoryUris: readonly string[];
  readonly captureAdvisoryIds?: readonly string[];
  readonly changedPaths: readonly string[];
  readonly citedDocumentCitationUris?: readonly string[];
  readonly evidenceReason?: Extract<
    ContextCheckEvidenceReasonV1,
    'graph-impact-evidence-incomplete' | 'graph-impact-evidence-unavailable'
  >;
  readonly graphImpactedMemoryUris?: readonly string[];
  readonly status: 'available';
}

export interface ContextCheckUnavailableSelectionV1 {
  readonly reason: 'affected-memory-evidence-unavailable' | 'changed-path-evidence-unavailable';
  readonly status: 'unavailable';
}

export type ContextCheckSelectionV1 = ContextCheckAvailableSelectionV1 | ContextCheckUnavailableSelectionV1;

export interface ContextCheckReportInputV1 {
  readonly healthReport: ContextHealthReportV1;
  readonly limit?: number;
  readonly selection: ContextCheckSelectionV1;
}

export interface ContextCheckFindingV1 {
  readonly affectedMemoryCount: number;
  readonly category: ContextCheckFindingCategoryV1;
  readonly confidence: ContextHealthConfidenceV1;
  readonly fingerprint: string;
  readonly repairability: ContextHealthRepairabilityV1;
  readonly severity: ContextHealthSeverityV1;
}

export interface ContextCheckReportV1 {
  readonly evidenceReason?: ContextCheckEvidenceReasonV1;
  readonly evidenceStatus: ContextCheckEvidenceStatusV1;
  readonly exitClassification: ContextCheckExitClassificationV1;
  readonly exitCode: 0 | 1 | 2;
  readonly findings: readonly ContextCheckFindingV1[];
  readonly limit: number;
  readonly omittedFindings: number;
  readonly project: string;
  readonly version: typeof CONTEXT_CHECK_REPORT_VERSION;
}

export interface ContextCheckSarifV1 {
  readonly $schema: 'https://json.schemastore.org/sarif-2.1.0.json';
  readonly runs: readonly [
    {readonly results: readonly ContextCheckSarifResultV1[]; readonly tool: ContextCheckSarifToolV1},
  ];
  readonly version: '2.1.0';
}

export interface ContextCheckSarifResultV1 {
  readonly level: 'error' | 'note' | 'warning';
  readonly message: {readonly text: string};
  readonly partialFingerprints: Readonly<Record<'threadnote/context-check/v1', string>>;
  readonly ruleId: string;
}

export interface ContextCheckSarifToolV1 {
  readonly driver: {
    readonly name: 'Threadnote Context Check';
    readonly rules: readonly {
      readonly id: string;
      readonly name: string;
      readonly shortDescription: {readonly text: string};
    }[];
    readonly version: '1.0.0';
  };
}

/** Filters a supplied health report; it intentionally does not inspect git, storage, or memory bodies. */
export function buildContextCheckReport(input: ContextCheckReportInputV1): ContextCheckReportV1 {
  const limit = findingLimit(input.limit);
  const invalid = inputProblems(input);
  if (invalid) return report(input.healthReport.project, limit, 'invalid', undefined, [], 0);
  if (input.selection.status === 'unavailable') {
    return report(input.healthReport.project, limit, 'unavailable', input.selection.reason, [], 0);
  }

  const selectedUris = new Set(input.selection.affectedMemoryUris);
  const citedDocumentCitationUris = new Set(input.selection.citedDocumentCitationUris ?? []);
  const findings = uniqueFindings(
    [
      ...input.healthReport.findings
        .map(finding => projectFinding(finding, selectedUris, citedDocumentCitationUris))
        .filter((finding): finding is ContextCheckFindingV1 => finding !== undefined),
      ...graphImpactFindings(input.selection.graphImpactedMemoryUris ?? []),
      ...captureAdvisoryFindings(input.selection.captureAdvisoryIds ?? []),
    ].sort(compareFindings),
  );
  const evidenceStatus: ContextCheckEvidenceStatusV1 =
    input.selection.evidenceReason !== undefined || input.healthReport.omittedFindings > 0 ? 'unavailable' : 'complete';
  return report(
    input.healthReport.project,
    limit,
    evidenceStatus,
    input.selection.evidenceReason ?? (input.healthReport.omittedFindings > 0 ? 'health-report-truncated' : undefined),
    findings.slice(0, limit),
    Math.max(0, findings.length - limit),
    findings,
  );
}

export function serializeContextCheckReportJson(report: ContextCheckReportV1): string {
  return JSON.stringify(report);
}

export function parseContextCheckReportJson(value: string): ContextCheckReportV1 {
  const parsed: unknown = JSON.parse(value);
  if (!isContextCheckReport(parsed)) throw new Error('Invalid ContextCheckReportV1 JSON.');
  return parsed;
}

export function projectContextCheckReportSarif(report: ContextCheckReportV1): ContextCheckSarifV1 {
  const results = [
    ...report.findings.map(sarifFinding),
    ...(report.exitCode === 2 &&
    (report.evidenceStatus !== 'complete' ||
      !report.findings.some(finding => finding.repairability === 'requires-evidence'))
      ? [sarifEvidence(report)]
      : []),
  ];
  const rules = [...new Map(results.map(result => [result.ruleId, sarifRule(result.ruleId)])).values()];
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    runs: [{results, tool: {driver: {name: 'Threadnote Context Check', rules, version: '1.0.0'}}}],
    version: '2.1.0',
  };
}

function projectFinding(
  finding: ContextHealthReportV1['findings'][number],
  selectedUris: ReadonlySet<string>,
  citedDocumentCitationUris: ReadonlySet<string>,
): ContextCheckFindingV1 | undefined {
  const activeConflict = isActiveConflict(finding.category);
  const affectedUris = [...new Set(finding.uris.filter(uri => activeConflict || selectedUris.has(uri)))].sort(
    compareText,
  );
  if (!activeConflict && affectedUris.length === 0) return undefined;
  const category = citedDocumentCategory(finding, citedDocumentCitationUris) ?? finding.category;
  return {
    affectedMemoryCount: affectedUris.length,
    category,
    confidence: finding.confidence,
    fingerprint: fingerprint(
      category,
      finding.id,
      finding.confidence,
      finding.repairability,
      finding.severity,
      affectedUris,
    ),
    repairability: finding.repairability,
    severity: finding.severity,
  };
}

function graphImpactFindings(uris: readonly string[]): readonly ContextCheckFindingV1[] {
  return [...new Set(uris)].sort(compareText).map(uri => ({
    affectedMemoryCount: 1,
    category: 'graph-impact',
    confidence: 'high',
    fingerprint: fingerprint('graph-impact', uri, 'high', 'manual-review', 'medium', [uri]),
    repairability: 'manual-review',
    severity: 'medium',
  }));
}

function captureAdvisoryFindings(ids: readonly string[]): readonly ContextCheckFindingV1[] {
  return [...new Set(ids)].sort(compareText).map(id => ({
    affectedMemoryCount: 0,
    category: 'capture-advisory',
    confidence: 'high',
    fingerprint: fingerprint('capture-advisory', id, 'high', 'manual-review', 'low', []),
    repairability: 'manual-review',
    severity: 'low',
  }));
}

function report(
  project: string,
  limit: number,
  evidenceStatus: ContextCheckEvidenceStatusV1,
  evidenceReason: ContextCheckReportV1['evidenceReason'],
  findings: readonly ContextCheckFindingV1[],
  omittedFindings: number,
  classificationFindings: readonly ContextCheckFindingV1[] = findings,
): ContextCheckReportV1 {
  const requiresEvidence = classificationFindings.some(finding => finding.repairability === 'requires-evidence');
  const exitClassification: ContextCheckExitClassificationV1 =
    evidenceStatus !== 'complete' || requiresEvidence
      ? 'invalid-or-required-evidence-unavailable'
      : classificationFindings.length === 0
        ? 'clean'
        : 'actionable';
  return {
    ...(evidenceReason === undefined ? {} : {evidenceReason}),
    evidenceStatus,
    exitClassification,
    exitCode: exitClassification === 'clean' ? 0 : exitClassification === 'actionable' ? 1 : 2,
    findings,
    limit,
    omittedFindings,
    project,
    version: CONTEXT_CHECK_REPORT_VERSION,
  };
}

function fingerprint(
  category: ContextCheckFindingCategoryV1,
  identity: string,
  confidence: ContextHealthConfidenceV1,
  repairability: ContextHealthRepairabilityV1,
  severity: ContextHealthSeverityV1,
  affectedUris: readonly string[],
): string {
  return sha256HexSync(
    [
      'threadnote-context-check-finding-v1',
      category,
      identity,
      confidence,
      repairability,
      severity,
      ...affectedUris,
    ].join('\u0000'),
  );
}

function isActiveConflict(category: ContextHealthFindingCategoryV1): boolean {
  return category === 'candidate-contradiction' || category === 'relation-target-conflicted';
}

function citedDocumentCategory(
  finding: ContextHealthReportV1['findings'][number],
  citedDocumentCitationUris: ReadonlySet<string>,
): ContextCheckFindingCategoryV1 | undefined {
  if (finding.repair.targetUri === undefined || !citedDocumentCitationUris.has(finding.repair.targetUri)) {
    return undefined;
  }
  if (finding.category === 'citation-changed') return 'cited-document-changed';
  if (finding.category === 'citation-missing') return 'cited-document-missing';
  if (finding.category === 'citation-unknown') return 'cited-document-unknown';
  return undefined;
}

function inputProblems(input: ContextCheckReportInputV1): boolean {
  if (input.healthReport.version !== 1 || input.healthReport.project.length === 0) return true;
  if (input.selection.status === 'unavailable') return false;
  return (
    input.selection.affectedMemoryUris.some(uri => uri.length === 0) ||
    input.selection.changedPaths.some(path => !safeRepositoryPath(path))
  );
}

function safeRepositoryPath(path: string): boolean {
  return path.length > 0 && !path.startsWith('/') && !path.split('/').includes('..');
}

function findingLimit(input: number | undefined): number {
  if (input === undefined || !Number.isFinite(input)) return DEFAULT_CONTEXT_CHECK_FINDING_LIMIT;
  return Math.max(0, Math.min(MAXIMUM_CONTEXT_CHECK_FINDING_LIMIT, Math.floor(input)));
}

function uniqueFindings(findings: readonly ContextCheckFindingV1[]): readonly ContextCheckFindingV1[] {
  return [...new Map(findings.map(finding => [finding.fingerprint, finding])).values()];
}

function compareFindings(left: ContextCheckFindingV1, right: ContextCheckFindingV1): number {
  const severity = severityRank(left.severity) - severityRank(right.severity);
  if (severity !== 0) return severity;
  const category = compareText(left.category, right.category);
  return category !== 0 ? category : compareText(left.fingerprint, right.fingerprint);
}

function severityRank(severity: ContextHealthSeverityV1): number {
  return {critical: 0, high: 1, medium: 2, low: 3}[severity];
}

function sarifFinding(finding: ContextCheckFindingV1): ContextCheckSarifResultV1 {
  const ruleId = `threadnote/context-check/${finding.category}`;
  return {
    level:
      finding.severity === 'critical' || finding.severity === 'high'
        ? 'error'
        : finding.severity === 'medium'
          ? 'warning'
          : 'note',
    message: {text: `Context health finding: ${finding.category}.`},
    partialFingerprints: {'threadnote/context-check/v1': finding.fingerprint},
    ruleId,
  };
}

function sarifEvidence(report: ContextCheckReportV1): ContextCheckSarifResultV1 {
  const name = report.evidenceStatus === 'invalid' ? 'invalid-input' : 'evidence-unavailable';
  return {
    level: 'error',
    message: {
      text: name === 'invalid-input' ? 'Context check input is invalid.' : 'Context check evidence is unavailable.',
    },
    partialFingerprints: {'threadnote/context-check/v1': sha256HexSync(`threadnote-context-check-${name}-v1`)},
    ruleId: `threadnote/context-check/${name}`,
  };
}

function sarifRule(id: string): {
  readonly id: string;
  readonly name: string;
  readonly shortDescription: {readonly text: string};
} {
  return {
    id,
    name: id.slice('threadnote/context-check/'.length),
    shortDescription: {text: 'Threadnote context-check result.'},
  };
}

function isContextCheckReport(value: unknown): value is ContextCheckReportV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'evidenceReason',
      'evidenceStatus',
      'exitClassification',
      'exitCode',
      'findings',
      'limit',
      'omittedFindings',
      'project',
      'version',
    ]) ||
    value.version !== 1 ||
    typeof value.project !== 'string' ||
    value.project.length === 0 ||
    value.project.length > 256
  )
    return false;
  if (
    value.evidenceStatus !== 'complete' &&
    value.evidenceStatus !== 'invalid' &&
    value.evidenceStatus !== 'unavailable'
  )
    return false;
  if (
    value.exitClassification !== 'clean' &&
    value.exitClassification !== 'actionable' &&
    value.exitClassification !== 'invalid-or-required-evidence-unavailable'
  )
    return false;
  if (value.exitCode !== 0 && value.exitCode !== 1 && value.exitCode !== 2) return false;
  if (
    !boundedInteger(value.limit, MAXIMUM_CONTEXT_CHECK_FINDING_LIMIT) ||
    !boundedInteger(value.omittedFindings, Number.MAX_SAFE_INTEGER) ||
    !Array.isArray(value.findings) ||
    value.findings.length > value.limit ||
    !validEvidenceReason(value.evidenceReason)
  )
    return false;
  if (!value.findings.every(isFinding)) return false;
  const requiresEvidence = value.findings.some(finding => finding.repairability === 'requires-evidence');
  const expectedExit =
    value.evidenceStatus !== 'complete' || requiresEvidence
      ? 'invalid-or-required-evidence-unavailable'
      : value.findings.length === 0 && value.omittedFindings === 0
        ? 'clean'
        : 'actionable';
  if (value.exitClassification !== expectedExit) return false;
  if (value.exitCode !== (expectedExit === 'clean' ? 0 : expectedExit === 'actionable' ? 1 : 2)) return false;
  if (value.evidenceStatus === 'complete' && value.evidenceReason !== undefined) return false;
  if (value.evidenceStatus === 'unavailable' && value.evidenceReason === undefined) return false;
  return true;
}

function isFinding(value: unknown): value is ContextCheckFindingV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'affectedMemoryCount',
      'category',
      'confidence',
      'fingerprint',
      'repairability',
      'severity',
    ]) &&
    boundedInteger(value.affectedMemoryCount, MAXIMUM_CONTEXT_CHECK_FINDING_LIMIT) &&
    CONTEXT_HEALTH_CATEGORIES.has(value.category) &&
    CONTEXT_HEALTH_CONFIDENCES.has(value.confidence) &&
    typeof value.fingerprint === 'string' &&
    /^[a-f0-9]{64}$/u.test(value.fingerprint) &&
    CONTEXT_HEALTH_REPAIRABILITIES.has(value.repairability) &&
    CONTEXT_HEALTH_SEVERITIES.has(value.severity)
  );
}

const CONTEXT_HEALTH_CATEGORIES = new Set<unknown>([
  'candidate-contradiction',
  'candidate-possible-duplicate',
  'citation-changed',
  'citation-missing',
  'citation-unknown',
  'capture-advisory',
  'cited-document-changed',
  'cited-document-missing',
  'cited-document-unknown',
  'exact-duplicate',
  'graph-impact',
  'guidance-locally-modified',
  'guidance-missing-block',
  'guidance-stale-sources',
  'guidance-unavailable',
  'relation-target-conflicted',
  'relation-target-inactive',
  'relation-target-missing',
  'review-overdue',
  'validity-expired',
]);
const CONTEXT_HEALTH_CONFIDENCES = new Set<unknown>(['high', 'low', 'medium']);
const CONTEXT_HEALTH_REPAIRABILITIES = new Set<unknown>(['manual-review', 'requires-evidence', 'reviewable']);
const CONTEXT_HEALTH_SEVERITIES = new Set<unknown>(['critical', 'high', 'low', 'medium']);

function validEvidenceReason(value: unknown): boolean {
  return (
    value === undefined ||
    value === 'health-report-truncated' ||
    value === 'affected-memory-evidence-unavailable' ||
    value === 'changed-path-evidence-unavailable' ||
    value === 'graph-impact-evidence-incomplete' ||
    value === 'graph-impact-evidence-unavailable'
  );
}

function boundedInteger(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum;
}

function hasExactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every(key => allowedKeys.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
