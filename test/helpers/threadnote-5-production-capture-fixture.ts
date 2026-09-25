import {canonicalJson} from '../../src/code_graph/checkpoint/canonical_json.js';
import {sha256HexSync} from '../../src/crypto/sha256.js';
import {
  threadnote5ActivationAttestationDigest,
  threadnote5ActivationOfflineObservationDigest,
  threadnote5ApplyAuditDigest,
  threadnote5ApprovedSourceUriHash,
  threadnote5ContextBriefAttemptDigest,
  threadnote5ProcedureVerificationReceiptDigest,
  threadnote5RecallFeedbackEventDigest,
  threadnote5ValueReportOfflineObservationDigest,
  type Threadnote5LocalAuthorityEntryV1,
  type Threadnote5LocalAuthorityManifestV1,
} from '../../src/evaluation/threadnote-5-release-readiness-authority.js';
import type {Threadnote5SourceV1} from '../../src/evaluation/threadnote-5-release-readiness-contract.js';
import {
  threadnote5LocalSubsystemReceiptDigest,
  type Threadnote5LocalSourceKindV1,
  type Threadnote5LocalSubsystemReceiptRecordV1,
} from '../../src/evaluation/threadnote-5-release-readiness-receipts.js';
import {
  bindActivationApprovalV1,
  createActivationReceiptV1,
  recordActivationOutcomeV1,
} from '../../src/activation/receipt.js';
import {createActivationPlanV1} from '../../src/activation/planner.js';
import type {ActivationReceiptV1} from '../../src/activation/contract.js';
import {
  completeSecondSurfaceProofV1,
  secondSurfaceProofContextHashV1,
  type SecondSurfaceProofContextV1,
  type SecondSurfaceReadObservationV1,
  type SecondSurfaceRecallObservationV1,
} from '../../src/activation/second/surface.js';
import {secondSurfaceChallengeIdV1} from '../../src/activation/second/surface_store.js';
import {activationValueEventsV1} from '../../src/activation/value.js';
import {parseContextBriefV1, renderContextBriefText} from '../../src/context_brief/projector.js';
import {buildKnowledgeDeltaGitProposalV1} from '../../src/git_proposal/knowledge_delta.js';
import type {CandidateReview} from '../../src/memory/candidate.js';
import {buildContextHealthReport, type ContextHealthReportInputV1} from '../../src/memory/context/health.js';
import {
  applyContextHealthRepairProposalV1,
  previewContextHealthRepairPlanV1,
} from '../../src/memory/context/health_repair.js';
import {
  aggregateContextHealthReportsV1,
  buildContextHealthSchedulePlanV1,
} from '../../src/memory/context/health_schedule.js';
import {
  canonicalMemoryDocumentContent,
  formatMemoryDocument,
  parseMemoryDocument,
  type MemoryMetadata,
  type MemoryRecord,
} from '../../src/memory/document.js';
import {projectKnowledgeDeltaV1} from '../../src/memory/knowledge_delta.js';
import {createProcedureVerificationReceipt, parseProcedureManifest} from '../../src/procedure/contract.js';
import {aggregateValueReportV1} from '../../src/value_report/index.js';
import {summarizeLocalValueEvents} from '../../src/value_report/events.js';
import {renderManagedGuidanceBlock, upsertGuidanceBlock} from '../../src/guidance/index.js';

export const PRODUCTION_CAPTURE_CANDIDATE: Threadnote5SourceV1 = {
  commit: '1'.repeat(40),
  executableSha256: '2'.repeat(64),
  id: 'threadnote-5.0.0',
  version: `5.0.0-local.g${'1'.repeat(40)}`,
};

export function productionCaptureFixture(): {
  readonly authorityManifest: Threadnote5LocalAuthorityManifestV1;
  readonly records: readonly Threadnote5LocalSubsystemReceiptRecordV1[];
} {
  const soloJourneys = journeys('solo');
  const twoAgentJourneys = journeys('two-agent');
  const sharedJourneys = journeys('git-shared');
  const offlineJourneys = journeys('offline');
  const interruptedJourney = journey('interrupted-resumed', 0);
  const interruptedBoundary = interruptedJourney.activationTrial.receiptChain.at(-2)?.revision;
  if (interruptedBoundary === undefined) throw new Error('Interrupted fixture lacks an intermediate revision.');

  const records = [
    record('solo', 'activation', {trials: soloJourneys.map(item => item.activationTrial)}),
    contextBriefRecord(soloJourneys),
    valueReportRecord(
      'solo',
      soloJourneys.map(item => item.firstBriefLaneId),
    ),
    record('two-agent', 'activation', {trials: twoAgentJourneys.map(item => item.activationTrial)}),
    record('two-agent', 'recall', {trials: twoAgentJourneys.map(item => ({proof: item.proof}))}),
    valueReportRecord(
      'two-agent',
      twoAgentJourneys.map(item => item.proof.proofHash),
      twoAgentJourneys,
    ),
    record('git-shared', 'sharing', {
      trials: sharedJourneys.map(item => ({
        decision: item.decision,
        plan: item.plan,
        receipt: item.publicationReceipt,
      })),
    }),
    record('git-shared', 'recall', {trials: sharedJourneys.map(item => ({proof: item.proof}))}),
    valueReportRecord(
      'git-shared',
      sharedJourneys.map(item => item.proof.proofHash),
    ),
    offlineActivationRecord(offlineJourneys),
    valueReportRecord(
      'offline',
      offlineJourneys.map(item => item.firstBriefLaneId),
      undefined,
      true,
    ),
    contextCheckRecord(),
    record('interrupted-resumed', 'activation', {
      trials: [{...interruptedJourney.activationTrial, resumeBoundaryRevision: interruptedBoundary}],
    }),
    record('interrupted-resumed', 'closeout', {reviews: reviews(100)}),
    migrationRecord(),
    proposalRecord(),
    procedureRecord(),
    healthMaintenanceRecord(),
    record('structured-closeout', 'closeout', {reviews: reviews(200)}),
    staleCitationRecord(),
    contradictionRecord(),
    guidanceRecord(),
    outputBudgetRecord(),
    record('output-budgets', 'closeout', {reviews: [review(999)]}),
  ] as const;
  if (records.length !== 24) throw new Error('Production fixture must contain exactly 24 source records.');
  return {authorityManifest: authorityManifestFor(records), records};
}

