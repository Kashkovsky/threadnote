import {canonicalJson} from '../code_graph/checkpoint/canonical_json.js';
import {sha256HexSync} from '../crypto/sha256.js';
import {
  buildKnowledgeDeltaGitProposalV1,
  type KnowledgeDeltaGitProposalInputV1,
} from '../git_proposal/knowledge_delta.js';
import {parseCandidateReview, type CandidateReview, type MemoryCandidate} from '../memory/candidate.js';
import {
  buildContextHealthReport,
  type ContextHealthReportInputV1,
  type ContextHealthReportV1,
} from '../memory/context_health.js';
import {
  applyContextHealthRepairProposalV1,
  contextHealthRepairProposalRevisionV1,
  contextHealthReportRevisionV1,
  previewContextHealthRepairPlanV1,
} from '../memory/context_health_repair.js';
import {projectKnowledgeDeltaV1} from '../memory/knowledge_delta.js';
import {
  parseProcedureManifest,
  parseProcedureVerificationReceipt,
  procedureStatus,
  type ProcedureStatusInput,
} from '../procedure/contract.js';
import {aggregateValueReportV1, type ValueReportInputV1, type ValueReportV1} from '../value_report/index.js';
import {
  parseThreadnote5TrustedSourceV1,
  type Threadnote5MeasurementV1,
  type Threadnote5ObservationV1,
  type Threadnote5ReleaseScenario,
  type Threadnote5SourceV1,
} from './threadnote-5-release-readiness-contract.js';
import {
  parseThreadnote5LocalAuthorityManifestV1,
  threadnote5ApplyAuditDigest,
  threadnote5ApprovedSourceUriHash,
  threadnote5LocalAuthorityManifestHash,
  threadnote5ProcedureVerificationReceiptDigest,
  type Threadnote5LocalAuthorityEntryV1,
} from './threadnote-5-release-readiness-authority.js';

export const THREADNOTE_5_LOCAL_SUBSYSTEM_RECEIPT_VERSION = 1 as const;

const MAX_RECORDS = 64;
const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_RECORD_SET_BYTES = 8 * 1024 * 1024;
const MAX_ATTEMPTS = 64;
const SOURCE_KINDS = ['closeout', 'context-health', 'git-proposal', 'procedure', 'value-report'] as const;

export type Threadnote5LocalSourceKindV1 = (typeof SOURCE_KINDS)[number];

/**
 * Private, short-lived source material used to derive content-free release evidence.
 * The digest binds the artifact to one scenario and one exact candidate runtime.
 */
export interface Threadnote5LocalSubsystemReceiptRecordV1 {
  readonly artifact: unknown;
  readonly candidate: Threadnote5SourceV1;
  readonly digest: string;
  readonly kind: Threadnote5LocalSourceKindV1;
  readonly scenario: Threadnote5ReleaseScenario;
  readonly version: typeof THREADNOTE_5_LOCAL_SUBSYSTEM_RECEIPT_VERSION;
}

export interface Threadnote5ScenarioReceiptVerificationV1 {
  readonly missingKinds: readonly string[];
  readonly scenario: Threadnote5ReleaseScenario;
  readonly state: 'unknown' | 'verified';
  readonly verifiedKinds: readonly string[];
}

export type Threadnote5LocalReceiptVerificationV1 =
  | {
      readonly reason: 'records-invalid' | 'records-unavailable' | 'records-mismatched' | 'verifier-incomplete';
      readonly scenarios: readonly Threadnote5ScenarioReceiptVerificationV1[];
      readonly state: 'unknown';
    }
  | {
      readonly authorityManifestHash: string | null;
      readonly receiptCount: number;
      readonly recordsHash: string;
      readonly scenarios: readonly Threadnote5ScenarioReceiptVerificationV1[];
      readonly state: 'verified';
    };

interface DerivedClaims {
  readonly assertions: readonly string[];
  readonly measurements: readonly Threadnote5MeasurementV1[];
  readonly missingKinds?: readonly string[];
}

export function threadnote5LocalSubsystemReceiptDigest(
  record: Omit<Threadnote5LocalSubsystemReceiptRecordV1, 'digest'>,
): string {
  return sha256HexSync(`threadnote-5-local-subsystem-receipt-v1\0${canonicalJson(record)}`);
}

/** Content-free, portable output for persistence or stdout. Input paths and private artifacts are intentionally absent. */
export function threadnote5LocalReceiptVerificationArtifact(verification: Threadnote5LocalReceiptVerificationV1): {
  readonly verification: Threadnote5LocalReceiptVerificationV1;
  readonly verificationHash: string;
  readonly version: 1;
} {
  return {
    verification,
    verificationHash: sha256HexSync(`threadnote-5-local-receipt-verification-v1\0${canonicalJson(verification)}`),
    version: 1,
  };
}

