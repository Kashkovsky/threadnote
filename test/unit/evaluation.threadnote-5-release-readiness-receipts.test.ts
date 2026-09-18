import {canonicalJson} from '../../src/code_graph/checkpoint/canonical_json.js';
import {sha256HexSync} from '../../src/crypto/sha256.js';
import {
  threadnote5ActivationAttestationDigest,
  threadnote5ActivationOfflineObservationDigest,
  threadnote5ApplyAuditDigest,
  threadnote5ApprovedSourceUriHash,
  threadnote5ContextBriefAttemptDigest,
  threadnote5LocalAuthorityManifestHash,
  threadnote5ProcedureVerificationReceiptDigest,
  threadnote5RecallFeedbackEventDigest,
  threadnote5ValueReportOfflineObservationDigest,
  type Threadnote5LocalAuthorityEntryV1,
  type Threadnote5LocalAuthorityManifestV1,
} from '../../src/evaluation/threadnote-5-release-readiness-authority.js';
import {
  THREADNOTE_5_BASELINE_COMMIT,
  THREADNOTE_5_BASELINE_VERSION,
  threadnote5ObservationReceiptHash,
  threadnote5ObservationTranscriptHash,
  threadnote5SourceHash,
  type Threadnote5MeasurementV1,
  type Threadnote5ObservationV1,
  type Threadnote5ReleaseScenario,
  type Threadnote5SourceV1,
} from '../../src/evaluation/threadnote-5-release-readiness-contract.js';
import {
  deriveThreadnote5LocalScenarioClaims,
  threadnote5LocalReceiptVerificationArtifact,
  threadnote5LocalSubsystemReceiptDigest,
  verifyThreadnote5LocalSubsystemReceipts,
  type Threadnote5LocalSourceKindV1,
  type Threadnote5LocalSubsystemReceiptRecordV1,
} from '../../src/evaluation/threadnote-5-release-readiness-receipts.js';
import {buildKnowledgeDeltaGitProposalV1} from '../../src/git_proposal/knowledge_delta.js';
import {type CandidateReview} from '../../src/memory/candidate.js';
import {buildContextHealthReport} from '../../src/memory/context_health.js';
import {
  aggregateContextHealthReportsV1,
  buildContextHealthSchedulePlanV1,
} from '../../src/memory/context_health_schedule.js';
import {canonicalMemoryDocumentContent} from '../../src/memory/document.js';
import {projectKnowledgeDeltaV1} from '../../src/memory/knowledge_delta.js';
import {createProcedureVerificationReceipt, parseProcedureManifest} from '../../src/procedure/contract.js';
import {aggregateValueReportV1} from '../../src/value_report/index.js';
import {activationValueEventsV1} from '../../src/activation/value.js';
import {
  activationReceiptRevisionV1,
  activationReceiptStatusV1,
  type ActivationReceiptV1,
} from '../../src/activation/contract.js';
import {createActivationPlanV1} from '../../src/activation/planner.js';
import {
  bindActivationApprovalV1,
  createActivationReceiptV1,
  recordActivationOutcomeV1,
} from '../../src/activation/receipt.js';
import {
  completeSecondSurfaceProofV1,
  secondSurfaceProofHashV1,
  secondSurfaceProofContextHashV1,
  type SecondSurfaceProofContextV1,
  type SecondSurfaceReadObservationV1,
  type SecondSurfaceRecallObservationV1,
} from '../../src/activation/second_surface.js';
import {secondSurfaceChallengeIdV1} from '../../src/activation/second_surface_store.js';
import {summarizeLocalValueEvents} from '../../src/value_report/events.js';
import {renderManagedGuidanceBlock} from '../../src/guidance/index.js';
import {parseContextBriefV1, renderContextBriefText} from '../../src/context_brief/projector.js';
import {measureAgentToolResponse} from '../../src/evaluation/agent-response.js';
import * as fc from 'fast-check';
import {describe, expect, it} from 'vitest';

const CANDIDATE: Threadnote5SourceV1 = {
  commit: '1'.repeat(40),
  executableSha256: '2'.repeat(64),
  id: 'threadnote-5.0.0',
  version: `5.0.0-local.g${'1'.repeat(40)}`,
};

