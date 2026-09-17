import {sha256HexSync} from '../crypto/sha256.js';
import {
  assertMemoryDocumentSchemaWritable,
  canonicalMemoryDocumentContent,
  isSharedMemoryUri,
  parseMemoryDocument,
  type MemoryRecord,
  type MemoryRelation,
} from './document.js';
import type {
  ContextHealthFindingCategoryV1,
  ContextHealthFindingV1,
  ContextHealthRepairDescriptorV1,
  ContextHealthReportV1,
} from './context_health.js';

export const CONTEXT_HEALTH_REPAIR_VERSION = 1 as const;
export const DEFAULT_CONTEXT_HEALTH_REPAIR_PROPOSAL_LIMIT = 100 as const;
export const MAXIMUM_CONTEXT_HEALTH_REPAIR_PROPOSAL_LIMIT = 500 as const;

const MAXIMUM_CONTEXT_HEALTH_REPAIR_SUMMARY_CHARACTERS = 2_000;

export interface ContextHealthRepairRecordPreconditionV1 {
  readonly expectedContentHash: string;
  readonly expectedProject: string;
  readonly uri: string;
}

export type ContextHealthRepairMutationV1 =
  | {
      readonly kind: 'archive-memory';
      readonly subjectUri: string;
      readonly survivorUri?: string;
    }
  | {
      readonly expectedResultContentHash: string;
      readonly kind: 'remove-relations';
      readonly subjectUri: string;
      readonly targetUri: string;
    }
  | {
      readonly kind: 'review-only';
      readonly reason: string;
      readonly repairKind: ContextHealthRepairDescriptorV1['kind'];
      readonly subjectUri?: string;
      readonly targetUri?: string;
    };

export interface ContextHealthRepairProposalV1 {
  readonly category: ContextHealthFindingCategoryV1;
  readonly findingId: string;
  readonly mutation: ContextHealthRepairMutationV1;
  readonly preconditions: readonly ContextHealthRepairRecordPreconditionV1[];
  readonly project: string;
  readonly proposalId: string;
  /** Exact revision of the proposal, including every record-content precondition. */
  readonly revision: string;
  readonly summary: string;
  readonly version: typeof CONTEXT_HEALTH_REPAIR_VERSION;
}

export interface ContextHealthRepairPlanV1 {
  readonly omittedProposals: number;
  readonly project: string;
  readonly proposals: readonly ContextHealthRepairProposalV1[];
  /** Exact revision of the source health report, independent of finding order. */
  readonly reportRevision: string;
  readonly sourceOmittedFindings: number;
  readonly version: typeof CONTEXT_HEALTH_REPAIR_VERSION;
}

export interface ContextHealthRepairApplyReceiptV1 {
  readonly proposalId: string;
  readonly resultHash: string;
  readonly revision: string;
  readonly version: typeof CONTEXT_HEALTH_REPAIR_VERSION;
}

export type ContextHealthRepairConflictCodeV1 =
  | 'invalid-proposal'
  | 'precondition-failed'
  | 'project-mismatch'
  | 'receipt-mismatch'
  | 'revision-mismatch'
  | 'shared-mutation-blocked'
  | 'subject-missing';

export interface ContextHealthRepairConflictV1 {
  readonly code: ContextHealthRepairConflictCodeV1;
  /** Stable for the same proposal, expected revision, code, and observed record hashes. */
  readonly conflictId: string;
  readonly message: string;
}

export type ContextHealthRepairApplyResultV1 =
  | {
      readonly records: readonly MemoryRecord[];
      readonly receipt: ContextHealthRepairApplyReceiptV1;
      readonly status: 'applied' | 'already-applied';
    }
  | {
      readonly conflict: ContextHealthRepairConflictV1;
      readonly records: readonly MemoryRecord[];
      readonly status: 'conflict';
    }
  | {
      readonly records: readonly MemoryRecord[];
      readonly status: 'review-required';
    };