function journeys(prefix: 'git-shared' | 'offline' | 'solo' | 'two-agent') {
  return Array.from({length: 10}, (_value, index) => journey(prefix, index));
}

function journey(prefix: string, index: number) {
  const startedAt = new Date(Date.UTC(2026, 8, 17, 8, index)).toISOString();
  const repositoryIdentityHash = sha256HexSync(`${prefix}:repository:${index}`);
  const {
    approvals,
    plan,
    receipt: publicationReceipt,
    receiptChain,
  } = activationChain(repositoryIdentityHash, startedAt);
  const publicationReceiptHash = publicationReceipt.operations.find(
    operation => operation.kind === 'decision.publish',
  )?.subsystemReceiptHash;
  if (publicationReceiptHash === undefined) throw new Error('Activation fixture has no publication receipt.');
  const decision = {
    canonicalUri: `threadnote://user/test/memories/shared/default/durable/projects/threadnote/${prefix}-${index}.md`,
    contentHash: sha256HexSync(`${prefix}:content:${index}`),
    memoryId: `tn_${sha256HexSync(`${prefix}:memory:${index}`).slice(0, 20)}`,
    publicationReceiptHash,
  };
  const context: SecondSurfaceProofContextV1 = {
    activationId: plan.activationId,
    activationReceiptRevision: publicationReceipt.revision,
    catalogRevision: 'catalog-v1',
    catalogSnapshotHash: plan.catalogSnapshotHash,
    decision,
    primary: surface(plan.primarySurfaceId, '1', '2', '3'),
    queryFingerprint: sha256HexSync(`${prefix}:query:${index}`),
    repositoryIdentityHash: plan.repositoryIdentityHash,
    repositoryState: 'clean',
    secondary: surface(plan.secondarySurfaceId, '6', '7', '8'),
    startedAt: publicationReceipt.updatedAt,
    teamId: plan.teamId,
    teamShareStateHash: plan.teamShareStateHash,
  };
  const common = {
    activationReceiptRevision: context.activationReceiptRevision,
    capabilitiesFingerprint: context.secondary.capabilitiesFingerprint,
    catalogRevision: context.catalogRevision,
    catalogSnapshotHash: context.catalogSnapshotHash,
    mcpConfigFingerprint: context.secondary.mcpConfigFingerprint!,
    mcpReceiptFingerprint: context.secondary.mcpReceiptFingerprint!,
    mcpServerFingerprint: context.secondary.mcpServerFingerprint!,
    repositoryIdentityHash: context.repositoryIdentityHash,
    surfaceId: context.secondary.surfaceId,
    teamShareStateHash: context.teamShareStateHash,
  };
  const recall: SecondSurfaceRecallObservationV1 = {
    ...common,
    complete: true,
    invocationId: sha256HexSync(`${prefix}:recall:${index}`),
    observedAt: new Date(Date.parse(context.startedAt) + 1_000).toISOString(),
    queryFingerprint: context.queryFingerprint,
    responseFingerprint: sha256HexSync(`${prefix}:recall-response:${index}`),
    results: [{canonicalUri: decision.canonicalUri, identityConflict: false, memoryId: decision.memoryId}],
    returnedResults: 1,
    totalResults: 1,
    truncated: false,
  };
  const read: SecondSurfaceReadObservationV1 = {
    ...common,
    canonicalUri: decision.canonicalUri,
    complete: true,
    contentHash: decision.contentHash,
    invocationId: sha256HexSync(`${prefix}:read:${index}`),
    memoryId: decision.memoryId,
    observedAt: new Date(Date.parse(context.startedAt) + 2_000).toISOString(),
    readable: true,
    recallResponseFingerprint: recall.responseFingerprint,
    requestedMemoryId: decision.memoryId,
    requestedUri: decision.canonicalUri,
    resourceCount: 1,
    responseFingerprint: sha256HexSync(`${prefix}:read-response:${index}`),
  };
  const proofResult = completeSecondSurfaceProofV1(context, recall, read);
  if (proofResult.status !== 'verified') throw new Error(`Fixture proof failed: ${proofResult.code}.`);
  const proof = proofResult.receipt;
  const finalReceipt = recordSuccessfulOperation(
    plan,
    publicationReceipt,
    plan.operations.at(-1)!,
    proof.proofHash,
    approvals,
  );
  const challengeId = secondSurfaceChallengeIdV1(context);
  const contextHash = secondSurfaceProofContextHashV1(context);
  const nonceHash = sha256HexSync(`${prefix}:nonce:${index}`);
  const challenge = {
    challengeId,
    context,
    contextHash,
    issuedAt: context.startedAt,
    nonceHash,
    receipt: {
      attestationHash: sha256HexSync(`${prefix}:attestation:${index}`),
      challengeId,
      contextHash,
      nonceHash,
      proof,
      runtimeFingerprint: context.secondary.mcpServerFingerprint!,
      surfaceId: context.secondary.surfaceId,
      transport: 'stdio' as const,
      type: 'threadnote-second-surface-transport-attestation' as const,
      version: 1 as const,
    },
    type: 'threadnote-second-surface-challenge' as const,
    version: 1 as const,
  };
  const fullChain = [...receiptChain, finalReceipt];
  const firstBriefReceipt = fullChain.find(receipt => receipt.firstBrief !== undefined);
  if (firstBriefReceipt?.firstBrief === undefined) throw new Error('Activation fixture has no first brief.');
  const identity = {
    activationId: plan.activationId,
    activationReceiptRevision: firstBriefReceipt.revision,
    completedAt: firstBriefReceipt.firstBrief.completedAt,
  };
  return {
    activationTrial: {
      approvals,
      events: activationValueEventsV1(finalReceipt),
      receiptChain: fullChain,
      secondSurface: {challenge},
      state: {plan, receipt: finalReceipt},
    },
    challenge,
    decision,
    finalReceipt,
    firstBriefLaneId: sha256HexSync(`threadnote-5-first-brief-lane-v1\0${canonicalJson(identity)}`),
    firstBriefReceipt,
    plan,
    proof,
    publicationReceipt,
  };
}