describe('Threadnote 5 source-native receipt verification', () => {
  it('replays current procedure evidence and rejects artifact or transcript tampering', () => {
    const record = procedureRecord();
    const observation = observed(record, [
      'procedure-receipt-current',
      'procedure-dependencies-compatible',
      'procedure-never-auto-executed',
    ]);
    expect(verify([observation], [record])).toMatchObject({receiptCount: 1, state: 'verified'});
    expect(
      verifyThreadnote5LocalSubsystemReceipts({
        candidate: CANDIDATE,
        observations: [observation],
        retainedRecords: [record],
      }),
    ).toMatchObject({reason: 'verifier-incomplete', state: 'unknown'});
    expect(verify([observation], [record], authorityManifestFor([record]), 'f'.repeat(64))).toMatchObject({
      reason: 'records-invalid',
      state: 'unknown',
    });

    const tampered = resealRecord(record, {
      ...(record.artifact as {readonly attempts: readonly unknown[]}),
      attempts: [
        {
          ...((record.artifact as {readonly attempts: readonly Record<string, unknown>[]}).attempts[0] ?? {}),
          artifactText: 'changed',
        },
      ],
    });
    expect(verify([observed(tampered, observationAssertions(observation))], [tampered])).toMatchObject({
      reason: 'records-invalid',
      state: 'unknown',
    });

    const claimMismatch = observed(record, ['procedure-receipt-current']);
    expect(verify([claimMismatch], [record])).toMatchObject({reason: 'records-mismatched', state: 'unknown'});

    const authority = authorityManifestFor([record]);
    const procedureEntry = authority.entries[0];
    if (procedureEntry?.type !== 'procedure-verification') throw new Error('Expected procedure authority.');
    expect(
      verify([observation], [record], {
        ...authority,
        entries: [{...procedureEntry, automaticExecutionCount: 1}],
      }),
    ).toMatchObject({reason: 'records-invalid', state: 'unknown'});
  });

  it('strictly replays ten structured closeouts and rejects malformed reviews', () => {
    const record = closeoutRecord();
    const observation = observed(
      record,
      [
        'decisions-rationale-present',
        'constraints-present',
        'verification-present',
        'invalidations-present',
        'unresolved-risks-present',
      ],
      [{eligibleCount: 10, id: 'knowledge-delta-completion-rate', positiveCount: 10}],
    );
    expect(verify([observation], [record])).toMatchObject({receiptCount: 1, state: 'verified'});

    const malformed = resealRecord(record, {reviews: [{candidates: [{}], version: 2}]});
    expect(
      verify(
        [observed(malformed, observationAssertions(observation), observation.transcript.measurements)],
        [malformed],
      ),
    ).toMatchObject({
      reason: 'records-invalid',
      state: 'unknown',
    });

    const reviewWithBlankItems = review(20);
    const blank = resealRecord(record, {
      reviews: [
        {...reviewWithBlankItems, structuredCloseout: {...reviewWithBlankItems.structuredCloseout!, constraints: ['']}},
      ],
    });
    expect(
      verify([observed(blank, observationAssertions(observation), observation.transcript.measurements)], [blank]),
    ).toMatchObject({reason: 'records-invalid', state: 'unknown'});

    const reviewWithExtra = review(21);
    const extra = resealRecord(record, {
      reviews: [
        {...reviewWithExtra, structuredCloseout: {...reviewWithExtra.structuredCloseout!, extra: 'unsupported'}},
      ],
    });
    expect(
      verify([observed(extra, observationAssertions(observation), observation.transcript.measurements)], [extra]),
    ).toMatchObject({reason: 'records-invalid', state: 'unknown'});
  });

  it('reconstructs provider-neutral proposals from apply/audit evidence and rejects self-approval', () => {
    const record = proposalRecord();
    const observation = observed(
      record,
      ['provider-apis-zero', 'proposal-provider-neutral', 'proposal-review-approved'],
      [{eligibleCount: 10, id: 'knowledge-delta-completion-rate', positiveCount: 10}],
    );
    expect(verify([observation], [record])).toMatchObject({receiptCount: 1, state: 'verified'});

    const artifact = record.artifact as {readonly attempts: readonly Record<string, unknown>[]};
    const first = artifact.attempts[0];
    const review = first.review as CandidateReview;
    const forgedReview = {
      ...review,
      candidates: review.candidates.map((candidate, index) =>
        index === 0 ? {...candidate, applyContentHash: 'f'.repeat(64)} : candidate,
      ),
    };
    const forged = resealRecord(record, {
      attempts: [{...first, review: forgedReview}, ...artifact.attempts.slice(1)],
    });
    expect(
      verify([observed(forged, observationAssertions(observation), observation.transcript.measurements)], [forged]),
    ).toMatchObject({
      reason: 'records-invalid',
      state: 'unknown',
    });

    const authority = authorityManifestFor([record]);
    const proposalEntry = authority.entries[0];
    if (proposalEntry?.type !== 'git-proposal-review') throw new Error('Expected Git proposal authority.');
    const providerCall = {
      ...authority,
      entries: [
        {
          ...proposalEntry,
          trials: proposalEntry.trials.map((trial, index) =>
            index === 0 ? {...trial, providerApiCallCount: 1} : trial,
          ),
        },
      ],
    };
    expect(verify([observation], [record], providerCall)).toMatchObject({
      reason: 'records-invalid',
      state: 'unknown',
    });
  });

  it('derives ValueReport reuse/count lanes but keeps unlinked activation evidence unknown', () => {
    const record = valueReportRecord();
    const observation = observed(
      record,
      ['two-surfaces-connected', 'second-surface-reused-decision'],
      [
        {eligibleCount: 10, id: 'wrong-memory-rate', positiveCount: 0},
        {eligibleCount: 10, id: 'second-agent-reuse-rate', positiveCount: 10},
      ],
    );
    expect(verify([observation], [record])).toMatchObject({reason: 'verifier-incomplete', state: 'unknown'});
    expect(verify([observation], [record]).scenarios).toEqual([
      {
        missingKinds: ['activation', 'activation-value-linkage', 'cross-record-correlation'],
        scenario: 'two-agent',
        state: 'unknown',
        verifiedKinds: ['value-report'],
      },
    ]);

    const artifact = record.artifact as {readonly captures: readonly Record<string, unknown>[]};
    const capture = artifact.captures[0];
    const input = capture.input as Record<string, unknown>;
    const invalid = resealRecord(record, {
      captures: [
        {...capture, input: {...input, counts: {setup: {started: 0, supportedAgentReuse: 1}}}},
        ...artifact.captures.slice(1),
      ],
    });
    expect(
      verify([observed(invalid, observationAssertions(observation), observation.transcript.measurements)], [invalid]),
    ).toMatchObject({
      reason: 'records-invalid',
      state: 'unknown',
    });
  });

  it('rejects ValueReport feedback trials filtered by timestamp or project scope', () => {
    const record = valueReportRecord();
    const artifact = record.artifact as {
      readonly captures: readonly {readonly input: Record<string, unknown>; readonly report: unknown}[];
      readonly feedbackTrials: readonly {
        readonly event: Record<string, unknown>;
        readonly laneId: string;
        readonly offlineObservation: null;
      }[];
    };
    const firstInput = artifact.captures[0].input as {
      readonly feedbackEvents: readonly Record<string, unknown>[];
      readonly period: unknown;
    };
    const timestampInput = {
      ...firstInput,
      feedbackEvents: [{...firstInput.feedbackEvents[0], timestamp: '2026-09-18T00:00:00.000Z'}],
    };
    const timestampFiltered = resealRecord(record, {
      ...artifact,
      captures: [
        {
          input: timestampInput,
          report: aggregateValueReportV1(timestampInput as unknown as Parameters<typeof aggregateValueReportV1>[0]),
        },
        ...artifact.captures.slice(1),
      ],
      feedbackTrials: [
        {...artifact.feedbackTrials[0], event: timestampInput.feedbackEvents[0]},
        ...artifact.feedbackTrials.slice(1),
      ],
    });
    expect(
      verify(
        [observed(timestampFiltered, ['two-surfaces-connected', 'second-surface-reused-decision'])],
        [timestampFiltered],
      ),
    ).toMatchObject({reason: 'records-invalid', state: 'unknown'});

    const projectInput = {
      ...firstInput,
      feedbackEvents: [{...firstInput.feedbackEvents[0], project: 'other-project'}],
      project: 'threadnote',
    };
    const projectFiltered = resealRecord(record, {
      ...artifact,
      captures: [
        {
          input: projectInput,
          report: aggregateValueReportV1(projectInput as unknown as Parameters<typeof aggregateValueReportV1>[0]),
        },
        ...artifact.captures.slice(1),
      ],
      feedbackTrials: [
        {...artifact.feedbackTrials[0], event: projectInput.feedbackEvents[0]},
        ...artifact.feedbackTrials.slice(1),
      ],
    });
    expect(
      verify(
        [observed(projectFiltered, ['two-surfaces-connected', 'second-surface-reused-decision'])],
        [projectFiltered],
      ),
    ).toMatchObject({reason: 'records-invalid', state: 'unknown'});
  });

  it('correlates the activation proof, second-surface recall, and raw value events', () => {
    const journey = activationJourneyFixture();
    const activation = makeRecord('two-agent', 'activation', {trials: [journey.activationTrial]});
    const recall = makeRecord('two-agent', 'recall', {trials: [{proof: journey.proof}]});
    const value = makeRecord(
      'two-agent',
      'value-report',
      activationValueArtifact(journey.plan, journey.finalReceipt, journey.proof.proofHash),
    );
    const assertions = [
      'two-surfaces-connected',
      'second-surface-reused-decision',
      'activation-receipt-reused-by-value-report',
    ];
    const measurements = [
      {eligibleCount: 1, id: 'wrong-memory-rate', positiveCount: 0},
      {eligibleCount: 1, id: 'second-agent-reuse-rate', positiveCount: 1},
    ] as const;
    const receipts = [
      {digest: recall.digest, kind: recall.kind},
      {digest: value.digest, kind: value.kind},
    ];
    const observation = observed(activation, assertions, measurements, receipts);
    const records = [activation, recall, value];
    expect(verify([observation], records)).toMatchObject({receiptCount: 3, state: 'verified'});

    const authority = authorityManifestFor(records);
    const activationAuthority = authority.entries.find(entry => entry.type === 'activation-verification');
    if (activationAuthority?.type !== 'activation-verification') throw new Error('Expected activation authority.');
    const wrongAuthority: Threadnote5LocalAuthorityManifestV1 = {
      ...authority,
      entries: [
        {
          ...activationAuthority,
          trials: activationAuthority.trials.map(trial => ({...trial, attestationDigest: '0'.repeat(64)})),
        },
      ],
    };
    expect(verify([observation], records, wrongAuthority)).toMatchObject({reason: 'records-invalid', state: 'unknown'});

    const {proofHash: _, ...proofBody} = journey.proof;
    const unrelatedBody = {...proofBody, activationId: 'c'.repeat(64)};
    const unrelatedProof = {...unrelatedBody, proofHash: secondSurfaceProofHashV1(unrelatedBody)};
    const unrelatedRecall = makeRecord('two-agent', 'recall', {trials: [{proof: unrelatedProof}]});
    const uncorrelatedObservation = observed(activation, assertions, measurements, [
      {digest: unrelatedRecall.digest, kind: unrelatedRecall.kind},
      {digest: value.digest, kind: value.kind},
    ]);
    expect(verify([uncorrelatedObservation], [activation, unrelatedRecall, value]).scenarios).toEqual([
      {
        missingKinds: ['cross-record-correlation'],
        scenario: 'two-agent',
        state: 'unknown',
        verifiedKinds: ['activation', 'recall', 'value-report'],
      },
    ]);

    const valueArtifact = value.artifact as {
      readonly activationTrials: readonly Record<string, unknown>[];
      readonly captures: readonly unknown[];
    };
    const activationTrial = valueArtifact.activationTrials[0];
    const events = activationTrial.events as readonly Record<string, unknown>[];
    const tamperedValue = resealRecord(value, {
      activationTrials: [
        {
          ...activationTrial,
          events: events.map((event, index) => (index === 0 ? {...event, durationMilliseconds: 1} : event)),
        },
      ],
      captures: valueArtifact.captures,
    });
    const tamperedObservation = observed(activation, assertions, measurements, [
      {digest: recall.digest, kind: recall.kind},
      {digest: tamperedValue.digest, kind: tamperedValue.kind},
    ]);
    expect(verify([tamperedObservation], [activation, recall, tamperedValue])).toMatchObject({
      reason: 'records-invalid',
      state: 'unknown',
    });

    const forgedReceipt = {
      ...journey.finalReceipt,
      operations: journey.finalReceipt.operations.map((operation, index) =>
        index === 0 ? {...operation, subsystemReceiptHash: '0'.repeat(64)} : operation,
      ),
    };
    const forgedValue = makeRecord(
      'two-agent',
      'value-report',
      activationValueArtifact(journey.plan, forgedReceipt, journey.proof.proofHash),
    );
    const forgedValueObservation = observed(activation, assertions, measurements, [
      {digest: recall.digest, kind: recall.kind},
      {digest: forgedValue.digest, kind: forgedValue.kind},
    ]);
    expect(verify([forgedValueObservation], [activation, recall, forgedValue])).toMatchObject({
      reason: 'records-invalid',
      state: 'unknown',
    });

    const unrelatedJourney = activationJourneyFixture('c'.repeat(64));
    const unrelatedValue = makeRecord(
      'two-agent',
      'value-report',
      activationValueArtifact(unrelatedJourney.plan, unrelatedJourney.finalReceipt, unrelatedJourney.proof.proofHash),
    );
    const unrelatedValueObservation = observed(activation, assertions, measurements, [
      {digest: recall.digest, kind: recall.kind},
      {digest: unrelatedValue.digest, kind: unrelatedValue.kind},
    ]);
    expect(verify([unrelatedValueObservation], [activation, recall, unrelatedValue]).scenarios).toEqual([
      {
        missingKinds: ['cross-record-correlation'],
        scenario: 'two-agent',
        state: 'unknown',
        verifiedKinds: ['activation', 'recall', 'value-report'],
      },
    ]);
  });

  it('correlates a Git publication receipt with the retrieved shared decision', () => {
    const journey = activationJourneyFixture();
    const sharing = makeRecord('git-shared', 'sharing', {
      trials: [{decision: journey.decision, plan: journey.plan, receipt: journey.publicationReceipt}],
    });
    const recall = makeRecord('git-shared', 'recall', {trials: [{proof: journey.proof}]});
    const observation = observed(
      sharing,
      ['git-shared-decision-retrieved'],
      [],
      [{digest: recall.digest, kind: recall.kind}],
    );
    expect(verify([observation], [sharing, recall])).toMatchObject({receiptCount: 2, state: 'verified'});

    const {proofHash: _, ...proofBody} = journey.proof;
    const unrelatedBody = {...proofBody, decisionContentHash: '0'.repeat(64)};
    const unrelatedProof = {...unrelatedBody, proofHash: secondSurfaceProofHashV1(unrelatedBody)};
    const unrelatedRecall = makeRecord('git-shared', 'recall', {trials: [{proof: unrelatedProof}]});
    const uncorrelated = observed(
      sharing,
      ['git-shared-decision-retrieved'],
      [],
      [{digest: unrelatedRecall.digest, kind: unrelatedRecall.kind}],
    );
    expect(verify([uncorrelated], [sharing, unrelatedRecall]).scenarios).toEqual([
      {
        missingKinds: ['cross-record-correlation'],
        scenario: 'git-shared',
        state: 'unknown',
        verifiedKinds: ['recall', 'sharing'],
      },
    ]);
  });

  it('requires independently bound zero-network evidence for offline activation', () => {
    const artifact = activationSoloArtifact();
    const trial = artifact.trials[0];
    const first = trial.receiptChain[0];
    const last = trial.receiptChain.at(-1);
    if (last === undefined) throw new Error('Expected the activation fixture to contain a receipt.');
    const offlineObservation = {
      afterAttemptCount: 0,
      afterRevision: last.revision,
      beforeAttemptCount: 0,
      beforeRevision: first.revision,
    };
    const record = makeRecord('offline', 'activation', {
      trials: [{...trial, offlineObservation}],
    });
    const observation = observed(record, ['local-flow-complete', 'network-attempts-zero']);
    expect(verify([observation], [record])).toMatchObject({state: 'verified'});

    const tampered = resealRecord(record, {
      trials: [{...trial, offlineObservation: {...offlineObservation, afterAttemptCount: 1}}],
    });
    expect(verify([observed(tampered, observationAssertions(observation))], [tampered])).toMatchObject({
      reason: 'records-invalid',
      state: 'unknown',
    });

    const pendingPlan = createActivationPlanV1({
      catalogSnapshotHash: 'a'.repeat(64),
      primarySurfaceId: 'codex-cli',
      publicationMode: 'direct',
      repositoryIdentityHash: '3'.repeat(64),
      secondarySurfaceId: 'claude-code',
      selectedSourceSetHash: 'c'.repeat(64),
      taskHash: 'd'.repeat(64),
      teamId: 'default',
      teamShareStateHash: 'e'.repeat(64),
      threadnoteVersion: '5.0.0-test',
    });
    const pendingReceipt = createActivationReceiptV1(pendingPlan, '2026-09-18T09:00:00.000Z');
    const pending = makeRecord('offline', 'activation', {
      trials: [
        {
          approvals: [],
          offlineObservation: {
            afterAttemptCount: 0,
            afterRevision: pendingReceipt.revision,
            beforeAttemptCount: 0,
            beforeRevision: pendingReceipt.revision,
          },
          receiptChain: [pendingReceipt],
          state: {plan: pendingPlan, receipt: pendingReceipt},
        },
      ],
    });
    expect(verify([observed(pending, ['local-flow-complete', 'network-attempts-zero'])], [pending])).toMatchObject({
      reason: 'records-invalid',
      state: 'unknown',
    });
  });

  it('requires an intermediate retained receipt as the interrupted-resume boundary', () => {
    const artifact = activationSoloArtifact();
    const trial = artifact.trials[0];
    const boundary = trial.receiptChain[Math.floor(trial.receiptChain.length / 2)];
    const record = makeRecord('interrupted-resumed', 'activation', {
      trials: [{...trial, resumeBoundaryRevision: boundary.revision}],
    });
    const observation = observed(record, ['completed-step-not-repeated', 'resume-receipt-accepted']);
    expect(verify([observation], [record])).toMatchObject({state: 'verified'});

    const initialBoundary = resealRecord(record, {
      trials: [{...trial, resumeBoundaryRevision: trial.receiptChain[0].revision}],
    });
    expect(verify([observed(initialBoundary, observationAssertions(observation))], [initialBoundary])).toMatchObject({
      reason: 'records-invalid',
      state: 'unknown',
    });
  });

  it('keeps static safety sources singular beside measured scenario sources', () => {
    const artifact = activationSoloArtifact();
    const trial = artifact.trials[0];
    const boundary = trial.receiptChain[Math.floor(trial.receiptChain.length / 2)];
    const activation = makeRecord('interrupted-resumed', 'activation', {
      trials: [{...trial, resumeBoundaryRevision: boundary.revision}],
    });
    const closeout = makeRecord('interrupted-resumed', 'closeout', {
      reviews: Array.from({length: 10}, (_value, index) => review(index + 30)),
    });
    const authorityManifest = authorityManifestFor([activation, closeout]);
    const derived = deriveThreadnote5LocalScenarioClaims({
      authorityManifest,
      candidate: CANDIDATE,
      expectedAuthorityManifestSha256: threadnote5LocalAuthorityManifestHash(authorityManifest),
      retainedRecords: [closeout, activation],
    });

    expect(derived.scenarios).toMatchObject([
      {
        metricContributingKinds: ['closeout'],
        missingKinds: [],
        scenario: 'interrupted-resumed',
      },
    ]);
  });

  it('requires the complete activation receipt chain rather than trusting a terminal receipt', () => {
    const artifact = activationSoloArtifact();
    const record = makeRecord('solo', 'activation', artifact);
    const observation = observed(
      record,
      ['local-setup-complete'],
      [{eligibleCount: 1, id: 'setup-success-rate', positiveCount: 1}],
    );
    expect(verify([observation], [record])).toMatchObject({state: 'verified'});

    const chain = artifact.trials[0].receiptChain;
    fc.assert(
      fc.property(fc.integer({min: 1, max: chain.length - 2}), omitted => {
        const tampered = resealRecord(record, {
          trials: [
            {
              ...artifact.trials[0],
              receiptChain: chain.filter((_receipt, index) => index !== omitted),
            },
          ],
        });
        expect(
          verify(
            [
              observed(
                tampered,
                ['local-setup-complete'],
                [{eligibleCount: 1, id: 'setup-success-rate', positiveCount: 1}],
              ),
            ],
            [tampered],
          ),
        ).toMatchObject({reason: 'records-invalid', state: 'unknown'});
      }),
      {numRuns: 20},
    );

    const trial = artifact.trials[0];
    const approval = trial.approvals[0];
    const invalidApproval = resealRecord(record, {
      trials: [{...trial, approvals: [{...approval, reviewRevisionHash: '0'.repeat(64)}, ...trial.approvals.slice(1)]}],
    });
    expect(
      verify(
        [
          observed(
            invalidApproval,
            ['local-setup-complete'],
            [{eligibleCount: 1, id: 'setup-success-rate', positiveCount: 1}],
          ),
        ],
        [invalidApproval],
      ),
    ).toMatchObject({reason: 'records-invalid', state: 'unknown'});

    const initial = trial.receiptChain[0];
    const {revision: _, ...initialBody} = initial;
    const impossibleInitialBody = {
      ...initialBody,
      updatedAt: new Date(Date.parse(initial.updatedAt) + 1_000).toISOString(),
    };
    const impossibleInitial = {
      ...impossibleInitialBody,
      revision: activationReceiptRevisionV1(impossibleInitialBody),
    };
    const forgedInitial = resealRecord(record, {
      trials: [
        {
          approvals: [],
          receiptChain: [impossibleInitial],
          state: {plan: trial.state.plan, receipt: impossibleInitial},
        },
      ],
    });
    expect(
      verify(
        [
          observed(
            forgedInitial,
            ['local-setup-complete'],
            [{eligibleCount: 1, id: 'setup-success-rate', positiveCount: 1}],
          ),
        ],
        [forgedInitial],
      ),
    ).toMatchObject({reason: 'records-invalid', state: 'unknown'});

    fc.assert(
      fc.property(fc.integer({min: 1, max: chain.length - 2}), operationIndex => {
        const initial = chain[0];
        const source = chain[operationIndex + 1];
        const operations = initial.operations.map((operation, index) =>
          index === operationIndex ? source.operations[index] : operation,
        );
        const body: Omit<ActivationReceiptV1, 'revision'> = {
          activationId: initial.activationId,
          generation: 1,
          operations,
          planHash: initial.planHash,
          previousRevision: initial.revision,
          startedAt: initial.startedAt,
          status: activationReceiptStatusV1(operations),
          type: initial.type,
          updatedAt: source.updatedAt,
          version: initial.version,
          ...(source.firstBrief === undefined ? {} : {firstBrief: source.firstBrief}),
        };
        const forged = {...body, revision: activationReceiptRevisionV1(body)};
        const tampered = resealRecord(record, {
          trials: [
            {
              approvals: [],
              receiptChain: [initial, forged],
              state: {plan: artifact.trials[0].state.plan, receipt: forged},
            },
          ],
        });
        expect(
          verify(
            [
              observed(
                tampered,
                ['local-setup-complete'],
                [{eligibleCount: 1, id: 'setup-success-rate', positiveCount: 1}],
              ),
            ],
            [tampered],
          ),
        ).toMatchObject({reason: 'records-invalid', state: 'unknown'});
      }),
      {numRuns: 20},
    );
  });

  it('rebuilds context-health findings from source inputs and detects report tampering', () => {
    const record = contextHealthRecord();
    const observation = observed(record, [
      'contradiction-category-observed',
      'possible-duplicate-category-observed',
      'manual-review-required',
      'ordering-stable',
    ]);
    expect(verify([observation], [record])).toMatchObject({receiptCount: 1, state: 'verified'});

    const artifact = record.artifact as {readonly reports: readonly Record<string, unknown>[]};
    const capture = artifact.reports[0];
    const report = capture.report as Record<string, unknown>;
    const tampered = resealRecord(record, {
      repairs: [],
      reports: [{...capture, report: {...report, status: 'clean'}}],
    });
    expect(verify([observed(tampered, observationAssertions(observation))], [tampered])).toMatchObject({
      reason: 'records-invalid',
      state: 'unknown',
    });
  });

  it('replays read-only scheduled configured-team health evidence only with its bound authority', () => {
    const record = healthMaintenanceRecord();
    const assertions = ['local-scheduled-invocation-read-only', 'configured-git-team-aggregation-read-only'];
    const observation = observed(record, assertions, [
      {eligibleCount: 0, id: 'health-resolution-rate', positiveCount: 0},
    ]);
    const authority = authorityManifestFor([record]);
    const before = canonicalJson({authority, artifact: record.artifact});
    expect(verify([observation], [record], authority)).toMatchObject({receiptCount: 1, state: 'verified'});
    expect(canonicalJson({authority, artifact: record.artifact})).toBe(before);
    expect(
      verifyThreadnote5LocalSubsystemReceipts({
        candidate: CANDIDATE,
        observations: [observation],
        retainedRecords: [record],
      }),
    ).toMatchObject({reason: 'verifier-incomplete', state: 'unknown'});

    const healthAuthority = authority.entries[0];
    if (healthAuthority?.type !== 'context-health-read-only') throw new Error('Expected context health authority.');
    expect(
      verify([observation], [record], {
        ...authority,
        entries: [
          {
            ...healthAuthority,
            aggregate: {...healthAuthority.aggregate, writeActivityCount: 1},
          },
        ],
      }),
    ).toMatchObject({reason: 'records-invalid', state: 'unknown'});

    const artifact = record.artifact as {
      readonly aggregate: unknown;
      readonly repairs: readonly unknown[];
      readonly reports: readonly unknown[];
      readonly schedule: {readonly input: unknown; readonly observedArgv: readonly string[]; readonly plan: unknown};
    };
    const argvTampered = resealRecord(record, {
      ...artifact,
      schedule: {...artifact.schedule, observedArgv: [...artifact.schedule.observedArgv, '--team', 'forged']},
    });
    expect(
      verify(
        [observed(argvTampered, assertions, [{eligibleCount: 0, id: 'health-resolution-rate', positiveCount: 0}])],
        [argvTampered],
      ),
    ).toMatchObject({
      reason: 'records-invalid',
      state: 'unknown',
    });

    const aggregateTampered = resealRecord(record, {
      ...artifact,
      aggregate: {
        ...(artifact.aggregate as {readonly input: Record<string, unknown>}),
        input: {
          ...(artifact.aggregate as {readonly input: Record<string, unknown>}).input,
          personal: {
            ...(artifact.aggregate as {readonly input: {readonly personal: Record<string, unknown>}}).input.personal,
            forged: true,
          },
        },
      },
    });
    expect(
      verify(
        [observed(aggregateTampered, assertions, [{eligibleCount: 0, id: 'health-resolution-rate', positiveCount: 0}])],
        [aggregateTampered],
      ),
    ).toMatchObject({reason: 'records-invalid', state: 'unknown'});

    for (const scheduleInput of [
      {cadenceMinutes: 60, project: 'threadnote', teams: ['platform']},
      {cadenceMinutes: 60, project: 'other-project', teams: []},
    ]) {
      const plan = buildContextHealthSchedulePlanV1(scheduleInput);
      const mismatched = resealRecord(record, {
        ...artifact,
        schedule: {input: scheduleInput, observedArgv: ['threadnote', ...plan.argv], plan},
      });
      expect(
        verify(
          [observed(mismatched, assertions, [{eligibleCount: 0, id: 'health-resolution-rate', positiveCount: 0}])],
          [mismatched],
        ),
      ).toMatchObject({reason: 'records-invalid', state: 'unknown'});
    }

    const firstSnapshot = healthAuthority.aggregate.teamSnapshots[0];
    if (firstSnapshot === undefined) throw new Error('Expected a context health team snapshot.');
    for (const teamSnapshots of [
      healthAuthority.aggregate.teamSnapshots.slice(1),
      [...healthAuthority.aggregate.teamSnapshots, {...firstSnapshot, team: 'surplus'}],
    ]) {
      const modifiedAuthority = {
        ...authority,
        entries: [
          {
            ...healthAuthority,
            aggregate: {...healthAuthority.aggregate, teamSnapshots},
          },
        ],
      };
      expect(
        verify([observation], [record], modifiedAuthority, threadnote5LocalAuthorityManifestHash(modifiedAuthority)),
      ).toMatchObject({reason: 'records-invalid', state: 'unknown'});
    }
    const duplicateAuthority = {
      ...authority,
      entries: [
        {
          ...healthAuthority,
          aggregate: {
            ...healthAuthority.aggregate,
            teamSnapshots: [...healthAuthority.aggregate.teamSnapshots, firstSnapshot],
          },
        },
      ],
    };
    expect(() => threadnote5LocalAuthorityManifestHash(duplicateAuthority)).toThrow(/teams must be unique/u);
    expect(verify([observation], [record], duplicateAuthority, '0'.repeat(64))).toMatchObject({
      reason: 'records-invalid',
      state: 'unknown',
    });

    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), (reverse, tamper) => {
        const entries = healthAuthority.aggregate.teamSnapshots;
        const snapshots = reverse ? [...entries].reverse() : entries;
        const reordered = {
          ...authority,
          entries: [
            {
              ...healthAuthority,
              aggregate: {
                ...healthAuthority.aggregate,
                teamSnapshots: tamper
                  ? snapshots.map((snapshot, index) =>
                      index === 0 ? {...snapshot, postWorktreeDigest: 'f'.repeat(64)} : snapshot,
                    )
                  : snapshots,
              },
            },
          ],
        };
        if (tamper) {
          expect(verify([observation], [record], reordered)).toMatchObject({
            reason: 'records-invalid',
            state: 'unknown',
          });
        } else {
          expect(threadnote5LocalAuthorityManifestHash(reordered)).toBe(
            threadnote5LocalAuthorityManifestHash(authority),
          );
          expect(verify([observation], [record], reordered)).toMatchObject({state: 'verified'});
        }
      }),
      {numRuns: 25},
    );
  });

  it('preserves an unreadable configured-team selection as unknown evidence', () => {
    const record = healthMaintenanceTeamSelectionUnknownRecord();
    const observation = observed(
      record,
      ['local-scheduled-invocation-read-only'],
      [{eligibleCount: 0, id: 'health-resolution-rate', positiveCount: 0}],
    );

    expect(verify([observation], [record])).toMatchObject({
      reason: 'verifier-incomplete',
      scenarios: [
        {
          missingKinds: ['context-health-team-selection-evidence'],
          scenario: 'health-maintenance',
          state: 'unknown',
          verifiedKinds: ['context-health'],
        },
      ],
      state: 'unknown',
    });
  });

  it('binds every source artifact to the exact candidate and exact bounded record set', () => {
    const record = procedureRecord();
    const observation = observed(record, observationAssertionsForProcedure());
    const otherCandidate: Threadnote5SourceV1 = {
      ...CANDIDATE,
      commit: '3'.repeat(40),
      version: `5.0.0-local.g${'3'.repeat(40)}`,
    };
    const wrongCandidateRecord = makeRecord(record.scenario, record.kind, record.artifact, otherCandidate);
    expect(
      verify([observed(wrongCandidateRecord, observationAssertionsForProcedure())], [wrongCandidateRecord]),
    ).toMatchObject({
      reason: 'records-mismatched',
      state: 'unknown',
    });
    expect(verify([observation], [record, record])).toMatchObject({reason: 'records-mismatched', state: 'unknown'});

    const extra = makeRecord('output-budgets', 'procedure', record.artifact);
    expect(verify([observation], [record, extra])).toMatchObject({reason: 'records-mismatched', state: 'unknown'});

    const oversized = makeRecord('verified-procedures', 'procedure', {padding: 'x'.repeat(1024 * 1024)});
    expect(verify([observed(oversized, observationAssertionsForProcedure())], [oversized])).toMatchObject({
      reason: 'records-invalid',
      state: 'unknown',
    });
  });

  it('hashes a multi-record set independent of input ordering', () => {
    const procedure = procedureRecord();
    const closeout = closeoutRecord();
    const observations = [
      observed(procedure, observationAssertionsForProcedure()),
      observed(
        closeout,
        [
          'decisions-rationale-present',
          'constraints-present',
          'verification-present',
          'invalidations-present',
          'unresolved-risks-present',
        ],
        [{eligibleCount: 10, id: 'knowledge-delta-completion-rate', positiveCount: 10}],
      ),
    ];
    const expected = verify(observations, [procedure, closeout]);
    expect(expected).toMatchObject({state: 'verified'});
    fc.assert(
      fc.property(fc.boolean(), reverse => {
        const records = reverse ? [closeout, procedure] : [procedure, closeout];
        expect(verify(observations, records)).toEqual(expected);
      }),
      {numRuns: 25},
    );
  });

  it('emits only content-free portable verification output', () => {
    const record = procedureRecord();
    const verification = verify([observed(record, observationAssertionsForProcedure())], [record]);
    const artifact = threadnote5LocalReceiptVerificationArtifact(verification);
    expect(Object.keys(artifact).sort()).toEqual(['verification', 'verificationHash', 'version']);
    expect(canonicalJson(artifact)).not.toContain('/Users/');
    expect(canonicalJson(artifact)).not.toContain('artifactText');
  });

  it('canonicalizes external authority entries independently of input order and rejects surplus coverage', () => {
    const entries: Threadnote5LocalAuthorityEntryV1[] = [
      {assertions: ['migration-runtime-executed'], recordDigest: 'a'.repeat(64), type: 'migration-execution'},
      {
        recordDigest: 'b'.repeat(64),
        trials: [{attemptDigest: 'c'.repeat(64), firstPlanCorrect: true, firstPlanSourceCited: true}],
        type: 'context-brief-plan-citation',
      },
    ];
    fc.assert(
      fc.property(fc.boolean(), reverse => {
        const manifest = {
          candidate: CANDIDATE,
          entries: reverse ? [...entries].reverse() : entries,
          version: 1 as const,
        };
        const reversed = {candidate: CANDIDATE, entries: [...manifest.entries].reverse(), version: 1 as const};
        expect(threadnote5LocalAuthorityManifestHash(manifest)).toBe(threadnote5LocalAuthorityManifestHash(reversed));
      }),
      {numRuns: 25},
    );
    expect(() =>
      threadnote5LocalAuthorityManifestHash({
        candidate: CANDIDATE,
        entries: [
          ...entries,
          {
            assertions: ['dirty-evidence-not-current', 'outcome-unknown'],
            recordDigest: 'a'.repeat(64),
            type: 'context-check-read-fence',
          },
        ],
        version: 1,
      }),
    ).toThrow();
  });

  it('keeps dirty Context Check evidence unknown without its bound authority and rejects mislabeled coverage', () => {
    const boundary = (extra: Record<string, unknown>) => ({candidate: CANDIDATE, digest: 'c'.repeat(64), ...extra});
    const record = makeRecord('dirty-worktree', 'context-check', {
      graphEvidence: boundary({state: 'incomplete'}),
      readFence: boundary({state: 'unknown'}),
      repositoryEvidence: boundary({dirty: true}),
      reportJson: JSON.stringify({
        evidenceReason: 'graph-impact-evidence-unavailable',
        evidenceStatus: 'unavailable',
        exitClassification: 'invalid-or-required-evidence-unavailable',
        exitCode: 2,
        findings: [],
        limit: 100,
        omittedFindings: 0,
        project: 'threadnote',
        version: 1,
      }),
    });
    const observation = observed(record, ['dirty-evidence-not-current', 'outcome-unknown']);
    expect(
      verifyThreadnote5LocalSubsystemReceipts({
        candidate: CANDIDATE,
        observations: [observation],
        retainedRecords: [record],
      }),
    ).toMatchObject({reason: 'verifier-incomplete', state: 'unknown'});
    const authority: Threadnote5LocalAuthorityManifestV1 = {
      candidate: CANDIDATE,
      entries: [
        {
          assertions: ['dirty-evidence-not-current', 'outcome-unknown'],
          recordDigest: record.digest,
          type: 'context-check-read-fence',
        },
      ],
      version: 1 as const,
    };
    expect(verify([observation], [record], authority)).toMatchObject({state: 'verified'});
    expect(
      verify([observation], [record], {
        ...authority,
        entries: [
          {assertions: ['migration-runtime-executed'], recordDigest: record.digest, type: 'migration-execution'},
        ],
      }),
    ).toMatchObject({reason: 'records-invalid', state: 'unknown'});
  });

  it('requires external runtime execution authority for migration receipts', () => {
    const baseline = {
      commit: THREADNOTE_5_BASELINE_COMMIT,
      executableSha256: '4'.repeat(64),
      id: 'threadnote-4.7.x',
      version: THREADNOTE_5_BASELINE_VERSION,
    } as const;
    const execution = (from: Threadnote5SourceV1, to: Threadnote5SourceV1, outcome: 'readable' | 'safe-refusal') => ({
      afterDigest: 'a'.repeat(64),
      beforeDigest: 'b'.repeat(64),
      from,
      outcome,
      protectedWriteCount: 0,
      to,
    });
    const record = makeRecord('upgrade-downgrade', 'migration', {
      baseline,
      candidate: CANDIDATE,
      downgrade: execution(CANDIDATE, baseline, 'safe-refusal'),
      upgrade: execution(baseline, CANDIDATE, 'readable'),
    });
    const observation = observed(record, [
      'upgrade-readable',
      'downgrade-readable-or-safe-refusal',
      'destructive-mutations-zero',
    ]);
    expect(
      verifyThreadnote5LocalSubsystemReceipts({
        candidate: CANDIDATE,
        observations: [observation],
        retainedRecords: [record],
      }),
    ).toMatchObject({reason: 'verifier-incomplete'});
    const authority: Threadnote5LocalAuthorityManifestV1 = {
      candidate: CANDIDATE,
      entries: [{assertions: ['migration-runtime-executed'], recordDigest: record.digest, type: 'migration-execution'}],
      version: 1 as const,
    };
    expect(verify([observation], [record], authority)).toMatchObject({state: 'verified'});
    const tampered = resealRecord(record, {
      ...(record.artifact as Record<string, unknown>),
      upgrade: execution(baseline, CANDIDATE, 'safe-refusal'),
    });
    expect(verify([observed(tampered, observationAssertions(observation))], [tampered], authority)).toMatchObject({
      reason: 'records-invalid',
    });
  });

  it('replays guidance bytes and requires authority only for stale-precondition rejection', () => {
    const previousSource = {
      contentHash: sha256HexSync('Previous rule.'),
      text: 'Previous rule.',
      uri: 'threadnote://user/test/memories/durable/projects/threadnote/previous-guidance.md',
    };
    const source = {
      contentHash: sha256HexSync('Rule.'),
      text: 'Rule.',
      uri: 'threadnote://user/test/memories/durable/projects/threadnote/Z-guidance.md',
    };
    const secondSource = {
      contentHash: sha256HexSync('Second rule.'),
      text: 'Second rule.',
      uri: 'threadnote://user/test/memories/durable/projects/threadnote/a-guidance.md',
    };
    const previousBlock = renderManagedGuidanceBlock([previousSource]);
    const sources = [secondSource, source];
    const block = renderManagedGuidanceBlock(sources);
    const receipt = (receiptSources: readonly (typeof source)[], expectedManagedBlockHash: string) => ({
      expectedManagedBlockHash,
      previousManagedBlockHash: null,
      project: 'threadnote',
      removeTargetWhenEmpty: false,
      repositoryId: 'e'.repeat(64),
      sources: [...receiptSources]
        .sort((left, right) => (left.uri < right.uri ? -1 : left.uri > right.uri ? 1 : 0))
        .map(({contentHash, uri}) => ({contentHash, uri})),
      state: 'current' as const,
      targetIdentity: 'f'.repeat(64),
      targetPath: 'AGENTS.md',
      version: 2 as const,
      wrapperOwned: false,
    });
    const before = receipt([previousSource], sha256HexSync(previousBlock));
    const after = receipt(sources, sha256HexSync(block));
    const beforeText = `Unmanaged\n${previousBlock}`;
    const afterText = `Unmanaged\n${block}`;
    const artifact = {
      after,
      afterText,
      before,
      beforeText,
      candidate: CANDIDATE,
      current: before,
      preview: after,
      sources,
      stalePrecondition: true,
    };
    const record = makeRecord('projection-drift', 'guidance', artifact);
    const observation = observed(record, [
      'unmanaged-text-preserved',
      'apply-previewed',
      'content-precondition-checked',
    ]);
    expect(
      verifyThreadnote5LocalSubsystemReceipts({
        candidate: CANDIDATE,
        observations: [observation],
        retainedRecords: [record],
      }),
    ).toMatchObject({reason: 'verifier-incomplete'});
    const authority: Threadnote5LocalAuthorityManifestV1 = {
      candidate: CANDIDATE,
      entries: [
        {
          assertions: ['stale-precondition-rejected'],
          recordDigest: record.digest,
          type: 'guidance-stale-precondition-rejection',
        },
      ],
      version: 1 as const,
    };
    expect(verify([observation], [record], authority)).toMatchObject({state: 'verified'});
    const tampered = resealRecord(record, {...artifact, afterText: `${afterText}\ntampered`});
    const tamperedAuthority: Threadnote5LocalAuthorityManifestV1 = {
      candidate: CANDIDATE,
      entries: [
        {
          assertions: ['stale-precondition-rejected'],
          recordDigest: tampered.digest,
          type: 'guidance-stale-precondition-rejection',
        },
      ],
      version: 1,
    };
    expect(
      verify([observed(tampered, observationAssertions(observation))], [tampered], tamperedAuthority),
    ).toMatchObject({reason: 'records-invalid'});
    const sourceMismatch = resealRecord(record, {
      ...artifact,
      after: {...after, sources: [{contentHash: previousSource.contentHash, uri: previousSource.uri}]},
      preview: {...after, sources: [{contentHash: previousSource.contentHash, uri: previousSource.uri}]},
    });
    const sourceMismatchAuthority: Threadnote5LocalAuthorityManifestV1 = {
      candidate: CANDIDATE,
      entries: [
        {
          assertions: ['stale-precondition-rejected'],
          recordDigest: sourceMismatch.digest,
          type: 'guidance-stale-precondition-rejection',
        },
      ],
      version: 1,
    };
    expect(
      verify([observed(sourceMismatch, observationAssertions(observation))], [sourceMismatch], sourceMismatchAuthority),
    ).toMatchObject({reason: 'records-invalid'});
  });

  it('replays ten measured Context Brief attempts with authority-gated solo claims and local output budgets', () => {
    const structuredContent = parseContextBriefV1({
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
    const attempt = {
      event: {candidate: CANDIDATE},
      request: {budgetTokens: 1_500, mode: 'brief', scope: {callerCwd: '/repo', kind: 'repository'}, task: 'x'},
      result: {structuredContent, text: renderContextBriefText(structuredContent)},
    };
    const tokens = measureAgentToolResponse(attempt.result).estimatedTokens;
    expect(tokens).toBeLessThan(800);
    const soloAttempts = Array.from({length: 10}, (_value, index) => ({
      ...attempt,
      event: {
        activationId: sha256HexSync(`context-brief-activation-${index}`),
        activationReceiptRevision: sha256HexSync(`context-brief-receipt-${index}`),
        candidate: CANDIDATE,
        completedAt: new Date(Date.UTC(2026, 8, 17, 0, index)).toISOString(),
      },
    }));
    const solo = makeRecord('solo', 'context-brief', {attempts: soloAttempts});
    const soloObservation = observed(
      solo,
      ['first-plan-source-cited', 'first-plan-correct'],
      [{id: 'estimated-tokens-to-first-cited-correct-plan', sampleCount: 10, total: 10 * tokens}],
    );
    expect(
      verifyThreadnote5LocalSubsystemReceipts({
        candidate: CANDIDATE,
        observations: [soloObservation],
        retainedRecords: [solo],
      }),
    ).toMatchObject({reason: 'verifier-incomplete'});
    const authority = authorityManifestFor([solo]);
    const verified = verify([soloObservation], [solo], authority);
    expect(verified).toMatchObject({state: 'verified'});
    const output = makeRecord('output-budgets', 'context-brief', {attempts: [attempt]});
    expect(verify([observed(output, ['context-brief-800-to-1500-estimated-tokens'])], [output])).toMatchObject({
      state: 'verified',
    });
    const closeout = makeRecord('output-budgets', 'closeout', {reviews: [review(99)]});
    const outputWithCloseout = observed(
      closeout,
      ['context-brief-800-to-1500-estimated-tokens', 'knowledge-delta-items-at-most-three'],
      [],
      [{digest: output.digest, kind: output.kind}],
    );
    expect(verify([outputWithCloseout], [closeout, output])).toMatchObject({state: 'verified'});
    const bad = resealRecord(output, {attempts: [{...attempt, result: {...attempt.result, text: 'tampered'}}]});
    expect(verify([observed(bad, ['context-brief-800-to-1500-estimated-tokens'])], [bad])).toMatchObject({
      reason: 'records-invalid',
    });
  });
});