/** Parses private local artifacts, replays shipped pure APIs, and returns content-free verification only. */
export function verifyThreadnote5LocalSubsystemReceipts(input: {
  readonly authorityManifest?: unknown;
  readonly candidate: Threadnote5SourceV1;
  readonly expectedAuthorityManifestSha256?: string;
  readonly observations: readonly Threadnote5ObservationV1[];
  readonly retainedRecords: unknown;
}): Threadnote5LocalReceiptVerificationV1 {
  let candidate: Threadnote5SourceV1;
  try {
    candidate = parseThreadnote5TrustedSourceV1(input.candidate, 'candidate');
  } catch {
    return unknownFor(input.observations, 'records-invalid');
  }
  if (!Array.isArray(input.retainedRecords)) return unknownFor(input.observations, 'records-unavailable');
  let recordSetBytes: number;
  try {
    recordSetBytes = encodedBytes(input.retainedRecords);
  } catch {
    return unknownFor(input.observations, 'records-invalid');
  }
  if (input.retainedRecords.length > MAX_RECORDS || recordSetBytes > MAX_RECORD_SET_BYTES) {
    return unknownFor(input.observations, 'records-invalid');
  }

  let records: readonly Threadnote5LocalSubsystemReceiptRecordV1[];
  try {
    records = input.retainedRecords.map(parseRecord);
  } catch {
    return unknownFor(input.observations, 'records-invalid');
  }
  if (
    !unique(records.map(record => record.digest)) ||
    !unique(records.map(record => `${record.scenario}\0${record.kind}`)) ||
    records.some(record => !sameSource(record.candidate, candidate))
  ) {
    return unknownFor(input.observations, 'records-mismatched');
  }

  const expected = new Map<
    string,
    {readonly kind: Threadnote5LocalSourceKindV1; readonly scenario: Threadnote5ReleaseScenario}
  >();
  for (const observation of input.observations) {
    for (const receipt of observation.attestation.subsystemReceipts) {
      if (isSourceKind(receipt.kind))
        expected.set(receipt.digest, {kind: receipt.kind, scenario: observation.scenario});
    }
  }
  if (
    records.length !== expected.size ||
    records.some(record => {
      const reference = expected.get(record.digest);
      return reference?.kind !== record.kind || reference.scenario !== record.scenario;
    })
  ) {
    return unknownFor(input.observations, 'records-mismatched');
  }

  const derivedByDigest = new Map<string, DerivedClaims>();
  let authorityManifestHash: string | null;
  try {
    const authority = resolveAuthority(
      records,
      candidate,
      input.authorityManifest,
      input.expectedAuthorityManifestSha256,
    );
    authorityManifestHash = authority.manifestHash;
    for (const record of records) {
      if (record.digest !== threadnote5LocalSubsystemReceiptDigest(withoutDigest(record))) {
        return unknownFor(input.observations, 'records-mismatched');
      }
      derivedByDigest.set(record.digest, deriveClaims(record, authority.byRecordDigest.get(record.digest)));
    }
  } catch {
    return unknownFor(input.observations, 'records-invalid');
  }

  let claimsMismatch = false;
  const scenarios = input.observations.map(observation => {
    const result = verifyObservation(observation, derivedByDigest);
    claimsMismatch ||= result.claimsMismatch;
    return result.verification;
  });
  if (claimsMismatch) return {reason: 'records-mismatched', scenarios, state: 'unknown'};
  if (scenarios.some(scenario => scenario.state !== 'verified')) {
    return {reason: 'verifier-incomplete', scenarios, state: 'unknown'};
  }
  const recordsHash = sha256HexSync(
    `threadnote-5-local-subsystem-records-v1\0${canonicalJson({
      authorityManifestHash,
      records: records.map(contentFreeRecord).sort((left, right) => left.digest.localeCompare(right.digest)),
    })}`,
  );
  return {authorityManifestHash, receiptCount: records.length, recordsHash, scenarios, state: 'verified'};
}

function verifyObservation(
  observation: Threadnote5ObservationV1,
  derivedByDigest: ReadonlyMap<string, DerivedClaims>,
): {readonly claimsMismatch: boolean; readonly verification: Threadnote5ScenarioReceiptVerificationV1} {
  const verifiedKinds: string[] = [];
  const missingKinds: string[] = [];
  const assertions = new Set<string>();
  const measurements: Threadnote5MeasurementV1[] = [];
  for (const receipt of observation.attestation.subsystemReceipts) {
    if (!isSourceKind(receipt.kind)) {
      missingKinds.push(receipt.kind);
      continue;
    }
    const derived = derivedByDigest.get(receipt.digest);
    if (derived === undefined) {
      missingKinds.push(receipt.kind);
      continue;
    }
    verifiedKinds.push(receipt.kind);
    for (const assertion of derived.assertions) assertions.add(assertion);
    measurements.push(...derived.measurements);
    missingKinds.push(...(derived.missingKinds ?? []));
  }
  if (!unique(measurements.map(measurement => measurement.id))) {
    return {
      claimsMismatch: true,
      verification: scenarioVerification(observation.scenario, verifiedKinds, ['duplicate-derived-metric']),
    };
  }
  const incomplete = missingKinds.length > 0;
  const expectedAssertions = observation.transcript.assertionResults
    .filter(result => result.observed)
    .map(result => result.id);
  const claimsMismatch =
    !incomplete &&
    (observation.transcript.outcome !== 'passed' ||
      canonicalJson([...assertions]) !== canonicalJson(expectedAssertions) ||
      canonicalJson(measurements) !== canonicalJson(observation.transcript.measurements));
  return {
    claimsMismatch,
    verification: scenarioVerification(
      observation.scenario,
      verifiedKinds,
      claimsMismatch ? ['derived-claims-mismatch'] : missingKinds,
    ),
  };
}

