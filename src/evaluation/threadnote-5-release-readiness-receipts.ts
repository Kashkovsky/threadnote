import {canonicalJson} from '../code_graph/checkpoint/canonical_json.js';
import {sha256HexSync} from '../crypto/sha256.js';
import {Effect} from 'effect';
import type {RuntimeConfig} from '../types.js';
import {
  activationReceiptRevisionV1,
  parseActivationPlanV1,
  parseActivationReceiptV1,
  type ActivationApprovalV1,
  type ActivationPlanV1,
  type ActivationReceiptV1,
} from '../activation/contract.js';
import {activationReceiptTransitionMatchesV1, createActivationReceiptV1} from '../activation/receipt.js';
import {previewActivationResumeV1} from '../activation/planner.js';
import {
  parseSecondSurfaceProofReceiptV1,
  secondSurfaceProofMatchesContextV1,
  type SecondSurfaceProofReceiptV1,
} from '../activation/second_surface.js';
import {activationValueEventsV1} from '../activation/value.js';
import {readActivationStateV1} from '../activation/store.js';
import {
  parseSecondSurfaceProofAttestationV1,
  parseSecondSurfaceProofChallengeV1,
  readSecondSurfaceProofChallengeV1,
  verifySecondSurfaceProofAttestationV1,
} from '../activation/second_surface_store.js';
import {readLocalValueEvents, summarizeLocalValueEvents, type LocalValueEventV1} from '../value_report/events.js';
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
import {parseContextBriefRequestV1} from '../context_brief/types.js';
import {parseContextBriefV1, renderContextBriefText} from '../context_brief/projector.js';
import {parseContextCheckReportJson} from '../context_check/index.js';
import {
  guidanceBlock,
  parseGuidanceReceiptV2,
  renderManagedGuidanceBlock,
  stripThreadnoteManagedGuidance,
  upsertGuidanceBlock,
} from '../guidance/index.js';
import {measureAgentToolResponse} from './agent-response.js';
import {
  parseThreadnote5LocalAuthorityManifestV1,
  threadnote5ActivationAttestationDigest,
  threadnote5ActivationOfflineObservationDigest,
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
const SOURCE_KINDS = [
  'activation',
  'closeout',
  'context-brief',
  'context-check',
  'context-health',
  'git-proposal',
  'guidance',
  'migration',
  'procedure',
  'recall',
  'sharing',
  'value-report',
] as const;

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

/** A narrow observer supplied by the offline harness around the production activation flow. */
export interface Threadnote5OfflineNetworkObserverV1 {
  readonly attemptedNetworkActivityCount: () => number;
}

/**
 * Captures only replayable activation evidence from the production stores. The receipt history
 * is supplied by the harness because the production store deliberately retains just its latest
 * receipt; the helper verifies the live final state, local value events, and (when present)
 * the private HMAC challenge before returning a serializable capture.
 */
export const captureThreadnote5ActivationTrialV1 = Effect.fn('releaseReadiness.captureActivationTrial')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  input: {
    readonly activationId: string;
    readonly approvals?: readonly ActivationApprovalV1[];
    readonly challengeId?: string;
    readonly receiptChain: readonly unknown[];
    readonly offlineObserver?: Threadnote5OfflineNetworkObserverV1;
    readonly resumeBoundaryRevision?: string;
  },
) {
  const beforeAttempts = input.offlineObserver?.attemptedNetworkActivityCount();
  const state = yield* readActivationStateV1(config, input.activationId);
  if (state === undefined) throw new Error('Activation capture requires retained production state.');
  const receiptChain = input.receiptChain.map(parseActivationReceiptV1);
  if (canonicalJson(receiptChain.at(-1)) !== canonicalJson(state.receipt)) {
    throw new Error('Activation capture chain does not end at the live production state.');
  }
  const approvals = input.approvals ?? [];
  verifyActivationReceiptChain(state.plan, receiptChain, approvals);
  const eventIds = new Set(activationValueEventsV1(state.receipt).map(event => event.eventId));
  const events = (yield* readLocalValueEvents(config.agentContextHome)).filter(
    (event): event is Extract<LocalValueEventV1, {readonly kind: 'activation'}> =>
      event.kind === 'activation' && eventIds.has(event.eventId),
  );
  const afterAttempts = input.offlineObserver?.attemptedNetworkActivityCount();
  if (beforeAttempts !== undefined && (beforeAttempts !== 0 || afterAttempts !== 0)) {
    throw new Error('Offline activation capture observed network activity.');
  }
  if (
    input.resumeBoundaryRevision !== undefined &&
    !resumeBoundaryIsVerified(receiptChain, input.resumeBoundaryRevision)
  ) {
    throw new Error('Activation capture resume boundary is not an intermediate retained receipt.');
  }
  const challenge =
    input.challengeId === undefined ? undefined : yield* readSecondSurfaceProofChallengeV1(config, input.challengeId);
  if (challenge !== undefined) {
    if (challenge.receipt === undefined) throw new Error('Second-surface capture requires a completed live challenge.');
    yield* verifySecondSurfaceProofAttestationV1(config, challenge, challenge.receipt);
  }
  const offlineObservation =
    beforeAttempts === undefined
      ? undefined
      : {
          afterAttemptCount: afterAttempts!,
          afterRevision: state.receipt.revision,
          beforeAttemptCount: beforeAttempts,
          beforeRevision: receiptChain[0].revision,
        };
  const trial = {
    approvals,
    events,
    ...(offlineObservation === undefined ? {} : {offlineObservation}),
    receiptChain,
    ...(input.resumeBoundaryRevision === undefined ? {} : {resumeBoundaryRevision: input.resumeBoundaryRevision}),
    state,
    ...(challenge === undefined ? {} : {secondSurface: {challenge}}),
  };
  return {
    authorityTrial: {
      activationId: state.plan.activationId,
      attestationDigest: challenge?.receipt === undefined ? null : threadnote5ActivationAttestationDigest(challenge),
      finalReceiptRevision: state.receipt.revision,
      offlineObservationDigest:
        offlineObservation === undefined ? null : threadnote5ActivationOfflineObservationDigest(offlineObservation),
      resumeBoundaryRevision: input.resumeBoundaryRevision ?? null,
    },
    trial,
  };
});

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
  readonly correlations?: Threadnote5DerivedCorrelationsV1;
  readonly measurements: readonly Threadnote5MeasurementV1[];
  readonly missingKinds?: readonly string[];
}