export interface ApplyContextHealthRepairProposalInputV1 {
  readonly expectedRevision: string;
  readonly proposal: ContextHealthRepairProposalV1;
  /** A receipt returned by an earlier successful application of this exact revision. */
  readonly receipt?: ContextHealthRepairApplyReceiptV1;
  /** The caller's current bounded memory snapshot. Unrelated projects remain untouched. */
  readonly records: readonly MemoryRecord[];
}

/**
 * Pure, provider-neutral preview. It derives proposals only from supplied health
 * evidence and record snapshots and never writes or mutates either input.
 */
export function previewContextHealthRepairPlanV1(
  report: ContextHealthReportV1,
  records: readonly MemoryRecord[],
  options: {readonly limit?: number} = {},
): ContextHealthRepairPlanV1 {
  const recordsByUri = recordsForProjectByUri(records, report.project);
  const proposals = [...report.findings]
    .sort((left, right) => compareText(left.id, right.id))
    .map(finding => proposalForFinding(report.project, finding, recordsByUri))
    .sort((left, right) => compareText(left.proposalId, right.proposalId));
  const limit = proposalLimit(options.limit);
  return {
    omittedProposals: Math.max(0, proposals.length - limit),
    project: report.project,
    proposals: proposals.slice(0, limit),
    reportRevision: contextHealthReportRevisionV1(report),
    sourceOmittedFindings: report.omittedFindings,
    version: CONTEXT_HEALTH_REPAIR_VERSION,
  };
}

/**
 * Applies one proposal to an immutable record snapshot. Storage adapters use the
 * returned records/receipt as the exact postcondition for their own atomic CAS.
 */
export function applyContextHealthRepairProposalV1(
  input: ApplyContextHealthRepairProposalInputV1,
): ContextHealthRepairApplyResultV1 {
  const {proposal, records} = input;
  const canonicalRevision = contextHealthRepairProposalRevisionV1(proposal);
  if (canonicalRevision !== proposal.revision || contextHealthRepairProposalIdV1(proposal) !== proposal.proposalId) {
    return conflict(input, 'invalid-proposal', 'The repair proposal identity or revision is invalid.');
  }
  if (input.expectedRevision !== proposal.revision) {
    return conflict(
      input,
      'revision-mismatch',
      `Repair proposal revision changed: expected ${input.expectedRevision}, current ${proposal.revision}.`,
    );
  }
  if (proposal.mutation.kind === 'review-only') {
    return {records, status: 'review-required'};
  }
  if (input.receipt !== undefined) {
    if (
      input.receipt.version !== CONTEXT_HEALTH_REPAIR_VERSION ||
      input.receipt.proposalId !== proposal.proposalId ||
      input.receipt.revision !== proposal.revision ||
      input.receipt.resultHash !== expectedReceiptResultHash(proposal)
    ) {
      return conflict(input, 'receipt-mismatch', 'The apply receipt belongs to another repair proposal revision.');
    }
    return {records, receipt: input.receipt, status: 'already-applied'};
  }

  const mutation = proposal.mutation;
  const subjectUri = mutation.subjectUri;
  if (isSharedMemoryUri(subjectUri)) {
    return conflict(input, 'shared-mutation-blocked', 'Local health repair never mutates a shared memory.');
  }
  const subject = uniqueRecord(records, subjectUri);
  if (subject?.metadata.project !== undefined && subject.metadata.project !== proposal.project) {
    return conflict(input, 'project-mismatch', `Repair subject ${subjectUri} belongs to another project.`);
  }
  if (mutation.kind === 'remove-relations' && subject !== undefined) {
    const resultContent = relationRepairContent(subject, mutation.targetUri);
    if (
      subject.metadata.relations?.some(relation => relation.uri === mutation.targetUri) !== true &&
      memoryContentHash(subject.content) === mutation.expectedResultContentHash &&
      resultContent !== undefined
    ) {
      return {
        records,
        receipt: applyReceipt(proposal, mutation.expectedResultContentHash),
        status: 'already-applied',
      };
    }
  }
  if (subject === undefined) {
    return conflict(input, 'subject-missing', `Repair subject ${subjectUri} is missing from the current snapshot.`);
  }

  const observed = observedPreconditionHashes(records, proposal.preconditions);
  if (observed.some(item => item.project !== null && item.project !== item.expectedProject)) {
    return conflict(input, 'project-mismatch', 'A repair precondition resolved outside the proposal project.');
  }
  if (observed.some(item => item.contentHash !== item.expectedContentHash)) {
    return conflict(input, 'precondition-failed', 'Memory content changed after the repair proposal was previewed.');
  }

  if (mutation.kind === 'archive-memory') {
    const nextRecords = records.filter(record => record.uri !== mutation.subjectUri);
    return {
      records: nextRecords,
      receipt: applyReceipt(proposal, memoryContentHash(subject.content)),
      status: 'applied',
    };
  }

  const nextContent = relationRepairContent(subject, mutation.targetUri);
  if (nextContent === undefined) {
    return conflict(input, 'invalid-proposal', 'The relation repair cannot safely rewrite this memory schema.');
  }
  if (memoryContentHash(nextContent) !== mutation.expectedResultContentHash) {
    return conflict(input, 'precondition-failed', 'The relation repair postcondition no longer matches its preview.');
  }
  const nextRecord = parseMemoryDocument(subject.uri, nextContent);
  if (nextRecord === undefined || nextRecord.metadata.project !== proposal.project) {
    return conflict(input, 'invalid-proposal', 'The relation repair would produce an invalid project memory.');
  }
  return {
    records: records.map(record => (record === subject ? nextRecord : record)),
    receipt: applyReceipt(proposal, mutation.expectedResultContentHash),
    status: 'applied',
  };
}