function scenarioVerification(
  scenario: Threadnote5ReleaseScenario,
  verifiedKinds: readonly string[],
  missingKinds: readonly string[],
): Threadnote5ScenarioReceiptVerificationV1 {
  const missing = [...new Set(missingKinds)].sort();
  return {
    missingKinds: missing,
    scenario,
    state: missing.length === 0 ? 'verified' : 'unknown',
    verifiedKinds: [...new Set(verifiedKinds)].sort(),
  };
}

function deriveClaims(
  record: Threadnote5LocalSubsystemReceiptRecordV1,
  authority: Threadnote5LocalAuthorityEntryV1 | undefined,
): DerivedClaims {
  switch (record.kind) {
    case 'closeout':
      return deriveCloseout(record.scenario, record.artifact, record.candidate);
    case 'git-proposal':
      return deriveProposal(record.artifact, record.candidate, authority);
    case 'procedure':
      return deriveProcedure(record.artifact, record.candidate, authority);
    case 'value-report':
      return deriveValueReport(record.artifact);
    case 'context-health':
      return deriveHealth(record.scenario, record.artifact);
  }
}

function deriveCloseout(
  scenario: Threadnote5ReleaseScenario,
  value: unknown,
  candidate: Threadnote5SourceV1,
): DerivedClaims {
  const source = exactObject(value, ['reviews'], 'closeout artifact');
  const reviews = boundedArray(source.reviews, 'closeout reviews', 1, MAX_ATTEMPTS).map(review =>
    strictCandidateReview(review, candidate),
  );
  if (!unique(reviews.map(review => review.reviewId))) throw new Error('Closeout trials must be unique.');
  const completed = reviews.filter(review =>
    review.candidates.some(candidate => candidateIsApplied(candidate, review)),
  ).length;
  if (scenario === 'structured-closeout') {
    return {
      assertions: [
        'decisions-rationale-present',
        'constraints-present',
        'verification-present',
        'invalidations-present',
        'unresolved-risks-present',
      ],
      measurements: [{eligibleCount: reviews.length, id: 'knowledge-delta-completion-rate', positiveCount: completed}],
    };
  }
  if (scenario === 'output-budgets') {
    return {assertions: ['knowledge-delta-items-at-most-three'], measurements: [], missingKinds: ['context-brief']};
  }
  return {
    assertions: [],
    measurements:
      scenario === 'interrupted-resumed'
        ? [{eligibleCount: reviews.length, id: 'knowledge-delta-completion-rate', positiveCount: completed}]
        : [],
    missingKinds: ['activation'],
  };
}

function deriveProposal(
  value: unknown,
  candidate: Threadnote5SourceV1,
  authority: Threadnote5LocalAuthorityEntryV1 | undefined,
): DerivedClaims {
  const source = exactObject(value, ['attempts'], 'Git proposal artifact');
  const attempts = boundedArray(source.attempts, 'Git proposal attempts', 1, MAX_ATTEMPTS);
  const authorityTrials: Array<
    Extract<Threadnote5LocalAuthorityEntryV1, {readonly type: 'git-proposal-review'}>['trials'][number]
  > = [];
  for (const attemptValue of attempts) {
    const attempt = exactObject(attemptValue, ['artifact', 'input', 'proposal', 'review'], 'Git proposal attempt');
    if (typeof attempt.artifact !== 'string') throw new Error('Git proposal artifact must be text.');
    const review = strictCandidateReview(attempt.review, candidate);
    const input = exactObject(attempt.input, ['baseCommit', 'mutations', 'project', 'target'], 'Git proposal input');
    const mutations = boundedArray(
      input.mutations,
      'Git proposal mutations',
      1,
      3,
    ) as KnowledgeDeltaGitProposalInputV1['mutations'];
    for (const mutation of mutations) assertMutationApproval(review, mutation);
    const rebuilt = buildKnowledgeDeltaGitProposalV1({
      baseCommit: input.baseCommit as string,
      delta: projectKnowledgeDeltaV1(review),
      mutations,
      project: input.project as string,
      target: input.target as KnowledgeDeltaGitProposalInputV1['target'],
    });
    if (attempt.artifact !== rebuilt.artifact || canonicalJson(attempt.proposal) !== canonicalJson(rebuilt.proposal)) {
      throw new Error('Git proposal does not reconstruct from its reviewed source evidence.');
    }
    const approvals = mutations
      .map(mutation => {
        const applyEvent = review.auditEvents.find(
          event => event.action === 'apply' && event.candidateId === mutation.candidateId,
        );
        if (applyEvent === undefined) throw new Error('Git proposal approval has no apply audit event.');
        return {
          applyAuditDigest: threadnote5ApplyAuditDigest(applyEvent),
          approvedContentHash: mutation.approval.expectedSourceContentHash,
          candidateId: mutation.candidateId,
          sourceUriHash: threadnote5ApprovedSourceUriHash(mutation.sourceUri),
        };
      })
      .sort((left, right) => left.candidateId.localeCompare(right.candidateId));
    authorityTrials.push({
      approvals,
      proposalHash: rebuilt.proposal.proposalHash,
      providerApiCallCount: 0,
      reviewId: review.reviewId,
      revision: review.revision,
    });
  }
  if (!unique(authorityTrials.map(trial => trial.proposalHash))) throw new Error('Git proposal trials must be unique.');
  if (authority === undefined) {
    return {
      assertions: ['proposal-provider-neutral'],
      measurements: [],
      missingKinds: ['git-proposal-review-authority', 'provider-call-audit'],
    };
  }
  if (
    authority.type !== 'git-proposal-review' ||
    canonicalJson(authority.trials) !==
      canonicalJson([...authorityTrials].sort((left, right) => left.proposalHash.localeCompare(right.proposalHash))) ||
    authority.trials.some(trial => trial.providerApiCallCount !== 0)
  ) {
    throw new Error('Git proposal authority does not match independently reviewed apply/provider evidence.');
  }
  return {
    assertions: ['provider-apis-zero', 'proposal-provider-neutral', 'proposal-review-approved'],
    measurements: [
      {eligibleCount: attempts.length, id: 'knowledge-delta-completion-rate', positiveCount: attempts.length},
    ],
  };
}