function surface(surfaceId: string, capability: string, config: string, receipt: string) {
  return {
    access: 'local-stdio' as const,
    capabilitiesFingerprint: capability.repeat(64),
    configurationState: 'current' as const,
    mcpCapability: 'managed' as const,
    mcpConfigFingerprint: config.repeat(64),
    mcpReceiptFingerprint: receipt.repeat(64),
    mcpServerFingerprint: '9'.repeat(64),
    surfaceId,
  };
}

function activationChain(repositoryIdentityHash: string, startedAt: string) {
  const plan = createActivationPlanV1({
    catalogSnapshotHash: 'a'.repeat(64),
    primarySurfaceId: 'codex-cli',
    publicationMode: 'direct',
    repositoryIdentityHash,
    secondarySurfaceId: 'claude-code',
    selectedSourceSetHash: 'c'.repeat(64),
    taskHash: 'd'.repeat(64),
    teamId: 'default',
    teamShareStateHash: 'e'.repeat(64),
    threadnoteVersion: '5.0.0-test',
  });
  let receipt = createActivationReceiptV1(plan, startedAt);
  const approvals: NonNullable<Parameters<typeof recordActivationOutcomeV1>[0]['approval']>[] = [];
  const receiptChain: ActivationReceiptV1[] = [receipt];
  for (const [index, operation] of plan.operations.slice(0, -1).entries()) {
    receipt = recordSuccessfulOperation(
      plan,
      receipt,
      operation,
      sha256HexSync(`${repositoryIdentityHash}:${index}`),
      approvals,
    );
    receiptChain.push(receipt);
  }
  return {approvals, plan, receipt, receiptChain};
}

function recordSuccessfulOperation(
  plan: ReturnType<typeof createActivationPlanV1>,
  receipt: ActivationReceiptV1,
  operation: ReturnType<typeof createActivationPlanV1>['operations'][number],
  subsystemReceiptHash: string,
  approvals: NonNullable<Parameters<typeof recordActivationOutcomeV1>[0]['approval']>[],
): ActivationReceiptV1 {
  const approval =
    operation.approvalKind === undefined
      ? undefined
      : bindActivationApprovalV1(plan, receipt, operation.id, 'f'.repeat(64));
  if (approval !== undefined) approvals.push(approval);
  const result = recordActivationOutcomeV1({
    approval,
    now: new Date(Date.parse(receipt.updatedAt) + 1_000).toISOString(),
    operationId: operation.id,
    outcome: {
      ownership: operation.reversible ? 'activation-created' : 'preexisting',
      status: operation.expectedOutcome,
      subsystemReceiptHash,
      undoEligible: operation.reversible,
    },
    plan,
    receipt,
  });
  if (result.status !== 'updated') throw new Error('Activation transition failed.');
  return result.receipt;
}

