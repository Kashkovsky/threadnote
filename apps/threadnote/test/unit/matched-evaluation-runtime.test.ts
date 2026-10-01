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
  assertMatchedEvaluationContinuationSupplementV1,
  assertMatchedEvaluationContinuationCheckpointV2,
  assertMatchedEvaluationContinuationPhaseOneEvidenceV2,
  continuationCheckpointStudyV2,
  matchedEvaluationContinuationPreparedHomeIdentityHashV2,
  parseMatchedEvaluationRuntimeV1,
  parseMatchedEvaluationContinuationPilotPlanV1,
  projectMatchedEvaluationContinuationSelectionCheckpointV1,
  projectMatchedEvaluationContinuationAdapterTaskV2,
  resolveMatchedEvaluationRuntimeRepositoriesV1,
  hashMatchedEvaluationPayloadV1,
  selectMatchedEvaluationPilotRowsV1,
} from '../../../../scripts/run-matched-evaluation.js';
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
        preparedHome: {fixtureHash: 'd'.repeat(64), identitySha256: 'e'.repeat(64)},
        repositoryRevision: '7'.repeat(40),
      },
      phaseTwoPrompt,
      phaseTwoPromptSha256: sha256HexSync(Buffer.from(phaseTwoPrompt)),
      retries: 0,
      sourceTask: {
        prompt: sourcePrompt,
        promptSha256: sha256HexSync(Buffer.from(sourcePrompt)),
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
            promptSha256: sha256HexSync(Buffer.from(source)),
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
        parentReport,
        parentReportSha256: 'b'.repeat(64),
        parentSelection,
        parentSelectionSha256: 'c'.repeat(64),
        plan: supplementPlan,
      }),
    ).toEqual({
      parentReportSha256: 'b'.repeat(64),
      parentSelectionSha256: 'c'.repeat(64),
      parentVariants: rows.map(row => row.variant),
      variant: 'threadnote-preloaded-resume',
      version: 1,
    });
    expect(() =>
      assertMatchedEvaluationContinuationSupplementV1({
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
    const patch = await gitOutput(repository, [
      'diff',
      '--binary',
      '--full-index',
      '--no-color',
      '--no-ext-diff',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      base.revision,
      checkpoint.revision,
      '--',
      '.',
      ':(exclude).context/**',
      ':(exclude)**/.context/**',
    ]);
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
      patchSha256: sha256HexSync(Buffer.from(patch)),
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