function deriveProcedure(
  value: unknown,
  candidate: Threadnote5SourceV1,
  authority: Threadnote5LocalAuthorityEntryV1 | undefined,
): DerivedClaims {
  const source = exactObject(value, ['attempts'], 'procedure artifact');
  const attempts = boundedArray(source.attempts, 'procedure attempts', 1, 1);
  let expectedAuthority:
    | Omit<
        Extract<Threadnote5LocalAuthorityEntryV1, {readonly type: 'procedure-verification'}>,
        'recordDigest' | 'type'
      >
    | undefined;
  for (const attemptValue of attempts) {
    const attempt = exactObject(attemptValue, ['artifactText', 'manifest', 'statusInput'], 'procedure attempt');
    if (typeof attempt.artifactText !== 'string') throw new Error('Procedure artifact text is required.');
    const manifest = parseProcedureManifest(attempt.manifest);
    const statusInput = attempt.statusInput as ProcedureStatusInput;
    const receipt = parseProcedureVerificationReceipt(object(statusInput, 'procedure status input').receipt);
    if (
      sha256HexSync(attempt.artifactText) !== manifest.artifact.sha256 ||
      manifest.dependencies.length !== 0 ||
      receipt.threadnoteVersion !== candidate.version ||
      procedureStatus(manifest, {...statusInput, localArtifactSha256: sha256HexSync(attempt.artifactText)}) !==
        'current'
    ) {
      throw new Error('Procedure evidence is not current and dependency-compatible for this candidate.');
    }
    expectedAuthority = {
      artifactId: manifest.artifact.id,
      automaticExecutionCount: 0,
      commandResults: manifest.verification.commands.map(command => ({
        commandId: command.id,
        exitCode: 0,
        outputDigest: '',
      })),
      receiptDigest: threadnote5ProcedureVerificationReceiptDigest(receipt),
      semanticVersion: manifest.artifact.semanticVersion,
    };
  }
  if (authority === undefined) {
    return {
      assertions: ['procedure-dependencies-compatible'],
      measurements: [],
      missingKinds: ['procedure-execution-authority'],
    };
  }
  if (authority.type !== 'procedure-verification' || expectedAuthority === undefined) {
    throw new Error('Procedure authority type does not match its source record.');
  }
  if (
    authority.artifactId !== expectedAuthority.artifactId ||
    authority.semanticVersion !== expectedAuthority.semanticVersion ||
    authority.receiptDigest !== expectedAuthority.receiptDigest ||
    authority.automaticExecutionCount !== 0 ||
    canonicalJson(
      authority.commandResults.map(result => ({commandId: result.commandId, exitCode: result.exitCode})),
    ) !== canonicalJson(expectedAuthority.commandResults.map(result => ({commandId: result.commandId, exitCode: 0}))) ||
    authority.commandResults.some(result => result.exitCode !== 0)
  ) {
    throw new Error('Procedure authority does not prove explicit successful verification without auto-execution.');
  }
  return {
    assertions: ['procedure-receipt-current', 'procedure-dependencies-compatible', 'procedure-never-auto-executed'],
    measurements: [],
  };
}

