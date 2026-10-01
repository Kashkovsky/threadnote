import {chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {sha256HexSync} from '@threadnote/platform/sha256';
import fc from 'fast-check';
import {afterEach, describe, expect, it} from 'vitest';
import {
  assertMatchedEvaluationPinnedFileV1,
  assertMatchedEvaluationRepositoryV1,
  compareAndSwapMatchedEvaluationLedgerV1,
  observeMatchedEvaluationRepositoryV1,
  stageMatchedEvaluationPinnedFileV1,
  withMatchedEvaluationArtifactLockV1,
} from '../../../../scripts/matched-evaluation-runtime-integrity.js';
import {captureCodeMemoryLinkProcessGroup} from '../../../../scripts/code-memory-link-process-boundary.js';
import {
  assertMatchedEvaluationContinuationPhaseOneReceiptV1,
  assertMatchedEvaluationContinuationAdapterConfigurationsV2,
  assertMatchedEvaluationContinuationSupplementV1,
  assertMatchedEvaluationContinuationCheckpointV2,
  assertMatchedEvaluationContinuationPhaseOneEvidenceV2,
  assertMatchedEvaluationContinuationPhaseOneResultV1,
  continuationCheckpointStudyV2,
  createMatchedEvaluationContinuationPhaseOneSelectionV1,
  matchedEvaluationContinuationPreparedHomeIdentityHashV2,
  parseMatchedEvaluationRuntimeV1,
  parseMatchedEvaluationContinuationPhaseOneTaskPacketV1,
  parseMatchedEvaluationContinuationPhaseOneSelectionV1,
  parseMatchedEvaluationContinuationPhaseOneReceiptV1,
  parseMatchedEvaluationContinuationPilotPlanV1,
  projectMatchedEvaluationContinuationSelectionCheckpointV1,
  projectMatchedEvaluationContinuationAdapterTaskV2,
  resolveRuntimeArm,
  resolveMatchedEvaluationRuntimeRepositoriesV1,
  stageResolvedRuntimeArmV1,
  hashMatchedEvaluationPayloadV1,
  selectMatchedEvaluationPilotRowsV1,
  type MatchedEvaluationContinuationPilotPlanV2,
  type MatchedEvaluationRuntimeV1,
} from '../../../../scripts/run-matched-evaluation.js';
import {parseMatchedEvaluationObservationV1} from '@threadnote/threadnote/evaluation/matched-evaluation-runner';
import {createMatchedEvaluationVerificationReceiptV1} from '@threadnote/threadnote/evaluation/matched-verification';
import {
  matchedEvaluationPromptHashV1,
  type MatchedEvaluationManifestV1,
} from '@threadnote/threadnote/evaluation/matched-evaluation';
import {
  matchedEvaluationCodexEnvironmentPolicyHashV1,
  matchedEvaluationPreparedHomeFixtureHashV1,
} from '../../../../scripts/matched-evaluation-codex-adapter.js';
import type {MatchedTokenEfficiencyStudyV1} from '@threadnote/threadnote/evaluation/matched-token-efficiency';

describe('matched evaluation runtime integrity', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, {force: true, recursive: true})));
  });

  it('seals one unique attempt per continuation treatment and the common checkpoint', () => {
    const handoff = [
      'Task: continue the frozen implementation.',
      'Decisions: keep the parser branch local.',
      'Constraints: preserve public behavior.',
      'Rationale: marker checkpoint-evidence-7f4c selects the verified path.',
      'Verification: focused regression still needs to run.',
      'Blockers: none.',
      'Risks: adjacent callers may encode the old shape.',
      'Next step: finish the branch and run the verifier.',
    ].join('\n');
    const base = {
      attempts: [
        {
          blindLabel: 'A',
          runNonce: 'run_00000000000000000000000000000001',
          runOrder: 4,
          variant: 'threadnote-resume',
        },
        {
          blindLabel: 'B',
          runNonce: 'run_00000000000000000000000000000002',
          runOrder: 2,
          variant: 'manual-handoff',
        },
        {
          blindLabel: 'C',
          runNonce: 'run_00000000000000000000000000000003',
          runOrder: 1,
          variant: 'files-bare',
        },
        {
          blindLabel: 'D',
          runNonce: 'run_00000000000000000000000000000004',
          runOrder: 3,
          variant: 'threadnote-graph',
        },
      ],
      baseTaskPromptSha256: '1'.repeat(64),
      candidate: {toolArtifactHash: '2'.repeat(64), toolVersion: '5.1.0-beta.1.local.gabc'},
      checkpoint: {
        automaticHandoffReadSha256: '5'.repeat(64),
        automaticHandoffUri: 'threadnote://user/evaluation/memories/handoffs/active/project/pilot.md',
        handoff,
        handoffSha256: sha256HexSync(Buffer.from(handoff)),
        phaseOneAccounting: {
          elapsedMilliseconds: 42,
          providerTokensMeasured: true,
          providerTokens: {
            cachedInputTokens: 4,
            inputTokens: 10,
            outputTokens: 5,
            reasoningOutputTokens: 2,
            totalTokens: 15,
          },
        },
        repositoryFixtureHash: '3'.repeat(64),
        repositoryRevision: '4'.repeat(40),
        resumeEvidenceMarker: 'checkpoint-evidence-7f4c',
      },
      retries: 0,
      taskId: 'tsk_1234567890abcdef',
      version: 1,
    } as const;

    expect(parseMatchedEvaluationContinuationPilotPlanV1(base).attempts.map(attempt => attempt.variant)).toEqual([
      'files-bare',
      'manual-handoff',
      'threadnote-graph',
      'threadnote-resume',
    ]);
    const withPreloadedResume = parseMatchedEvaluationContinuationPilotPlanV1({
      ...base,
      attempts: [
        ...base.attempts,
        {
          blindLabel: 'E',
          runNonce: 'run_00000000000000000000000000000005',
          runOrder: 5,
          variant: 'threadnote-preloaded-resume',
        },
      ],
    });
    expect(withPreloadedResume.attempts.map(attempt => attempt.variant)).toContain('threadnote-preloaded-resume');
    expect(() =>
      parseMatchedEvaluationContinuationPilotPlanV1({
        ...base,
        attempts: base.attempts.map(attempt => ({...attempt, variant: 'files-bare'})),
      }),
    ).toThrow('one unique attempt per variant');
    expect(() =>
      parseMatchedEvaluationContinuationPilotPlanV1({
        ...base,
        checkpoint: {...base.checkpoint, handoff: `${handoff} changed`},
      }),
    ).toThrow('handoff hash differs');
    expect(
      parseMatchedEvaluationContinuationPilotPlanV1({
        ...base,
        checkpoint: {
          ...base.checkpoint,
          phaseOneAccounting: {
            elapsedMilliseconds: 42,
            providerTokens: null,
            providerTokensMeasured: false,
          },
        },
      }).checkpoint.phaseOneAccounting.providerTokens,
    ).toBeNull();
    expect(() =>
      parseMatchedEvaluationContinuationPilotPlanV1({
        ...base,
        checkpoint: {
          ...base.checkpoint,
          phaseOneAccounting: {...base.checkpoint.phaseOneAccounting, providerTokensMeasured: false},
        },
      }),
    ).toThrow('unmeasured phase-one provider tokens must be null');
    fc.assert(
      fc.property(
        fc.shuffledSubarray(['files-bare', 'manual-handoff', 'threadnote-graph', 'threadnote-resume'] as const, {
          minLength: 4,
          maxLength: 4,
        }),
        variants => {
          const parsed = parseMatchedEvaluationContinuationPilotPlanV1({
            ...base,
            attempts: base.attempts.map((attempt, index) => ({...attempt, variant: variants[index]})),
          });
          expect(new Set(parsed.attempts.map(attempt => attempt.variant))).toEqual(new Set(variants));
          expect(parsed.attempts.map(attempt => attempt.runOrder)).toEqual([1, 2, 3, 4]);
        },
      ),
      {numRuns: 24},
    );

    const sourcePrompt = 'Original public issue prompt.';
    const phaseOnePrompt = `${sourcePrompt}\n\nAdd a failing regression test and stop before implementing the production fix.`;
    const phaseTwoPrompt = 'Implement the production fix for the committed regression and verify the focused suite.';
    const versionTwo = {
      attempts: base.attempts,
      candidate: base.candidate,
      checkpoint: {
        ...base.checkpoint,
        adapterConfigurations: {
          threadnoteCompactSha256: 'a'.repeat(64),
          threadnoteGraphSha256: 'b'.repeat(64),
        },
        phaseOneExecution: {
          adapterArtifactHash: 'f'.repeat(64),
          adapterConfigurationFileSha256: '0'.repeat(64),
          adapterConfigurationHash: '1'.repeat(64),
          adapterProtocol: 'matched-evaluation-adapter-v5',
          appServerExecutableSha256: '2'.repeat(64),
          appServerVersion: 'codex-cli 0.144.5',
          artifactSha256: '3'.repeat(64),
          environmentPolicyHash: '4'.repeat(64),
          model: {
            id: 'gpt-5.6-luna',
            parametersHash: '5'.repeat(64),
            provider: 'openai',
            reasoningEffort: 'low',
          },
          requestSha256: '6'.repeat(64),
          responseSha256: '7'.repeat(64),
          runNonce: 'run_11111111111111111111111111111111',
          transcriptHash: '8'.repeat(64),
          transcriptSha256: '9'.repeat(64),
        },
        phaseOnePatchSha256: '6'.repeat(64),
        phaseOnePrompt,
        phaseOnePromptSha256: sha256HexSync(Buffer.from(phaseOnePrompt)),
        preparedContext: {
          graphContentHash: '9'.repeat(64),
          graphSnapshotHash: 'a'.repeat(64),
          linkReceiptsHash: 'b'.repeat(64),
          taskContextHash: 'c'.repeat(64),
        },
        preparedGraphHome: {fixtureHash: 'f'.repeat(64), identitySha256: '0'.repeat(64)},
        preparedHome: {fixtureHash: 'd'.repeat(64), identitySha256: 'e'.repeat(64)},
        repositoryRevision: '7'.repeat(40),
      },
      phaseTwoPrompt,
      phaseTwoPromptSha256: sha256HexSync(Buffer.from(phaseTwoPrompt)),
      retries: 0,
      sourceTask: {
        prompt: sourcePrompt,
        promptSha256: matchedEvaluationPromptHashV1(sourcePrompt),
        repositoryFixtureHash: '8'.repeat(64),
        repositoryRevision: base.checkpoint.repositoryRevision,
        taskId: base.taskId,
      },
      taskId: base.taskId,
      version: 2,
    } as const;
    const parsedVersionTwo = parseMatchedEvaluationContinuationPilotPlanV1(versionTwo);
    expect(parsedVersionTwo).toMatchObject({
      checkpoint: {phaseOneExecution: versionTwo.checkpoint.phaseOneExecution},
      version: 2,
      phaseTwoPrompt,
    });
    expect(projectMatchedEvaluationContinuationSelectionCheckpointV1(parsedVersionTwo)).toMatchObject({
      adapterConfigurations: versionTwo.checkpoint.adapterConfigurations,
      phaseOneExecution: versionTwo.checkpoint.phaseOneExecution,
      phaseOnePatchSha256: versionTwo.checkpoint.phaseOnePatchSha256,
      phaseOnePromptSha256: versionTwo.checkpoint.phaseOnePromptSha256,
    });
    expect(() =>
      parseMatchedEvaluationContinuationPilotPlanV1({
        ...versionTwo,
        checkpoint: {
          ...versionTwo.checkpoint,
          phaseOneExecution: {
            ...versionTwo.checkpoint.phaseOneExecution,
            model: {...versionTwo.checkpoint.phaseOneExecution.model, parametersHash: 'invalid'},
          },
        },
      }),
    ).toThrow('phase-one model parameters hash');
    expect(() =>
      parseMatchedEvaluationContinuationPilotPlanV1({
        ...versionTwo,
        phaseTwoPrompt: `${phaseTwoPrompt} changed`,
      }),
    ).toThrow('phase-two prompt hash differs');
    expect(() =>
      parseMatchedEvaluationContinuationPilotPlanV1({
        ...versionTwo,
        checkpoint: {...versionTwo.checkpoint, phaseOnePrompt: `${phaseOnePrompt} changed`},
      }),
    ).toThrow('phase-one prompt hash differs');
    expect(() =>
      parseMatchedEvaluationContinuationPilotPlanV1({
        ...versionTwo,
        sourceTask: {...versionTwo.sourceTask, prompt: `${sourcePrompt} changed`},
      }),
    ).toThrow('source task prompt hash differs');
    const incompletePhaseOnePrompt = 'Add a failing regression test without the exact public issue.';
    expect(() =>
      parseMatchedEvaluationContinuationPilotPlanV1({
        ...versionTwo,
        checkpoint: {
          ...versionTwo.checkpoint,
          phaseOnePrompt: incompletePhaseOnePrompt,
          phaseOnePromptSha256: sha256HexSync(Buffer.from(incompletePhaseOnePrompt)),
        },
      }),
    ).toThrow('must include the exact source task prompt');
    expect(() =>
      parseMatchedEvaluationContinuationPilotPlanV1({
        ...versionTwo,
        checkpoint: {...versionTwo.checkpoint, repositoryRevision: versionTwo.sourceTask.repositoryRevision},
      }),
    ).toThrow('checkpoint must differ from the source revision');
    expect(() =>
      parseMatchedEvaluationContinuationPilotPlanV1({
        ...versionTwo,
        sourceTask: {...versionTwo.sourceTask, repositoryFixtureHash: versionTwo.checkpoint.repositoryFixtureHash},
      }),
    ).toThrow('checkpoint fixture must differ from the source fixture');
    const prompt = fc.string({minLength: 1, maxLength: 48}).filter(value => !value.includes('\0'));
    fc.assert(
      fc.property(prompt, prompt, prompt, (phaseOneSuffix, phaseTwo, source) => {
        const phaseOne = `${source}\n\n${phaseOneSuffix}`;
        fc.pre(phaseOne !== phaseTwo && source !== phaseTwo);
        const generated = {
          ...versionTwo,
          checkpoint: {
            ...versionTwo.checkpoint,
            phaseOnePrompt: phaseOne,
            phaseOnePromptSha256: sha256HexSync(Buffer.from(phaseOne)),
          },
          phaseTwoPrompt: phaseTwo,
          phaseTwoPromptSha256: sha256HexSync(Buffer.from(phaseTwo)),
          sourceTask: {
            ...versionTwo.sourceTask,
            prompt: source,
            promptSha256: matchedEvaluationPromptHashV1(source),
          },
        };
        expect(parseMatchedEvaluationContinuationPilotPlanV1(generated)).toMatchObject({
          phaseTwoPrompt: phaseTwo,
          version: 2,
        });
        expect(() =>
          parseMatchedEvaluationContinuationPilotPlanV1({
            ...generated,
            phaseTwoPromptSha256: generated.checkpoint.phaseOnePromptSha256,
          }),
        ).toThrow('phase-two prompt hash differs');
      }),
      {numRuns: 32},
    );

    const supplementPlan = parseMatchedEvaluationContinuationPilotPlanV1({
      ...versionTwo,
      attempts: [
        ...versionTwo.attempts,
        {
          blindLabel: 'E',
          runNonce: 'run_00000000000000000000000000000005',
          runOrder: 5,
          variant: 'threadnote-preloaded-resume',
        },
      ],
    });
    const rows = supplementPlan.attempts.slice(0, 4).map((attempt, index) => ({
      arm:
        attempt.variant === 'threadnote-graph'
          ? 'threadnote-graph'
          : attempt.variant === 'threadnote-resume'
            ? 'threadnote-compact'
            : 'files',
      blindLabel: attempt.blindLabel,
      position: index + 1,
      repetition: 1,
      runNonce: attempt.runNonce,
      runOrder: attempt.runOrder,
      taskId: supplementPlan.taskId,
      variant: attempt.variant,
    }));
    const parentSelection = {
      candidate: supplementPlan.candidate,
      checkpoint: projectMatchedEvaluationContinuationSelectionCheckpointV1(supplementPlan),
      comparativeClaimsEligible: false,
      identities: {planFileHash: 'a'.repeat(64)},
      rows,
      taskId: supplementPlan.taskId,
      version: 1,
    };
    const parentReport = {
      ...parentSelection,
      attempts: rows.map(row => ({
        arm: row.arm,
        runNonce: row.runNonce,
        runOrder: row.runOrder,
        status: 'completed',
        variant: row.variant,
      })),
      completed: true,
    };
    expect(
      assertMatchedEvaluationContinuationSupplementV1({
        adapterArtifactSha256: 'd'.repeat(64),
        parentReport,
        parentReportSha256: 'b'.repeat(64),
        parentSelection,
        parentSelectionSha256: 'c'.repeat(64),
        plan: supplementPlan,
      }),
    ).toEqual({
      adapterArtifactSha256: 'd'.repeat(64),
      parentReportSha256: 'b'.repeat(64),
      parentSelectionSha256: 'c'.repeat(64),
      parentVariants: rows.map(row => row.variant),
      variant: 'threadnote-preloaded-resume',
      version: 1,
    });
    expect(() =>
      assertMatchedEvaluationContinuationSupplementV1({
        adapterArtifactSha256: 'd'.repeat(64),
        parentReport: {
          ...parentReport,
          attempts: parentReport.attempts.map((attempt, index) =>
            index === 0 ? {...attempt, status: 'failed'} : attempt,
          ),
        },
        parentReportSha256: 'b'.repeat(64),
        parentSelection,
        parentSelectionSha256: 'c'.repeat(64),
        plan: supplementPlan,
      }),
    ).toThrow('differs from its sealed completed row');
  });

  it('seals a deterministic four-treatment order before continuation phase one runs', () => {
    const sourceTaskPrompt = 'Implement the frozen source task.';
    const packet = parseMatchedEvaluationContinuationPhaseOneTaskPacketV1({
      phaseOneAllowedPaths: ['tests/test_regression.py'],
      phaseOneDirective: 'Add only the failing regression and stop.',
      phaseOneFocusedChecks: ['PYTHONPATH=src {python} -m pytest -q tests/test_regression.py'],
      phaseTwoFocusedChecks: ['PYTHONPATH=src {python} -m pytest -q tests/test_regression.py'],
      phaseTwoPrompt: 'Continue from the checkpoint and implement the production correction.',
      repositoryName: 'example',
      sourceRevision: 'a'.repeat(40),
      sourceTaskPrompt,
      status: 'draft-unsealed',
      taskKey: 'example-regression',
      version: 1,
    });
    const input = {
      packet,
      repositoryRevision: packet.sourceRevision,
      task: {
        promptHash: matchedEvaluationPromptHashV1(sourceTaskPrompt),
        repositoryFixtureHash: 'b'.repeat(64),
        taskId: 'tsk_1234567890abcdef',
      } as MatchedEvaluationManifestV1['tasks'][number],
      taskPacketSha256: 'c'.repeat(64),
      taskPrompt: sourceTaskPrompt,
    };

    const first = createMatchedEvaluationContinuationPhaseOneSelectionV1(input);
    const second = createMatchedEvaluationContinuationPhaseOneSelectionV1(input);
    expect(second).toEqual(first);
    expect(parseMatchedEvaluationContinuationPhaseOneSelectionV1(JSON.parse(JSON.stringify(first)))).toEqual(first);
    expect(first.continuationAttempts.map(attempt => attempt.runOrder)).toEqual([1, 2, 3, 4]);
    expect(new Set(first.continuationAttempts.map(attempt => attempt.variant))).toEqual(
      new Set(['files-bare', 'manual-handoff', 'threadnote-graph', 'threadnote-resume']),
    );
    expect(new Set(first.continuationAttempts.map(attempt => attempt.runNonce))).toHaveProperty('size', 4);
    expect(first.phaseOnePrompt).toBe(`${sourceTaskPrompt}\n\n${packet.phaseOneDirective}`);
    expect(() =>
      parseMatchedEvaluationContinuationPhaseOneSelectionV1({
        ...first,
        phaseOnePrompt: `${first.phaseOnePrompt}\nchanged after sealing`,
      }),
    ).toThrow('differs from its packet');
    fc.assert(
      fc.property(fc.stringMatching(/^[0-9a-f]{64}$/u), taskPacketSha256 => {
        const selection = createMatchedEvaluationContinuationPhaseOneSelectionV1({...input, taskPacketSha256});
        expect(selection.continuationAttempts.map(attempt => attempt.runOrder)).toEqual([1, 2, 3, 4]);
        expect(new Set(selection.continuationAttempts.map(attempt => attempt.variant))).toHaveProperty('size', 4);
        expect(new Set(selection.continuationAttempts.map(attempt => attempt.runNonce))).toHaveProperty('size', 4);
        expect(createMatchedEvaluationContinuationPhaseOneSelectionV1({...input, taskPacketSha256})).toEqual(selection);
      }),
      {numRuns: 8},
    );

    const evidenceSha256 = {
      adapterArtifactHash: '1'.repeat(64),
      adapterConfigurationFileSha256: '2'.repeat(64),
      artifactSha256: '3'.repeat(64),
      requestSha256: '4'.repeat(64),
      responseSha256: '5'.repeat(64),
      transcriptSha256: '6'.repeat(64),
    };
    const metrics = {
      auditability: {citations: 0, resolvableCitations: 0},
      completion: {completed: true},
      context: null,
      correctness: {judge: 'blinded-rubric-v1', judgeCompleted: true, scoreMilli: 1_000},
      drift: {falseCurrentOutcomes: 0},
      providerCostMicros: null,
      retrieval: {recalledEvidence: 0, requiredEvidence: 0},
      safety: {authorizationLeaks: 0, blockedActions: 0, harmfulActions: 0},
      sourceSupport: {requiredClaims: 0, supportedClaims: 0},
      timing: {
        agentTaskMilliseconds: 10,
        deterministicVerifierMilliseconds: 0,
        endToEndMilliseconds: 15,
        firstSufficientEvidenceMilliseconds: null,
        judgeSetupMilliseconds: 1,
        judgeTurnMilliseconds: 2,
        preparationMilliseconds: 2,
      },
      usage: {
        modelVisibleBytes: 100,
        modelVisibleTokens: 25,
        providerTokens: {
          cachedInputTokens: 0,
          inputTokens: 20,
          outputTokens: 5,
          reasoningOutputTokens: 0,
          totalTokens: 25,
        },
        redundantFileReads: 0,
        toolTurns: 1,
      },
      validity: {failureCount: 0, valid: true},
      verification: null,
    };
    const selectionSha256 = '7'.repeat(64);
    const receipt = parseMatchedEvaluationContinuationPhaseOneReceiptV1({
      continuationAttempts: first.continuationAttempts,
      evidenceSha256,
      metrics,
      phaseOnePromptSha256: first.phaseOnePromptSha256,
      phaseOneRunNonce: first.phaseOneRunNonce,
      selectionSha256,
      taskId: first.sourceTask.taskId,
      taskPacketSha256: first.taskPacketSha256,
      transcriptHash: evidenceSha256.transcriptSha256,
      version: 1,
    });
    const responseObservation = parseMatchedEvaluationObservationV1({
      artifactHash: evidenceSha256.artifactSha256,
      metrics,
      transcriptHash: evidenceSha256.transcriptSha256,
      version: 5,
    });
    expect(() =>
      assertMatchedEvaluationContinuationPhaseOneReceiptV1({
        evidenceSha256,
        receipt,
        responseObservation,
        selection: first,
        selectionSha256,
      }),
    ).not.toThrow();
    expect(() =>
      assertMatchedEvaluationContinuationPhaseOneReceiptV1({
        evidenceSha256: {...evidenceSha256, responseSha256: '8'.repeat(64)},
        receipt,
        responseObservation,
        selection: first,
        selectionSha256,
      }),
    ).toThrow('differs from the sealed selection or preserved evidence');
    expect(() =>
      parseMatchedEvaluationContinuationPhaseOneReceiptV1({
        ...receipt,
        evidenceSha256: {...receipt.evidenceSha256, artifactSha256: 'invalid'},
      }),
    ).toThrow('receipt artifact hash');

    const verification = createMatchedEvaluationVerificationReceiptV1({
      artifactHash: evidenceSha256.artifactSha256,
      diagnosticHash: '8'.repeat(64),
      durationMilliseconds: 1,
      environmentHash: '9'.repeat(64),
      exitCode: 1,
      interpreterHash: 'a'.repeat(64),
      planHash: 'b'.repeat(64),
      runnerHash: 'c'.repeat(64),
      sandboxExecutableHash: 'd'.repeat(64),
      status: 'task-failed',
      taskId: first.sourceTask.taskId,
      verificationId: 'e'.repeat(64),
    });
    const expectedFailureObservation = {
      artifactHash: evidenceSha256.artifactSha256,
      metrics: {
        ...metrics,
        completion: {completed: false},
        timing: {...metrics.timing, deterministicVerifierMilliseconds: 1, endToEndMilliseconds: 16},
        verification,
      },
      transcriptHash: evidenceSha256.transcriptSha256,
      version: 5,
    };
    expect(() =>
      assertMatchedEvaluationContinuationPhaseOneResultV1(
        {agentResult: {completed: false}, patch: 'diff --git a/test.py b/test.py\n'},
        expectedFailureObservation,
        first.sourceTask.taskId,
      ),
    ).not.toThrow();
    expect(() =>
      assertMatchedEvaluationContinuationPhaseOneResultV1(
        {agentResult: {completed: false}, patch: ''},
        expectedFailureObservation,
        first.sourceTask.taskId,
      ),
    ).toThrow('nonempty test patch');
  });

  it('binds v2 phase-one provenance claims to the preserved adapter evidence files', async () => {
    const root = await temporaryRoot(roots);
    const phaseOne = join(root, 'phase-one');
    await mkdir(phaseOne);
    const taskId = 'tsk_1234567890abcdef';
    const sourceFixtureHash = 'a'.repeat(64);
    const sourceRevision = 'b'.repeat(40);
    const prompt = 'Add the regression test and stop before the production fix.';
    const runNonce = 'run_22222222222222222222222222222222';
    const model = {
      id: 'gpt-5.6-luna',
      parametersHash: 'c'.repeat(64),
      provider: 'openai',
      reasoningEffort: 'low',
    };
    const adapter = Buffer.from('sealed adapter');
    const config = Buffer.from(
      `${JSON.stringify({
        appServer: {executableSha256: 'd'.repeat(64), version: 'codex-cli 0.144.5'},
        environmentPolicyHash: 'e'.repeat(64),
        model,
      })}\n`,
    );
    const request = Buffer.from(
      `${JSON.stringify({
        adapterArtifactHash: sha256HexSync(adapter),
        adapterConfigurationHash: sha256HexSync(config),
        adapterProtocol: 'matched-evaluation-adapter-v5',
        agentTask: {prompt, repositoryFixtureHash: sourceFixtureHash, taskId},
        environmentPolicyHash: 'e'.repeat(64),
        model: {model: model.id, parametersHash: model.parametersHash, provider: model.provider},
        runNonce,
      })}\n`,
    );
    const artifact = Buffer.from(
      `${JSON.stringify({
        agentResult: {completed: true},
        patch: 'diff --git a/tests/test_marker.py b/tests/test_marker.py\n',
        repository: {fixtureHash: sourceFixtureHash, revision: sourceRevision},
        runNonce,
        taskId,
      })}\n`,
    );
    const providerTokens = {
      cachedInputTokens: 4,
      inputTokens: 10,
      outputTokens: 5,
      reasoningOutputTokens: 2,
      totalTokens: 15,
    };
    const transcript = Buffer.from('{"kind":"agent"}\n');
    const transcriptHash = 'f'.repeat(64);
    const response = Buffer.from(
      `${JSON.stringify({
        metrics: {safety: {blockedActions: 0}, timing: {endToEndMilliseconds: 42}, usage: {providerTokens}},
        transcriptHash,
      })}\n`,
    );
    await Promise.all([
      writeFile(join(phaseOne, 'adapter'), adapter),
      writeFile(join(phaseOne, 'adapter-config.json'), config),
      writeFile(join(phaseOne, 'artifact.json'), artifact),
      writeFile(join(phaseOne, 'request.json'), request),
      writeFile(join(phaseOne, 'response.json'), response),
      writeFile(join(phaseOne, 'transcript.jsonl'), transcript),
    ]);
    const plan = {
      checkpoint: {
        phaseOneAccounting: {elapsedMilliseconds: 42, providerTokens, providerTokensMeasured: true},
        phaseOneExecution: {
          adapterArtifactHash: sha256HexSync(adapter),
          adapterConfigurationFileSha256: sha256HexSync(config),
          adapterConfigurationHash: sha256HexSync(config),
          adapterProtocol: 'matched-evaluation-adapter-v5',
          appServerExecutableSha256: 'd'.repeat(64),
          appServerVersion: 'codex-cli 0.144.5',
          artifactSha256: sha256HexSync(artifact),
          environmentPolicyHash: 'e'.repeat(64),
          model,
          requestSha256: sha256HexSync(request),
          responseSha256: sha256HexSync(response),
          runNonce,
          transcriptHash,
          transcriptSha256: sha256HexSync(transcript),
        },
        phaseOnePrompt: prompt,
      },
      sourceTask: {repositoryFixtureHash: sourceFixtureHash, repositoryRevision: sourceRevision},
      taskId,
    } as Parameters<typeof assertMatchedEvaluationContinuationPhaseOneEvidenceV2>[0]['plan'];

    await expect(
      assertMatchedEvaluationContinuationPhaseOneEvidenceV2({plan, planPath: join(root, 'continuation-plan.json')}),
    ).resolves.toEqual({agentPatch: 'diff --git a/tests/test_marker.py b/tests/test_marker.py\n'});
    const blockedResponse = Buffer.from(
      `${JSON.stringify({
        metrics: {safety: {blockedActions: 1}, timing: {endToEndMilliseconds: 42}, usage: {providerTokens}},
        transcriptHash,
      })}\n`,
    );
    await writeFile(join(phaseOne, 'response.json'), blockedResponse);
    await expect(
      assertMatchedEvaluationContinuationPhaseOneEvidenceV2({
        plan: {
          ...plan,
          checkpoint: {
            ...plan.checkpoint,
            phaseOneExecution: {
              ...plan.checkpoint.phaseOneExecution,
              responseSha256: sha256HexSync(blockedResponse),
            },
          },
        },
        planPath: join(root, 'continuation-plan.json'),
      }),
    ).rejects.toThrow('accounting differs');
    await writeFile(join(phaseOne, 'response.json'), response);
    await writeFile(join(phaseOne, 'response.json'), `${response.toString('utf8')} `);
    await expect(
      assertMatchedEvaluationContinuationPhaseOneEvidenceV2({plan, planPath: join(root, 'continuation-plan.json')}),
    ).rejects.toThrow('responseSha256');
  });

  it('attests a nonempty direct-child phase-one checkpoint and its exact binary patch', async () => {
    if (process.platform === 'win32') return;
    const root = await temporaryRoot(roots);
    const repository = join(root, 'repository');
    const base = await repositoryFixture(repository, 'https://github.com/example/continuation-fixture.git', 'base');
    await writeFile(join(repository, 'service.ts'), 'export const value = "phase-one";\n');
    await git(repository, ['add', 'service.ts']);
    await git(repository, ['commit', '-qm', 'phase one']);
    const checkpoint = await observeMatchedEvaluationRepositoryV1(repository);
    const agentPatch = await gitOutput(repository, [
      'diff',
      '--binary',
      '--no-ext-diff',
      base.revision,
      checkpoint.revision,
      '--',
      '.',
    ]);
    const input = {
      agentPatch,
      baseFixtureHash: base.fixtureHash,
      baseRevision: base.revision,
      checkpoint,
      patchSha256: sha256HexSync(Buffer.from(agentPatch)),
      repositoryDirectory: repository,
    };

    await expect(assertMatchedEvaluationContinuationCheckpointV2(input)).resolves.toBeUndefined();
    await expect(
      assertMatchedEvaluationContinuationCheckpointV2({
        ...input,
        agentPatch: agentPatch.replace('phase-one', 'different'),
      }),
    ).rejects.toThrow('checkpoint differs from the preserved phase-one agent patch');
    await expect(
      assertMatchedEvaluationContinuationCheckpointV2({...input, patchSha256: 'f'.repeat(64)}),
    ).rejects.toThrow('phase-one patch differs');
    await expect(
      assertMatchedEvaluationContinuationCheckpointV2({...input, baseFixtureHash: 'e'.repeat(64)}),
    ).rejects.toThrow('source repository differs');
    await git(repository, ['commit', '--allow-empty', '-qm', 'second phase-one commit']);
    const secondCheckpoint = await observeMatchedEvaluationRepositoryV1(repository);
    await expect(
      assertMatchedEvaluationContinuationCheckpointV2({...input, checkpoint: secondCheckpoint}),
    ).rejects.toThrow('one direct non-merge commit');
  });

  it('projects only the phase-two prompt and checkpoint identity to fresh Agent B', () => {
    const task = {
      category: 'unfamiliar-call-path',
      memoryFixtures: [],
      negativeControls: [],
      pairId: null,
      prompt: 'Original public issue prompt.',
      repositoryFixtureHash: '1'.repeat(64),
      rubric: {completion: 'behavior passes', criteria: ['passes'], requiredEvidenceIds: []},
      sourceGold: [],
      taskId: 'tsk_1234567890abcdef',
      variant: 'historical-as-issued',
    } as const;
    const study = {
      studyHash: '2'.repeat(64),
      taskContexts: [
        {
          clusterId: 'cluster_1234567890abcdef',
          graphContentHash: '3'.repeat(64),
          graphSnapshotHash: '4'.repeat(64),
          linkReceiptsHash: '5'.repeat(64),
          repositoryFixtureHash: task.repositoryFixtureHash,
          taskContextHash: '6'.repeat(64),
          taskId: task.taskId,
        },
      ],
    } as unknown as MatchedTokenEfficiencyStudyV1;
    const plan = {
      checkpoint: {
        preparedContext: {
          graphContentHash: '7'.repeat(64),
          graphSnapshotHash: '8'.repeat(64),
          linkReceiptsHash: '9'.repeat(64),
          taskContextHash: 'a'.repeat(64),
        },
        repositoryFixtureHash: 'b'.repeat(64),
      },
      phaseTwoPrompt: 'Implement the production fix from the committed regression test.',
    } as Parameters<typeof projectMatchedEvaluationContinuationAdapterTaskV2>[2];

    const compact = projectMatchedEvaluationContinuationAdapterTaskV2({arm: 'threadnote-compact', task}, study, plan);
    expect(compact.agentTask).toMatchObject({
      prompt: plan.phaseTwoPrompt,
      repositoryFixtureHash: plan.checkpoint.repositoryFixtureHash,
    });
    expect(compact.agentTask.prompt).not.toBe(task.prompt);
    expect(compact.preparedContext).toMatchObject({
      memoryAccess: 'linked',
      taskContext: plan.checkpoint.preparedContext,
    });
    expect(
      projectMatchedEvaluationContinuationAdapterTaskV2({arm: 'threadnote-graph', task}, study, plan).preparedContext,
    ).toMatchObject({
      graphContext: {
        graphContentHash: plan.checkpoint.preparedContext.graphContentHash,
        graphSnapshotHash: plan.checkpoint.preparedContext.graphSnapshotHash,
      },
      memoryAccess: 'disabled',
    });
    expect(
      projectMatchedEvaluationContinuationAdapterTaskV2({arm: 'files', task}, study, plan).preparedContext,
    ).toBeNull();
  });

  it('keeps the source study frozen while resolving the continuation cluster at the checkpoint', () => {
    const clusterId = 'cluster_1234567890abcdef';
    const taskId = 'tsk_1234567890abcdef';
    const sourceTask = {
      prompt: 'Original issue.',
      promptSha256: '1'.repeat(64),
      repositoryFixtureHash: '2'.repeat(64),
      repositoryRevision: '3'.repeat(40),
      taskId,
    };
    const preparedContext = {
      graphContentHash: '4'.repeat(64),
      graphSnapshotHash: '5'.repeat(64),
      linkReceiptsHash: '6'.repeat(64),
      taskContextHash: '7'.repeat(64),
    };
    const checkpoint = {
      preparedContext,
      repositoryFixtureHash: '8'.repeat(64),
      repositoryRevision: '9'.repeat(40),
    } as unknown as Parameters<typeof continuationCheckpointStudyV2>[2];
    const study = {
      clusters: [
        {
          clusterId,
          repositoryFixtureHash: sourceTask.repositoryFixtureHash,
          repositoryIdentityHash: 'a'.repeat(64),
          revision: sourceTask.repositoryRevision,
        },
      ],
      taskContexts: [{clusterId, graphSnapshotHash: 'b'.repeat(64), taskId}],
    } as unknown as MatchedTokenEfficiencyStudyV1;

    expect(continuationCheckpointStudyV2(study, sourceTask, checkpoint).clusters[0]).toMatchObject({
      repositoryFixtureHash: checkpoint.repositoryFixtureHash,
      revision: checkpoint.repositoryRevision,
    });
    expect(() =>
      continuationCheckpointStudyV2(study, {...sourceTask, repositoryFixtureHash: 'c'.repeat(64)}, checkpoint),
    ).toThrow('source repository differs');
    expect(() =>
      continuationCheckpointStudyV2(study, sourceTask, {
        ...checkpoint,
        preparedContext: {...preparedContext, graphSnapshotHash: study.taskContexts[0].graphSnapshotHash},
      }),
    ).toThrow('checkpoint-specific prepared graph snapshot');
  });

  it('binds prepared-home identity without exposing its account or project in the plan', () => {
    const prepared = {
      identity: {account: 'evaluation', user: 'agent-b'},
      project: 'continuation-project',
      taskId: 'tsk_1234567890abcdef',
    };
    const identityHash = matchedEvaluationContinuationPreparedHomeIdentityHashV2(prepared);
    expect(identityHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(
      matchedEvaluationContinuationPreparedHomeIdentityHashV2({
        ...prepared,
        identity: {...prepared.identity, user: 'different-agent'},
      }),
    ).not.toBe(identityHash);
  });

  it('admits only checkpoint adapter configs that replace context homes without changing execution policy', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'threadnote-continuation-config-')));
    roots.push(root);
    const graphHome = join(root, 'graph-home');
    const compactHome = join(root, 'compact-home');
    const checkpointConfigDirectory = join(root, 'checkpoint-adapter-config');
    await Promise.all([mkdir(graphHome), mkdir(compactHome), mkdir(checkpointConfigDirectory)]);
    const [graphFixtureHash, compactFixtureHash] = await Promise.all([
      matchedEvaluationPreparedHomeFixtureHashV1(graphHome),
      matchedEvaluationPreparedHomeFixtureHashV1(compactHome),
    ]);
    const taskId = 'tsk_1234567890abcdef';
    const graphContext = {
      graphContentHash: '1'.repeat(64),
      graphSnapshotHash: '2'.repeat(64),
      linkReceiptsHash: null,
      memoryAccess: 'disabled' as const,
      taskContextHash: null,
    };
    const compactContext = {
      ...graphContext,
      linkReceiptsHash: '3'.repeat(64),
      memoryAccess: 'linked' as const,
      taskContextHash: '4'.repeat(64),
    };
    const graphPreparedHome = continuationPreparedHome(taskId, graphHome, graphFixtureHash, graphContext, 'graph');
    const compactPreparedHome = continuationPreparedHome(
      taskId,
      compactHome,
      compactFixtureHash,
      compactContext,
      'compact',
    );
    const sourceGraph = continuationAdapterConfig('threadnote-graph', []);
    const sourceCompact = continuationAdapterConfig('threadnote-compact', []);
    const checkpointGraph = continuationAdapterConfig('threadnote-graph', [graphPreparedHome]);
    const checkpointCompact = continuationAdapterConfig('threadnote-compact', [compactPreparedHome]);
    const sourceGraphPath = join(root, 'source-graph.json');
    const sourceCompactPath = join(root, 'source-compact.json');
    const checkpointGraphPath = join(checkpointConfigDirectory, 'threadnote-graph.json');
    const checkpointCompactPath = join(checkpointConfigDirectory, 'threadnote-compact.json');
    const files = [
      [sourceGraphPath, sourceGraph],
      [sourceCompactPath, sourceCompact],
      [checkpointGraphPath, checkpointGraph],
      [checkpointCompactPath, checkpointCompact],
    ] as const;
    await Promise.all(files.map(([path, value]) => writeFile(path, `${JSON.stringify(value)}\n`)));
    const sourceGraphHash = sha256HexSync(Buffer.from(`${JSON.stringify(sourceGraph)}\n`));
    const sourceCompactHash = sha256HexSync(Buffer.from(`${JSON.stringify(sourceCompact)}\n`));
    const checkpointGraphHash = sha256HexSync(Buffer.from(`${JSON.stringify(checkpointGraph)}\n`));
    const checkpointCompactHash = sha256HexSync(Buffer.from(`${JSON.stringify(checkpointCompact)}\n`));
    const plan = {
      checkpoint: {
        adapterConfigurations: {
          threadnoteCompactSha256: checkpointCompactHash,
          threadnoteGraphSha256: checkpointGraphHash,
        },
        preparedContext: {
          graphContentHash: graphContext.graphContentHash,
          graphSnapshotHash: graphContext.graphSnapshotHash,
          linkReceiptsHash: compactContext.linkReceiptsHash,
          taskContextHash: compactContext.taskContextHash,
        },
        preparedGraphHome: {
          fixtureHash: graphFixtureHash,
          identitySha256: matchedEvaluationContinuationPreparedHomeIdentityHashV2(graphPreparedHome),
        },
        preparedHome: {
          fixtureHash: compactFixtureHash,
          identitySha256: matchedEvaluationContinuationPreparedHomeIdentityHashV2(compactPreparedHome),
        },
      },
      taskId,
    } as unknown as MatchedEvaluationContinuationPilotPlanV2;
    const manifest = {
      arms: [
        {adapterConfigurationHash: sourceGraphHash, arm: 'threadnote-graph'},
        {adapterConfigurationHash: sourceCompactHash, arm: 'threadnote-compact'},
      ],
    } as unknown as MatchedEvaluationManifestV1;
    const runtime = {
      arms: [
        {adapterConfigFile: sourceGraphPath, arm: 'threadnote-graph'},
        {adapterConfigFile: sourceCompactPath, arm: 'threadnote-compact'},
      ],
    } as unknown as MatchedEvaluationRuntimeV1;

    const overrides = await assertMatchedEvaluationContinuationAdapterConfigurationsV2({
      manifest,
      plan,
      planPath: join(root, 'plan.json'),
      runtime,
    });
    expect(overrides.get('threadnote-graph')?.adapterConfigFile).toBe(checkpointGraphPath);
    expect(overrides.get('threadnote-compact')?.adapterConfigFile).toBe(checkpointCompactPath);

    const changedPolicy = {
      ...checkpointCompact,
      taskBudget: {...checkpointCompact.taskBudget, tokens: checkpointCompact.taskBudget.tokens + 1},
    };
    const changedBytes = `${JSON.stringify(changedPolicy)}\n`;
    await writeFile(checkpointCompactPath, changedBytes);
    await expect(
      assertMatchedEvaluationContinuationAdapterConfigurationsV2({
        manifest,
        plan: {
          ...plan,
          checkpoint: {
            ...plan.checkpoint,
            adapterConfigurations: {
              ...plan.checkpoint.adapterConfigurations,
              threadnoteCompactSha256: sha256HexSync(Buffer.from(changedBytes)),
            },
          },
        },
        planPath: join(root, 'plan.json'),
        runtime,
      }),
    ).rejects.toThrow('changes the frozen execution policy');

    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.record({delta: fc.integer({min: 1, max: 700}), field: fc.constant('contextBudgetTokens' as const)}),
          fc.record({delta: fc.integer({min: 1, max: 744}), field: fc.constant('steps' as const)}),
          fc.record({delta: fc.integer({min: 1, max: 9_000_000}), field: fc.constant('tokens' as const)}),
        ),
        async ({field, delta}) => {
          const mutated =
            field === 'contextBudgetTokens'
              ? {...checkpointCompact, contextBudgetTokens: checkpointCompact.contextBudgetTokens + delta}
              : {
                  ...checkpointCompact,
                  taskBudget: {
                    ...checkpointCompact.taskBudget,
                    [field]: checkpointCompact.taskBudget[field] + delta,
                  },
                };
          const bytes = `${JSON.stringify(mutated)}\n`;
          await writeFile(checkpointCompactPath, bytes);
          await expect(
            assertMatchedEvaluationContinuationAdapterConfigurationsV2({
              manifest,
              plan: {
                ...plan,
                checkpoint: {
                  ...plan.checkpoint,
                  adapterConfigurations: {
                    ...plan.checkpoint.adapterConfigurations,
                    threadnoteCompactSha256: sha256HexSync(Buffer.from(bytes)),
                  },
                },
              },
              planPath: join(root, 'plan.json'),
              runtime,
            }),
          ).rejects.toThrow('changes the frozen execution policy');
        },
      ),
      {numRuns: 9},
    );
  });

  it('stages a sealed continuation adapter-config override instead of the source config', async () => {
    const root = await temporaryRoot(roots);
    const adapterPath = join(root, 'adapter');
    const sourceConfigPath = join(root, 'source-config.json');
    const checkpointConfigPath = join(root, 'checkpoint-config.json');
    const stagedDirectory = join(root, 'staged');
    const adapter = Buffer.from('#!/bin/sh\nexit 0\n');
    const sourceConfig = Buffer.from('{"contextHomes":[]}\n');
    const checkpointConfig = Buffer.from('{"contextHomes":[{"taskId":"tsk_1234567890abcdef"}]}\n');
    await Promise.all([
      writeFile(adapterPath, adapter),
      writeFile(sourceConfigPath, sourceConfig),
      writeFile(checkpointConfigPath, checkpointConfig),
      mkdir(stagedDirectory),
    ]);
    await chmod(adapterPath, 0o700);
    const sourceConfigHash = sha256HexSync(sourceConfig);
    const checkpointConfigHash = sha256HexSync(checkpointConfig);
    const runtime = {
      arms: [
        {
          adapterArguments: [],
          adapterConfigFile: sourceConfigPath,
          adapterExecutable: adapterPath,
          arm: 'files',
          environmentKeys: [],
          toolExecutable: null,
          toolLockFile: null,
        },
      ],
      artifactDirectory: join(root, 'artifacts'),
      repositories: [],
      timeoutMilliseconds: 60_000,
      verificationPlanHash: null,
      version: 4,
    } as const satisfies MatchedEvaluationRuntimeV1;
    const definition = {
      adapterArtifactHash: sha256HexSync(adapter),
      adapterConfigurationHash: sourceConfigHash,
      adapterProtocol: 'matched-evaluation-adapter-v5',
      arm: 'files',
      environmentPolicyHash: 'a'.repeat(64),
      tool: {artifactHash: null, lockIdentityHash: null, name: 'none', version: 'none'},
    } as const satisfies Parameters<typeof resolveRuntimeArm>[2];

    const resolved = await resolveRuntimeArm(runtime, 'files', definition, null, {
      adapterConfigFile: checkpointConfigPath,
      adapterConfigurationHash: checkpointConfigHash,
    });
    if ('reason' in resolved) throw new Error(`Expected resolved arm, received ${resolved.reason}: ${resolved.detail}`);
    expect(resolved.definition.adapterConfigurationHash).toBe(checkpointConfigHash);

    const staged = await stageResolvedRuntimeArmV1(resolved, stagedDirectory);
    expect(await readFile(staged.adapterConfigFile)).toEqual(checkpointConfig);
    expect(staged.definition.adapterConfigurationHash).toBe(checkpointConfigHash);
  });

  it('selects exactly one first-repetition row per pilot arm in frozen order', () => {
    const manifest = {
      activeArms: ['files', 'threadnote-graph', 'threadnote-compact'],
      blindAssignment: {
        A: 'files',
        B: 'threadnote-graph',
        C: 'threadnote-compact',
        D: 'threadnote-source',
        E: 'reference-scope',
      },
      schedule: [
        {
          taskId: 'tsk_1234567890abcdef',
          repetition: 1,
          position: 2,
          runNonce: 'run_00000000000000000000000000000001',
          runOrder: 8,
          blindLabel: 'B',
        },
        {
          taskId: 'tsk_1234567890abcdef',
          repetition: 1,
          position: 1,
          runNonce: 'run_00000000000000000000000000000002',
          runOrder: 7,
          blindLabel: 'A',
        },
        {
          taskId: 'tsk_1234567890abcdef',
          repetition: 1,
          position: 3,
          runNonce: 'run_00000000000000000000000000000003',
          runOrder: 9,
          blindLabel: 'C',
        },
        {
          taskId: 'tsk_1234567890abcdef',
          repetition: 2,
          position: 1,
          runNonce: 'run_00000000000000000000000000000004',
          runOrder: 10,
          blindLabel: 'A',
        },
      ],
    } as const;
    expect(selectMatchedEvaluationPilotRowsV1(manifest, 'tsk_1234567890abcdef').map(row => row.runOrder)).toEqual([
      7, 8, 9,
    ]);
    expect(() =>
      selectMatchedEvaluationPilotRowsV1(
        {...manifest, activeArms: ['files', 'threadnote-graph', 'threadnote-source']},
        'tsk_1234567890abcdef',
      ),
    ).toThrow('exactly files');
    expect(() => selectMatchedEvaluationPilotRowsV1(manifest, 'tsk_ffffffffffffffff')).toThrow(
      'not in the manifest schedule',
    );
  });

  it('hashes the complete staged payload deterministically and rejects symlinks', async () => {
    if (process.platform === 'win32') return;
    const root = await temporaryRoot(roots);
    await mkdir(join(root, 'runtime'));
    await writeFile(join(root, 'threadnote'), 'payload');
    await writeFile(join(root, 'runtime', 'native'), 'native');
    const first = await hashMatchedEvaluationPayloadV1(root);
    expect(await hashMatchedEvaluationPayloadV1(root)).toBe(first);
    await writeFile(join(root, 'runtime', 'native'), 'changed');
    expect(await hashMatchedEvaluationPayloadV1(root)).not.toBe(first);
    await symlink(join(root, 'threadnote'), join(root, 'runtime', 'escape'));
    await expect(hashMatchedEvaluationPayloadV1(root)).rejects.toThrow('symbolic link');
  });

  it('binds repository identity, revision, dirty state, and fixture bytes to the manifest observation', async () => {
    if (process.platform === 'win32') return;
    const root = await temporaryRoot(roots);
    const repository = join(root, 'repository');
    await mkdir(repository);
    await git(repository, ['init', '-q']);
    await git(repository, ['config', 'user.email', 'evaluation@example.invalid']);
    await git(repository, ['config', 'user.name', 'Evaluation Fixture']);
    await git(repository, ['remote', 'add', 'origin', 'https://github.com/example/context-fixture.git']);
    await writeFile(join(repository, 'service.ts'), 'export const value = 1;\n');
    await git(repository, ['add', 'service.ts']);
    await git(repository, ['commit', '-qm', 'fixture']);

    const clean = await observeMatchedEvaluationRepositoryV1(repository);
    expect(clean).toMatchObject({dirty: false});
    expect(clean.fixtureHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(clean.identityHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(await observeMatchedEvaluationRepositoryV1(repository)).toEqual(clean);

    await writeFile(join(repository, 'service.ts'), 'export const value = 2;\n');
    const dirty = await observeMatchedEvaluationRepositoryV1(repository);
    expect(dirty).toMatchObject({dirty: true, identityHash: clean.identityHash, revision: clean.revision});
    expect(dirty.fixtureHash).not.toBe(clean.fixtureHash);
    await expect(assertMatchedEvaluationRepositoryV1(repository, clean)).rejects.toThrow('dirty differs');
  });

  it('rejects repository fixture symlinks before execution can read their targets', async () => {
    if (process.platform === 'win32') return;
    const root = await temporaryRoot(roots);
    const repository = join(root, 'repository');
    await mkdir(repository);
    await git(repository, ['init', '-q']);
    await git(repository, ['config', 'user.email', 'evaluation@example.invalid']);
    await git(repository, ['config', 'user.name', 'Evaluation Fixture']);
    const target = join(root, 'outside-repository.ts');
    await writeFile(target, 'export const value = 1;\n');
    await symlink(target, join(repository, 'service.ts'));
    await git(repository, ['add', 'service.ts']);
    await git(repository, ['commit', '-qm', 'fixture']);

    await expect(observeMatchedEvaluationRepositoryV1(repository)).rejects.toThrow(
      'Repository fixture path must not be symbolic link: service.ts',
    );
  });

  it('holds one exclusive artifact lock for the complete runner lifetime', async () => {
    const artifactDirectory = join(await temporaryRoot(roots), '.context', 'evaluation');
    await mkdir(artifactDirectory, {recursive: true});
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>(resolvePromise => {
      entered = resolvePromise;
    });
    const releasePromise = new Promise<void>(resolvePromise => {
      release = resolvePromise;
    });
    const first = withMatchedEvaluationArtifactLockV1(artifactDirectory, async () => {
      entered();
      await releasePromise;
    });
    await enteredPromise;

    await expect(withMatchedEvaluationArtifactLockV1(artifactDirectory, async () => undefined)).rejects.toThrow(
      'Another matched evaluation runner owns this artifact directory',
    );
    release();
    await first;
    await expect(withMatchedEvaluationArtifactLockV1(artifactDirectory, async () => 'complete')).resolves.toBe(
      'complete',
    );
  });

  it('rejects same-length ledger replacement and stages immutable executable bytes', async () => {
    const root = await temporaryRoot(roots);
    const ledger = join(root, 'outcomes.jsonl');
    await writeFile(ledger, 'first\n');
    await compareAndSwapMatchedEvaluationLedgerV1(ledger, 'first\n', 'second\n');
    expect(await readFile(ledger, 'utf8')).toBe('second\n');
    await writeFile(ledger, 'forged\n');
    await expect(compareAndSwapMatchedEvaluationLedgerV1(ledger, 'second\n', 'third!\n')).rejects.toThrow(
      'Outcome ledger changed',
    );

    const executable = join(root, 'adapter');
    await writeFile(executable, '#!/bin/sh\nexit 0\n');
    await chmod(executable, 0o700);
    const expectedHash = sha256HexSync(await readFile(executable));
    await expect(
      assertMatchedEvaluationPinnedFileV1(executable, expectedHash, true, 'fixture adapter'),
    ).resolves.toBeUndefined();
    const staged = join(root, 'staged-adapter');
    await expect(
      stageMatchedEvaluationPinnedFileV1(executable, staged, expectedHash, true, 'fixture adapter'),
    ).resolves.toBe(staged);
    await writeFile(executable, '#!/bin/sh\nexit 1\n');
    expect(await readFile(staged, 'utf8')).toBe('#!/bin/sh\nexit 0\n');
    await expect(
      assertMatchedEvaluationPinnedFileV1(staged, expectedHash, true, 'staged adapter'),
    ).resolves.toBeUndefined();
    await expect(
      assertMatchedEvaluationPinnedFileV1(executable, expectedHash, true, 'fixture adapter'),
    ).rejects.toThrow('differs from its pinned manifest identity');
  });

  it('binds every held-out cluster to its own clean repository checkout', async () => {
    if (process.platform === 'win32') return;
    const root = await temporaryRoot(roots);
    const firstDirectory = join(root, 'first-repository');
    const secondDirectory = join(root, 'second-repository');
    const first = await repositoryFixture(firstDirectory, 'https://github.com/example/first-fixture.git', 'first');
    const second = await repositoryFixture(secondDirectory, 'https://github.com/example/second-fixture.git', 'second');
    const firstCluster = 'cluster_1111111111111111';
    const secondCluster = 'cluster_2222222222222222';
    const study = {
      clusters: [
        {
          clusterId: firstCluster,
          repositoryFixtureHash: first.fixtureHash,
          repositoryIdentityHash: first.identityHash,
          revision: first.revision,
        },
        {
          clusterId: secondCluster,
          repositoryFixtureHash: second.fixtureHash,
          repositoryIdentityHash: second.identityHash,
          revision: second.revision,
        },
      ],
    } as unknown as MatchedTokenEfficiencyStudyV1;
    const runtime = {
      arms: [],
      artifactDirectory: join(root, 'artifacts'),
      repositories: [
        {clusterId: secondCluster, repositoryDirectory: secondDirectory, repositoryIdentityHash: second.identityHash},
        {clusterId: firstCluster, repositoryDirectory: firstDirectory, repositoryIdentityHash: first.identityHash},
      ],
      timeoutMilliseconds: 60_000,
      verificationPlanHash: 'f'.repeat(64),
      version: 4 as const,
    };

    expect(parseMatchedEvaluationRuntimeV1(runtime)).toEqual(runtime);
    const resolved = await resolveMatchedEvaluationRuntimeRepositoriesV1(runtime, study, first);

    expect(resolved.get(firstCluster)).toMatchObject({repositoryDirectory: firstDirectory, expected: first});
    expect(resolved.get(secondCluster)).toMatchObject({repositoryDirectory: secondDirectory, expected: second});
    await expect(
      resolveMatchedEvaluationRuntimeRepositoriesV1(
        {
          ...runtime,
          repositories: runtime.repositories.map(repository =>
            repository.clusterId === firstCluster
              ? {...repository, repositoryIdentityHash: second.identityHash}
              : repository,
          ),
        },
        study,
        first,
      ),
    ).rejects.toThrow(`Runtime repository identity differs for cluster ${firstCluster}`);
    expect(() =>
      parseMatchedEvaluationRuntimeV1({...runtime, repositories: [runtime.repositories[0], runtime.repositories[0]]}),
    ).toThrow('runtime repository cluster ids must be unique');
  });
});

