import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  createMatchedEvaluationVerificationCalibrationV1,
  createMatchedEvaluationVerificationPlanV1,
  createMatchedEvaluationVerificationReceiptV1,
  matchedEvaluationVerificationIdV1,
  parseMatchedEvaluationVerificationPlanV1,
  parseMatchedEvaluationVerificationReceiptV1,
} from '@threadnote/threadnote/evaluation/matched-verification';

describe('matched evaluation deterministic verification', () => {
  it('canonicalizes task order and rejects a tampered plan', () => {
    const first = task('tsk_1111111111111111', 'alpha');
    const second = task('tsk_2222222222222222', 'beta');
    const plan = createMatchedEvaluationVerificationPlanV1({
      environmentDirectory: '/tmp/verifier-environment',
      environmentHash: '1'.repeat(64),
      interpreter: '/tmp/verifier-environment/bin/python',
      interpreterHash: '2'.repeat(64),
      runner: '/tmp/verifier.py',
      runnerHash: '3'.repeat(64),
      sandbox: {executable: '/usr/bin/sandbox-exec', executableHash: '4'.repeat(64), policy: 'darwin-seatbelt-v1'},
      tasks: [second, first],
      timeoutMilliseconds: 120_000,
    });

    expect(plan.tasks.map(candidate => candidate.taskId)).toEqual([first.taskId, second.taskId]);
    expect(parseMatchedEvaluationVerificationPlanV1(plan)).toEqual(plan);
    expect(() => parseMatchedEvaluationVerificationPlanV1({...plan, runnerHash: '5'.repeat(64)})).toThrow(
      'plan hash does not match',
    );
  });

  it('binds every artifact hash into a parse-verified receipt', () => {
    fc.assert(
      fc.property(fc.uint8Array({minLength: 32, maxLength: 32}), bytes => {
        const artifactHash = Buffer.from(bytes).toString('hex');
        const receipt = createMatchedEvaluationVerificationReceiptV1({
          artifactHash,
          diagnosticHash: '1'.repeat(64),
          durationMilliseconds: 12,
          environmentHash: '2'.repeat(64),
          exitCode: 0,
          interpreterHash: '3'.repeat(64),
          planHash: '4'.repeat(64),
          runnerHash: '5'.repeat(64),
          sandboxExecutableHash: '6'.repeat(64),
          status: 'passed',
          taskId: 'tsk_1111111111111111',
          verificationId: '7'.repeat(64),
        });

        expect(parseMatchedEvaluationVerificationReceiptV1(receipt)).toEqual(receipt);
        const changedArtifactHash = `${artifactHash[0] === '0' ? '1' : '0'}${artifactHash.slice(1)}`;
        expect(
          createMatchedEvaluationVerificationReceiptV1({...receipt, artifactHash: changedArtifactHash}).receiptHash,
        ).not.toBe(receipt.receiptHash);
      }),
      {numRuns: 50},
    );
  });

  it('rejects status and exit-code disagreement', () => {
    expect(() =>
      createMatchedEvaluationVerificationReceiptV1({
        artifactHash: '0'.repeat(64),
        diagnosticHash: '1'.repeat(64),
        durationMilliseconds: 0,
        environmentHash: '2'.repeat(64),
        exitCode: 1,
        interpreterHash: '3'.repeat(64),
        planHash: '4'.repeat(64),
        runnerHash: '5'.repeat(64),
        sandboxExecutableHash: '6'.repeat(64),
        status: 'passed',
        taskId: 'tsk_1111111111111111',
        verificationId: '7'.repeat(64),
      }),
    ).toThrow('status and exit code disagree');
  });
});

function task(taskId: string, selector: string) {
  return {
    calibration: createMatchedEvaluationVerificationCalibrationV1({
      baseDiagnosticHash: 'a'.repeat(64),
      baseExitCode: 1,
      baseRepositoryFixtureHash: 'b'.repeat(64),
      baseRevision: 'c'.repeat(40),
      fixDiagnosticHash: 'd'.repeat(64),
      fixExitCode: 0,
      fixRepositoryFixtureHash: 'e'.repeat(64),
      fixRevision: 'f'.repeat(40),
    }),
    selector,
    taskId,
    verificationId: matchedEvaluationVerificationIdV1(taskId, selector),
  };
}