function deriveValueReport(value: unknown): DerivedClaims {
  const source = exactObject(value, ['captures'], 'value-report artifact');
  const reports = boundedArray(source.captures, 'value-report captures', 1, MAX_ATTEMPTS).map(parseValueReportCapture);
  if (!unique(reports.map(report => `${report.period.from}\0${report.period.to}`))) {
    throw new Error('Value-report capture periods must be unique.');
  }
  const eligibleWrong = reports.reduce((sum, report) => sum + report.feedback.total, 0);
  const wrong = reports.reduce((sum, report) => sum + report.feedback.wrong, 0);
  const eligibleReuse = reports.reduce((sum, report) => sum + report.setup.started, 0);
  const reuse = reports.reduce((sum, report) => sum + report.setup.supportedAgentReuse, 0);
  if (reports.some(report => report.setup.supportedAgentReuse > report.setup.started)) {
    throw new Error('Value report reuse cannot exceed setup attempts.');
  }
  return {
    assertions: [
      ...(eligibleReuse > 0 ? ['two-surfaces-connected'] : []),
      ...(reuse > 0 ? ['second-surface-reused-decision'] : []),
    ],
    measurements: [
      {eligibleCount: eligibleWrong, id: 'wrong-memory-rate', positiveCount: wrong},
      {eligibleCount: eligibleReuse, id: 'second-agent-reuse-rate', positiveCount: reuse},
    ],
    missingKinds: ['activation', 'recall', 'activation-value-linkage'],
  };
}

function parseValueReportCapture(value: unknown): ValueReportV1 {
  const capture = exactObject(value, ['input', 'report'], 'value-report capture');
  const rebuilt = aggregateValueReportV1(capture.input as ValueReportInputV1);
  if (canonicalJson(rebuilt) !== canonicalJson(capture.report)) {
    throw new Error('Value report does not match its source events and counts.');
  }
  return rebuilt;
}

function deriveHealth(scenario: Threadnote5ReleaseScenario, value: unknown): DerivedClaims {
  const source = exactObject(value, ['repairs', 'reports'], 'context-health artifact');
  const reports = boundedArray(source.reports, 'context-health reports', 0, MAX_ATTEMPTS).map(parseHealthReportCapture);
  const repairs = boundedArray(source.repairs, 'context-health repairs', 0, MAX_ATTEMPTS).map(parseHealthRepairCapture);
  if (!unique(reports.map(contextHealthReportRevisionV1))) throw new Error('Context-health reports must be unique.');
  if (!unique(repairs.map(repair => repair.proposalId)))
    throw new Error('Context-health repair trials must be unique.');
  if (scenario === 'stale-citation') {
    const categories = new Set(reports.flatMap(report => report.findings.map(finding => finding.category)));
    return {
      assertions: [
        ...(categories.has('citation-changed') ? ['changed-never-current'] : []),
        ...(categories.has('citation-missing') ? ['missing-never-current'] : []),
        ...(categories.has('citation-unknown') ? ['unknown-remains-distinct'] : []),
      ],
      measurements: [],
    };
  }
  if (scenario === 'contradiction-triage') {
    const findings = reports.flatMap(report => report.findings);
    const categories = new Set(findings.map(finding => finding.category));
    return {
      assertions: [
        ...(categories.has('candidate-contradiction') ? ['contradiction-category-observed'] : []),
        ...(categories.has('candidate-possible-duplicate') ? ['possible-duplicate-category-observed'] : []),
        ...(findings.some(finding => finding.repairability === 'manual-review') ? ['manual-review-required'] : []),
        'ordering-stable',
      ],
      measurements: [],
    };
  }
  if (scenario === 'health-maintenance') {
    const resolved = repairs.filter(repair => repair.resolved).length;
    return {
      assertions: [
        ...(repairs.length > 0 ? ['health-issue-detected'] : []),
        ...(resolved === repairs.length && repairs.length > 0 ? ['health-resolution-recorded'] : []),
      ],
      measurements: [{eligibleCount: repairs.length, id: 'health-resolution-rate', positiveCount: resolved}],
      missingKinds: ['context-health-schedule', 'context-health-team-aggregate'],
    };
  }
  throw new Error(`Context-health evidence is unsupported for ${scenario}.`);
}

function parseHealthReportCapture(value: unknown): ContextHealthReportV1 {
  const capture = exactObject(value, ['input', 'report'], 'context-health report capture');
  const input = healthInput(capture.input);
  const rebuilt = buildContextHealthReport(input);
  if (canonicalJson(rebuilt) !== canonicalJson(capture.report)) {
    throw new Error('Context-health report does not match its source inputs.');
  }
  contextHealthReportRevisionV1(rebuilt);
  return rebuilt;
}

function parseHealthRepairCapture(value: unknown): {readonly proposalId: string; readonly resolved: boolean} {
  const capture = exactObject(
    value,
    ['input', 'plan', 'proposal', 'receipt', 'report'],
    'context-health repair capture',
  );
  const input = healthInput(capture.input);
  const report = buildContextHealthReport(input);
  if (canonicalJson(report) !== canonicalJson(capture.report)) {
    throw new Error('Context-health repair report does not match its source inputs.');
  }
  const plan = previewContextHealthRepairPlanV1(report, input.records);
  if (canonicalJson(plan) !== canonicalJson(capture.plan)) throw new Error('Context-health repair plan changed.');
  const proposal = plan.proposals.find(
    item => item.proposalId === object(capture.proposal, 'context-health proposal').proposalId,
  );
  if (proposal === undefined || contextHealthRepairProposalRevisionV1(proposal) !== proposal.revision) {
    throw new Error('Context-health repair proposal is not part of the current plan.');
  }
  if (canonicalJson(proposal) !== canonicalJson(capture.proposal)) {
    throw new Error('Context-health repair proposal differs from the current plan.');
  }
  const applied = applyContextHealthRepairProposalV1({
    expectedRevision: proposal.revision,
    proposal,
    records: input.records,
  });
  if (applied.status !== 'applied' || canonicalJson(applied.receipt) !== canonicalJson(capture.receipt)) {
    throw new Error('Context-health repair receipt cannot be reproduced.');
  }
  const postReport = buildContextHealthReport({...input, records: applied.records});
  return {
    proposalId: proposal.proposalId,
    resolved: !postReport.findings.some(finding => finding.id === proposal.findingId),
  };
}

