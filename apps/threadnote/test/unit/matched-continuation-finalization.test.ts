import fc from 'fast-check';
import {afterEach, describe, expect, it} from 'vitest';
import {mkdtemp, readFile, readdir, realpath, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {createMatchedEvaluationVerificationReceiptV1} from '@threadnote/threadnote/evaluation/matched-verification';
import {
  createMatchedContinuationStudyV1,
  MATCHED_CONTINUATION_VARIANTS,
  type MatchedContinuationStudyTaskV1,
} from '@threadnote/threadnote/evaluation/matched-continuation-study';
import type {MatchedEvaluationMetricsV1} from '@threadnote/threadnote/evaluation/matched-evaluation-runner';
import {
  parseAndVerifyMatchedContinuationTaskReportV1,
  projectMatchedContinuationOutcomesV1,
  publishMatchedContinuationFinalizationV1,
  type ParsedAttempt,
  type ParsedTaskReport,
} from '../../../../scripts/finalize-matched-continuation-study.js';
import {
  projectMatchedEvaluationContinuationSelectionCheckpointV1,
  type MatchedEvaluationContinuationPilotPlanV2,
} from '../../../../scripts/run-matched-evaluation.js';

describe('matched continuation finalization', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, {force: true, recursive: true})));
  });

  it('rehashes task-report evidence and rejects partial or tampered reports', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'threadnote-continuation-finalizer-')));
    roots.push(root);
    const study = createStudy();
    const task = study.tasks[0];
    const plan = continuationPlan(task, study.sourceEvidence.verificationPlanHash);
    const attempts = await Promise.all(
      plan.attempts.map(attempt =>
        completedReportAttempt(
          root,
          plan,
          attempt,
          metrics(task.taskId, hex(700 + attempt.runOrder), study.sourceEvidence.verificationPlanHash),
        ),
      ),
    );
    const report = taskReport(plan, study, attempts);

    const parsed = await parseAndVerifyMatchedContinuationTaskReportV1({
      plan,
      reportInput: report,
      sourceReportSha256: hex(900),
      study,
    });
    expect(parsed.attempts).toHaveLength(5);
    expect(parsed.phaseOne.providerTokens.totalTokens).toBe(30);

    await expect(
      parseAndVerifyMatchedContinuationTaskReportV1({
        plan,
        reportInput: {...report, attempts: attempts.slice(0, 4), completed: false},
        sourceReportSha256: hex(901),
        study,
      }),
    ).rejects.toThrow('exactly five terminal attempts');

    await writeFile(attempts[0].rawArtifactPath, '{"tampered":true}\n');
    await expect(
      parseAndVerifyMatchedContinuationTaskReportV1({
        plan,
        reportInput: report,
        sourceReportSha256: hex(902),
        study,
      }),
    ).rejects.toThrow('artifact differs from its report hash');
  });

  it('projects the sealed global schedule and retains failed-attempt lifecycle accounting', () => {
    const study = createStudy();
    const reports = new Map<string, ParsedTaskReport>();
    for (const task of study.tasks) {
      const scheduled = study.schedule.filter(entry => entry.taskId === task.taskId);
      const attempts: ParsedAttempt[] = scheduled.map((entry, index) => {
        if (entry.globalRunOrder === 1) {
          return {
            accountingStatus: 'retained-agent-checkpoint',
            artifactSha256: null,
            diagnostics: 'adapter failed with exit code 1',
            providerUsage: tokens(12),
            rawArtifactPath: `/tmp/${entry.runNonce}-artifact.json`,
            requestPath: `/tmp/${entry.runNonce}-request.json`,
            requestSha256: null,
            responsePath: `/tmp/${entry.runNonce}-response.json`,
            responseSha256: null,
            runNonce: entry.runNonce,
            runOrder: entry.withinTaskRunOrder,
            status: 'failed',
            taskId: task.taskId,
            timing: {agentTaskMilliseconds: 80, preparationMilliseconds: 20},
            transcriptPath: `/tmp/${entry.runNonce}.jsonl`,
            variant: entry.variant,
          };
        }
        const artifactSha256 = hex(1_000 + entry.globalRunOrder);
        return {
          artifactSha256,
          metrics: metrics(task.taskId, artifactSha256, study.sourceEvidence.verificationPlanHash),
          rawArtifactPath: `/tmp/${entry.runNonce}-artifact.json`,
          requestPath: `/tmp/${entry.runNonce}-request.json`,
          requestSha256: hex(1_100 + entry.globalRunOrder),
          responsePath: `/tmp/${entry.runNonce}-response.json`,
          responseSha256: hex(1_200 + entry.globalRunOrder),
          runNonce: entry.runNonce,
          runOrder: entry.withinTaskRunOrder,
          status: 'completed',
          taskId: task.taskId,
          transcriptHash: hex(1_300 + index),
          transcriptPath: `/tmp/${entry.runNonce}.jsonl`,
          variant: entry.variant,
        };
      });
      reports.set(task.taskId, {
        attempts,
        phaseOne: {accountingSource: 'sealed-phase-one', elapsedMilliseconds: 50, providerTokens: tokens(10)},
        sourceReportSha256: hex(1_400 + reports.size),
      });
    }

    const outcomes = projectMatchedContinuationOutcomesV1({reports, study});

    expect(outcomes).toHaveLength(25);
    expect(outcomes.map(outcome => outcome.globalRunOrder)).toEqual(Array.from({length: 25}, (_, index) => index + 1));
    expect(outcomes[0]).toMatchObject({
      assessment: null,
      phaseOne: {elapsedMilliseconds: 50, providerTokens: {totalTokens: 10}},
      phaseTwo: {accountingSource: 'failure-checkpoint', elapsedMilliseconds: 100, providerTokens: {totalTokens: 12}},
      status: 'failed',
    });
    expect(outcomes[1].previousOutcomeHash).toBe(outcomes[0].outcomeHash);
    fc.assert(
      fc.property(
        fc.shuffledSubarray(
          study.tasks.map(task => task.taskId),
          {minLength: study.tasks.length, maxLength: study.tasks.length},
        ),
        taskOrder => {
          const reordered = new Map(taskOrder.map(taskId => [taskId, reports.get(taskId)!]));
          expect(projectMatchedContinuationOutcomesV1({reports: reordered, study})).toEqual(outcomes);
        },
      ),
      {numRuns: 20},
    );
  });

  it('publishes one complete output directory and refuses concurrent or later overwrites', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'threadnote-continuation-publisher-')));
    roots.push(root);
    const output = join(root, '.context', 'finalized');
    const first = finalizationArtifacts('first');
    const second = finalizationArtifacts('second');

    const results = await Promise.allSettled([
      publishMatchedContinuationFinalizationV1(output, first),
      publishMatchedContinuationFinalizationV1(output, second),
    ]);

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const receipt = await readFile(join(output, 'continuation-finalization-receipt.json'), 'utf8');
    const selected = receipt === 'first-receipt' ? first : second;
    expect(receipt).toBe(Buffer.from(selected.receipt).toString('utf8'));
    await expect(readFile(join(output, 'continuation-outcomes.jsonl'), 'utf8')).resolves.toBe(
      Buffer.from(selected.outcomeLedger).toString('utf8'),
    );
    await expect(readFile(join(output, 'continuation-report.json'), 'utf8')).resolves.toBe(
      Buffer.from(selected.report).toString('utf8'),
    );
    await expect(readFile(join(output, 'continuation-article-evidence.md'), 'utf8')).resolves.toBe(
      Buffer.from(selected.articleEvidence).toString('utf8'),
    );
    await expect(publishMatchedContinuationFinalizationV1(output, first)).rejects.toThrow('overwrite is not allowed');
    expect((await readdir(join(root, '.context'))).filter(entry => entry.includes('.staging-'))).toEqual([]);
  });
});