function contextBriefRecord(items: readonly ReturnType<typeof journey>[]) {
  const structuredContent = contextBriefContent();
  return record('solo', 'context-brief', {
    attempts: items.map(item => ({
      event: {
        activationId: item.plan.activationId,
        activationReceiptRevision: item.firstBriefReceipt.revision,
        candidate: PRODUCTION_CAPTURE_CANDIDATE,
        completedAt: item.firstBriefReceipt.firstBrief!.completedAt,
      },
      request: {budgetTokens: 1_500, mode: 'brief', scope: {callerCwd: '/repo', kind: 'repository'}, task: 'x'},
      result: {structuredContent, text: renderContextBriefText(structuredContent)},
    })),
  });
}

function contextBriefContent() {
  return parseContextBriefV1({
    activeHandoffs: [],
    coverage: {
      gaps: [],
      memory: {},
      omissions: {
        activeHandoffs: 0,
        coverageGaps: 0,
        durableDecisions: 0,
        graphCards: 0,
        graphContracts: 0,
        recommendedFollowUps: 0,
        stalenessAndConflicts: 0,
      },
    },
    durableDecisions: [],
    graph: {cards: [], contracts: []},
    mode: 'brief',
    output: {omittedItems: 0, projectorVersion: 2, returnedItems: 0, truncated: false},
    recommendedFollowUps: [],
    scope: {},
    stalenessAndConflicts: [],
    task: {summary: 'x', truncated: false},
    trust: {},
    type: 'context-brief',
    version: 2,
  });
}

function valueReportRecord(
  scenario: 'git-shared' | 'offline' | 'solo' | 'two-agent',
  laneIds: readonly string[],
  activationJourneys?: readonly ReturnType<typeof journey>[],
  offline = false,
) {
  const captures = laneIds.map((laneId, index) => {
    const from = new Date(Date.UTC(2026, 8, 18, scenarioOrdinal(scenario), index)).toISOString();
    const to = new Date(Date.parse(from) + 30_000).toISOString();
    const event = {
      action: 'useful' as const,
      project: 'threadnote',
      queryFingerprint: sha256HexSync(`${scenario}:feedback:${index}`),
      rankerVersion: 'hybrid-v8',
      timestamp: from,
      uri: `threadnote://user/test/memories/durable/projects/threadnote/${scenario}-${index}.md`,
      version: 1 as const,
    };
    const counts =
      scenario === 'two-agent' ? {setup: {completed: 1, failed: 0, started: 1, supportedAgentReuse: 1}} : undefined;
    const input = {
      feedbackEvents: [event],
      ...(counts === undefined ? {} : {counts}),
      period: {from, to},
      project: 'threadnote',
    };
    return {event, input, laneId, report: aggregateValueReportV1(input)};
  });
  const activationTrials = activationJourneys?.map(item => {
    const events = activationValueEventsV1(item.finalReceipt);
    const from = new Date(Date.parse(item.finalReceipt.startedAt) - 1_000).toISOString();
    const to = new Date(Date.parse(item.finalReceipt.updatedAt) + 1_000).toISOString();
    const input = {period: {from, to}};
    return {
      events,
      input,
      report: aggregateValueReportV1({
        ...input,
        counts: summarizeLocalValueEvents(events, {from: new Date(from), to: new Date(to)}),
      }),
      state: {plan: item.plan, receipt: item.finalReceipt},
    };
  });
  return record(scenario, 'value-report', {
    ...(activationTrials === undefined ? {} : {activationTrials}),
    captures: captures.map(({input, report}) => ({input, report})),
    feedbackTrials: captures.map(({event, laneId}) => ({
      event,
      laneId,
      offlineObservation: offline ? {afterAttemptCount: 0, beforeAttemptCount: 0} : null,
    })),
  });
}

function scenarioOrdinal(scenario: string) {
  return ['solo', 'two-agent', 'git-shared', 'offline'].indexOf(scenario);
}

function offlineActivationRecord(items: readonly ReturnType<typeof journey>[]) {
  return record('offline', 'activation', {
    trials: items.map(item => {
      const first = item.activationTrial.receiptChain[0];
      return {
        ...item.activationTrial,
        offlineObservation: {
          afterAttemptCount: 0,
          afterRevision: item.finalReceipt.revision,
          beforeAttemptCount: 0,
          beforeRevision: first.revision,
        },
      };
    }),
  });
}

function reviews(offset: number) {
  return Array.from({length: 10}, (_value, index) => review(offset + index));
}

