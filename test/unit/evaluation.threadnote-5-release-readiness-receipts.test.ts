import {canonicalJson} from '../../src/code_graph/checkpoint/canonical_json.js';
import {sha256HexSync} from '../../src/crypto/sha256.js';
import {
  threadnote5ApplyAuditDigest,
  threadnote5ApprovedSourceUriHash,
  threadnote5LocalAuthorityManifestHash,
  threadnote5ProcedureVerificationReceiptDigest,
  type Threadnote5LocalAuthorityEntryV1,
  type Threadnote5LocalAuthorityManifestV1,
} from '../../src/evaluation/threadnote-5-release-readiness-authority.js';
import {
  threadnote5ObservationReceiptHash,
  threadnote5ObservationTranscriptHash,
  threadnote5SourceHash,
  type Threadnote5MeasurementV1,
  type Threadnote5ObservationV1,
  type Threadnote5ReleaseScenario,
  type Threadnote5SourceV1,
} from '../../src/evaluation/threadnote-5-release-readiness-contract.js';
import {
  threadnote5LocalReceiptVerificationArtifact,
  threadnote5LocalSubsystemReceiptDigest,
  verifyThreadnote5LocalSubsystemReceipts,
  type Threadnote5LocalSourceKindV1,
  type Threadnote5LocalSubsystemReceiptRecordV1,
} from '../../src/evaluation/threadnote-5-release-readiness-receipts.js';
import {buildKnowledgeDeltaGitProposalV1} from '../../src/git_proposal/knowledge_delta.js';
import {type CandidateReview} from '../../src/memory/candidate.js';
import {buildContextHealthReport} from '../../src/memory/context_health.js';
import {canonicalMemoryDocumentContent} from '../../src/memory/document.js';
import {projectKnowledgeDeltaV1} from '../../src/memory/knowledge_delta.js';
import {createProcedureVerificationReceipt, parseProcedureManifest} from '../../src/procedure/contract.js';
import {aggregateValueReportV1} from '../../src/value_report/index.js';
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

  it('derives ValueReport reuse/count lanes but keeps pending activation linkage unknown', () => {
    const record = valueReportRecord();
    const observation = observed(
      record,
      ['two-surfaces-connected', 'second-surface-reused-decision', 'activation-receipt-reused-by-value-report'],
      [
        {eligibleCount: 10, id: 'wrong-memory-rate', positiveCount: 0},
        {eligibleCount: 10, id: 'second-agent-reuse-rate', positiveCount: 10},
      ],
      [
        {digest: 'a'.repeat(64), kind: 'activation'},
        {digest: 'b'.repeat(64), kind: 'recall'},
      ],
    );
    expect(verify([observation], [record])).toMatchObject({reason: 'verifier-incomplete', state: 'unknown'});
    expect(verify([observation], [record]).scenarios).toEqual([
      {
        missingKinds: ['activation', 'activation-value-linkage', 'recall'],
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
  return makeRecord('two-agent', 'value-report', {captures});
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