function finalizationArtifacts(label: string) {
  return {
    articleEvidence: Buffer.from(`${label}-article`),
    outcomeLedger: Buffer.from(`${label}-ledger`),
    receipt: Buffer.from(`${label}-receipt`),
    report: Buffer.from(`${label}-report`),
  };
}

async function completedReportAttempt(
  root: string,
  plan: MatchedEvaluationContinuationPilotPlanV2,
  attempt: MatchedEvaluationContinuationPilotPlanV2['attempts'][number],
  attemptMetrics: MatchedEvaluationMetricsV1,
) {
  const prefix = join(root, attempt.runNonce);
  const rawArtifactPath = `${prefix}-artifact.json`;
  const requestPath = `${prefix}-request.json`;
  const responsePath = `${prefix}-response.json`;
  const transcriptPath = `${prefix}.jsonl`;
  const checkpointPath = `${transcriptPath}.agent.jsonl`;
  const artifactBytes = Buffer.from(`${JSON.stringify({runNonce: attempt.runNonce})}\n`);
  const requestBytes = Buffer.from(`${JSON.stringify({request: attempt.runNonce})}\n`);
  const responseBytes = Buffer.from(`${JSON.stringify({response: attempt.runNonce})}\n`);
  const transcriptBytes = Buffer.from(`${JSON.stringify({transcript: attempt.runNonce})}\n`);
  await Promise.all([
    writeFile(rawArtifactPath, artifactBytes),
    writeFile(requestPath, requestBytes),
    writeFile(responsePath, responseBytes),
    writeFile(transcriptPath, transcriptBytes),
  ]);
  const variant = attempt.variant;
  return {
    arm: underlyingArm(variant),
    artifactSha256: sha256HexSync(artifactBytes),
    checkpointPath,
    metrics: {
      ...attemptMetrics,
      verification: createMatchedEvaluationVerificationReceiptV1({
        ...attemptMetrics.verification!,
        artifactHash: sha256HexSync(artifactBytes),
      }),
    },
    rawArtifactPath,
    requestPath,
    requestSha256: sha256HexSync(requestBytes),
    responsePath,
    responseSha256: sha256HexSync(responseBytes),
    runNonce: attempt.runNonce,
    runOrder: attempt.runOrder,
    status: 'completed' as const,
    taskId: plan.taskId,
    transcriptHash: sha256HexSync(transcriptBytes),
    transcriptPath,
    variant,
  };
}

