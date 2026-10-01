import fc from 'fast-check';
import {afterEach, describe, expect, it} from 'vitest';
import {mkdtemp, realpath, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  assertMatchedContinuationRuntimeMatchesStudyV1,
  createMatchedContinuationStudyV1,
  matchedContinuationStudyHashV1,
  MATCHED_CONTEXT_CONTINUATION_VARIANTS,
  parseMatchedContinuationStudyV1,
  MATCHED_CONTINUATION_VARIANTS,
  type MatchedContinuationStudyTaskV1,
  type MatchedContinuationVariant,
} from '@threadnote/threadnote/evaluation/matched-continuation-study';
import {assertMatchedContinuationRuntimeFilesV1} from '../../../../scripts/matched-continuation-runtime-integrity.js';

describe('matched continuation claim-study sealing', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, {force: true, recursive: true})));
  });

  it('seals a position-balanced multi-repository continuation schedule', () => {
    const study = createStudy();

    expect(study.tasks).toHaveLength(5);
    expect(study.schedule).toHaveLength(25);
    expect(study.workflowAccounting).toBe('phase-one-plus-phase-two-per-attempt');
    expect(study.studyHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(parseMatchedContinuationStudyV1(JSON.parse(JSON.stringify(study)))).toEqual(study);
    for (const variant of MATCHED_CONTINUATION_VARIANTS) {
      expect(
        study.schedule
          .filter(entry => entry.variant === variant)
          .map(entry => entry.withinTaskRunOrder)
          .sort(),
      ).toEqual([1, 2, 3, 4, 5]);
    }
  });

  it('rejects incomplete, imbalanced, or source-identical continuation evidence', () => {
    const study = createStudy();
    expect(() => parseMatchedContinuationStudyV1({...study, schedule: study.schedule.slice(1)})).toThrow(
      'one attempt per task and variant',
    );
    const imbalanced = study.schedule.map(entry =>
      entry.variant === 'files-bare' ? {...entry, withinTaskRunOrder: 1} : entry,
    );
    expect(() => parseMatchedContinuationStudyV1({...study, schedule: imbalanced})).toThrow(
      'continuation schedule is incomplete',
    );
    expect(() =>
      parseMatchedContinuationStudyV1({
        ...study,
        tasks: study.tasks.map((task, index) =>
          index === 0 ? {...task, checkpointRevision: task.sourceRevision} : task,
        ),
      }),
    ).toThrow('checkpoint must advance source');
    expect(() =>
      parseMatchedContinuationStudyV1({
        ...study,
        tasks: study.tasks.map((task, index) =>
          index === 0 ? {...task, repositoryUrl: `${task.repositoryUrl}?token=secret`} : task,
        ),
      }),
    ).toThrow('without credentials or parameters');
  });

  it('requires runtime coverage to match every sealed task exactly', () => {
    const study = createStudy();
    const runtime = {
      corpusPath: '/tmp/continuation/corpus.json',
      exposureAuditPath: '/tmp/continuation/exposure-audit.json',
      exposureAuditSha256: study.sourceEvidence.exposureAuditSha256,
      manifestPath: '/tmp/continuation/manifest.json',
      matchedPreparationReceiptPath: '/tmp/continuation/preparation-receipt.json',
      matchedRuntimePath: '/tmp/continuation/runtime.json',
      matchedStudyPath: '/tmp/continuation/study.json',
      studyHash: study.studyHash,
      tasks: study.tasks.map(task => ({
        pilotDirectory: `/tmp/continuation/pilots/${task.taskId}`,
        planPath: `/tmp/continuation/plans/${task.taskId}.json`,
        planSha256: task.planSha256,
        taskId: task.taskId,
      })),
      version: 1,
    };

    expect(() => assertMatchedContinuationRuntimeMatchesStudyV1(study, runtime)).not.toThrow();
    expect(() =>
      assertMatchedContinuationRuntimeMatchesStudyV1(study, {...runtime, tasks: runtime.tasks.slice(1)}),
    ).toThrow('do not exactly cover');
    expect(() =>
      assertMatchedContinuationRuntimeMatchesStudyV1(study, {...runtime, studyHash: 'f'.repeat(64)}),
    ).toThrow('different study');
    expect(() =>
      assertMatchedContinuationRuntimeMatchesStudyV1(study, {...runtime, exposureAuditSha256: 'f'.repeat(64)}),
    ).toThrow('exposure audit hash differs');
    expect(() =>
      assertMatchedContinuationRuntimeMatchesStudyV1(study, {
        ...runtime,
        tasks: runtime.tasks.map((task, index) => (index === 0 ? {...task, planSha256: hex(63)} : task)),
      }),
    ).toThrow('runtime plan hash differs');
  });

  it('rehashes every local plan before the sealed runtime can consume it', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'threadnote-continuation-integrity-')));
    roots.push(root);
    const exposureAuditPath = join(root, 'exposure-audit.json');
    const matchedPreparationReceiptPath = join(root, 'matched-preparation-receipt.json');
    const exposureAuditBytes = Buffer.from('{"version":1}\n');
    const receiptBytes = Buffer.from('{"version":1}\n');
    await Promise.all([
      writeFile(exposureAuditPath, exposureAuditBytes),
      writeFile(matchedPreparationReceiptPath, receiptBytes),
    ]);
    const input = studyInput();
    const plans = await Promise.all(
      input.tasks.map(async task => {
        const planPath = join(root, `${task.taskId}.json`);
        const bytes = Buffer.from(`${JSON.stringify({taskId: task.taskId})}\n`);
        await writeFile(planPath, bytes);
        return {bytes, planPath, taskId: task.taskId};
      }),
    );
    const study = createMatchedContinuationStudyV1({
      ...input,
      sourceEvidence: {
        ...input.sourceEvidence,
        exposureAuditSha256: sha256HexSync(exposureAuditBytes),
        matchedPreparationReceiptSha256: sha256HexSync(receiptBytes),
      },
      tasks: input.tasks.map(task => ({
        ...task,
        planSha256: sha256HexSync(plans.find(plan => plan.taskId === task.taskId)!.bytes),
      })),
    });
    const runtime = {
      corpusPath: join(root, 'corpus.json'),
      exposureAuditPath,
      exposureAuditSha256: study.sourceEvidence.exposureAuditSha256,
      manifestPath: join(root, 'manifest.json'),
      matchedPreparationReceiptPath,
      matchedRuntimePath: join(root, 'matched-runtime.json'),
      matchedStudyPath: join(root, 'matched-study.json'),
      studyHash: study.studyHash,
      tasks: study.tasks.map(task => ({
        pilotDirectory: join(root, 'pilots', task.taskId),
        planPath: plans.find(plan => plan.taskId === task.taskId)!.planPath,
        planSha256: task.planSha256,
        taskId: task.taskId,
      })),
      version: 1,
    };

    await expect(assertMatchedContinuationRuntimeFilesV1(study, runtime)).resolves.toBeUndefined();
    await writeFile(runtime.tasks[0].planPath, '{"changed":true}\n');
    await expect(assertMatchedContinuationRuntimeFilesV1(study, runtime)).rejects.toThrow(
      `continuation plan ${runtime.tasks[0].taskId} differs from its pinned manifest identity`,
    );
  });

  it('canonicalizes task order without changing the sealed hash', () => {
    fc.assert(
      fc.property(fc.shuffledSubarray([0, 1, 2, 3, 4], {minLength: 5, maxLength: 5}), order => {
        const input = studyInput();
        const shuffled = {...input, tasks: order.map(index => input.tasks[index])};
        const study = createMatchedContinuationStudyV1(shuffled);
        const {studyHash: _studyHash, version: _version, ...withoutHash} = study;
        expect(study.studyHash).toBe(createStudy().studyHash);
        expect(matchedContinuationStudyHashV1(withoutHash)).toBe(study.studyHash);
      }),
      {numRuns: 20},
    );
  });

  it('seals one-cluster matched-context pilots while retaining the formal claim threshold', () => {
    fc.assert(
      fc.property(
        fc.shuffledSubarray([...MATCHED_CONTEXT_CONTINUATION_VARIANTS], {minLength: 3, maxLength: 3}),
        variantOrder => {
          const study = createMatchedContinuationStudyV1({
            ...studyInput({taskCount: 1, variants: MATCHED_CONTEXT_CONTINUATION_VARIANTS}),
            variants: variantOrder,
          });

          expect(study.tasks).toHaveLength(1);
          expect(study.schedule).toHaveLength(3);
          expect(study.variants).toEqual(MATCHED_CONTEXT_CONTINUATION_VARIANTS);
          expect(study.gates.minimumClusters).toBe(5);
          expect(parseMatchedContinuationStudyV1(JSON.parse(JSON.stringify(study)))).toEqual(study);
        },
      ),
      {numRuns: 20},
    );
  });
});

function createStudy() {
  return createMatchedContinuationStudyV1(studyInput());
}

function studyInput(
  options: {
    readonly taskCount?: number;
    readonly variants?: readonly MatchedContinuationVariant[];
  } = {},
) {
  const variants = options.variants ?? MATCHED_CONTINUATION_VARIANTS;
  const tasks = Array.from({length: options.taskCount ?? 5}, (_, index): MatchedContinuationStudyTaskV1 => ({
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
  return {
    bootstrap: {confidenceLevelBasisPoints: 9_500 as const, iterations: 10_000, seed: hex(1)},
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
      Array.from({length: variants.length}, (_, position) => {
        const variant = variants[(position + taskIndex) % variants.length];
        globalRunOrder += 1;
        return {
          globalRunOrder,
          runNonce: `run_${globalRunOrder.toString(16).padStart(32, '0')}`,
          taskId: task.taskId,
          variant,
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
    variants,
    workflowAccounting: 'phase-one-plus-phase-two-per-attempt' as const,
  };
}

function hex(seed: number): string {
  return seed.toString(16).padStart(64, '0');
}

function commit(seed: number): string {
  return seed.toString(16).padStart(40, '0');
}