function verify(
  observations: readonly Threadnote5ObservationV1[],
  retainedRecords: readonly Threadnote5LocalSubsystemReceiptRecordV1[],
  authorityManifest: Threadnote5LocalAuthorityManifestV1 = authorityManifestFor(retainedRecords),
  expectedAuthorityManifestSha256 = threadnote5LocalAuthorityManifestHash(authorityManifest),
) {
  return verifyThreadnote5LocalSubsystemReceipts({
    authorityManifest,
    candidate: CANDIDATE,
    expectedAuthorityManifestSha256,
    observations,
    retainedRecords,
  });
}

function makeRecord(
  scenario: Threadnote5ReleaseScenario,
  kind: Threadnote5LocalSourceKindV1,
  artifact: unknown,
  candidate: Threadnote5SourceV1 = CANDIDATE,
): Threadnote5LocalSubsystemReceiptRecordV1 {
  const unsigned = {artifact, candidate, kind, scenario, version: 1 as const};
  return {...unsigned, digest: threadnote5LocalSubsystemReceiptDigest(unsigned)};
}

function resealRecord(
  record: Threadnote5LocalSubsystemReceiptRecordV1,
  artifact: unknown,
): Threadnote5LocalSubsystemReceiptRecordV1 {
  return makeRecord(record.scenario, record.kind, artifact, record.candidate);
}