function taskReport(
  plan: MatchedEvaluationContinuationPilotPlanV2,
  study: ReturnType<typeof createStudy>,
  attempts: readonly Awaited<ReturnType<typeof completedReportAttempt>>[],
) {
  return {
    attempts,
    candidate: plan.candidate,
    checkpoint: projectMatchedEvaluationContinuationSelectionCheckpointV1(plan),
    completed: true,
    completionMeaning: 'completed only when all five fresh phase-two attempts completed',
    comparativeClaimsEligible: false,
    identities: {
      manifestHash: study.sourceEvidence.manifestHash,
      planFileHash: study.tasks.find(task => task.taskId === plan.taskId)!.planSha256,
      runtimeVersion: 4,
      studyHash: study.sourceEvidence.matchedStudyHash,
      verificationPlanHash: study.sourceEvidence.verificationPlanHash,
    },
    limitations: ['No retries are allowed.'],
    phaseTwoPromptSha256: plan.phaseTwoPromptSha256,
    planVersion: 2,
    rows: plan.attempts.map(attempt => ({
      arm: underlyingArm(attempt.variant),
      blindLabel: attempt.blindLabel,
      position: attempt.runOrder,
      repetition: 1,
      runNonce: attempt.runNonce,
      runOrder: attempt.runOrder,
      taskId: plan.taskId,
      variant: attempt.variant,
    })),
    sourceTask: {
      promptSha256: plan.sourceTask.promptSha256,
      repositoryFixtureHash: plan.sourceTask.repositoryFixtureHash,
      repositoryRevision: plan.sourceTask.repositoryRevision,
      taskId: plan.sourceTask.taskId,
    },
    taskId: plan.taskId,
    version: 1,
  };
}