function continuationPreparedHome(
  taskId: string,
  homeDirectory: string,
  homeFixtureHash: string,
  expectedContext: Record<string, unknown>,
  suffix: string,
) {
  return {
    expectedContext,
    homeDirectory,
    homeFixtureHash,
    identity: {account: `evaluation-${suffix}`, user: `agent-${suffix}`},
    project: `continuation-${suffix}`,
    taskId,
  };
}

function continuationAdapterConfig(
  arm: 'threadnote-compact' | 'threadnote-graph',
  contextHomes: readonly ReturnType<typeof continuationPreparedHome>[],
) {
  return {
    approvedCommands: [],
    appServer: {
      argumentsAfterSubcommand: [],
      argumentsBeforeSubcommand: [],
      executable: '/usr/bin/codex',
      executableSha256: '1'.repeat(64),
      version: 'codex-cli 1.0.0',
    },
    arm,
    authSourcePath: '/tmp/auth.json',
    contextBudgetTokens: 800,
    contextHomes,
    environmentPolicyHash: matchedEvaluationCodexEnvironmentPolicyHashV1(),
    git: {executable: '/usr/bin/git', executableSha256: '2'.repeat(64)},
    judgeModel: {id: 'judge-model', parametersHash: '3'.repeat(64), provider: 'openai', reasoningEffort: 'low'},
    model: {id: 'agent-model', parametersHash: '4'.repeat(64), provider: 'openai', reasoningEffort: 'low'},
    pricingMicrosPerMillionTokens: null,
    safeBinaries: [],
    safeExecutablePath: '/usr/bin:/bin',
    taskBudget: {steps: 256, tokens: 1_000_000},
    temporaryRoot: '/tmp',
    verificationPlan: null,
    version: 4,
  } as const;
}