export function contextHealthReportRevisionV1(report: ContextHealthReportV1): string {
  return sha256HexSync(
    JSON.stringify({
      findings: [...report.findings]
        .sort((left, right) => compareText(left.id, right.id))
        .map(finding => ({
          category: finding.category,
          confidence: finding.confidence,
          id: finding.id,
          repair: {
            kind: finding.repair.kind,
            subjectUri: finding.repair.subjectUri ?? null,
            summary: finding.repair.summary,
            targetUri: finding.repair.targetUri ?? null,
          },
          repairability: finding.repairability,
          severity: finding.severity,
          summary: finding.summary,
          uris: [...finding.uris].sort(compareText),
        })),
      limit: report.limit,
      omittedFindings: report.omittedFindings,
      project: report.project,
      recordsScanned: report.recordsScanned,
      version: report.version,
    }),
  );
}

export function contextHealthRepairProposalRevisionV1(
  proposal: Omit<ContextHealthRepairProposalV1, 'revision'> | ContextHealthRepairProposalV1,
): string {
  return sha256HexSync(JSON.stringify(proposalRevisionPayload(proposal)));
}

function proposalForFinding(
  project: string,
  finding: ContextHealthFindingV1,
  recordsByUri: ReadonlyMap<string, MemoryRecord | undefined>,
): ContextHealthRepairProposalV1 {
  const mutation = mutationForFinding(project, finding, recordsByUri);
  const preconditions = mutationPreconditions(project, mutation, recordsByUri);
  const base = {
    category: finding.category,
    findingId: finding.id,
    mutation,
    preconditions,
    project,
    proposalId: '',
    summary: boundedSummary(finding.repair.summary),
    version: CONTEXT_HEALTH_REPAIR_VERSION,
  } satisfies Omit<ContextHealthRepairProposalV1, 'revision'>;
  const withIdentity = {...base, proposalId: contextHealthRepairProposalIdV1(base)};
  return {...withIdentity, revision: contextHealthRepairProposalRevisionV1(withIdentity)};
}