function continuationPlan(
  task: MatchedContinuationStudyTaskV1,
  verificationPlanHash: string,
): MatchedEvaluationContinuationPilotPlanV2 {
  const phaseOnePrompt = 'Implement phase one.';
  const phaseTwoPrompt = 'Continue phase two.';
  const marker = 'resume-marker-1';
  const handoff = `Task: Continue\nDecisions: frozen\nConstraints: no retries\nRationale: matched\nVerification: ${verificationPlanHash}\nNext step: ${marker}\n`;
  return {
    attempts: Array.from({length: 5}, (_, index) => ({
      blindLabel: ['A', 'B', 'C', 'D', 'E'][index] as 'A' | 'B' | 'C' | 'D' | 'E',
      runNonce: `run_${(index + 1).toString(16).padStart(32, '0')}`,
      runOrder: index + 1,
      variant: MATCHED_CONTINUATION_VARIANTS[index],
    })),
    candidate: {toolArtifactHash: hex(3), toolVersion: '5.1.0-beta.1.local.test'},
    checkpoint: {
      automaticHandoffReadSha256: hex(101),
      automaticHandoffUri: 'threadnote://memory/handoff/test',
      handoff,
      handoffSha256: sha256HexSync(handoff),
      phaseOneAccounting: {elapsedMilliseconds: 100, providerTokens: tokens(30), providerTokensMeasured: true},
      phaseOneExecution: {
        adapterArtifactHash: hex(102),
        adapterConfigurationFileSha256: hex(103),
        adapterConfigurationHash: hex(104),
        adapterProtocol: 'matched-evaluation-adapter-v5',
        appServerExecutableSha256: hex(105),
        appServerVersion: 'test',
        artifactSha256: hex(106),
        environmentPolicyHash: hex(107),
        model: {id: 'test', parametersHash: hex(108), provider: 'test', reasoningEffort: 'low'},
        requestSha256: hex(109),
        responseSha256: hex(110),
        runNonce: 'run_000000000000000000000000000000aa',
        transcriptHash: hex(111),
        transcriptSha256: hex(112),
      },
      phaseOnePatchSha256: hex(113),
      phaseOnePrompt,
      phaseOnePromptSha256: sha256HexSync(phaseOnePrompt),
      preparedContext: {
        graphContentHash: hex(114),
        graphSnapshotHash: hex(115),
        linkReceiptsHash: hex(116),
        taskContextHash: hex(117),
      },
      preparedHome: {fixtureHash: hex(118), identitySha256: hex(119)},
      repositoryFixtureHash: task.checkpointRepositoryFixtureHash,
      repositoryRevision: task.checkpointRevision,
      resumeEvidenceMarker: marker,
    },
    phaseTwoPrompt,
    phaseTwoPromptSha256: sha256HexSync(phaseTwoPrompt),
    retries: 0,
    sourceTask: {
      prompt: 'Implement the source task.',
      promptSha256: sha256HexSync('Implement the source task.'),
      repositoryFixtureHash: task.sourceRepositoryFixtureHash,
      repositoryRevision: task.sourceRevision,
      taskId: task.taskId,
    },
    taskId: task.taskId,
    version: 2,
  };
}