function healthInput(value: unknown): ContextHealthReportInputV1 {
  const source = object(value, 'context-health input');
  const now = source.now instanceof Date ? source.now : new Date(String(source.now));
  if (!Number.isFinite(now.getTime()) || !Array.isArray(source.records) || typeof source.project !== 'string') {
    throw new Error('Context-health input is invalid.');
  }
  return {...(source as unknown as ContextHealthReportInputV1), now};
}

function strictCandidateReview(value: unknown, candidate: Threadnote5SourceV1): CandidateReview {
  const source = object(value, 'candidate review');
  if (
    !allowedKeys(source, [
      'auditEvents',
      'candidates',
      'codeCitations',
      'createdAt',
      'outcome',
      'project',
      'reviewId',
      'revision',
      'sourceAgentClient',
      'sourceCommit',
      'sourceSessionId',
      'structuredCloseout',
      'task',
      'topic',
      'version',
    ]) ||
    source.version !== 2 ||
    typeof source.reviewId !== 'string' ||
    !/^review-[0-9a-f]{16}$/u.test(source.reviewId) ||
    !integerIn(source.revision, 1, 10_000) ||
    !isoInstant(source.createdAt) ||
    !nonEmptyText(source.outcome, 4_000) ||
    !nonEmptyText(source.project, 256) ||
    !nonEmptyText(source.sourceAgentClient, 256) ||
    source.sourceCommit !== candidate.commit ||
    !nonEmptyText(source.task, 4_000) ||
    !nonEmptyText(source.topic, 256) ||
    !Array.isArray(source.candidates) ||
    source.candidates.length < 1 ||
    source.candidates.length > 3 ||
    !Array.isArray(source.auditEvents) ||
    source.auditEvents.length < 1 ||
    source.auditEvents.length > 100 ||
    !Array.isArray(source.codeCitations)
  ) {
    throw new Error('Candidate review is not a bounded v2 review.');
  }
  strictStructuredCloseout(source.structuredCloseout);
  const review = parseCandidateReview(value);
  if (review.auditEvents.length !== source.auditEvents.length)
    throw new Error('Candidate review contains invalid audit events.');
  const ids = review.candidates.map(candidate => candidate.candidateId);
  if (!unique(ids) || !review.candidates.every(candidate => candidateIsReviewedDecision(candidate, review))) {
    throw new Error('Candidate review does not contain valid durable decision candidates.');
  }
  if (!review.auditEvents.every(event => strictAuditEvent(event, review, new Set(ids)))) {
    throw new Error('Candidate review audit history is malformed or crosses review identities.');
  }
  if (
    !review.auditEvents.some(
      event => event.action === 'create_review' && event.reviewId === review.reviewId && event.revision === 1,
    )
  ) {
    throw new Error('Candidate review has no source create-review audit event.');
  }
  const closeout = review.structuredCloseout;
  if (
    closeout === undefined ||
    closeout.rationale.trim().length === 0 ||
    closeout.constraints.length === 0 ||
    closeout.verificationPerformed.length === 0 ||
    closeout.knowledgeInvalidated.length === 0 ||
    closeout.unresolvedRisks.length === 0
  ) {
    throw new Error('Candidate review does not contain the exact five structured-closeout fields.');
  }
  return review;
}

function strictStructuredCloseout(value: unknown): void {
  const source = exactObject(
    value,
    ['constraints', 'knowledgeInvalidated', 'rationale', 'type', 'unresolvedRisks', 'verificationPerformed', 'version'],
    'structured closeout',
  );
  if (source.type !== 'structured-closeout' || source.version !== 1 || !nonEmptyText(source.rationale, 4_000)) {
    throw new Error('Structured closeout identity or rationale is invalid.');
  }
  for (const field of ['constraints', 'knowledgeInvalidated', 'unresolvedRisks', 'verificationPerformed'] as const) {
    const items = source[field];
    if (
      !Array.isArray(items) ||
      items.length < 1 ||
      items.length > 32 ||
      !items.every(item => nonEmptyText(item, 2_000) && item.trim() === item)
    ) {
      throw new Error(`Structured closeout ${field} must contain bounded non-empty items.`);
    }
  }
}