function authorityManifestFor(
  records: readonly Threadnote5LocalSubsystemReceiptRecordV1[],
): Threadnote5LocalAuthorityManifestV1 {
  const uniqueRecords = [...new Map(records.map(record => [record.digest, record] as const)).values()];
  const entries: Threadnote5LocalAuthorityEntryV1[] = [];
  for (const record of uniqueRecords) {
    if (record.kind === 'activation') {
      const trials = (record.artifact as {readonly trials: readonly Record<string, unknown>[]}).trials;
      entries.push({
        recordDigest: record.digest,
        trials: trials.map(trial => {
          const state = trial.state as {
            readonly plan: {readonly activationId: string};
            readonly receipt: {readonly revision: string};
          };
          const challenge = (trial.secondSurface as {readonly challenge?: unknown} | undefined)?.challenge;
          const offlineObservation = trial.offlineObservation;
          return {
            activationId: state.plan.activationId,
            attestationDigest: challenge === undefined ? null : threadnote5ActivationAttestationDigest(challenge),
            finalReceiptRevision: state.receipt.revision,
            offlineObservationDigest:
              offlineObservation === undefined
                ? null
                : threadnote5ActivationOfflineObservationDigest(offlineObservation),
            resumeBoundaryRevision:
              typeof trial.resumeBoundaryRevision === 'string' ? trial.resumeBoundaryRevision : null,
          };
        }),
        type: 'activation-verification',
      });
      continue;
    }
    if (record.kind === 'context-brief' && record.scenario === 'solo') {
      const attempts = (record.artifact as {readonly attempts: readonly unknown[]}).attempts;
      entries.push({
        recordDigest: record.digest,
        trials: attempts.map(attempt => ({
          attemptDigest: threadnote5ContextBriefAttemptDigest(attempt),
          firstPlanCorrect: true,
          firstPlanSourceCited: true,
        })),
        type: 'context-brief-plan-citation',
      });
      continue;
    }
    if (record.kind === 'value-report') {
      const trials = (
        record.artifact as {
          readonly feedbackTrials?: readonly {
            readonly event: unknown;
            readonly laneId: string;
            readonly offlineObservation: unknown | null;
          }[];
        }
      ).feedbackTrials;
      if (trials === undefined) continue;
      entries.push({
        recordDigest: record.digest,
        trials: trials.map(trial => ({
          feedbackEventDigest: threadnote5RecallFeedbackEventDigest(trial.event),
          laneId: trial.laneId,
          offlineObservationDigest:
            trial.offlineObservation === null
              ? null
              : threadnote5ValueReportOfflineObservationDigest(trial.offlineObservation),
        })),
        type: 'value-report-verification',
      });
      continue;
    }
    if (record.kind === 'procedure') {
      const attempts = (record.artifact as {readonly attempts?: readonly Record<string, unknown>[]}).attempts;
      const attempt = attempts?.[0];
      if (attempt === undefined) continue;
      const manifest = parseProcedureManifest(attempt.manifest);
      const statusInput = attempt.statusInput as {readonly receipt: unknown};
      entries.push({
        artifactId: manifest.artifact.id,
        automaticExecutionCount: 0,
        commandResults: manifest.verification.commands.map(command => ({
          commandId: command.id,
          exitCode: 0,
          outputDigest: sha256HexSync(`verified-output:${command.id}`),
        })),
        receiptDigest: threadnote5ProcedureVerificationReceiptDigest(statusInput.receipt),
        recordDigest: record.digest,
        semanticVersion: manifest.artifact.semanticVersion,
        type: 'procedure-verification',
      });
      continue;
    }
    if (record.kind === 'git-proposal') {
      const attempts = (record.artifact as {readonly attempts: readonly Record<string, unknown>[]}).attempts;
      entries.push({
        recordDigest: record.digest,
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
              const applyEvent = candidateReview.auditEvents.find(
                event => event.action === 'apply' && event.candidateId === mutation.candidateId,
              );
              if (applyEvent === undefined) throw new Error('Proposal fixture has no apply audit event.');
              return {
                applyAuditDigest: threadnote5ApplyAuditDigest(applyEvent),
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
      });
    }
    if (record.kind === 'context-health' && record.scenario === 'health-maintenance') {
      const artifact = record.artifact as {
        readonly aggregate: {
          readonly input: {
            readonly teams: readonly (
              {readonly scope: 'team'; readonly team: string} | {readonly scope: 'team-selection'}
            )[];
          };
        };
      };
      entries.push({
        aggregate: {
          networkActivityCount: 0,
          teamSnapshots: artifact.aggregate.input.teams.flatMap((source, index) =>
            source.scope === 'team'
              ? [
                  {
                    postHead: String(index + 1).repeat(40),
                    postIndexDigest: String(index + 3).repeat(64),
                    postWorktreeDigest: String(index + 5).repeat(64),
                    preHead: String(index + 1).repeat(40),
                    preIndexDigest: String(index + 3).repeat(64),
                    preWorktreeDigest: String(index + 5).repeat(64),
                    team: source.team,
                  },
                ]
              : [],
          ),
          writeActivityCount: 0,
        },
        recordDigest: record.digest,
        schedule: {networkActivityCount: 0, writeActivityCount: 0},
        type: 'context-health-read-only',
      });
    }
  }
  return {candidate: CANDIDATE, entries, version: 1};
}

function observed(
  record: Threadnote5LocalSubsystemReceiptRecordV1,
  assertions: readonly string[],
  measurements: readonly Threadnote5MeasurementV1[] = [],
  additionalReceipts: Threadnote5ObservationV1['attestation']['subsystemReceipts'] = [],
): Threadnote5ObservationV1 {
  const transcript = {
    assertionResults: assertions.map(id => ({id, observed: true})),
    measurements,
    outcome: 'passed' as const,
    reason: null,
  };
  const runtime = {executableSha256: CANDIDATE.executableSha256, sourceCommit: CANDIDATE.commit};
  const base = {
    attestation: {
      postRuntime: runtime,
      preRuntime: runtime,
      previousTranscriptDigest: null,
      subsystemReceipts: [...additionalReceipts, {digest: record.digest, kind: record.kind}],
      transcriptDigest: threadnote5ObservationTranscriptHash(transcript),
    },
    observationId: `obs_${sha256HexSync(`${record.scenario}\0${record.digest}`).slice(0, 32)}`,
    scenario: record.scenario,
    sourceHash: threadnote5SourceHash(CANDIDATE),
    transcript,
    version: 1 as const,
  };
  return {...base, receiptHash: threadnote5ObservationReceiptHash(base)};
}

function observationAssertions(observation: Threadnote5ObservationV1): readonly string[] {
  return observation.transcript.assertionResults.map(result => result.id);
}

function observationAssertionsForProcedure(): readonly string[] {
  return ['procedure-receipt-current', 'procedure-dependencies-compatible', 'procedure-never-auto-executed'];
}

function procedureRecord(): Threadnote5LocalSubsystemReceiptRecordV1 {
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
    threadnoteVersion: CANDIDATE.version,
    verifiedAt: '2026-09-17T12:00:00.000Z',
    verifier: 'verifier',
  });
  return makeRecord('verified-procedures', 'procedure', {
    attempts: [
      {
        artifactText,
        manifest,
        statusInput: {capabilities: ['filesystem.read'], receipt, surfaceIds: ['terminal']},
      },
    ],
  });
}