function review(
  index: number,
  application?: {readonly contentHash: string; readonly sourceUri: string},
): CandidateReview {
  const reviewId = `review-${index.toString(16).padStart(16, '0')}`;
  const candidateId = `${reviewId}-1`;
  const sourceUri =
    application?.sourceUri ?? `threadnote://user/test/memories/durable/projects/threadnote/topic-${index}.md`;
  const contentHash = application?.contentHash ?? sha256HexSync(`body-${index}`);
  return {
    auditEvents: [
      {action: 'create_review', at: '2026-09-17T10:00:00.000Z', reviewId, revision: 1},
      {action: 'apply', at: '2026-09-17T10:01:00.000Z', candidateId, memoryUri: sourceUri, reviewId, revision: 2},
    ],
    candidates: [
      {
        applyApprovedAt: '2026-09-17T10:01:00.000Z',
        applyBodyText: `Approved decision ${index}.`,
        applyContentHash: contentHash,
        applyOperation: 'create',
        applyStage: 'written',
        applyTargetUri: sourceUri,
        candidateId,
        categories: ['decision'],
        comparison: 'new',
        confidence: 0.9,
        evidence: [`commit:${PRODUCTION_CAPTURE_CANDIDATE.commit}`],
        kind: 'durable',
        project: 'threadnote',
        proposedText: `Approved decision ${index}.`,
        reason: 'A durable release decision.',
        recommendation: 'create',
        state: 'applied',
        topic: `topic-${index}`,
      },
    ],
    codeCitations: [],
    createdAt: '2026-09-17T10:00:00.000Z',
    outcome: 'Implemented and verified.',
    project: 'threadnote',
    reviewId,
    revision: 2,
    sourceAgentClient: 'codex',
    sourceCommit: PRODUCTION_CAPTURE_CANDIDATE.commit,
    structuredCloseout: {
      constraints: ['Offline and local.'],
      knowledgeInvalidated: ['Prior release assumption.'],
      rationale: 'The implementation establishes the release contract.',
      type: 'structured-closeout',
      unresolvedRisks: ['No unresolved release risk.'],
      verificationPerformed: ['Focused tests passed.'],
      version: 1,
    },
    task: 'Verify Threadnote 5.',
    topic: `topic-${index}`,
    version: 2,
  };
}

function proposalRecord() {
  const attempts = reviews(300).map((candidateReview, index) => {
    const number = 300 + index;
    const candidate = candidateReview.candidates[0];
    const sourceUri = candidate.applyTargetUri!;
    const sourceContent = approvedSource(candidate.candidateId, candidate.topic, number);
    const contentHash = sha256HexSync(canonicalMemoryDocumentContent(sourceContent));
    const updatedReview = review(number, {contentHash, sourceUri});
    const input = {
      baseCommit: 'a'.repeat(40),
      mutations: [
        {
          approval: {
            expectedSourceContentHash: contentHash,
            reviewId: updatedReview.reviewId,
            revision: 2,
            share: true as const,
          },
          candidateId: updatedReview.candidates[0].candidateId,
          expectedTarget: {state: 'absent' as const},
          operation: 'create' as const,
          sourceContent,
          sourceUri,
        },
      ],
      project: 'threadnote',
      target: {repositoryId: 'b'.repeat(64), team: 'default'},
    };
    const built = buildKnowledgeDeltaGitProposalV1({...input, delta: projectKnowledgeDeltaV1(updatedReview)});
    return {artifact: built.artifact, input, proposal: built.proposal, review: updatedReview};
  });
  return record('provider-neutral-proposal', 'git-proposal', {attempts});
}

function approvedSource(candidateId: string, topic: string, index: number) {
  return [
    'MEMORY',
    'kind: durable',
    'status: active',
    'project: threadnote',
    `topic: ${topic}`,
    'source_agent_client: codex',
    'timestamp: 2026-09-17T00:00:00.000Z',
    'schema_version: 5',
    `memory_id: tn_release_${index}`,
    'visibility: personal',
    'authority: user_approved',
    'trust: approved',
    `candidate_id: ${candidateId}`,
    '',
    `Approved decision ${index}.`,
  ].join('\n');
}

function procedureRecord() {
  const artifactText = 'artifact';
  const manifest = parseProcedureManifest({
    artifact: {id: 'team.example/review', semanticVersion: '1.2.3', sha256: sha256HexSync(artifactText)},
    compatible: {capabilities: ['filesystem.read'], surfaceIds: ['terminal']},
    dependencies: [],
    owner: 'owner-opaque-42',
    presentation: {summary: 'Review the repository.', taskKeywords: ['review']},
    relatedDurableMemoryIds: [],
    reviewedOn: '2026-09-17',
    rollout: {channel: 'stable', percentage: 100},
    schemaVersion: 2,
    verification: {commands: [{argv: ['bun', 'test'], id: 'unit'}], fixtures: []},
  });
  const receipt = createProcedureVerificationReceipt(manifest, {
    hostVersion: 'host',
    threadnoteVersion: PRODUCTION_CAPTURE_CANDIDATE.version,
    verifiedAt: '2026-09-17T12:00:00.000Z',
    verifier: 'verifier',
  });
  return record('verified-procedures', 'procedure', {
    attempts: [
      {artifactText, manifest, statusInput: {capabilities: ['filesystem.read'], receipt, surfaceIds: ['terminal']}},
    ],
  });
}

function contextCheckRecord() {
  const boundary = (extra: Record<string, unknown>) => ({
    candidate: PRODUCTION_CAPTURE_CANDIDATE,
    digest: 'c'.repeat(64),
    ...extra,
  });
  return record('dirty-worktree', 'context-check', {
    graphEvidence: boundary({state: 'incomplete'}),
    readFence: boundary({state: 'unknown'}),
    repositoryEvidence: boundary({dirty: true}),
    reportJson: JSON.stringify({
      evidenceReason: 'graph-impact-evidence-unavailable',
      evidenceStatus: 'unavailable',
      exitClassification: 'clean-with-evidence-warning',
      exitCode: 0,
      findings: [],
      limit: 100,
      omittedFindings: 0,
      project: 'threadnote',
      version: 2,
    }),
  });
}