interface Threadnote5ActivationValueLinkV1 {
  readonly activationId: string;
  readonly finalReceiptRevision: string;
}

interface Threadnote5SecondSurfaceLinkV1 {
  readonly activationId: string;
  readonly activationReceiptRevision: string;
  readonly decisionCanonicalUri: string;
  readonly decisionContentHash: string;
  readonly decisionMemoryId: string;
  readonly proofHash: string;
  readonly publicationReceiptHash: string;
}

interface Threadnote5SharedDecisionLinkV1 {
  readonly activationId: string;
  readonly activationReceiptRevision: string;
  readonly decisionCanonicalUri: string;
  readonly decisionContentHash: string;
  readonly decisionMemoryId: string;
  readonly publicationReceiptHash: string;
}

interface Threadnote5DerivedCorrelationsV1 {
  readonly activationValues?: readonly Threadnote5ActivationValueLinkV1[];
  readonly secondSurfaceProofs?: readonly Threadnote5SecondSurfaceLinkV1[];
  readonly sharedDecisions?: readonly Threadnote5SharedDecisionLinkV1[];
}

type Threadnote5AuthorityRequirementV1 =
  | 'activation-live-verification-authority'
  | 'context-brief-plan-citation-authority'
  | 'context-check-read-fence-authority'
  | 'guidance-stale-precondition-rejection-authority'
  | 'migration-execution-authority'
  | 'git-proposal-review-authority'
  | 'procedure-execution-authority';

interface Threadnote5LocalReceiptAdapterV1 {
  readonly acceptedScenarios: readonly Threadnote5ReleaseScenario[];
  readonly kind: Threadnote5LocalSourceKindV1;
  readonly requiredAuthority: readonly Threadnote5AuthorityRequirementV1[];
  readonly authorityType?: (
    record: Threadnote5LocalSubsystemReceiptRecordV1,
  ) => Threadnote5LocalAuthorityEntryV1['type'] | undefined;
  readonly derive: (
    record: Threadnote5LocalSubsystemReceiptRecordV1,
    authority: Threadnote5LocalAuthorityEntryV1 | undefined,
  ) => DerivedClaims;
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
  const correlationsByKind = new Map<Threadnote5LocalSourceKindV1, Threadnote5DerivedCorrelationsV1>();
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
    if (derived.correlations !== undefined) correlationsByKind.set(receipt.kind, derived.correlations);
    measurements.push(...derived.measurements);
    missingKinds.push(...(derived.missingKinds ?? []));
  }
  const correlated = correlateScenarioClaims(observation.scenario, correlationsByKind);
  for (const assertion of correlated.assertions) assertions.add(assertion);
  missingKinds.push(...correlated.missingKinds);
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

function correlateScenarioClaims(
  scenario: Threadnote5ReleaseScenario,
  correlations: ReadonlyMap<Threadnote5LocalSourceKindV1, Threadnote5DerivedCorrelationsV1>,
): {readonly assertions: readonly string[]; readonly missingKinds: readonly string[]} {
  if (scenario === 'two-agent') {
    const activation = correlations.get('activation');
    const recall = correlations.get('recall');
    const value = correlations.get('value-report');
    if (
      !sameCorrelationSet(activation?.secondSurfaceProofs, recall?.secondSurfaceProofs) ||
      !sameCorrelationSet(activation?.activationValues, value?.activationValues)
    ) {
      return {assertions: [], missingKinds: ['cross-record-correlation']};
    }
    return {
      assertions: ['second-surface-reused-decision', 'activation-receipt-reused-by-value-report'],
      missingKinds: [],
    };
  }
  if (scenario === 'git-shared') {
    const sharing = correlations.get('sharing')?.sharedDecisions;
    const recall = correlations.get('recall')?.secondSurfaceProofs?.map(sharedDecisionLink);
    return sameCorrelationSet(sharing, recall)
      ? {assertions: ['git-shared-decision-retrieved'], missingKinds: []}
      : {assertions: [], missingKinds: ['cross-record-correlation']};
  }
  return {assertions: [], missingKinds: []};
}

function sameCorrelationSet<T>(left: readonly T[] | undefined, right: readonly T[] | undefined): boolean {
  if (left === undefined || right === undefined || left.length === 0 || left.length !== right.length) return false;
  const canonical = (values: readonly T[]) => values.map(value => canonicalJson(value)).sort(compareText);
  return canonicalJson(canonical(left)) === canonicalJson(canonical(right));
}