async function temporaryRoot(roots: string[]): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'threadnote-matched-evaluation-')));
  roots.push(root);
  return root;
}

async function git(cwd: string, arguments_: readonly string[]): Promise<void> {
  await gitOutput(cwd, arguments_);
}

async function gitOutput(cwd: string, arguments_: readonly string[]): Promise<string> {
  const result = await captureCodeMemoryLinkProcessGroup({
    arguments: ['-C', cwd, ...arguments_],
    command: 'git',
    cwd,
    environment: {
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      HOME: '/nonexistent',
      PATH: process.env.PATH ?? '/usr/bin:/bin',
    },
    label: 'Matched evaluation Git fixture',
    maxOutputBytes: 64 * 1_024,
    timeoutMilliseconds: 10_000,
  });
  return result.stdout;
}

async function repositoryFixture(directory: string, remote: string, value: string) {
  await mkdir(directory);
  await git(directory, ['init', '-q']);
  await git(directory, ['config', 'user.email', 'evaluation@example.invalid']);
  await git(directory, ['config', 'user.name', 'Evaluation Fixture']);
  await git(directory, ['remote', 'add', 'origin', remote]);
  await writeFile(join(directory, 'service.ts'), `export const value = ${JSON.stringify(value)};\n`);
  await git(directory, ['add', 'service.ts']);
  await git(directory, ['commit', '-qm', 'fixture']);
  return await observeMatchedEvaluationRepositoryV1(directory);
}