function migrationRecord() {
  const baseline = {
    commit: '80ca4acdb7347a4d00b0381f3757a5ac984d9fbf',
    executableSha256: '4'.repeat(64),
    id: 'threadnote-4.7.x' as const,
    version: '4.7.8',
  };
  const execution = (from: Threadnote5SourceV1, to: Threadnote5SourceV1, outcome: 'readable' | 'safe-refusal') => ({
    afterDigest: 'a'.repeat(64),
    beforeDigest: 'b'.repeat(64),
    from,
    outcome,
    protectedWriteCount: 0,
    to,
  });
  return record('upgrade-downgrade', 'migration', {
    baseline,
    candidate: PRODUCTION_CAPTURE_CANDIDATE,
    downgrade: execution(PRODUCTION_CAPTURE_CANDIDATE, baseline, 'safe-refusal'),
    upgrade: execution(baseline, PRODUCTION_CAPTURE_CANDIDATE, 'readable'),
  });
}

function guidanceRecord() {
  const previous = source('Previous rule.', 'previous-guidance');
  const sources = [source('Second rule.', 'a-guidance'), source('Rule.', 'Z-guidance')];
  const previousBlock = renderManagedGuidanceBlock([previous]);
  const block = renderManagedGuidanceBlock(sources);
  const receipt = (items: readonly ReturnType<typeof source>[], expectedManagedBlockHash: string) => ({
    expectedManagedBlockHash,
    previousManagedBlockHash: null,
    project: 'threadnote',
    removeTargetWhenEmpty: false,
    repositoryId: 'e'.repeat(64),
    sources: [...items]
      .sort((left, right) => (left.uri < right.uri ? -1 : left.uri > right.uri ? 1 : 0))
      .map(({contentHash, uri}) => ({contentHash, uri})),
    state: 'current' as const,
    targetIdentity: 'f'.repeat(64),
    targetPath: 'AGENTS.md',
    version: 2 as const,
    wrapperOwned: false,
  });
  const before = receipt([previous], sha256HexSync(previousBlock));
  const after = receipt(sources, sha256HexSync(block));
  const beforeText = `Unmanaged\n${previousBlock}`;
  return record('projection-drift', 'guidance', {
    after,
    afterText: upsertGuidanceBlock(beforeText, block),
    before,
    beforeText,
    candidate: PRODUCTION_CAPTURE_CANDIDATE,
    current: before,
    preview: after,
    sources,
    stalePrecondition: true,
  });
}

function source(text: string, topic: string) {
  return {
    contentHash: sha256HexSync(text),
    text,
    uri: `threadnote://user/test/memories/durable/projects/threadnote/${topic}.md`,
  };
}

function outputBudgetRecord() {
  const structuredContent = contextBriefContent();
  return record('output-budgets', 'context-brief', {
    attempts: [
      {
        event: {candidate: PRODUCTION_CAPTURE_CANDIDATE},
        request: {budgetTokens: 1_500, mode: 'brief', scope: {callerCwd: '/repo', kind: 'repository'}, task: 'x'},
        result: {structuredContent, text: renderContextBriefText(structuredContent)},
      },
    ],
  });
}

function contradictionRecord() {
  const input = {
    candidateEvidence: [
      {candidateId: 'candidate-a', comparison: 'contradiction' as const, project: 'threadnote'},
      {candidateId: 'candidate-b', comparison: 'possible_duplicate' as const, project: 'threadnote'},
    ],
    now: new Date('2026-09-17T00:00:00.000Z'),
    project: 'threadnote',
    records: [],
  };
  return healthRecord('contradiction-triage', input);
}

function staleCitationRecord() {
  const memory = memoryRecord('cited', 'Cited memory.');
  const now = new Date('2026-09-17T12:00:00.000Z');
  const receipt = (
    status: 'changed' | 'deleted' | 'unknown',
    reason: 'repository-unavailable' | 'source-changed' | 'source-deleted',
  ) => ({
    candidateCount: 0,
    citationId: `tncc_${status}`,
    coverage: status === 'unknown' ? ('incomplete' as const) : ('current-complete' as const),
    kind: 'file' as const,
    observedAt: now.toISOString(),
    reason,
    status,
    strategy: 'none' as const,
    validatorVersion: 1 as const,
  });
  return healthRecord('stale-citation', {
    citationValidations: [
      {
        receipts: [
          receipt('changed', 'source-changed'),
          receipt('deleted', 'source-deleted'),
          receipt('unknown', 'repository-unavailable'),
        ],
        uri: memory.uri,
      },
    ],
    now,
    project: 'threadnote',
    records: [memory],
  });
}

function healthRecord(scenario: 'contradiction-triage' | 'stale-citation', input: ContextHealthReportInputV1) {
  const report = buildContextHealthReport(input);
  return record(
    scenario,
    'context-health',
    jsonRoundTrip({repairs: [], reports: [{input: {...input, now: input.now.toISOString()}, report}]}),
  );
}