function sharedDecisionLink(proof: Threadnote5SecondSurfaceLinkV1): Threadnote5SharedDecisionLinkV1 {
  const {proofHash: _, ...link} = proof;
  return link;
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

const LOCAL_RECEIPT_ADAPTERS: readonly Threadnote5LocalReceiptAdapterV1[] = [
  {
    acceptedScenarios: ['solo', 'two-agent', 'offline', 'interrupted-resumed'],
    authorityType: record => (record.scenario === 'solo' ? undefined : 'activation-verification'),
    derive: (record, authority) => deriveActivation(record.scenario, record.artifact, authority),
    kind: 'activation',
    requiredAuthority: ['activation-live-verification-authority'],
  },
  {
    acceptedScenarios: ['structured-closeout', 'interrupted-resumed', 'output-budgets'],
    derive: record => deriveCloseout(record.scenario, record.artifact, record.candidate),
    kind: 'closeout',
    requiredAuthority: [],
  },
  {
    acceptedScenarios: ['solo', 'output-budgets'],
    derive: (record, authority) => deriveContextBrief(record.scenario, record.artifact, record.candidate, authority),
    kind: 'context-brief',
    requiredAuthority: ['context-brief-plan-citation-authority'],
    authorityType: record => (record.scenario === 'solo' ? 'context-brief-plan-citation' : undefined),
  },
  {
    acceptedScenarios: ['dirty-worktree'],
    derive: (record, authority) => deriveContextCheck(record.artifact, record.candidate, authority),
    kind: 'context-check',
    requiredAuthority: ['context-check-read-fence-authority'],
    authorityType: () => 'context-check-read-fence',
  },
  {
    acceptedScenarios: ['stale-citation', 'contradiction-triage', 'health-maintenance'],
    derive: record => deriveHealth(record.scenario, record.artifact),
    kind: 'context-health',
    requiredAuthority: [],
  },
  {
    acceptedScenarios: ['projection-drift'],
    derive: (record, authority) => deriveGuidance(record.artifact, record.candidate, authority),
    kind: 'guidance',
    requiredAuthority: ['guidance-stale-precondition-rejection-authority'],
    authorityType: record =>
      object(record.artifact, 'guidance capture').stalePrecondition === true
        ? 'guidance-stale-precondition-rejection'
        : undefined,
  },
  {
    acceptedScenarios: ['upgrade-downgrade'],
    derive: (record, authority) => deriveMigration(record.artifact, record.candidate, authority),
    kind: 'migration',
    requiredAuthority: ['migration-execution-authority'],
    authorityType: () => 'migration-execution',
  },
  {
    acceptedScenarios: ['verified-procedures'],
    derive: (record, authority) => deriveProcedure(record.artifact, record.candidate, authority),
    kind: 'procedure',
    requiredAuthority: ['procedure-execution-authority'],
    authorityType: () => 'procedure-verification',
  },
  {
    acceptedScenarios: ['solo', 'two-agent', 'git-shared'],
    derive: record => deriveValueReport(record.scenario, record.artifact),
    kind: 'value-report',
    requiredAuthority: [],
  },
  {
    acceptedScenarios: ['two-agent', 'git-shared'],
    derive: record => deriveRecall(record.scenario, record.artifact),
    kind: 'recall',
    requiredAuthority: [],
  },
  {
    acceptedScenarios: ['git-shared'],
    derive: record => deriveSharing(record.artifact),
    kind: 'sharing',
    requiredAuthority: [],
  },
  {
    acceptedScenarios: ['provider-neutral-proposal'],
    derive: (record, authority) => deriveProposal(record.artifact, record.candidate, authority),
    kind: 'git-proposal',
    requiredAuthority: ['git-proposal-review-authority'],
    authorityType: () => 'git-proposal-review',
  },
];

const LOCAL_RECEIPT_ADAPTER_BY_KIND = new Map(LOCAL_RECEIPT_ADAPTERS.map(adapter => [adapter.kind, adapter] as const));

/** Adapter declarations are exported so capture tooling can reject a mislabeled source before persistence. */
export const THREADNOTE_5_LOCAL_RECEIPT_ADAPTERS = LOCAL_RECEIPT_ADAPTERS.map(adapter => ({
  acceptedScenarios: [...adapter.acceptedScenarios],
  kind: adapter.kind,
  requiredAuthority: [...adapter.requiredAuthority],
}));

function deriveClaims(
  record: Threadnote5LocalSubsystemReceiptRecordV1,
  authority: Threadnote5LocalAuthorityEntryV1 | undefined,
): DerivedClaims {
  const adapter = LOCAL_RECEIPT_ADAPTER_BY_KIND.get(record.kind);
  if (adapter === undefined || !adapter.acceptedScenarios.includes(record.scenario)) {
    throw new Error('Subsystem receipt adapter does not accept this scenario.');
  }
  return adapter.derive(record, authority);
}

/**
 * Replays the retained activation state rather than accepting a terminal receipt as proof.
 * A receipt update can complete exactly one planned operation, so a skipped, repeated, or
 * disconnected revision is rejected before it can contribute a readiness claim.
 */
function deriveActivation(
  scenario: Threadnote5ReleaseScenario,
  value: unknown,
  authority: Threadnote5LocalAuthorityEntryV1 | undefined,
): DerivedClaims {
  const source = exactObject(value, ['trials'], 'activation capture');
  const trialValues = boundedArray(source.trials, 'activation trials', 1, MAX_ATTEMPTS);
  const authorityTrials = authority?.type === 'activation-verification' ? authority.trials : [];
  if (scenario !== 'solo' && authority?.type !== 'activation-verification') {
    return {assertions: [], measurements: [], missingKinds: ['activation-live-verification-authority']};
  }
  if (authorityTrials.length !== (scenario === 'solo' ? 0 : trialValues.length)) {
    throw new Error('Activation authority must exactly cover its captured trials.');
  }
  const trials = trialValues.map(trial => {
    const activationId = object(object(trial, 'activation trial').state, 'activation state').plan;
    const plan = parseActivationPlanV1(activationId);
    return parseActivationTrial(
      trial,
      scenario,
      authorityTrials.find(candidate => candidate.activationId === plan.activationId),
    );
  });
  if (!unique(trials.map(trial => trial.plan.activationId))) throw new Error('Activation trials must be unique.');
  const completed = trials.filter(trial => trial.finalReceipt.status === 'completed').length;
  if (scenario === 'solo') {
    return {
      assertions: trials.every(trial => trial.finalReceipt.firstBrief !== undefined) ? ['local-setup-complete'] : [],
      measurements: [{eligibleCount: trials.length, id: 'setup-success-rate', positiveCount: completed}],
    };
  }
  if (scenario === 'two-agent') {
    if (trials.some(trial => !trial.secondSurfaceVerified)) {
      throw new Error('Two-agent activation trial lacks a bound second-surface proof.');
    }
    return {
      assertions: ['two-surfaces-connected'],
      correlations: {
        activationValues: trials.map(activationValueLink),
        secondSurfaceProofs: trials.map(trial => trial.secondSurfaceLink!),
      },
      measurements: [],
    };
  }
  if (scenario === 'offline') {
    if (trials.some(trial => !trial.offlineObserved || trial.finalReceipt.status !== 'completed')) {
      throw new Error('Offline activation trial is incomplete or lacks a zero-attempt network observer.');
    }
    return {assertions: ['local-flow-complete', 'network-attempts-zero'], measurements: []};
  }
  if (trials.some(trial => !trial.interruptionVerified)) {
    throw new Error('Interrupted activation trial lacks a retained pre-resume receipt.');
  }
  return {
    assertions: ['completed-step-not-repeated', 'resume-receipt-accepted'],
    measurements: [],
  };
}

interface ParsedActivationTrialV1 {
  readonly finalReceipt: ActivationReceiptV1;
  readonly interruptionVerified: boolean;
  readonly offlineObserved: boolean;
  readonly plan: ActivationPlanV1;
  readonly secondSurfaceLink?: Threadnote5SecondSurfaceLinkV1;
  readonly secondSurfaceVerified: boolean;
}

function parseActivationTrial(
  value: unknown,
  scenario: Threadnote5ReleaseScenario,
  authority:
    Extract<Threadnote5LocalAuthorityEntryV1, {readonly type: 'activation-verification'}>['trials'][number] | undefined,
): ParsedActivationTrialV1 {
  const trial = object(value, 'activation trial');
  if (
    !allowedKeys(trial, [
      'approvals',
      'events',
      'offlineObservation',
      'receiptChain',
      'resumeBoundaryRevision',
      'secondSurface',
      'state',
    ])
  ) {
    throw new Error('Activation trial has unsupported fields.');
  }
  const state = exactObject(trial.state, ['plan', 'receipt'], 'activation state');
  const plan = parseActivationPlanV1(state.plan);
  const finalReceipt = parseActivationReceiptV1(state.receipt);
  const chain = boundedArray(trial.receiptChain, 'activation receipt chain', 1, 16).map(parseActivationReceiptV1);
  const approvals = boundedArray(trial.approvals, 'activation approvals', 0, 16).map(parseActivationApproval);
  if (canonicalJson(chain.at(-1)) !== canonicalJson(finalReceipt)) {
    throw new Error('Activation receipt chain does not end at the retained state.');
  }
  verifyActivationReceiptChain(plan, chain, approvals);
  if (
    scenario !== 'solo' &&
    (authority === undefined ||
      authority.finalReceiptRevision !== finalReceipt.revision ||
      authority.activationId !== plan.activationId)
  ) {
    throw new Error('Activation trial is not covered by its independent authority.');
  }
  const secondSurfaceLink =
    scenario === 'two-agent' && trial.secondSurface !== undefined
      ? verifySecondSurfaceCapture(trial.secondSurface, plan, chain, finalReceipt, authority?.attestationDigest ?? null)
      : undefined;
  const secondSurfaceVerified = secondSurfaceLink !== undefined;
  const offlineObserved =
    scenario === 'offline' && trial.offlineObservation !== undefined
      ? verifyOfflineObservation(trial.offlineObservation, chain, authority?.offlineObservationDigest ?? null)
      : false;
  const interruptionVerified =
    scenario === 'interrupted-resumed' &&
    typeof trial.resumeBoundaryRevision === 'string' &&
    authority?.resumeBoundaryRevision === trial.resumeBoundaryRevision &&
    resumeBoundaryIsVerified(chain, trial.resumeBoundaryRevision);
  if (scenario === 'two-agent' && !secondSurfaceVerified)
    throw new Error('Activation second-surface evidence is absent.');
  if (scenario === 'offline' && !offlineObserved) throw new Error('Activation offline observer is absent.');
  if (scenario === 'interrupted-resumed' && !interruptionVerified) {
    throw new Error('Activation resume evidence is absent.');
  }
  return {finalReceipt, interruptionVerified, offlineObserved, plan, secondSurfaceLink, secondSurfaceVerified};
}

function verifyActivationReceiptChain(
  plan: ActivationPlanV1,
  chain: readonly ActivationReceiptV1[],
  approvals: readonly ActivationApprovalV1[],
): void {
  const initial = chain[0];
  if (canonicalJson(initial) !== canonicalJson(createActivationReceiptV1(plan, initial.startedAt))) {
    throw new Error('Activation receipt chain must begin with the initial persisted receipt.');
  }
  const approvalsByHash = new Map(approvals.map(approval => [approval.approvalHash, approval] as const));
  if (approvalsByHash.size !== approvals.length) throw new Error('Activation approvals must be unique.');
  const usedApprovals = new Set<string>();
  for (let index = 0; index < chain.length; index += 1) {
    const receipt = chain[index];
    if (
      receipt.activationId !== plan.activationId ||
      receipt.planHash !== plan.planHash ||
      activationReceiptRevisionV1(receipt) !== receipt.revision ||
      receipt.operations.length !== plan.operations.length ||
      receipt.operations.some(
        (operation, operationIndex) =>
          operation.id !== plan.operations[operationIndex]?.id ||
          operation.kind !== plan.operations[operationIndex]?.kind ||
          operation.inputHash !== plan.operations[operationIndex]?.inputHash,
      )
    ) {
      throw new Error('Activation receipt does not bind to the parsed plan.');
    }
    if (index === 0) continue;
    const previous = chain[index - 1];
    const resume = previewActivationResumeV1(plan, previous);
    const operation =
      resume.status === 'completed' || resume.status === 'drifted'
        ? undefined
        : receipt.operations.find(candidate => candidate.id === resume.operationId);
    const approvalHash = operation?.approvalHash;
    const approval = approvalHash === undefined ? undefined : approvalsByHash.get(approvalHash);
    if (!activationReceiptTransitionMatchesV1(plan, previous, receipt, approval)) {
      throw new Error('Activation receipt update is not a production-valid transition.');
    }
    if (approvalHash !== undefined) usedApprovals.add(approvalHash);
  }
  if (usedApprovals.size !== approvals.length) throw new Error('Activation approval evidence is unused.');
}

function parseActivationApproval(value: unknown): ActivationApprovalV1 {
  return exactObject(
    value,
    [
      'approvalHash',
      'approved',
      'kind',
      'operationId',
      'planHash',
      'receiptRevision',
      'reviewRevisionHash',
      'type',
      'version',
    ],
    'activation approval',
  ) as unknown as ActivationApprovalV1;
}

function verifySecondSurfaceCapture(
  value: unknown,
  plan: ActivationPlanV1,
  chain: readonly ActivationReceiptV1[],
  receipt: ActivationReceiptV1,
  authorityDigest: string | null,
): Threadnote5SecondSurfaceLinkV1 | undefined {
  const capture = exactObject(value, ['challenge'], 'second-surface capture');
  const challenge = parseSecondSurfaceProofChallengeV1(capture.challenge);
  if (challenge.receipt === undefined || authorityDigest !== threadnote5ActivationAttestationDigest(challenge)) {
    return undefined;
  }
  const attestation = parseSecondSurfaceProofAttestationV1(challenge.receipt);
  const proof = parseSecondSurfaceProofReceiptV1(attestation.proof);
  if (!secondSurfaceProofMatchesContextV1(challenge.context, proof)) return undefined;
  const proofTransition = chain.findIndex(receipt =>
    receipt.operations.some(operation => operation.kind === 'secondary.prove' && operation.status === 'verified'),
  );
  const proofPrevious = proofTransition > 0 ? chain[proofTransition - 1] : undefined;
  if (
    challenge.context.activationId !== plan.activationId ||
    challenge.context.activationReceiptRevision !== proofPrevious?.revision ||
    receipt.operations.find(operation => operation.kind === 'secondary.prove')?.subsystemReceiptHash !== proof.proofHash
  ) {
    return undefined;
  }
  return secondSurfaceLink(proof);
}

function verifyOfflineObservation(
  value: unknown,
  chain: readonly ActivationReceiptV1[],
  authorityDigest: string | null,
): boolean {
  const observation = exactObject(
    value,
    ['afterAttemptCount', 'afterRevision', 'beforeAttemptCount', 'beforeRevision'],
    'offline network observation',
  );
  return (
    observation.beforeAttemptCount === 0 &&
    observation.afterAttemptCount === 0 &&
    observation.beforeRevision === chain[0]?.revision &&
    observation.afterRevision === chain.at(-1)?.revision &&
    authorityDigest === threadnote5ActivationOfflineObservationDigest(observation)
  );
}

function resumeBoundaryIsVerified(chain: readonly ActivationReceiptV1[], boundaryRevision: string): boolean {
  const boundaryIndex = chain.findIndex(receipt => receipt.revision === boundaryRevision);
  return boundaryIndex > 0 && boundaryIndex < chain.length - 1;
}

function deriveRecall(_scenario: Threadnote5ReleaseScenario, value: unknown): DerivedClaims {
  const source = exactObject(value, ['trials'], 'recall capture');
  const trials = boundedArray(source.trials, 'recall trials', 1, MAX_ATTEMPTS).map(trial => {
    const item = exactObject(trial, ['proof'], 'recall trial');
    return parseSecondSurfaceProofReceiptV1(item.proof);
  });
  if (!unique(trials.map(trial => trial.proofHash))) throw new Error('Recall trials must be unique.');
  return {
    assertions: [],
    correlations: {secondSurfaceProofs: trials.map(secondSurfaceLink)},
    measurements: [],
  };
}

function deriveSharing(value: unknown): DerivedClaims {
  const source = exactObject(value, ['trials'], 'sharing capture');
  const links = boundedArray(source.trials, 'sharing trials', 1, MAX_ATTEMPTS).map(trial => {
    const item = exactObject(trial, ['decision', 'plan', 'receipt'], 'sharing trial');
    const plan = parseActivationPlanV1(item.plan);
    const receipt = parseActivationReceiptV1(item.receipt);
    const publication = receipt.operations.find(
      operation => operation.kind === 'decision.publish' || operation.kind === 'decision.propose',
    );
    const next = previewActivationResumeV1(plan, receipt);
    const decision = exactObject(
      item.decision,
      ['canonicalUri', 'contentHash', 'memoryId', 'publicationReceiptHash'],
      'shared decision',
    );
    if (
      receipt.planHash !== plan.planHash ||
      publication === undefined ||
      (publication.status !== 'applied' && publication.status !== 'already-current') ||
      publication.subsystemReceiptHash !== decision.publicationReceiptHash ||
      next.status === 'completed' ||
      next.status === 'drifted' ||
      next.operationId !== 'secondary-proof' ||
      !hash(decision.contentHash) ||
      !hash(decision.publicationReceiptHash) ||
      !nonEmptyText(decision.canonicalUri, 1_024) ||
      !nonEmptyText(decision.memoryId, 160)
    ) {
      throw new Error('Sharing capture has no completed activation publication receipt.');
    }
    return {
      activationId: plan.activationId,
      activationReceiptRevision: receipt.revision,
      decisionCanonicalUri: decision.canonicalUri,
      decisionContentHash: decision.contentHash,
      decisionMemoryId: decision.memoryId,
      publicationReceiptHash: decision.publicationReceiptHash,
    };
  });
  if (!unique(links.map(link => `${link.activationId}\0${link.activationReceiptRevision}`))) {
    throw new Error('Sharing trials must be unique.');
  }
  return {assertions: [], correlations: {sharedDecisions: links}, measurements: []};
}

function activationValueLink(trial: ParsedActivationTrialV1): Threadnote5ActivationValueLinkV1 {
  return {activationId: trial.plan.activationId, finalReceiptRevision: trial.finalReceipt.revision};
}

function secondSurfaceLink(proof: SecondSurfaceProofReceiptV1): Threadnote5SecondSurfaceLinkV1 {
  return {
    activationId: proof.activationId,
    activationReceiptRevision: proof.activationReceiptRevision,
    decisionCanonicalUri: proof.decisionCanonicalUri,
    decisionContentHash: proof.decisionContentHash,
    decisionMemoryId: proof.decisionMemoryId,
    proofHash: proof.proofHash,
    publicationReceiptHash: proof.publicationReceiptHash,
  };
}

/**
 * This is intentionally a capture boundary, not an agent runner. The production request and
 * result are reparsed; the event only carries the exact candidate identity and requested budget.
 */
function deriveContextBrief(
  scenario: Threadnote5ReleaseScenario,
  value: unknown,
  candidate: Threadnote5SourceV1,
  authority: Threadnote5LocalAuthorityEntryV1 | undefined,
): DerivedClaims {
  const source = exactObject(value, ['attempts'], 'Context Brief capture');
  const attempts = boundedArray(source.attempts, 'Context Brief attempts', 1, MAX_ATTEMPTS);
  const estimatedTokens = attempts.map(attempt => contextBriefAttemptTokens(attempt, candidate));
  if (scenario === 'output-budgets') {
    return {assertions: ['context-brief-800-to-1500-estimated-tokens'], measurements: []};
  }
  if (authority?.type !== 'context-brief-plan-citation' || !authority.assertions.includes('first-plan-source-cited')) {
    return {assertions: [], measurements: [], missingKinds: ['context-brief-plan-citation-authority']};
  }
  return {
    assertions: ['first-plan-source-cited', 'first-plan-correct'],
    measurements: [
      {
        id: 'estimated-tokens-to-first-cited-correct-plan',
        sampleCount: attempts.length,
        total: estimatedTokens.reduce((sum, value) => sum + value, 0),
      },
    ],
  };
}

function contextBriefAttemptTokens(value: unknown, candidate: Threadnote5SourceV1): number {
  const capture = exactObject(value, ['event', 'request', 'result'], 'Context Brief attempt');
  const request = parseContextBriefRequestV1(capture.request);
  const result = exactObject(capture.result, ['structuredContent', 'text'], 'Context Brief result');
  const structuredContent = parseContextBriefV1(result.structuredContent);
  const textResult = text(result.text, 'Context Brief result text', 256 * 1024);
  if (textResult !== renderContextBriefText(structuredContent))
    throw new Error('Context Brief text projection does not replay.');
  const measurement = measureAgentToolResponse({structuredContent, text: textResult});
  const event = exactObject(capture.event, ['candidate'], 'Context Brief capture event');
  if (
    !sameSource(parseThreadnote5TrustedSourceV1(event.candidate, 'candidate'), candidate) ||
    measurement.estimatedTokens > request.budgetTokens
  ) {
    throw new Error('Context Brief attempt candidate or budget binding is invalid.');
  }
  return measurement.estimatedTokens;
}

function deriveContextCheck(
  value: unknown,
  candidate: Threadnote5SourceV1,
  authority: Threadnote5LocalAuthorityEntryV1 | undefined,
): DerivedClaims {
  const capture = exactObject(
    value,
    ['graphEvidence', 'readFence', 'reportJson', 'repositoryEvidence'],
    'Context Check capture',
  );
  const report = parseContextCheckReportJson(text(capture.reportJson, 'Context Check report JSON', 256 * 1024));
  const repository = captureBoundary(capture.repositoryEvidence, candidate, 'repository evidence', ['dirty']);
  const graph = captureBoundary(capture.graphEvidence, candidate, 'graph evidence', ['state']);
  const fence = captureBoundary(capture.readFence, candidate, 'Context Check read fence', ['state']);
  if (
    repository.dirty !== true ||
    graph.state !== 'incomplete' ||
    fence.state !== 'unknown' ||
    report.evidenceStatus !== 'unavailable' ||
    report.exitClassification !== 'invalid-or-required-evidence-unavailable' ||
    report.exitCode !== 2
  ) {
    throw new Error('Context Check capture does not prove dirty evidence is non-current and the outcome is unknown.');
  }
  if (authority?.type !== 'context-check-read-fence' || !authority.assertions.includes('dirty-evidence-not-current')) {
    return {assertions: [], measurements: [], missingKinds: ['context-check-read-fence-authority']};
  }
  return {assertions: ['dirty-evidence-not-current', 'outcome-unknown'], measurements: []};
}

function deriveGuidance(
  value: unknown,
  candidate: Threadnote5SourceV1,
  authority: Threadnote5LocalAuthorityEntryV1 | undefined,
): DerivedClaims {
  const capture = exactObject(
    value,
    ['after', 'afterText', 'before', 'beforeText', 'candidate', 'current', 'preview', 'sources', 'stalePrecondition'],
    'guidance capture',
  );
  if (!sameSource(parseThreadnote5TrustedSourceV1(capture.candidate, 'candidate'), candidate)) {
    throw new Error('Guidance capture candidate identity is mismatched.');
  }
  const current = guidanceReceipt(capture.current, 'current GuidanceReceiptV2');
  const expected = {
    project: current.project,
    repositoryId: current.repositoryId,
    targetIdentity: current.targetIdentity,
    targetPath: current.targetPath,
  };
  const before = parseGuidanceReceiptV2(capture.before, expected);
  const after = parseGuidanceReceiptV2(capture.after, expected);
  const preview = parseGuidanceReceiptV2(capture.preview, expected);
  if (!Array.isArray(capture.sources) || capture.sources.length === 0 || capture.sources.length > 64) {
    throw new Error('Guidance capture must retain bounded source receipts.');
  }
  const sources = capture.sources.map(source => {
    const entry = exactObject(source, ['contentHash', 'text', 'uri'], 'guidance source');
    const contentHash = text(entry.contentHash, 'guidance source hash', 64);
    const sourceText = text(entry.text, 'guidance source text', 60 * 1024);
    if (!hash(contentHash) || sha256HexSync(sourceText) !== contentHash)
      throw new Error('Guidance source content hash is invalid.');
    return {contentHash, text: sourceText, uri: text(entry.uri, 'guidance source URI', 4_096)};
  });
  if (!unique(sources.map(source => source.uri))) throw new Error('Guidance capture source URIs must be unique.');
  const beforeText = text(capture.beforeText, 'guidance before text', 256 * 1024);
  const capturedAfterText = text(capture.afterText, 'guidance after text', 256 * 1024);
  const block = renderManagedGuidanceBlock(sources);
  const afterText = upsertGuidanceBlock(beforeText, block);
  const beforeBlock = guidanceBlock(beforeText);
  const projectedSources = [...sources]
    .sort((left, right) => compareText(left.uri, right.uri))
    .map(({contentHash, uri}) => ({contentHash, uri}));
  if (
    beforeBlock === undefined ||
    stripThreadnoteManagedGuidance(beforeText) !== stripThreadnoteManagedGuidance(afterText) ||
    capturedAfterText !== afterText ||
    sha256HexSync(beforeBlock) !== before.expectedManagedBlockHash ||
    sha256HexSync(block) !== after.expectedManagedBlockHash ||
    canonicalJson(projectedSources) !== canonicalJson(after.sources)
  ) {
    throw new Error('Guidance capture does not prove preservation and managed-block preconditions.');
  }
  if (
    canonicalJson(before) !== canonicalJson(current) ||
    canonicalJson(preview) !== canonicalJson(after) ||
    before.state !== 'current' ||
    after.state !== 'current' ||
    typeof capture.stalePrecondition !== 'boolean'
  ) {
    throw new Error('Guidance capture cannot replay its source, preview, and receipt transition.');
  }
  const staleMissing =
    capture.stalePrecondition &&
    (authority?.type !== 'guidance-stale-precondition-rejection' ||
      !authority.assertions.includes('stale-precondition-rejected'));
  return {
    assertions: ['unmanaged-text-preserved', 'apply-previewed', 'content-precondition-checked'],
    measurements: [],
    ...(staleMissing ? {missingKinds: ['guidance-stale-precondition-rejection-authority']} : {}),
  };
}

function deriveMigration(
  value: unknown,
  candidate: Threadnote5SourceV1,
  authority: Threadnote5LocalAuthorityEntryV1 | undefined,
): DerivedClaims {
  const capture = exactObject(value, ['baseline', 'candidate', 'downgrade', 'upgrade'], 'migration capture');
  const baseline = parseThreadnote5TrustedSourceV1(capture.baseline, 'baseline');
  const capturedCandidate = parseThreadnote5TrustedSourceV1(capture.candidate, 'candidate');
  if (!sameSource(capturedCandidate, candidate)) throw new Error('Migration capture candidate identity is mismatched.');
  const upgrade = migrationExecution(capture.upgrade, baseline, candidate, 'upgrade');
  const downgrade = migrationExecution(capture.downgrade, candidate, baseline, 'downgrade');
  if (authority?.type !== 'migration-execution' || !authority.assertions.includes('migration-runtime-executed')) {
    return {assertions: [], measurements: [], missingKinds: ['migration-execution-authority']};
  }
  const assertions = [
    ...(upgrade.outcome === 'readable' ? ['upgrade-readable'] : []),
    ...(downgrade.outcome === 'readable' || downgrade.outcome === 'safe-refusal'
      ? ['downgrade-readable-or-safe-refusal']
      : []),
    ...(upgrade.protectedWriteCount === 0 && downgrade.protectedWriteCount === 0 ? ['destructive-mutations-zero'] : []),
  ];
  return {assertions, measurements: []};
}

function guidanceReceipt(value: unknown, label: string) {
  const raw = object(value, label);
  return parseGuidanceReceiptV2(value, {
    project: text(raw.project, `${label} project`, 256),
    repositoryId: text(raw.repositoryId, `${label} repository id`, 4_096),
    targetIdentity: text(raw.targetIdentity, `${label} target identity`, 4_096),
    targetPath: text(raw.targetPath, `${label} target path`, 1_024),
  });
}

function captureBoundary(
  value: unknown,
  candidate: Threadnote5SourceV1,
  label: string,
  required: readonly string[],
): Record<string, unknown> {
  const boundary = object(value, label);
  if (
    !allowedKeys(boundary, ['candidate', 'digest', ...required]) ||
    Object.keys(boundary).length !== required.length + 2
  ) {
    throw new Error(`${label} has unsupported or missing fields.`);
  }
  if (
    !hash(boundary.digest) ||
    !sameSource(parseThreadnote5TrustedSourceV1(boundary.candidate, 'candidate'), candidate)
  ) {
    throw new Error(`${label} is not bound to the candidate.`);
  }
  return boundary;
}

function migrationExecution(
  value: unknown,
  from: Threadnote5SourceV1,
  to: Threadnote5SourceV1,
  label: string,
): {readonly outcome: 'readable' | 'safe-refusal'; readonly protectedWriteCount: number} {
  const execution = exactObject(
    value,
    ['afterDigest', 'beforeDigest', 'from', 'outcome', 'protectedWriteCount', 'to'],
    `${label} migration execution`,
  );
  if (
    !hash(execution.beforeDigest) ||
    !hash(execution.afterDigest) ||
    !sameSource(
      parseThreadnote5TrustedSourceV1(execution.from, from.id === 'threadnote-4.7.x' ? 'baseline' : 'candidate'),
      from,
    ) ||
    !sameSource(
      parseThreadnote5TrustedSourceV1(execution.to, to.id === 'threadnote-4.7.x' ? 'baseline' : 'candidate'),
      to,
    ) ||
    !integerIn(execution.protectedWriteCount, 0, MAX_ATTEMPTS) ||
    (execution.outcome !== 'readable' && execution.outcome !== 'safe-refusal')
  ) {
    throw new Error(`${label} migration execution is invalid.`);
  }
  return {outcome: execution.outcome, protectedWriteCount: execution.protectedWriteCount};
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

function deriveValueReport(scenario: Threadnote5ReleaseScenario, value: unknown): DerivedClaims {
  const source = object(value, 'value-report artifact');
  if (!allowedKeys(source, ['activationTrials', 'captures']) || !Array.isArray(source.captures)) {
    throw new Error('Value-report artifact has unsupported fields.');
  }
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
  const activationLinks =
    source.activationTrials === undefined
      ? undefined
      : activationValueTrials(boundedArray(source.activationTrials, 'activation value trials', 1, MAX_ATTEMPTS));
  return {
    assertions: [],
    ...(activationLinks === undefined ? {} : {correlations: {activationValues: activationLinks}}),
    measurements: [
      {eligibleCount: eligibleWrong, id: 'wrong-memory-rate', positiveCount: wrong},
      {eligibleCount: eligibleReuse, id: 'second-agent-reuse-rate', positiveCount: reuse},
    ],
    ...(scenario === 'two-agent' && activationLinks === undefined
      ? {missingKinds: ['activation', 'activation-value-linkage']}
      : {}),
  };
}

function activationValueTrials(trials: readonly unknown[]): readonly Threadnote5ActivationValueLinkV1[] {
  const links: Threadnote5ActivationValueLinkV1[] = [];
  for (const value of trials) {
    const trial = exactObject(value, ['events', 'input', 'report', 'state'], 'activation value trial');
    const state = exactObject(trial.state, ['plan', 'receipt'], 'activation value state');
    const plan = parseActivationPlanV1(state.plan);
    const receipt = parseActivationReceiptV1(state.receipt);
    if (
      receipt.activationId !== plan.activationId ||
      receipt.planHash !== plan.planHash ||
      activationReceiptRevisionV1(receipt) !== receipt.revision
    ) {
      throw new Error('Activation value trial state does not match its plan.');
    }
    if (!Array.isArray(trial.events)) throw new Error('Activation value trial events are invalid.');
    const events = trial.events.map(parseLocalValueEvent);
    const expected = activationValueEventsV1(receipt);
    if (
      events.length !== expected.length ||
      !unique(events.map(event => event.eventId)) ||
      !unique(expected.map(event => event.eventId))
    ) {
      throw new Error('Activation value trial events are incomplete or duplicated.');
    }
    for (const event of expected) {
      const actual = events.find(candidate => candidate.kind === 'activation' && candidate.eventId === event.eventId);
      if (canonicalJson(actual) !== canonicalJson(event)) {
        throw new Error('Activation value trial event does not match the production projection.');
      }
    }
    const input = object(trial.input, 'activation value report input');
    const report = aggregateValueReportV1({
      ...(input as unknown as ValueReportInputV1),
      counts: summarizeLocalValueEvents(events, {
        from: new Date(text(object(input.period, 'activation value period').from, 'activation value period from', 64)),
        to: new Date(text(object(input.period, 'activation value period').to, 'activation value period to', 64)),
      }),
    });
    if (canonicalJson(report) !== canonicalJson(trial.report)) {
      throw new Error('Activation value trial report does not match its raw events.');
    }
    links.push({activationId: plan.activationId, finalReceiptRevision: receipt.revision});
  }
  if (!unique(links.map(link => link.activationId))) throw new Error('Activation value trials must be unique.');
  return links;
}

function parseLocalValueEvent(value: unknown): Extract<LocalValueEventV1, {readonly kind: 'activation'}> {
  const event = object(value, 'local value event');
  if (
    event.kind !== 'activation' ||
    event.version !== 1 ||
    !hash(event.eventId) ||
    !integerIn(event.durationMilliseconds, 0, 7 * 24 * 60 * 60 * 1_000) ||
    !isoInstant(event.timestamp) ||
    !['started', 'first-evidence', 'completed', 'second-surface-proof'].includes(event.phase as string) ||
    !allowedKeys(event, ['durationMilliseconds', 'eventId', 'kind', 'phase', 'timestamp', 'version'])
  ) {
    throw new Error('Activation value event is invalid.');
  }
  return event as unknown as Extract<LocalValueEventV1, {readonly kind: 'activation'}>;
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
  const authorityRecords = records.filter(record => authorityTypeForRecord(record) !== undefined);
  if (manifest.entries.length !== authorityRecords.length) {
    throw new Error('Local authority manifest must exactly cover authority-dependent source records.');
  }
  const byRecordDigest = new Map(manifest.entries.map(entry => [entry.recordDigest, entry] as const));
  for (const record of authorityRecords) {
    const entry = byRecordDigest.get(record.digest);
    if (entry === undefined || entry.type !== authorityTypeForRecord(record)) {
      throw new Error('Local authority entry is missing or mislabeled for its source record.');
    }
  }
  return {byRecordDigest, manifestHash};
}

function authorityTypeForRecord(
  record: Threadnote5LocalSubsystemReceiptRecordV1,
): Threadnote5LocalAuthorityEntryV1['type'] | undefined {
  const adapter = LOCAL_RECEIPT_ADAPTER_BY_KIND.get(record.kind);
  if (adapter === undefined || !adapter.acceptedScenarios.includes(record.scenario)) return undefined;
  return adapter.authorityType?.(record);
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

function text(value: unknown, label: string, maximum: number): string {
  if (!nonEmptyText(value, maximum)) throw new Error(`${label} must be bounded non-empty text.`);
  return value;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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