function metrics(taskId: string, artifactHash: string, planHash: string): MatchedEvaluationMetricsV1 {
  return {
    auditability: {citations: 2, resolvableCitations: 2},
    completion: {completed: true},
    context: null,
    correctness: {judge: 'blinded-rubric-v1', judgeCompleted: true, scoreMilli: 1_000},
    drift: {falseCurrentOutcomes: 0},
    providerCostMicros: null,
    retrieval: {recalledEvidence: 2, requiredEvidence: 2},
    safety: {authorizationLeaks: 0, blockedActions: 0, harmfulActions: 0},
    sourceSupport: {requiredClaims: 2, supportedClaims: 2},
    timing: {
      agentTaskMilliseconds: 80,
      deterministicVerifierMilliseconds: 5,
      endToEndMilliseconds: 120,
      firstSufficientEvidenceMilliseconds: 60,
      judgeSetupMilliseconds: 10,
      judgeTurnMilliseconds: 15,
      preparationMilliseconds: 10,
    },
    usage: {
      modelVisibleBytes: 1_000,
      modelVisibleTokens: 40,
      providerTokens: tokens(50),
      redundantFileReads: 0,
      toolTurns: 2,
    },
    validity: {failureCount: 0, valid: true},
    verification: createMatchedEvaluationVerificationReceiptV1({
      artifactHash,
      diagnosticHash: hex(201),
      durationMilliseconds: 5,
      environmentHash: hex(202),
      exitCode: 0,
      interpreterHash: hex(203),
      planHash,
      runnerHash: hex(204),
      sandboxExecutableHash: hex(205),
      status: 'passed',
      taskId,
      verificationId: hex(206),
    }),
  };
}

function createStudy() {
  const tasks = Array.from({length: 5}, (_, index): MatchedContinuationStudyTaskV1 => ({
    checkpointRepositoryFixtureHash: hex(index + 40),
    checkpointRevision: commit(index + 40),
    clusterId: `cluster_${hex(index + 10).slice(-16)}`,
    planSha256: hex(index + 50),
    repositoryUrl: `https://example.com/org/repository-${index}.git`,
    sourceRepositoryFixtureHash: hex(index + 20),
    sourceRevision: commit(index + 20),
    taskId: `tsk_${hex(index + 30).slice(-16)}`,
  }));
  let globalRunOrder = 0;
  return createMatchedContinuationStudyV1({
    bootstrap: {confidenceLevelBasisPoints: 9_500, iterations: 200, seed: hex(1)},
    candidate: {
      adapterArtifactSha256: hex(2),
      sourceCommit: commit(2),
      toolArtifactHash: hex(3),
      toolVersion: '5.1.0-beta.1.local.test',
    },
    gates: {
      completionNonInferiorityBasisPoints: 500,
      maximumAuthorizationLeaks: 0,
      maximumFalseCurrentOutcomes: 0,
      maximumHarmfulActions: 0,
      minimumClusters: 5,
      minimumCorrectnessScoreMilli: 1_000,
      minimumTokenReductionBasisPoints: 500,
    },
    schedule: tasks.flatMap((task, taskIndex) =>
      Array.from({length: 5}, (_, position) => {
        globalRunOrder += 1;
        return {
          globalRunOrder,
          runNonce: `run_${globalRunOrder.toString(16).padStart(32, '0')}`,
          taskId: task.taskId,
          variant: MATCHED_CONTINUATION_VARIANTS[(position + taskIndex) % 5],
          withinTaskRunOrder: position + 1,
        };
      }),
    ),
    sourceEvidence: {
      corpusHash: hex(4),
      exposureAuditSha256: hex(9),
      manifestHash: hex(5),
      matchedPreparationReceiptSha256: hex(8),
      matchedStudyHash: hex(6),
      verificationPlanHash: hex(7),
    },
    studyId: 'held-out-continuation-v1',
    tasks,
    variants: MATCHED_CONTINUATION_VARIANTS,
    workflowAccounting: 'phase-one-plus-phase-two-per-attempt',
  });
}

function tokens(totalTokens: number) {
  return {
    cachedInputTokens: 0,
    inputTokens: Math.floor(totalTokens / 2),
    outputTokens: totalTokens - Math.floor(totalTokens / 2),
    reasoningOutputTokens: 0,
    totalTokens,
  };
}

function underlyingArm(variant: (typeof MATCHED_CONTINUATION_VARIANTS)[number]) {
  if (variant === 'files-bare' || variant === 'manual-handoff') return 'files' as const;
  if (variant === 'threadnote-graph') return 'threadnote-graph' as const;
  return 'threadnote-compact' as const;
}

function hex(seed: number): string {
  return seed.toString(16).padStart(64, '0');
}

function commit(seed: number): string {
  return seed.toString(16).padStart(40, '0');
}