function healthMaintenanceRecord() {
  const repairs = Array.from({length: 10}, (_value, index) => healthRepair(index));
  const scheduleInput = {cadenceMinutes: 60, project: 'threadnote', teams: ['platform', 'runtime']};
  const aggregateInput = {
    personal: {reason: 'snapshot-unreadable' as const, scope: 'personal' as const, state: 'unknown' as const},
    project: 'threadnote',
    teams: scheduleInput.teams.map(team => ({
      reason: 'snapshot-unreadable' as const,
      scope: 'team' as const,
      state: 'unknown' as const,
      team,
    })),
  };
  const plan = buildContextHealthSchedulePlanV1(scheduleInput);
  return record(
    'health-maintenance',
    'context-health',
    jsonRoundTrip({
      aggregate: {aggregate: aggregateContextHealthReportsV1(aggregateInput), input: aggregateInput},
      repairs,
      reports: repairs.map(item => ({input: item.input, report: item.report})),
      schedule: {input: scheduleInput, observedArgv: ['threadnote', ...plan.argv], plan},
    }),
  );
}

function healthRepair(index: number) {
  const expired = memoryRecord(`expired-${index}`, `Expired ${index}.`, {validTo: '2026-09-16T00:00:00.000Z'});
  const input = {
    now: new Date(`2026-09-17T12:${String(index).padStart(2, '0')}:00.000Z`),
    project: 'threadnote',
    records: [expired],
  };
  const report = buildContextHealthReport(input);
  const plan = previewContextHealthRepairPlanV1(report, input.records);
  const proposal = plan.proposals[0];
  if (proposal === undefined) throw new Error('Health fixture has no repair proposal.');
  const applied = applyContextHealthRepairProposalV1({
    expectedRevision: proposal.revision,
    proposal,
    records: input.records,
  });
  if (applied.status !== 'applied') throw new Error('Health fixture repair did not apply.');
  return {input: {...input, now: input.now.toISOString()}, plan, proposal, receipt: applied.receipt, report};
}

function memoryRecord(topic: string, body: string, metadata: Partial<MemoryMetadata> = {}): MemoryRecord {
  const complete: MemoryMetadata = {
    kind: 'durable',
    project: 'threadnote',
    sourceAgentClient: 'codex',
    status: 'active',
    timestamp: '2026-09-01T00:00:00.000Z',
    topic,
    ...metadata,
  };
  const uri = `threadnote://user/me/memories/durable/projects/threadnote/${topic}.md`;
  const parsed = parseMemoryDocument(uri, formatMemoryDocument('MEMORY', complete, body));
  if (parsed === undefined) throw new Error('Fixture memory is invalid.');
  return parsed;
}

function authorityManifestFor(
  records: readonly Threadnote5LocalSubsystemReceiptRecordV1[],
): Threadnote5LocalAuthorityManifestV1 {
  const entries: Threadnote5LocalAuthorityEntryV1[] = [];
  for (const item of records) {
    if (item.kind === 'activation') entries.push(activationAuthority(item));
    else if (item.kind === 'context-brief' && item.scenario === 'solo') entries.push(contextBriefAuthority(item));
    else if (item.kind === 'value-report') entries.push(valueReportAuthority(item));
    else if (item.kind === 'git-proposal') entries.push(proposalAuthority(item));
    else if (item.kind === 'procedure') entries.push(procedureAuthority(item));
    else if (item.kind === 'context-health' && item.scenario === 'health-maintenance')
      entries.push(healthAuthority(item));
    else if (item.kind === 'context-check')
      entries.push({
        assertions: ['dirty-evidence-not-current', 'outcome-unknown'],
        recordDigest: item.digest,
        type: 'context-check-read-fence',
      });
    else if (item.kind === 'migration')
      entries.push({
        assertions: ['migration-runtime-executed'],
        recordDigest: item.digest,
        type: 'migration-execution',
      });
    else if (item.kind === 'guidance')
      entries.push({
        assertions: ['stale-precondition-rejected'],
        recordDigest: item.digest,
        type: 'guidance-stale-precondition-rejection',
      });
  }
  return {candidate: PRODUCTION_CAPTURE_CANDIDATE, entries, version: 1};
}

function activationAuthority(item: Threadnote5LocalSubsystemReceiptRecordV1): Threadnote5LocalAuthorityEntryV1 {
  const trials = (item.artifact as {readonly trials: readonly Record<string, unknown>[]}).trials;
  return {
    recordDigest: item.digest,
    trials: trials.map(trial => {
      const state = trial.state as {
        readonly plan: {readonly activationId: string};
        readonly receipt: {readonly revision: string};
      };
      const challenge = (trial.secondSurface as {readonly challenge?: unknown} | undefined)?.challenge;
      return {
        activationId: state.plan.activationId,
        attestationDigest: challenge === undefined ? null : threadnote5ActivationAttestationDigest(challenge),
        finalReceiptRevision: state.receipt.revision,
        offlineObservationDigest:
          trial.offlineObservation === undefined
            ? null
            : threadnote5ActivationOfflineObservationDigest(trial.offlineObservation),
        resumeBoundaryRevision: typeof trial.resumeBoundaryRevision === 'string' ? trial.resumeBoundaryRevision : null,
      };
    }),
    type: 'activation-verification',
  };
}