function closeoutRecord(): Threadnote5LocalSubsystemReceiptRecordV1 {
  return makeRecord('structured-closeout', 'closeout', {
    reviews: Array.from({length: 10}, (_value, index) => review(index + 1)),
  });
}

function activationSoloArtifact() {
  const {approvals, plan, receipt, receiptChain} = activationChainBeforeSecondSurface();
  const operation = plan.operations.at(-1)!;
  const result = recordSuccessfulActivationOperation(plan, receipt, operation, 'a'.repeat(64), approvals);
  return {trials: [{approvals, receiptChain: [...receiptChain, result], state: {plan, receipt: result}}]};
}

function activationJourneyFixture(repositoryIdentityHash = 'b'.repeat(64)) {
  const {
    approvals,
    plan,
    receipt: publicationReceipt,
    receiptChain,
  } = activationChainBeforeSecondSurface(repositoryIdentityHash);
  const publicationReceiptHash = publicationReceipt.operations.find(
    operation => operation.kind === 'decision.publish',
  )!.subsystemReceiptHash!;
  const decision = {
    canonicalUri: 'threadnote://user/test/memories/shared/default/durable/projects/threadnote/activation.md',
    contentHash: 'd'.repeat(64),
    memoryId: 'tn_activation_decision',
    publicationReceiptHash,
  };
  const context: SecondSurfaceProofContextV1 = {
    activationId: plan.activationId,
    activationReceiptRevision: publicationReceipt.revision,
    catalogRevision: 'catalog-v1',
    catalogSnapshotHash: plan.catalogSnapshotHash,
    decision,
    primary: {
      access: 'local-stdio',
      capabilitiesFingerprint: '1'.repeat(64),
      configurationState: 'current',
      mcpCapability: 'managed',
      mcpConfigFingerprint: '2'.repeat(64),
      mcpReceiptFingerprint: '3'.repeat(64),
      mcpServerFingerprint: '9'.repeat(64),
      surfaceId: plan.primarySurfaceId,
    },
    queryFingerprint: '5'.repeat(64),
    repositoryIdentityHash: plan.repositoryIdentityHash,
    repositoryState: 'clean',
    secondary: {
      access: 'local-stdio',
      capabilitiesFingerprint: '6'.repeat(64),
      configurationState: 'current',
      mcpCapability: 'managed',
      mcpConfigFingerprint: '7'.repeat(64),
      mcpReceiptFingerprint: '8'.repeat(64),
      mcpServerFingerprint: '9'.repeat(64),
      surfaceId: plan.secondarySurfaceId,
    },
    startedAt: publicationReceipt.updatedAt,
    teamId: plan.teamId,
    teamShareStateHash: plan.teamShareStateHash,
  };
  const commonObservation = {
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
    ...commonObservation,
    complete: true,
    invocationId: 'a'.repeat(64),
    observedAt: new Date(Date.parse(context.startedAt) + 1_000).toISOString(),
    queryFingerprint: context.queryFingerprint,
    responseFingerprint: 'b'.repeat(64),
    results: [{canonicalUri: decision.canonicalUri, identityConflict: false, memoryId: decision.memoryId}],
    returnedResults: 1,
    totalResults: 1,
    truncated: false,
  };
  const read: SecondSurfaceReadObservationV1 = {
    ...commonObservation,
    canonicalUri: decision.canonicalUri,
    complete: true,
    contentHash: decision.contentHash,
    invocationId: 'c'.repeat(64),
    memoryId: decision.memoryId,
    observedAt: new Date(Date.parse(context.startedAt) + 2_000).toISOString(),
    readable: true,
    recallResponseFingerprint: recall.responseFingerprint,
    requestedMemoryId: decision.memoryId,
    requestedUri: decision.canonicalUri,
    resourceCount: 1,
    responseFingerprint: 'd'.repeat(64),
  };
  const proofResult = completeSecondSurfaceProofV1(context, recall, read);
  if (proofResult.status !== 'verified') {
    throw new Error(`Second-surface fixture proof was rejected: ${proofResult.code}.`);
  }
  const proof = proofResult.receipt;
  const finalReceipt = recordSuccessfulActivationOperation(
    plan,
    publicationReceipt,
    plan.operations.at(-1)!,
    proof.proofHash,
    approvals,
  );
  const challengeId = secondSurfaceChallengeIdV1(context);
  const contextHash = secondSurfaceProofContextHashV1(context);
  const nonceHash = 'e'.repeat(64);
  const challenge = {
    challengeId,
    context,
    contextHash,
    issuedAt: context.startedAt,
    nonceHash,
    receipt: {
      attestationHash: 'f'.repeat(64),
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
  return {
    activationTrial: {
      approvals,
      events: activationValueEventsV1(finalReceipt),
      receiptChain: [...receiptChain, finalReceipt],
      secondSurface: {challenge},
      state: {plan, receipt: finalReceipt},
    },
    challenge,
    decision,
    finalReceipt,
    plan,
    proof,
    publicationReceipt,
  };
}

function activationValueArtifact(
  plan: ReturnType<typeof createActivationPlanV1>,
  receipt: ActivationReceiptV1,
  laneId: string,
) {
  const events = activationValueEventsV1(receipt);
  const from = new Date(Date.parse(receipt.startedAt) - 1_000).toISOString();
  const to = new Date(Date.parse(receipt.updatedAt) + 1_000).toISOString();
  const input = {
    counts: summarizeLocalValueEvents(events, {from: new Date(from), to: new Date(to)}),
    feedbackEvents: [
      {
        action: 'useful' as const,
        queryFingerprint: sha256HexSync(`activation-value-${receipt.activationId}`),
        rankerVersion: 'hybrid-v1',
        timestamp: from,
        uri: 'threadnote://user/test/memories/shared/default/durable/projects/threadnote/activation.md',
        version: 1 as const,
      },
    ],
    period: {from, to},
  };
  const report = aggregateValueReportV1(input);
  return {
    activationTrials: [{events, input, report, state: {plan, receipt}}],
    captures: [{input, report}],
    feedbackTrials: [{event: input.feedbackEvents[0], laneId, offlineObservation: null}],
  };
}

function activationChainBeforeSecondSurface(repositoryIdentityHash = 'b'.repeat(64)) {
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
  let receipt = createActivationReceiptV1(plan, '2026-09-18T08:00:00.000Z');
  const approvals: NonNullable<Parameters<typeof recordActivationOutcomeV1>[0]['approval']>[] = [];
  const receiptChain: ActivationReceiptV1[] = [receipt];
  for (const [index, operation] of plan.operations.slice(0, -1).entries()) {
    receipt = recordSuccessfulActivationOperation(
      plan,
      receipt,
      operation,
      (index + 1).toString(16).padStart(64, '0'),
      approvals,
    );
    receiptChain.push(receipt);
  }
  return {approvals, plan, receipt, receiptChain};
}

function recordSuccessfulActivationOperation(
  plan: ReturnType<typeof createActivationPlanV1>,
  receipt: ActivationReceiptV1,
  operation: ReturnType<typeof createActivationPlanV1>['operations'][number],
  subsystemReceiptHash: string,
  approvals?: NonNullable<Parameters<typeof recordActivationOutcomeV1>[0]['approval']>[],
): ActivationReceiptV1 {
  const approval =
    operation.approvalKind === undefined
      ? undefined
      : bindActivationApprovalV1(plan, receipt, operation.id, 'f'.repeat(64));
  if (approval !== undefined) approvals?.push(approval);
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
  if (result.status !== 'updated') throw new Error('Activation fixture transition was rejected.');
  return result.receipt;
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
      {
        action: 'apply',
        at: '2026-09-17T10:01:00.000Z',
        candidateId,
        memoryUri: sourceUri,
        reviewId,
        revision: 2,
      },
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
        evidence: [`commit:${CANDIDATE.commit}`],
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
    sourceCommit: CANDIDATE.commit,
    structuredCloseout: {
      constraints: ['Offline and local.'],
      knowledgeInvalidated: ['Prior release assumption.'],
      rationale: 'The implementation establishes the release contract.',
      type: 'structured-closeout',
      unresolvedRisks: ['Pending activation adapter.'],
      verificationPerformed: ['Focused tests passed.'],
      version: 1,
    },
    task: 'Verify Threadnote 5.',
    topic: `topic-${index}`,
    version: 2,
  };
}

function proposalRecord(): Threadnote5LocalSubsystemReceiptRecordV1 {
  const attempts = Array.from({length: 10}, (_value, index) => {
    const number = index + 1;
    const reviewId = `review-${number.toString(16).padStart(16, '0')}`;
    const candidateId = `${reviewId}-1`;
    const topic = `topic-${number}`;
    const sourceUri = `threadnote://user/test/memories/durable/projects/threadnote/${topic}.md`;
    const sourceContent = approvedSource(candidateId, topic, number);
    const contentHash = sha256HexSync(canonicalMemoryDocumentContent(sourceContent));
    const candidateReview = review(number, {contentHash, sourceUri});
    const input = {
      baseCommit: 'a'.repeat(40),
      mutations: [
        {
          approval: {expectedSourceContentHash: contentHash, reviewId, revision: 2, share: true as const},
          candidateId,
          expectedTarget: {state: 'absent' as const},
          operation: 'create' as const,
          sourceContent,
          sourceUri,
        },
      ],
      project: 'threadnote',
      target: {repositoryId: 'b'.repeat(64), team: 'default'},
    };
    const built = buildKnowledgeDeltaGitProposalV1({...input, delta: projectKnowledgeDeltaV1(candidateReview)});
    return {artifact: built.artifact, input, proposal: built.proposal, review: candidateReview};
  });
  return makeRecord('provider-neutral-proposal', 'git-proposal', {attempts});
}

function approvedSource(candidateId: string, topic: string, index: number): string {
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

function valueReportRecord(): Threadnote5LocalSubsystemReceiptRecordV1 {
  const captures = Array.from({length: 10}, (_value, index) => {
    const from = new Date(Date.UTC(2026, 8, 17, 0, index)).toISOString();
    const to = new Date(Date.UTC(2026, 8, 17, 0, index, 30)).toISOString();
    const input = {
      counts: {setup: {completed: 1, failed: 0, started: 1, supportedAgentReuse: 1}},
      feedbackEvents: [
        {
          action: 'useful' as const,
          queryFingerprint: sha256HexSync(`query-${index}`),
          rankerVersion: 'hybrid-v1',
          timestamp: from,
          uri: `threadnote://private/memory-${index}`,
          version: 1 as const,
        },
      ],
      period: {from, to},
    };
    return {input, report: aggregateValueReportV1(input)};
  });
  return makeRecord('two-agent', 'value-report', {
    captures,
    feedbackTrials: captures.map((capture, index) => ({
      event: capture.input.feedbackEvents[0],
      laneId: sha256HexSync(`value-report-lane-${index}`),
      offlineObservation: null,
    })),
  });
}

function contextHealthRecord(): Threadnote5LocalSubsystemReceiptRecordV1 {
  const input = {
    candidateEvidence: [
      {candidateId: 'candidate-a', comparison: 'contradiction' as const, project: 'threadnote'},
      {candidateId: 'candidate-b', comparison: 'possible_duplicate' as const, project: 'threadnote'},
    ],
    now: new Date('2026-09-17T00:00:00.000Z'),
    project: 'threadnote',
    records: [],
  };
  const report = buildContextHealthReport(input);
  return makeRecord('contradiction-triage', 'context-health', {
    repairs: [],
    reports: [{input: {...input, now: input.now.toISOString()}, report}],
  });
}

function healthMaintenanceRecord(): Threadnote5LocalSubsystemReceiptRecordV1 {
  const scheduleInput = {cadenceMinutes: 60, project: 'threadnote', teams: []};
  const aggregateInput = {
    personal: {reason: 'snapshot-unreadable' as const, scope: 'personal' as const, state: 'unknown' as const},
    project: 'threadnote',
    teams: [
      {reason: 'snapshot-unreadable' as const, scope: 'team' as const, state: 'unknown' as const, team: 'platform'},
      {reason: 'snapshot-unreadable' as const, scope: 'team' as const, state: 'unknown' as const, team: 'runtime'},
    ],
  };
  const plan = buildContextHealthSchedulePlanV1(scheduleInput);
  return makeRecord('health-maintenance', 'context-health', {
    aggregate: {aggregate: aggregateContextHealthReportsV1(aggregateInput), input: aggregateInput},
    repairs: [],
    reports: [],
    schedule: {input: scheduleInput, observedArgv: ['threadnote', ...plan.argv], plan},
  });
}

function healthMaintenanceTeamSelectionUnknownRecord(): Threadnote5LocalSubsystemReceiptRecordV1 {
  const scheduleInput = {cadenceMinutes: 60, project: 'threadnote', teams: []};
  const aggregateInput = {
    personal: {reason: 'snapshot-unreadable' as const, scope: 'personal' as const, state: 'unknown' as const},
    project: 'threadnote',
    teams: [
      {
        reason: 'snapshot-unreadable' as const,
        scope: 'team-selection' as const,
        state: 'unknown' as const,
      },
    ],
  };
  const plan = buildContextHealthSchedulePlanV1(scheduleInput);
  return makeRecord('health-maintenance', 'context-health', {
    aggregate: {aggregate: aggregateContextHealthReportsV1(aggregateInput), input: aggregateInput},
    repairs: [],
    reports: [],
    schedule: {input: scheduleInput, observedArgv: ['threadnote', ...plan.argv], plan},
  });
}