function mutationForFinding(
  project: string,
  finding: ContextHealthFindingV1,
  recordsByUri: ReadonlyMap<string, MemoryRecord | undefined>,
): ContextHealthRepairMutationV1 {
  const subjectUri = finding.repair.subjectUri;
  const targetUri = finding.repair.targetUri;
  const subject = subjectUri === undefined ? undefined : recordsByUri.get(subjectUri);
  if (subjectUri !== undefined && isSharedMemoryUri(subjectUri)) {
    return {
      kind: 'review-only',
      reason: 'Shared memories require a separate reviewed Git proposal and are never mutated by local health repair.',
      repairKind: finding.repair.kind,
      subjectUri,
      ...(targetUri === undefined ? {} : {targetUri}),
    };
  }
  if (
    subject !== undefined &&
    (finding.repair.kind === 'archive-memory' || finding.repair.kind === 'deduplicate-memory') &&
    !isArchiveRepairableKind(subject.metadata.kind)
  ) {
    return {
      kind: 'review-only',
      reason: `Automatic health repair cannot archive ${subject.metadata.kind} memories.`,
      repairKind: finding.repair.kind,
      subjectUri: subject.uri,
      ...(targetUri === undefined ? {} : {targetUri}),
    };
  }
  if (
    finding.repairability === 'reviewable' &&
    finding.repair.kind === 'archive-memory' &&
    subjectUri !== undefined &&
    subject?.metadata.project === project &&
    subject.metadata.status === 'active'
  ) {
    return {kind: 'archive-memory', subjectUri};
  }
  if (
    finding.repairability === 'reviewable' &&
    finding.repair.kind === 'deduplicate-memory' &&
    subjectUri !== undefined &&
    targetUri !== undefined &&
    subject?.metadata.project === project &&
    subject.metadata.status === 'active' &&
    recordsByUri.get(targetUri)?.metadata.project === project &&
    recordsByUri.get(targetUri)?.metadata.status === 'active'
  ) {
    return {kind: 'archive-memory', subjectUri, survivorUri: targetUri};
  }
  if (
    finding.repairability === 'reviewable' &&
    finding.repair.kind === 'repair-relation' &&
    (finding.category === 'relation-target-inactive' || finding.category === 'relation-target-missing') &&
    subjectUri !== undefined &&
    targetUri !== undefined &&
    subject?.metadata.project === project &&
    subject.metadata.status === 'active' &&
    subject.metadata.relations?.some(relation => relation.uri === targetUri) === true
  ) {
    const resultContent = relationRepairContent(subject, targetUri);
    if (resultContent === undefined) {
      return {
        kind: 'review-only',
        reason: 'The memory schema cannot be safely rewritten by automatic health repair.',
        repairKind: finding.repair.kind,
        subjectUri,
        targetUri,
      };
    }
    return {
      expectedResultContentHash: memoryContentHash(resultContent),
      kind: 'remove-relations',
      subjectUri,
      targetUri,
    };
  }
  return {
    kind: 'review-only',
    reason:
      finding.repairability === 'reviewable'
        ? 'The supplied project snapshot does not contain enough exact evidence for an automatic mutation.'
        : `The finding is ${finding.repairability.replace('-', ' ')}.`,
    repairKind: finding.repair.kind,
    ...(subjectUri === undefined ? {} : {subjectUri}),
    ...(targetUri === undefined ? {} : {targetUri}),
  };
}

function mutationPreconditions(
  project: string,
  mutation: ContextHealthRepairMutationV1,
  recordsByUri: ReadonlyMap<string, MemoryRecord | undefined>,
): readonly ContextHealthRepairRecordPreconditionV1[] {
  if (mutation.kind === 'review-only') return [];
  const uris =
    mutation.kind === 'archive-memory' && mutation.survivorUri !== undefined
      ? [mutation.subjectUri, mutation.survivorUri]
      : [mutation.subjectUri];
  return uris
    .flatMap(uri => {
      const record = recordsByUri.get(uri);
      return record === undefined
        ? []
        : [{expectedContentHash: memoryContentHash(record.content), expectedProject: project, uri}];
    })
    .sort((left, right) => compareText(left.uri, right.uri));
}