function candidateIsReviewedDecision(candidate: MemoryCandidate, review: CandidateReview): boolean {
  const source = candidate as unknown as Record<string, unknown>;
  return (
    allowedKeys(source, [
      'applyApprovedAt',
      'applyBodyText',
      'applyContentHash',
      'applyOperation',
      'applyReplaceUri',
      'applyStage',
      'applyTargetUri',
      'candidateId',
      'categories',
      'comparison',
      'confidence',
      'evidence',
      'kind',
      'project',
      'proposedText',
      'reason',
      'recommendation',
      'state',
      'targetContentHash',
      'targetUri',
      'topic',
    ]) &&
    new RegExp(`^${review.reviewId}-[1-3]$`, 'u').test(candidate.candidateId) &&
    candidate.kind === 'durable' &&
    ['contradiction', 'duplicate', 'new', 'possible_duplicate', 'replacement'].includes(candidate.comparison) &&
    ['create', 'manual_review', 'no_action', 'replace'].includes(candidate.recommendation) &&
    ['applied', 'applying', 'conflict', 'deferred', 'pending', 'rejected'].includes(candidate.state) &&
    candidate.project === review.project &&
    candidate.topic === review.topic &&
    candidate.proposedText.trim().length > 0 &&
    candidate.proposedText.length <= 66_000 &&
    candidate.reason.trim().length > 0 &&
    Number.isFinite(candidate.confidence) &&
    candidate.confidence >= 0 &&
    candidate.confidence <= 1 &&
    Array.isArray(candidate.evidence) &&
    candidate.evidence.length > 0 &&
    candidate.evidence.length <= 34 &&
    candidate.evidence.every(item => nonEmptyText(item, 4_000)) &&
    Array.isArray(candidate.categories) &&
    candidate.categories.length > 0 &&
    candidate.categories.length <= 4 &&
    unique(candidate.categories) &&
    candidate.categories.every(category => ['decision', 'handoff', 'invariant', 'preference'].includes(category)) &&
    candidate.categories.some(category => category === 'decision' || category === 'invariant') &&
    (candidate.applyApprovedAt === undefined || isoInstant(candidate.applyApprovedAt)) &&
    (candidate.applyBodyText === undefined || nonEmptyText(candidate.applyBodyText, 66_000)) &&
    (candidate.applyContentHash === undefined || hash(candidate.applyContentHash)) &&
    (candidate.applyOperation === undefined ||
      candidate.applyOperation === 'create' ||
      candidate.applyOperation === 'replace') &&
    (candidate.applyReplaceUri === undefined || nonEmptyText(candidate.applyReplaceUri, 4_000)) &&
    (candidate.applyStage === undefined ||
      ['cleanup_pending', 'conflict', 'prepared', 'written'].includes(candidate.applyStage)) &&
    (candidate.applyTargetUri === undefined || nonEmptyText(candidate.applyTargetUri, 4_000)) &&
    (candidate.targetContentHash === undefined || hash(candidate.targetContentHash)) &&
    (candidate.targetUri === undefined || nonEmptyText(candidate.targetUri, 4_000))
  );
}

function strictAuditEvent(
  event: CandidateReview['auditEvents'][number],
  review: CandidateReview,
  candidateIds: ReadonlySet<string>,
): boolean {
  const source = event as unknown as Record<string, unknown>;
  return (
    allowedKeys(source, ['action', 'at', 'candidateId', 'memoryUri', 'reviewId', 'revision']) &&
    event.reviewId === review.reviewId &&
    isoInstant(event.at) &&
    integerIn(event.revision, 1, review.revision) &&
    (event.candidateId === undefined || candidateIds.has(event.candidateId)) &&
    (event.memoryUri === undefined || nonEmptyText(event.memoryUri, 4_000)) &&
    (event.action === 'create_review'
      ? event.revision === 1 && event.candidateId === undefined
      : event.candidateId !== undefined)
  );
}

function candidateIsApplied(candidate: MemoryCandidate, review: CandidateReview): boolean {
  return (
    candidate.state === 'applied' &&
    hash(candidate.applyContentHash) &&
    nonEmptyText(candidate.applyBodyText, 66_000) &&
    nonEmptyText(candidate.applyTargetUri, 4_000) &&
    (candidate.applyOperation === 'create' || candidate.applyOperation === 'replace') &&
    review.auditEvents.some(
      event =>
        event.action === 'apply' &&
        event.candidateId === candidate.candidateId &&
        event.reviewId === review.reviewId &&
        event.revision <= review.revision,
    )
  );
}

function assertMutationApproval(
  review: CandidateReview,
  mutation: KnowledgeDeltaGitProposalInputV1['mutations'][number],
): void {
  const candidate = review.candidates.find(item => item.candidateId === mutation.candidateId);
  if (
    candidate === undefined ||
    !candidateIsApplied(candidate, review) ||
    mutation.approval.reviewId !== review.reviewId ||
    mutation.approval.revision !== review.revision ||
    mutation.approval.expectedSourceContentHash !== candidate.applyContentHash ||
    mutation.sourceUri !== candidate.applyTargetUri
  ) {
    throw new Error('Git proposal approval is not backed by the candidate apply/audit evidence.');
  }
}