function contextBriefAuthority(item: Threadnote5LocalSubsystemReceiptRecordV1): Threadnote5LocalAuthorityEntryV1 {
  const attempts = (item.artifact as {readonly attempts: readonly unknown[]}).attempts;
  return {
    recordDigest: item.digest,
    trials: attempts.map(attempt => ({
      attemptDigest: threadnote5ContextBriefAttemptDigest(attempt),
      firstPlanCorrect: true,
      firstPlanSourceCited: true,
    })),
    type: 'context-brief-plan-citation',
  };
}

function valueReportAuthority(item: Threadnote5LocalSubsystemReceiptRecordV1): Threadnote5LocalAuthorityEntryV1 {
  const trials = (
    item.artifact as {
      readonly feedbackTrials: readonly {
        readonly event: unknown;
        readonly laneId: string;
        readonly offlineObservation: unknown | null;
      }[];
    }
  ).feedbackTrials;
  return {
    recordDigest: item.digest,
    trials: trials.map(trial => ({
      feedbackEventDigest: threadnote5RecallFeedbackEventDigest(trial.event),
      laneId: trial.laneId,
      offlineObservationDigest:
        trial.offlineObservation === null
          ? null
          : threadnote5ValueReportOfflineObservationDigest(trial.offlineObservation),
    })),
    type: 'value-report-verification',
  };
}

function proposalAuthority(item: Threadnote5LocalSubsystemReceiptRecordV1): Threadnote5LocalAuthorityEntryV1 {
  const attempts = (item.artifact as {readonly attempts: readonly Record<string, unknown>[]}).attempts;
  return {
    recordDigest: item.digest,
    trials: attempts.map(attempt => {
      const proposal = attempt.proposal as {readonly proposalHash: string};
      const candidateReview = attempt.review as CandidateReview;
      const input = attempt.input as {
        readonly mutations: readonly {
          readonly approval: {readonly expectedSourceContentHash: string};
          readonly candidateId: string;
          readonly sourceUri: string;
        }[];
      };
      return {
        approvals: input.mutations.map(mutation => {
          const event = candidateReview.auditEvents.find(
            candidate => candidate.action === 'apply' && candidate.candidateId === mutation.candidateId,
          );
          if (event === undefined) throw new Error('Proposal fixture lacks apply audit.');
          return {
            applyAuditDigest: threadnote5ApplyAuditDigest(event),
            approvedContentHash: mutation.approval.expectedSourceContentHash,
            candidateId: mutation.candidateId,
            sourceUriHash: threadnote5ApprovedSourceUriHash(mutation.sourceUri),
          };
        }),
        proposalHash: proposal.proposalHash,
        providerApiCallCount: 0,
        reviewId: candidateReview.reviewId,
        revision: candidateReview.revision,
      };
    }),
    type: 'git-proposal-review',
  };
}

function procedureAuthority(item: Threadnote5LocalSubsystemReceiptRecordV1): Threadnote5LocalAuthorityEntryV1 {
  const attempt = (item.artifact as {readonly attempts: readonly Record<string, unknown>[]}).attempts[0];
  const manifest = parseProcedureManifest(attempt.manifest);
  return {
    artifactId: manifest.artifact.id,
    automaticExecutionCount: 0,
    commandResults: manifest.verification.commands.map(command => ({
      commandId: command.id,
      exitCode: 0,
      outputDigest: sha256HexSync(`verified-output:${command.id}`),
    })),
    receiptDigest: threadnote5ProcedureVerificationReceiptDigest(
      (attempt.statusInput as {readonly receipt: unknown}).receipt,
    ),
    recordDigest: item.digest,
    semanticVersion: manifest.artifact.semanticVersion,
    type: 'procedure-verification',
  };
}

function healthAuthority(item: Threadnote5LocalSubsystemReceiptRecordV1): Threadnote5LocalAuthorityEntryV1 {
  const teams = (
    item.artifact as {readonly aggregate: {readonly input: {readonly teams: readonly {readonly team: string}[]}}}
  ).aggregate.input.teams;
  return {
    aggregate: {
      networkActivityCount: 0,
      teamSnapshots: teams.map((source, index) => ({
        postHead: String(index + 1).repeat(40),
        postIndexDigest: String(index + 3).repeat(64),
        postWorktreeDigest: String(index + 5).repeat(64),
        preHead: String(index + 1).repeat(40),
        preIndexDigest: String(index + 3).repeat(64),
        preWorktreeDigest: String(index + 5).repeat(64),
        team: source.team,
      })),
      writeActivityCount: 0,
    },
    recordDigest: item.digest,
    schedule: {networkActivityCount: 0, writeActivityCount: 0},
    type: 'context-health-read-only',
  };
}

function record(
  scenario: Threadnote5LocalSubsystemReceiptRecordV1['scenario'],
  kind: Threadnote5LocalSourceKindV1,
  artifact: unknown,
): Threadnote5LocalSubsystemReceiptRecordV1 {
  const unsigned = {artifact, candidate: PRODUCTION_CAPTURE_CANDIDATE, kind, scenario, version: 1 as const};
  try {
    return {...unsigned, digest: threadnote5LocalSubsystemReceiptDigest(unsigned)};
  } catch (cause) {
    throw new Error(`Could not seal ${scenario}/${kind} fixture record.`, {cause});
  }
}

function jsonRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
