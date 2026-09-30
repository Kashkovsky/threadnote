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
  parseMatchedEvaluationRuntimeV1,
  parseMatchedEvaluationContinuationPilotPlanV1,
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
  await captureCodeMemoryLinkProcessGroup({
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