function resolveAuthority(
  records: readonly Threadnote5LocalSubsystemReceiptRecordV1[],
  candidate: Threadnote5SourceV1,
  value: unknown,
  expectedHash: string | undefined,
): {
  readonly byRecordDigest: ReadonlyMap<string, Threadnote5LocalAuthorityEntryV1>;
  readonly manifestHash: string | null;
} {
  if (value === undefined && expectedHash === undefined) return {byRecordDigest: new Map(), manifestHash: null};
  if (value === undefined || expectedHash === undefined || !hash(expectedHash)) {
    throw new Error('Local authority manifest and its independently supplied hash are required together.');
  }
  const manifest = parseThreadnote5LocalAuthorityManifestV1(value);
  const manifestHash = threadnote5LocalAuthorityManifestHash(manifest);
  if (manifestHash !== expectedHash || !sameSource(manifest.candidate, candidate)) {
    throw new Error('Local authority manifest does not match its trusted hash or exact candidate.');
  }
  const authorityRecords = records.filter(record => record.kind === 'git-proposal' || record.kind === 'procedure');
  if (manifest.entries.length !== authorityRecords.length) {
    throw new Error('Local authority manifest must exactly cover authority-dependent source records.');
  }
  const byRecordDigest = new Map(manifest.entries.map(entry => [entry.recordDigest, entry] as const));
  for (const record of authorityRecords) {
    const entry = byRecordDigest.get(record.digest);
    if (
      entry === undefined ||
      (record.kind === 'git-proposal' && entry.type !== 'git-proposal-review') ||
      (record.kind === 'procedure' && entry.type !== 'procedure-verification')
    ) {
      throw new Error('Local authority entry is missing or mislabeled for its source record.');
    }
  }
  return {byRecordDigest, manifestHash};
}

function parseRecord(value: unknown): Threadnote5LocalSubsystemReceiptRecordV1 {
  if (encodedBytes(value) > MAX_RECORD_BYTES) throw new Error('Subsystem record exceeds the byte limit.');
  const record = exactObject(
    value,
    ['artifact', 'candidate', 'digest', 'kind', 'scenario', 'version'],
    'subsystem record',
  );
  if (record.version !== 1 || !hash(record.digest) || !isSourceKind(record.kind)) {
    throw new Error('Subsystem record identity is invalid.');
  }
  return {
    artifact: record.artifact,
    candidate: parseThreadnote5TrustedSourceV1(record.candidate, 'candidate'),
    digest: record.digest,
    kind: record.kind,
    scenario: releaseScenario(record.scenario),
    version: 1,
  };
}

function unknownFor(
  observations: readonly Threadnote5ObservationV1[],
  reason: Extract<Threadnote5LocalReceiptVerificationV1, {readonly state: 'unknown'}>['reason'],
): Extract<Threadnote5LocalReceiptVerificationV1, {readonly state: 'unknown'}> {
  return {
    reason,
    scenarios: observations.map(observation => ({
      missingKinds: observation.attestation.subsystemReceipts.map(receipt => receipt.kind),
      scenario: observation.scenario,
      state: 'unknown',
      verifiedKinds: [],
    })),
    state: 'unknown',
  };
}

function contentFreeRecord(record: Threadnote5LocalSubsystemReceiptRecordV1): {
  readonly candidateHash: string;
  readonly digest: string;
  readonly kind: Threadnote5LocalSourceKindV1;
  readonly scenario: Threadnote5ReleaseScenario;
  readonly version: 1;
} {
  return {
    candidateHash: sha256HexSync(canonicalJson(record.candidate)),
    digest: record.digest,
    kind: record.kind,
    scenario: record.scenario,
    version: 1,
  };
}

function exactObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  const source = object(value, label);
  if (canonicalJson(Object.keys(source).sort()) !== canonicalJson([...keys].sort())) {
    throw new Error(`${label} has unsupported or missing fields.`);
  }
  return source;
}

function allowedKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const set = new Set(allowed);
  return Object.keys(value).every(key => set.has(key));
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function boundedArray(value: unknown, label: string, minimum: number, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new Error(`${label} must contain ${minimum} to ${maximum} entries.`);
  }
  return value;
}

function withoutDigest(
  record: Threadnote5LocalSubsystemReceiptRecordV1,
): Omit<Threadnote5LocalSubsystemReceiptRecordV1, 'digest'> {
  const {digest: _, ...rest} = record;
  return rest;
}

function sameSource(left: Threadnote5SourceV1, right: Threadnote5SourceV1): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(canonicalJson(value)).byteLength;
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function hash(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function nonEmptyText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
}

function isoInstant(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function integerIn(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

function isSourceKind(value: unknown): value is Threadnote5LocalSourceKindV1 {
  return SOURCE_KINDS.includes(value as Threadnote5LocalSourceKindV1);
}

function releaseScenario(value: unknown): Threadnote5ReleaseScenario {
  const scenarios: readonly Threadnote5ReleaseScenario[] = [
    'solo',
    'two-agent',
    'git-shared',
    'offline',
    'dirty-worktree',
    'interrupted-resumed',
    'upgrade-downgrade',
    'provider-neutral-proposal',
    'verified-procedures',
    'health-maintenance',
    'structured-closeout',
    'stale-citation',
    'contradiction-triage',
    'projection-drift',
    'output-budgets',
  ];
  if (!scenarios.includes(value as Threadnote5ReleaseScenario))
    throw new Error('Subsystem record scenario is invalid.');
  return value as Threadnote5ReleaseScenario;
}