function recordsForProjectByUri(
  records: readonly MemoryRecord[],
  project: string,
): ReadonlyMap<string, MemoryRecord | undefined> {
  const grouped = new Map<string, MemoryRecord[]>();
  for (const record of records) {
    if (record.metadata.project !== project) continue;
    grouped.set(record.uri, [...(grouped.get(record.uri) ?? []), record]);
  }
  return new Map([...grouped].map(([uri, matches]) => [uri, matches.length === 1 ? matches[0] : undefined]));
}

function memoryContentWithoutTargetRelations(record: MemoryRecord, targetUri: string): string {
  const relations = (record.metadata.relations ?? []).filter(relation => relation.uri !== targetUri);
  if (relations.length === (record.metadata.relations ?? []).length)
    return canonicalMemoryDocumentContent(record.content);
  return memoryContentWithRelations(record.content, relations);
}

function relationRepairContent(record: MemoryRecord, targetUri: string): string | undefined {
  try {
    return memoryContentWithoutTargetRelations(record, targetUri);
  } catch {
    return undefined;
  }
}

function memoryContentWithRelations(content: string, relations: readonly MemoryRelation[]): string {
  assertMemoryDocumentSchemaWritable(content);
  const canonical = canonicalMemoryDocumentContent(content).replace(/\r\n?/gu, '\n');
  const separatorIndex = canonical.indexOf('\n\n');
  const header = separatorIndex === -1 ? canonical : canonical.slice(0, separatorIndex);
  const body = separatorIndex === -1 ? '' : canonical.slice(separatorIndex + 2);
  const headerLines = header.split('\n').filter(line => !/^relation\s*:/u.test(line));
  const relationLines = [...relations]
    .sort((left, right) => compareText(`${left.type}\0${left.uri}`, `${right.type}\0${right.uri}`))
    .map(relation => `relation: ${relation.type} ${relation.uri}`);
  return [...headerLines, ...relationLines, '', body].join('\n').trim();
}

function contextHealthRepairProposalIdV1(
  proposal: Omit<ContextHealthRepairProposalV1, 'revision'> | ContextHealthRepairProposalV1,
): string {
  const mutation = proposal.mutation;
  return `health-repair-${sha256HexSync(
    JSON.stringify({
      category: proposal.category,
      findingId: proposal.findingId,
      mutation:
        mutation.kind === 'review-only'
          ? {
              kind: mutation.kind,
              repairKind: mutation.repairKind,
              subjectUri: mutation.subjectUri ?? null,
              targetUri: mutation.targetUri ?? null,
            }
          : mutation.kind === 'archive-memory'
            ? {
                kind: mutation.kind,
                subjectUri: mutation.subjectUri,
                survivorUri: mutation.survivorUri ?? null,
              }
            : {kind: mutation.kind, subjectUri: mutation.subjectUri, targetUri: mutation.targetUri},
      project: proposal.project,
      version: proposal.version,
    }),
  ).slice(0, 40)}`;
}

function proposalRevisionPayload(
  proposal: Omit<ContextHealthRepairProposalV1, 'revision'> | ContextHealthRepairProposalV1,
) {
  return {
    category: proposal.category,
    findingId: proposal.findingId,
    mutation: canonicalMutation(proposal.mutation),
    preconditions: [...proposal.preconditions]
      .sort((left, right) => compareText(left.uri, right.uri))
      .map(precondition => ({
        expectedContentHash: precondition.expectedContentHash,
        expectedProject: precondition.expectedProject,
        uri: precondition.uri,
      })),
    project: proposal.project,
    proposalId: proposal.proposalId,
    summary: proposal.summary,
    version: proposal.version,
  };
}

function canonicalMutation(mutation: ContextHealthRepairMutationV1) {
  if (mutation.kind === 'archive-memory') {
    return {
      kind: mutation.kind,
      subjectUri: mutation.subjectUri,
      survivorUri: mutation.survivorUri ?? null,
    };
  }
  if (mutation.kind === 'remove-relations') {
    return {
      expectedResultContentHash: mutation.expectedResultContentHash,
      kind: mutation.kind,
      subjectUri: mutation.subjectUri,
      targetUri: mutation.targetUri,
    };
  }
  return {
    kind: mutation.kind,
    reason: mutation.reason,
    repairKind: mutation.repairKind,
    subjectUri: mutation.subjectUri ?? null,
    targetUri: mutation.targetUri ?? null,
  };
}

function applyReceipt(proposal: ContextHealthRepairProposalV1, resultHash: string): ContextHealthRepairApplyReceiptV1 {
  return {
    proposalId: proposal.proposalId,
    resultHash,
    revision: proposal.revision,
    version: CONTEXT_HEALTH_REPAIR_VERSION,
  };
}

function expectedReceiptResultHash(proposal: ContextHealthRepairProposalV1): string {
  if (proposal.mutation.kind === 'remove-relations') return proposal.mutation.expectedResultContentHash;
  if (proposal.mutation.kind === 'archive-memory') {
    return (
      proposal.preconditions.find(precondition => precondition.uri === proposal.mutation.subjectUri)
        ?.expectedContentHash ?? ''
    );
  }
  return '';
}

function conflict(
  input: ApplyContextHealthRepairProposalInputV1,
  code: ContextHealthRepairConflictCodeV1,
  message: string,
): ContextHealthRepairApplyResultV1 {
  const observed = observedPreconditionHashes(input.records, input.proposal.preconditions);
  return {
    conflict: {
      code,
      conflictId: `health-repair-conflict-${sha256HexSync(
        JSON.stringify({
          code,
          expectedRevision: input.expectedRevision,
          observed,
          proposalId: input.proposal.proposalId,
          revision: input.proposal.revision,
          version: CONTEXT_HEALTH_REPAIR_VERSION,
        }),
      ).slice(0, 40)}`,
      message,
    },
    records: input.records,
    status: 'conflict',
  };
}

function observedPreconditionHashes(
  records: readonly MemoryRecord[],
  preconditions: readonly ContextHealthRepairRecordPreconditionV1[],
) {
  return [...preconditions]
    .sort((left, right) => compareText(left.uri, right.uri))
    .map(precondition => {
      const record = uniqueRecord(records, precondition.uri);
      return {
        contentHash: record === undefined ? null : memoryContentHash(record.content),
        expectedContentHash: precondition.expectedContentHash,
        expectedProject: precondition.expectedProject,
        project: record?.metadata.project ?? null,
        uri: precondition.uri,
      };
    });
}

function uniqueRecord(records: readonly MemoryRecord[], uri: string): MemoryRecord | undefined {
  const matches = records.filter(record => record.uri === uri);
  return matches.length === 1 ? matches[0] : undefined;
}

function memoryContentHash(content: string): string {
  return sha256HexSync(canonicalMemoryDocumentContent(content));
}

function proposalLimit(input: number | undefined): number {
  if (input === undefined || !Number.isFinite(input)) return DEFAULT_CONTEXT_HEALTH_REPAIR_PROPOSAL_LIMIT;
  return Math.max(0, Math.min(MAXIMUM_CONTEXT_HEALTH_REPAIR_PROPOSAL_LIMIT, Math.floor(input)));
}

function boundedSummary(value: string): string {
  return value.length <= MAXIMUM_CONTEXT_HEALTH_REPAIR_SUMMARY_CHARACTERS
    ? value
    : value.slice(0, MAXIMUM_CONTEXT_HEALTH_REPAIR_SUMMARY_CHARACTERS);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isArchiveRepairableKind(kind: MemoryRecord['metadata']['kind']): boolean {
  return kind === 'durable' || kind === 'handoff' || kind === 'incident';
}
