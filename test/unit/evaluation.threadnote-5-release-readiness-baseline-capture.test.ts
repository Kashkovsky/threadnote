/* oxlint-disable effecttsgo/node-builtin-import -- Boundary tests exercise exact executable bytes on disk. */
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  parseThreadnote5BaselineCapturePlanV1,
  parseThreadnote5BaselineJudgeResponseV1,
  parseThreadnote5BaselineObserverResponseV1,
  threadnote5BaselineCapturePlanHash,
  threadnote5BaselineJudgeRequestHash,
  threadnote5BaselineJudgeReceiptHash,
  threadnote5BaselineObserverCitationsHash,
  threadnote5BaselineObserverMeasurementReceiptHash,
  threadnote5BaselineObserverRequestHash,
} from '../../src/evaluation/threadnote-5-release-readiness-baseline-capture.js';
import {
  copyDirectory,
  hashBaselineFixtureTree,
  pinBaselineExecutableCopy,
  verifyPinnedBaselineExecutable,
} from '../../scripts/threadnote-5-baseline-filesystem-boundary.js';
import {prepareThreadnote5BaselineOutputPathsV1} from '../../scripts/capture-threadnote-5-baseline-evidence.js';
import {darwinFstatatSymbol} from '../../scripts/threadnote-5-baseline-output-publication.js';
import {
  captureThreadnote5PinnedExecutableV1,
  copyThreadnote5BaselineHomeFixturesV1,
  prepareThreadnote5DescriptorExecHelperV1,
  threadnote5BaselineNetworkSandboxInvocation,
} from '../../scripts/threadnote-5-baseline-runtime-capture.js';
import {sha256HexSync} from '../../src/crypto/sha256.js';

describe('Threadnote 4.7.8 baseline capture plan', () => {
  it('does not accept caller-authored observations, outcomes, or observation hashes', () => {
    expect(() =>
      parseThreadnote5BaselineCapturePlanV1({
        observations: [{firstCitedPlanIndependentlyJudgedCorrect: true, observationHash: 'f'.repeat(64)}],
        source: {version: '4.7.8'},
      }),
    ).toThrow(/unsupported or missing fields/u);
  });

  it('requires unique trial ids and deterministically hashes reviewed expectations', () => {
    const plan = capturePlan();
    expect(threadnote5BaselineCapturePlanHash(plan)).toBe(threadnote5BaselineCapturePlanHash(structuredClone(plan)));
    expect(() =>
      parseThreadnote5BaselineCapturePlanV1({
        ...plan,
        trials: plan.trials.map(trial => ({...trial, trialId: 'same-trial'})),
      }),
    ).toThrow(/trial ids must be unique/u);
    expect(() =>
      parseThreadnote5BaselineCapturePlanV1({
        ...plan,
        judge: {...plan.judge, executableSha256: plan.observer.executableSha256},
      }),
    ).toThrow(/distinct identities and executable bytes/u);
    for (const role of ['judge', 'observer'] as const) {
      expect(() =>
        parseThreadnote5BaselineCapturePlanV1({
          ...plan,
          [role]: {...plan[role], id: 'threadnote-4.7.x'},
        }),
      ).toThrow(/source, observer, and judge identities/u);
    }
  });

  it.skipIf(process.platform === 'win32')(
    'rejects filesystem aliases between public evidence and private replay outputs',
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.stringMatching(/^[a-z][a-z0-9-]{0,20}\.json$/u), async basename => {
          const root = await mkdtemp(join(tmpdir(), 'threadnote-baseline-output-test-'));
          try {
            const canonicalDirectory = join(root, 'canonical');
            const aliasDirectory = join(root, 'alias');
            await mkdir(canonicalDirectory);
            await symlink(canonicalDirectory, aliasDirectory, 'dir');
            await expect(
              prepareThreadnote5BaselineOutputPathsV1({
                evidenceOutputPath: join(canonicalDirectory, basename),
                privateReplayOutputPath: join(aliasDirectory, basename),
              }),
            ).rejects.toThrow(/different files/u);
            expect(await readdir(canonicalDirectory)).toEqual([]);
          } finally {
            await rm(root, {force: true, recursive: true});
          }
        }),
        {numRuns: 20},
      );
    },
  );

  it.skipIf(process.platform === 'win32')(
    'publishes fresh output files privately through canonical parents',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'threadnote-baseline-output-mode-test-'));
      const canonicalDirectory = join(root, 'canonical');
      const aliasDirectory = join(root, 'alias');
      await mkdir(canonicalDirectory);
      await symlink(canonicalDirectory, aliasDirectory, 'dir');
      const prepared = await prepareThreadnote5BaselineOutputPathsV1({
        evidenceOutputPath: join(canonicalDirectory, 'evidence.json'),
        privateReplayOutputPath: join(aliasDirectory, 'private-replay.json'),
      });
      try {
        const canonicalParent = await realpath(canonicalDirectory);
        expect(prepared.evidenceOutputPath).toBe(join(canonicalParent, 'evidence.json'));
        expect(prepared.privateReplayOutputPath).toBe(join(canonicalParent, 'private-replay.json'));
        await prepared.publish({evidence: 'public evidence\n', privateReplay: 'private replay\n'});
        expect(await readFile(prepared.evidenceOutputPath, 'utf8')).toBe('public evidence\n');
        expect(await readFile(prepared.privateReplayOutputPath, 'utf8')).toBe('private replay\n');
        expect((await stat(prepared.privateReplayOutputPath)).mode & 0o777).toBe(0o600);
      } finally {
        await prepared.cleanupReservations();
        await rm(root, {force: true, recursive: true});
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'fails closed when a reserved parent is retargeted without publishing private replay at the public path',
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.stringMatching(/^[a-z][a-z0-9-]{0,20}\.json$/u), async basename => {
          const root = await mkdtemp(join(tmpdir(), 'threadnote-baseline-output-retarget-test-'));
          const publicDirectory = join(root, 'public');
          const privateDirectory = join(root, 'private');
          const movedPrivateDirectory = join(root, 'private-original');
          await mkdir(publicDirectory);
          await mkdir(privateDirectory);
          const prepared = await prepareThreadnote5BaselineOutputPathsV1({
            evidenceOutputPath: join(publicDirectory, basename),
            privateReplayOutputPath: join(privateDirectory, basename),
          });
          try {
            await rename(privateDirectory, movedPrivateDirectory);
            await symlink(publicDirectory, privateDirectory, 'dir');
            await expect(
              prepared.publish({evidence: 'public evidence\n', privateReplay: 'private replay\n'}),
            ).rejects.toThrow(/parent changed after it was pinned/u);
            await expect(readFile(join(publicDirectory, basename), 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
            await expect(readFile(join(movedPrivateDirectory, basename), 'utf8')).rejects.toMatchObject({
              code: 'ENOENT',
            });
          } finally {
            await prepared.cleanupReservations();
            await rm(root, {force: true, recursive: true});
          }
        }),
        {numRuns: 20},
      );
    },
  );

  it('does not overwrite a file substituted for a reserved output before publication', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-baseline-output-substitution-test-'));
    const evidenceOutputPath = join(root, 'evidence.json');
    const prepared = await prepareThreadnote5BaselineOutputPathsV1({
      evidenceOutputPath,
      privateReplayOutputPath: join(root, 'private-replay.json'),
    });
    try {
      const replacementPath = join(root, 'replacement.json');
      await writeFile(replacementPath, 'unrelated replacement\n');
      await rename(replacementPath, evidenceOutputPath);
      await expect(
        prepared.publish({evidence: 'public evidence\n', privateReplay: 'private replay\n'}),
      ).rejects.toThrow(/destination changed after staging began/u);
      expect(await readFile(evidenceOutputPath, 'utf8')).toBe('unrelated replacement\n');
    } finally {
      await prepared.cleanupReservations();
      await rm(root, {force: true, recursive: true});
    }
  });

  it('atomically refuses a newly created destination after final validation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-baseline-output-no-replace-test-'));
    const evidenceOutputPath = join(root, 'evidence.json');
    const privateReplayOutputPath = join(root, 'private-replay.json');
    const canonicalEvidenceOutputPath = join(await realpath(root), 'evidence.json');
    let substituted = false;
    const prepared = await prepareThreadnote5BaselineOutputPathsV1(
      {evidenceOutputPath, privateReplayOutputPath},
      {
        afterFinalValidationBeforeCommit: async outputPath => {
          if (outputPath !== canonicalEvidenceOutputPath || substituted) return;
          substituted = true;
          await writeFile(evidenceOutputPath, 'late unrelated destination\n');
        },
      },
    );
    try {
      await expect(
        prepared.publish({evidence: 'public evidence\n', privateReplay: 'private replay\n'}),
      ).rejects.toThrow(/destination changed after staging began \(atomic no-replace\)/u);
      expect(await readFile(evidenceOutputPath, 'utf8')).toBe('late unrelated destination\n');
      await expect(readFile(privateReplayOutputPath, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
    } finally {
      await prepared.cleanupReservations();
      await rm(root, {force: true, recursive: true});
    }
  });

  it('restores a substituted existing destination after atomic exchange detects the wrong inode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-baseline-output-exchange-test-'));
    const evidenceOutputPath = join(root, 'evidence.json');
    const privateReplayOutputPath = join(root, 'private-replay.json');
    await writeFile(evidenceOutputPath, 'expected original destination\n');
    const canonicalEvidenceOutputPath = join(await realpath(root), 'evidence.json');
    let substituted = false;
    const prepared = await prepareThreadnote5BaselineOutputPathsV1(
      {evidenceOutputPath, privateReplayOutputPath},
      {
        afterFinalValidationBeforeCommit: async outputPath => {
          if (outputPath !== canonicalEvidenceOutputPath || substituted) return;
          substituted = true;
          const replacement = join(root, 'late-replacement.json');
          await writeFile(replacement, 'late unrelated destination\n');
          await rename(replacement, evidenceOutputPath);
        },
      },
    );
    try {
      await expect(
        prepared.publish({evidence: 'public evidence\n', privateReplay: 'private replay\n'}),
      ).rejects.toThrow(/destination changed during atomic publication/u);
      expect(await readFile(evidenceOutputPath, 'utf8')).toBe('late unrelated destination\n');
      await expect(readFile(privateReplayOutputPath, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
    } finally {
      await prepared.cleanupReservations();
      await rm(root, {force: true, recursive: true});
    }
  });

  it('prevents public publication when private replay is substituted immediately before public commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-baseline-private-before-public-test-'));
    const evidenceOutputPath = join(root, 'evidence.json');
    const privateReplayOutputPath = join(root, 'private-replay.json');
    const prepared = await prepareThreadnote5BaselineOutputPathsV1(
      {evidenceOutputPath, privateReplayOutputPath},
      {
        beforePublicCommit: async () => {
          const replacement = join(root, 'late-private-replacement.json');
          await writeFile(replacement, 'late unrelated private destination\n');
          await rename(replacement, privateReplayOutputPath);
        },
      },
    );
    try {
      await expect(
        prepared.publish({evidence: 'public evidence\n', privateReplay: 'private replay\n'}),
      ).rejects.toThrow(/private replay changed before public publication|changed while it was being published/u);
      await expect(readFile(evidenceOutputPath, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
      expect(await readFile(privateReplayOutputPath, 'utf8')).toBe('late unrelated private destination\n');
    } finally {
      await prepared.cleanupReservations();
      await rm(root, {force: true, recursive: true});
    }
  });

  it('does not expose public evidence when private replay changes in the final public commit hook', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-baseline-private-final-hook-test-'));
    const evidenceOutputPath = join(root, 'evidence.json');
    const privateReplayOutputPath = join(root, 'private-replay.json');
    const canonicalEvidenceOutputPath = join(await realpath(root), 'evidence.json');
    const prepared = await prepareThreadnote5BaselineOutputPathsV1(
      {evidenceOutputPath, privateReplayOutputPath},
      {
        afterFinalValidationBeforeCommit: async outputPath => {
          if (outputPath !== canonicalEvidenceOutputPath) return;
          const replacement = join(root, 'late-private-replacement.json');
          await writeFile(replacement, 'late unrelated private destination\n');
          await rename(replacement, privateReplayOutputPath);
        },
      },
    );
    try {
      await expect(
        prepared.publish({evidence: 'public evidence\n', privateReplay: 'private replay\n'}),
      ).rejects.toThrow(/private replay changed before public publication/u);
      await expect(readFile(evidenceOutputPath, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
      expect(await readFile(privateReplayOutputPath, 'utf8')).toBe('late unrelated private destination\n');
    } finally {
      await prepared.cleanupReservations();
      await rm(root, {force: true, recursive: true});
    }
  });

  it('never publishes through a retargeted private parent at the final commit boundary', async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), async substituteSymlink => {
        const root = await mkdtemp(join(tmpdir(), 'threadnote-baseline-private-parent-final-test-'));
        const publicDirectory = join(root, 'public');
        const privateDirectory = join(root, 'private');
        const movedPrivateDirectory = join(root, 'private-original');
        await mkdir(publicDirectory);
        await mkdir(privateDirectory);
        const evidenceOutputPath = join(publicDirectory, 'evidence.json');
        const privateReplayOutputPath = join(privateDirectory, 'replay.json');
        const canonicalEvidenceOutputPath = join(await realpath(publicDirectory), 'evidence.json');
        let publicCommits = 0;
        const prepared = await prepareThreadnote5BaselineOutputPathsV1(
          {evidenceOutputPath, privateReplayOutputPath},
          {
            afterFinalValidationBeforeCommit: async outputPath => {
              if (outputPath !== canonicalEvidenceOutputPath) return;
              await rename(privateDirectory, movedPrivateDirectory);
              if (substituteSymlink) await symlink(publicDirectory, privateDirectory, 'dir');
              else await mkdir(privateDirectory);
            },
            afterPublicCommit: async () => {
              publicCommits += 1;
            },
          },
        );
        try {
          await expect(
            prepared.publish({evidence: 'public evidence\n', privateReplay: 'private replay\n'}),
          ).rejects.toThrow(/private replay changed before public publication/u);
          expect(publicCommits).toBe(0);
          await expect(readFile(evidenceOutputPath, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
        } finally {
          await prepared.cleanupReservations();
          await rm(root, {force: true, recursive: true});
        }
      }),
      {examples: [[false], [true]], numRuns: 8},
    );
  });

  it('retains matching replay through cleanup whenever public withdrawal fails', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        fc.boolean(),
        fc.stringMatching(/^[a-zA-Z0-9 ._-]{1,80}$/u),
        async (existingEvidence, substituteReplay, replayText) => {
          const root = await mkdtemp(join(tmpdir(), 'threadnote-baseline-rollback-retention-test-'));
          const evidenceOutputPath = join(root, 'evidence.json');
          const privateReplayOutputPath = join(root, 'private-replay.json');
          const stages: string[] = [];
          if (existingEvidence) await writeFile(evidenceOutputPath, 'original evidence\n');
          const prepared = await prepareThreadnote5BaselineOutputPathsV1(
            {evidenceOutputPath, privateReplayOutputPath},
            {
              afterStageOutputPrepared: async stagePath => {
                stages.push(stagePath);
              },
              afterPublicCommit: async () => {
                if (existingEvidence) await rename(join(stages[0], 'payload'), join(stages[0], 'saved-original'));
                else await writeFile(join(stages[0], 'payload'), 'unrelated rollback blocker\n');
                if (substituteReplay) {
                  const replacement = join(root, 'replacement.json');
                  await writeFile(replacement, 'unrelated replacement\n');
                  await rename(replacement, privateReplayOutputPath);
                }
                throw new Error('injected post-public failure');
              },
            },
          );
          try {
            await expect(prepared.publish({evidence: 'public evidence\n', privateReplay: replayText})).rejects.toThrow(
              /public evidence could not be withdrawn/u,
            );
            await prepared.cleanupReservations();
            expect(await readFile(evidenceOutputPath, 'utf8')).toBe('public evidence\n');
            expect(await readFile(privateReplayOutputPath, 'utf8')).toBe(
              substituteReplay ? 'unrelated replacement\n' : replayText,
            );
            expect(await readFile(join(stages[1], 'replay-recovery'), 'utf8')).toBe(replayText);
            expect((await stat(join(stages[1], 'replay-recovery'))).mode & 0o777).toBe(0o600);
            expect((await stat(join(stages[1], 'replay-recovery'))).ino).not.toBe(
              (await stat(privateReplayOutputPath)).ino,
            );
            expect(await readFile(join(stages[0], existingEvidence ? 'saved-original' : 'payload'), 'utf8')).toBe(
              existingEvidence ? 'original evidence\n' : 'unrelated rollback blocker\n',
            );
          } finally {
            await prepared.cleanupReservations();
            await rm(root, {force: true, recursive: true});
          }
        },
      ),
      {
        examples: [
          [false, false, 'replay'],
          [false, true, 'replay'],
          [true, false, 'replay'],
          [true, true, 'replay'],
        ],
        numRuns: 12,
      },
    );
  });

  it('recreates an independently verified replay after recovery deletion and blocked public withdrawal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-baseline-recovery-recreation-test-'));
    const evidenceOutputPath = join(root, 'evidence.json');
    const privateReplayOutputPath = join(root, 'private-replay.json');
    const stages: string[] = [];
    const prepared = await prepareThreadnote5BaselineOutputPathsV1(
      {evidenceOutputPath, privateReplayOutputPath},
      {
        afterStageOutputPrepared: async stagePath => {
          stages.push(stagePath);
        },
        afterPublicCommit: async () => {
          await writeFile(join(stages[0], 'payload'), 'unrelated rollback blocker\n');
          await rm(join(stages[1], 'replay-recovery'));
          await writeFile(join(stages[1], 'replay-recovery'), 'unrelated recovery replacement\n');
          const replacement = join(root, 'private-replacement.json');
          await writeFile(replacement, 'unrelated private replacement\n');
          await rename(replacement, privateReplayOutputPath);
          throw new Error('injected post-public failure');
        },
      },
    );
    try {
      await expect(
        prepared.publish({evidence: 'public evidence\n', privateReplay: 'exact private replay\n'}),
      ).rejects.toThrow(/private replay retained at .*replay-recovery-[0-9a-f]{32}/u);
      await prepared.cleanupReservations();
      expect(await readFile(evidenceOutputPath, 'utf8')).toBe('public evidence\n');
      expect(await readFile(privateReplayOutputPath, 'utf8')).toBe('unrelated private replacement\n');
      expect(await readFile(join(stages[1], 'replay-recovery'), 'utf8')).toBe('unrelated recovery replacement\n');
      const recoveryNames = (await readdir(stages[1])).filter(name => /^replay-recovery-[0-9a-f]{32}$/u.test(name));
      expect(recoveryNames).toHaveLength(1);
      const recoveryPath = join(stages[1], recoveryNames[0]);
      expect(await readFile(recoveryPath, 'utf8')).toBe('exact private replay\n');
      expect((await stat(recoveryPath)).mode & 0o777).toBe(0o600);
      expect((await stat(recoveryPath)).ino).not.toBe((await stat(privateReplayOutputPath)).ino);
    } finally {
      await prepared.cleanupReservations();
      await rm(root, {force: true, recursive: true});
    }
  });

  it('proves a fresh caller-visible recovery after blocked rollback and stage retargeting during cleanup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-baseline-final-retention-test-'));
    const evidenceOutputPath = join(root, 'evidence.json');
    const privateReplayOutputPath = join(root, 'private-replay.json');
    const stages: string[] = [];
    const cleanupCalls: string[] = [];
    const prepared = await prepareThreadnote5BaselineOutputPathsV1(
      {evidenceOutputPath, privateReplayOutputPath},
      {
        afterStageOutputPrepared: async path => {
          stages.push(path);
        },
        afterPublicCommit: async () => {
          await writeFile(join(stages[0], 'payload'), 'rollback blocker');
          throw new Error('injected public failure');
        },
        beforeStageDirectoryCleanup: async path => {
          cleanupCalls.push(path);
          if (path === stages[1]) {
            await rename(path, `${path}-moved`);
            await mkdir(path, {mode: 0o700});
            await writeFile(join(path, 'replay-recovery'), 'unrelated replacement');
          }
        },
      },
    );
    try {
      const failure = await prepared.publish({evidence: 'public evidence', privateReplay: 'exact private replay'}).then(
        () => undefined,
        cause => cause as Error,
      );
      const retainedPath = /private replay retained at (.+)\.$/u.exec(failure?.message ?? '')?.[1];
      expect(retainedPath).toBeDefined();
      expect(retainedPath).not.toBe(join(stages[1], 'replay-recovery'));
      await prepared.cleanupReservations();
      expect(cleanupCalls).toEqual(stages);
      expect(await readFile(retainedPath!, 'utf8')).toBe('exact private replay');
      expect((await stat(retainedPath!)).mode & 0o777).toBe(0o600);
      expect((await stat(retainedPath!)).ino).not.toBe((await stat(privateReplayOutputPath)).ino);
      expect((await stat(retainedPath!)).ino).not.toBe((await stat(join(`${stages[1]}-moved`, 'replay-recovery'))).ino);
      expect(await readFile(join(stages[1], 'replay-recovery'), 'utf8')).toBe('unrelated replacement');
    } finally {
      await prepared.cleanupReservations();
      await rm(root, {force: true, recursive: true});
    }
  });

  it('does not claim replay retention when every pinned exact copy was corrupted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-baseline-unproven-recovery-test-'));
    const evidenceOutputPath = join(root, 'evidence.json');
    const privateReplayOutputPath = join(root, 'private-replay.json');
    const stages: string[] = [];
    const prepared = await prepareThreadnote5BaselineOutputPathsV1(
      {evidenceOutputPath, privateReplayOutputPath},
      {
        afterStageOutputPrepared: async stagePath => {
          stages.push(stagePath);
        },
        afterPublicCommit: async () => {
          await writeFile(join(stages[0], 'payload'), 'unrelated rollback blocker\n');
          await writeFile(privateReplayOutputPath, 'wrong replay');
          await writeFile(join(stages[1], 'replay-recovery'), 'wrong replay');
          throw new Error('injected post-public failure');
        },
      },
    );
    try {
      await expect(prepared.publish({evidence: 'public evidence\n', privateReplay: 'exact replay'})).rejects.toThrow(
        /exact private replay recovery could not be proven/u,
      );
      await prepared.cleanupReservations();
      expect(await readFile(evidenceOutputPath, 'utf8')).toBe('public evidence\n');
      expect((await readdir(stages[1])).some(name => /^replay-recovery-[0-9a-f]{32}$/u.test(name))).toBe(false);
    } finally {
      await prepared.cleanupReservations();
      await rm(root, {force: true, recursive: true});
    }
  });

  it('rejects equal-length in-place corruption of every committed byte domain', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('evidence', 'private-replay', 'recovery'),
        fc.stringMatching(/^[a-zA-Z0-9 ._-]{1,80}$/u),
        async (target, privateReplay) => {
          const root = await mkdtemp(join(tmpdir(), 'threadnote-baseline-byte-binding-test-'));
          const evidence = 'public-evidence-bound-bytes';
          const evidenceOutputPath = join(root, 'evidence.json');
          const privateReplayOutputPath = join(root, 'private-replay.json');
          const stages: string[] = [];
          const canonicalEvidenceOutputPath = join(await realpath(root), 'evidence.json');
          const prepared = await prepareThreadnote5BaselineOutputPathsV1(
            {evidenceOutputPath, privateReplayOutputPath},
            {
              afterFinalValidationBeforeCommit: async outputPath => {
                if (outputPath !== canonicalEvidenceOutputPath) return;
                const path =
                  target === 'evidence'
                    ? join(stages[0], 'payload')
                    : target === 'private-replay'
                      ? privateReplayOutputPath
                      : join(stages[1], 'replay-recovery');
                const original = target === 'evidence' ? evidence : privateReplay;
                const replacement = `${original[0] === 'x' ? 'y' : 'x'}${original.slice(1)}`;
                expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(original));
                await writeFile(path, replacement);
              },
              afterStageOutputPrepared: async stagePath => {
                stages.push(stagePath);
              },
            },
          );
          try {
            await expect(prepared.publish({evidence, privateReplay})).rejects.toThrow(
              /bytes changed|private replay changed/u,
            );
            await expect(readFile(evidenceOutputPath, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
          } finally {
            await prepared.cleanupReservations();
            await rm(root, {force: true, recursive: true});
          }
        },
      ),
      {
        examples: [
          ['evidence', 'replay'],
          ['private-replay', 'replay'],
          ['recovery', 'replay'],
        ],
        numRuns: 12,
      },
    );
  });

  it('waits for interrupted publication rollback before closing its reservations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-baseline-publication-interruption-test-'));
    let release!: () => void;
    const blocked = new Promise<void>(resolvePromise => {
      release = resolvePromise;
    });
    let entered!: () => void;
    const enteredPublicCommit = new Promise<void>(resolvePromise => {
      entered = resolvePromise;
    });
    const prepared = await prepareThreadnote5BaselineOutputPathsV1(
      {evidenceOutputPath: join(root, 'evidence.json'), privateReplayOutputPath: join(root, 'private-replay.json')},
      {
        beforePublicCommit: async () => {
          entered();
          await blocked;
        },
      },
    );
    try {
      const publication = prepared.publish({evidence: 'public evidence\n', privateReplay: 'private replay\n'});
      await enteredPublicCommit;
      const cleanup = prepared.cleanupReservations();
      let cleaned = false;
      void cleanup.then(() => {
        cleaned = true;
      });
      await Promise.resolve();
      expect(cleaned).toBe(false);
      release();
      await expect(publication).rejects.toThrow(/interrupted before public commit/u);
      await cleanup;
      await expect(readFile(join(root, 'evidence.json'), 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
      await expect(readFile(join(root, 'private-replay.json'), 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
    } finally {
      release();
      await prepared.cleanupReservations();
      await rm(root, {force: true, recursive: true});
    }
  });

  it('selects the architecture-correct Darwin fstatat ABI and rejects unknown layouts', () => {
    expect(darwinFstatatSymbol('arm64')).toBe('fstatat');
    expect(darwinFstatatSymbol('x64')).toBe('fstatat$INODE64');
    expect(() => darwinFstatatSymbol('ia32')).toThrow(/does not support Darwin ia32 ABI/u);
  });

  it('retains both a substituted stage pathname and its renamed pinned directory during cleanup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-baseline-stage-cleanup-test-'));
    let replacementPath: string | undefined;
    let renamedOriginalPath: string | undefined;
    const prepared = await prepareThreadnote5BaselineOutputPathsV1(
      {
        evidenceOutputPath: join(root, 'evidence.json'),
        privateReplayOutputPath: join(root, 'private-replay.json'),
      },
      {
        beforeStageDirectoryCleanup: async stageDirectoryPath => {
          if (replacementPath !== undefined) return;
          replacementPath = stageDirectoryPath;
          renamedOriginalPath = `${stageDirectoryPath}-renamed`;
          await rename(stageDirectoryPath, renamedOriginalPath);
          await mkdir(stageDirectoryPath, {mode: 0o700});
        },
      },
    );
    try {
      await prepared.cleanupReservations();
      expect(replacementPath).toBeDefined();
      expect(renamedOriginalPath).toBeDefined();
      expect((await stat(replacementPath!)).mode & 0o777).toBe(0o700);
      expect((await stat(renamedOriginalPath!)).mode & 0o777).toBe(0o700);
      expect(await readdir(replacementPath!)).toEqual([]);
      expect(await readdir(renamedOriginalPath!)).toEqual([]);
    } finally {
      await prepared.cleanupReservations();
      await rm(root, {force: true, recursive: true});
    }
  });

  it('retains a substituted stage pathname and renamed original after preparation fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-baseline-stage-preparation-test-'));
    let replacementPath: string | undefined;
    let renamedOriginalPath: string | undefined;
    try {
      await expect(
        prepareThreadnote5BaselineOutputPathsV1(
          {
            evidenceOutputPath: join(root, 'evidence.json'),
            privateReplayOutputPath: join(root, 'private-replay.json'),
          },
          {
            afterStageOutputPrepared: async stageDirectoryPath => {
              replacementPath = stageDirectoryPath;
              renamedOriginalPath = `${stageDirectoryPath}-renamed`;
              await rename(stageDirectoryPath, renamedOriginalPath);
              await mkdir(stageDirectoryPath, {mode: 0o700});
            },
          },
        ),
      ).rejects.toThrow(/parent changed after it was pinned/u);
      expect(replacementPath).toBeDefined();
      expect(renamedOriginalPath).toBeDefined();
      expect((await stat(replacementPath!)).mode & 0o777).toBe(0o700);
      expect((await stat(renamedOriginalPath!)).mode & 0o777).toBe(0o700);
      expect(await readdir(replacementPath!)).toEqual([]);
      expect(await readdir(renamedOriginalPath!)).toEqual([]);
    } finally {
      await rm(root, {force: true, recursive: true});
    }
  });

  it.skipIf(process.platform === 'win32')(
    'does not delete a replacement installed at a reservation path during cleanup',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'threadnote-baseline-output-cleanup-test-'));
      const publicDirectory = join(root, 'public');
      const privateDirectory = join(root, 'private');
      const movedPrivateDirectory = join(root, 'private-original');
      await mkdir(publicDirectory);
      await mkdir(privateDirectory);
      const privateReplayOutputPath = join(privateDirectory, 'replay.json');
      const prepared = await prepareThreadnote5BaselineOutputPathsV1({
        evidenceOutputPath: join(publicDirectory, 'evidence.json'),
        privateReplayOutputPath,
      });
      try {
        await expect(
          prepared.publish({
            get evidence(): string {
              throw new Error('injected evidence publication failure');
            },
            privateReplay: 'private replay awaiting evidence\n',
          }),
        ).rejects.toThrow(/injected evidence publication failure/u);
        await rename(privateDirectory, movedPrivateDirectory);
        await mkdir(privateDirectory);
        await writeFile(privateReplayOutputPath, 'unrelated replacement\n');
        await prepared.cleanupReservations();
        expect(await readFile(privateReplayOutputPath, 'utf8')).toBe('unrelated replacement\n');
        await expect(readFile(join(movedPrivateDirectory, 'replay.json'), 'utf8')).rejects.toMatchObject({
          code: 'ENOENT',
        });
        const retainedStages = await readdir(movedPrivateDirectory, {withFileTypes: true});
        expect(retainedStages).toHaveLength(1);
        expect(retainedStages[0]?.isDirectory()).toBe(true);
        expect(retainedStages[0]?.name).toMatch(/^\.threadnote-baseline-stage-/u);
      } finally {
        await prepared.cleanupReservations();
        await rm(root, {force: true, recursive: true});
      }
    },
  );

  it('replaces hard-linked destinations without changing either unrelated inode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-baseline-output-hard-link-test-'));
    const evidenceOriginal = join(root, 'evidence-original.json');
    const privateOriginal = join(root, 'private-original.json');
    const evidenceOutputPath = join(root, 'evidence.json');
    const privateReplayOutputPath = join(root, 'private-replay.json');
    await writeFile(evidenceOriginal, 'unrelated evidence inode\n');
    await writeFile(privateOriginal, 'unrelated private inode\n');
    await link(evidenceOriginal, evidenceOutputPath);
    await link(privateOriginal, privateReplayOutputPath);
    const evidenceMode = (await stat(evidenceOriginal)).mode & 0o777;
    const privateMode = (await stat(privateOriginal)).mode & 0o777;
    const prepared = await prepareThreadnote5BaselineOutputPathsV1({evidenceOutputPath, privateReplayOutputPath});
    try {
      await prepared.publish({evidence: 'public evidence\n', privateReplay: 'private replay\n'});
      expect(await readFile(evidenceOriginal, 'utf8')).toBe('unrelated evidence inode\n');
      expect(await readFile(privateOriginal, 'utf8')).toBe('unrelated private inode\n');
      expect((await stat(evidenceOriginal)).mode & 0o777).toBe(evidenceMode);
      expect((await stat(privateOriginal)).mode & 0o777).toBe(privateMode);
      expect(await readFile(evidenceOutputPath, 'utf8')).toBe('public evidence\n');
      expect(await readFile(privateReplayOutputPath, 'utf8')).toBe('private replay\n');
      expect((await stat(privateReplayOutputPath)).mode & 0o777).toBe(0o600);
    } finally {
      await prepared.cleanupReservations();
      await rm(root, {force: true, recursive: true});
    }
  });

  it('requires collision-resistant lowercase ASCII output filenames', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-baseline-output-name-test-'));
    try {
      await expect(
        prepareThreadnote5BaselineOutputPathsV1({
          evidenceOutputPath: join(root, 'Evidence.json'),
          privateReplayOutputPath: join(root, 'private-replay.json'),
        }),
      ).rejects.toThrow(/lowercase ASCII/u);
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, {force: true, recursive: true});
    }
  });

  it('copies both HOME trees from one verified snapshot despite a restored source swap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-baseline-home-snapshot-test-'));
    try {
      const source = join(root, 'source');
      const snapshot = join(root, 'snapshot');
      const home = join(root, 'threadnote-home');
      const userHome = join(root, 'user-home');
      const fixturePath = join(source, 'memory.json');
      await mkdir(source);
      await writeFile(fixturePath, 'reviewed fixture\n');
      const expectedSha256 = await hashBaselineFixtureTree(source);
      await copyThreadnote5BaselineHomeFixturesV1(
        {expectedSha256, home, snapshot, source, userHome},
        async (copySource, destination) => {
          await copyDirectory(copySource, destination);
          if (destination === home) await writeFile(fixturePath, 'unreviewed fixture\n');
          if (destination === userHome) await writeFile(fixturePath, 'reviewed fixture\n');
        },
      );
      expect(await hashBaselineFixtureTree(home)).toBe(expectedSha256);
      expect(await hashBaselineFixtureTree(userHome)).toBe(expectedSha256);
      expect(await hashBaselineFixtureTree(source)).toBe(expectedSha256);
    } finally {
      await rm(root, {force: true, recursive: true});
    }
  });

  it('accepts only a response bound to the reviewed observer, judge, request, trial, and native citations', () => {
    const identity = capturePlan().observer;
    const response = observerResponse();
    expect(
      parseThreadnote5BaselineObserverResponseV1(response, {
        allowedMemoryUris: ['threadnote://memory/expected-0'],
        identity,
        requestSha256: 'b'.repeat(64),
        requiredMemoryUris: ['threadnote://memory/expected-0'],
        returnedMemoryUris: ['threadnote://memory/expected-0'],
        trialId: 'trial-0',
      }),
    ).toEqual(response);
    expect(() =>
      parseThreadnote5BaselineObserverResponseV1(
        {...response, judgmentReceipt: {firstCitedPlanIndependentlyJudgedCorrect: true}},
        {
          allowedMemoryUris: ['threadnote://memory/expected-0'],
          identity,
          requestSha256: 'b'.repeat(64),
          requiredMemoryUris: ['threadnote://memory/expected-0'],
          returnedMemoryUris: ['threadnote://memory/expected-0'],
          trialId: 'trial-0',
        },
      ),
    ).toThrow(/unsupported or missing fields/u);
    expect(() =>
      parseThreadnote5BaselineObserverResponseV1(
        {
          ...response,
          measurementReceipt: {
            ...response.measurementReceipt,
            estimatedTokensToFirstCitedPlan: 1_201,
          },
        },
        {
          allowedMemoryUris: ['threadnote://memory/expected-0'],
          identity,
          requestSha256: 'b'.repeat(64),
          requiredMemoryUris: ['threadnote://memory/expected-0'],
          returnedMemoryUris: ['threadnote://memory/expected-0'],
          trialId: 'trial-0',
        },
      ),
    ).toThrow(/measurement receipt hash does not match/u);
  });

  it('accepts correctness only from the separately reviewed judge identity and receipt', () => {
    const identity = capturePlan().judge;
    const response = judgeResponse();
    const expected = {
      firstCitedPlanSha256: 'c'.repeat(64),
      identity,
      requestSha256: 'd'.repeat(64),
      trialId: 'trial-0',
    };
    expect(parseThreadnote5BaselineJudgeResponseV1(response, expected)).toEqual(response);
    expect(() => parseThreadnote5BaselineJudgeResponseV1({...response, judgeId: 'observer-harness'}, expected)).toThrow(
      /does not match the reviewed trial/u,
    );
    expect(() =>
      parseThreadnote5BaselineJudgeResponseV1({...response, firstCitedPlanIndependentlyJudgedCorrect: false}, expected),
    ).toThrow(/does not match the reviewed trial/u);
  });

  it('binds the judge request to the exact observer request, native output, citations, and plan bytes', () => {
    const contextBriefOutput = '{"activeHandoffs":[],"durableDecisions":[],"type":"context-brief"}\n';
    const observerProjection = {
      capturePlanSha256: '1'.repeat(64),
      contextBrief: {activeHandoffs: [], durableDecisions: [], type: 'context-brief'},
      contextBriefOutputSha256: sha256HexSync(contextBriefOutput),
      homeFixtureSha256: '2'.repeat(64),
      protocol: 'threadnote-5-baseline-observer' as const,
      repositoryFixtureSha256: '3'.repeat(64),
      source: {commit: '4'.repeat(40), executableSha256: '5'.repeat(64), version: '4.7.8'},
      task: 'Use the cited memory to plan the change.',
      trialId: 'trial-0',
      version: 1 as const,
    };
    const observerRequestSha256 = threadnote5BaselineObserverRequestHash(observerProjection);
    const observerRequest = {...observerProjection, requestSha256: observerRequestSha256};
    const citedMemoryUris = ['threadnote://memory/expected-0'];
    const firstCitedPlan = 'Use threadnote://memory/expected-0 and preserve its constraint.';
    const request = {
      capturePlanSha256: observerProjection.capturePlanSha256,
      citedMemoryUris,
      citedMemoryUrisSha256: threadnote5BaselineObserverCitationsHash(citedMemoryUris),
      contextBriefOutput,
      contextBriefOutputSha256: observerProjection.contextBriefOutputSha256,
      firstCitedPlan,
      firstCitedPlanSha256: sha256HexSync(firstCitedPlan),
      observerRequest,
      observerRequestSha256,
      protocol: 'threadnote-5-baseline-judge' as const,
      trialId: 'trial-0',
      version: 1 as const,
    };
    const requestSha256 = threadnote5BaselineJudgeRequestHash(request);
    expect(threadnote5BaselineJudgeRequestHash({...request, firstCitedPlan: `${firstCitedPlan}\nChanged.`})).not.toBe(
      requestSha256,
    );
    expect(threadnote5BaselineJudgeRequestHash({...request, contextBriefOutput: `${contextBriefOutput} `})).not.toBe(
      requestSha256,
    );
    expect(
      threadnote5BaselineJudgeRequestHash({
        ...request,
        citedMemoryUris: [...citedMemoryUris, 'threadnote://memory/other'],
      }),
    ).not.toBe(requestSha256);
    expect(
      threadnote5BaselineJudgeRequestHash({
        ...request,
        observerRequest: {...observerRequest, task: 'Different task'},
      }),
    ).not.toBe(requestSha256);
  });

  it('round-trips any bounded observer measurement only with its matching receipt hash', () => {
    const identity = capturePlan().observer;
    fc.assert(
      fc.property(
        fc.integer({min: 0, max: 1_000_000}),
        fc.integer({min: 0, max: 10_000_000}),
        (estimatedTokens, milliseconds) => {
          const response = observerResponse({estimatedTokens, milliseconds});
          const expected = {
            allowedMemoryUris: ['threadnote://memory/expected-0'],
            identity,
            requestSha256: 'b'.repeat(64),
            requiredMemoryUris: ['threadnote://memory/expected-0'],
            returnedMemoryUris: ['threadnote://memory/expected-0'],
            trialId: 'trial-0',
          };
          expect(parseThreadnote5BaselineObserverResponseV1(response, expected)).toEqual(response);
          expect(() =>
            parseThreadnote5BaselineObserverResponseV1(
              {
                ...response,
                measurementReceipt: {
                  ...response.measurementReceipt,
                  estimatedTokensToFirstCitedPlan: estimatedTokens + 1,
                },
              },
              expected,
            ),
          ).toThrow(/measurement receipt hash does not match/u);
        },
      ),
      {numRuns: 40},
    );
  });

  it.skipIf(process.platform === 'win32')(
    'pins and executes reviewed bytes even after the supplied pathname is replaced',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'threadnote-baseline-pin-test-'));
      try {
        const source = join(root, 'source');
        const pinned = join(root, 'pinned');
        const reviewed = await nativeExecutableFixture(source);
        const identity = await pinBaselineExecutableCopy(source, pinned, sha256HexSync(reviewed));
        const replacement = join(root, 'replacement');
        await writeFile(replacement, '#!/bin/sh\nprintf replaced', {mode: 0o500});
        await rename(replacement, source);
        await verifyPinnedBaselineExecutable(identity);
        const result = Bun.spawnSync([identity.path]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout.toString()).toBe('reviewed');
        expect(sha256HexSync(await Bun.file(source).text())).not.toBe(identity.sha256);
        const pinnedReplacement = join(root, 'pinned-replacement');
        await writeFile(pinnedReplacement, reviewed, {mode: 0o500});
        await rename(pinnedReplacement, pinned);
        await expect(verifyPinnedBaselineExecutable(identity)).rejects.toThrow(/identity or bytes changed/u);
      } finally {
        await rm(root, {force: true, recursive: true});
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'executes the reviewed open object when its pinned pathname is replaced immediately before spawn',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'threadnote-baseline-descriptor-exec-test-'));
      try {
        const source = join(root, 'source');
        const pinned = join(root, 'pinned');
        const reviewed = await nativeExecutableFixture(source);
        const identity = await pinBaselineExecutableCopy(source, pinned, sha256HexSync(reviewed));
        const helper = await prepareThreadnote5DescriptorExecHelperV1(root);
        let substituted = false;
        const result = await captureThreadnote5PinnedExecutableV1({
          arguments: [],
          cwd: root,
          environment: {PATH: '/usr/bin:/bin', TMPDIR: root},
          executable: identity,
          helper,
          hooks: {
            beforeExecutableSpawn: async ({executablePath}) => {
              expect(executablePath).toBe(pinned);
              await rename(pinned, `${pinned}-reviewed`);
              await writeFile(pinned, '#!/bin/sh\nprintf replaced', {mode: 0o500});
              await chmod(pinned, 0o500);
              substituted = true;
            },
          },
          label: 'descriptor-bound executable regression',
          maxOutputBytes: 64 * 1_024,
          networkIsolated: process.platform === 'darwin',
          role: 'observer',
          timeoutMilliseconds: 10_000,
        });
        expect(substituted).toBe(true);
        expect(result.stdout).toBe('reviewed');
        expect(await readFile(pinned, 'utf8')).toContain('replaced');
      } finally {
        await rm(root, {force: true, recursive: true});
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses in-place executable mutation before any unreviewed bytes run',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'threadnote-baseline-descriptor-mutation-test-'));
      try {
        const source = join(root, 'source');
        const pinned = join(root, 'pinned');
        const marker = join(root, 'unreviewed-ran');
        const reviewed = await nativeExecutableFixture(source);
        const identity = await pinBaselineExecutableCopy(source, pinned, sha256HexSync(reviewed));
        const helper = await prepareThreadnote5DescriptorExecHelperV1(root);
        await expect(
          captureThreadnote5PinnedExecutableV1({
            arguments: [],
            cwd: root,
            environment: {PATH: '/usr/bin:/bin', TMPDIR: root},
            executable: identity,
            helper,
            hooks: {
              beforeExecutableSpawn: async ({executablePath}) => {
                await chmod(executablePath, 0o700);
                await writeFile(executablePath, `#!/bin/sh\nprintf unreviewed > '${marker}'`);
                await chmod(executablePath, 0o500);
              },
            },
            label: 'descriptor-bound executable mutation regression',
            maxOutputBytes: 64 * 1_024,
            networkIsolated: false,
            role: 'judge',
            timeoutMilliseconds: 10_000,
          }),
        ).rejects.toThrow(/identity or bytes changed/u);
        await expect(readFile(marker, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
      } finally {
        await rm(root, {force: true, recursive: true});
      }
    },
  );

  it('constructs Linux isolation with an unprivileged user namespace before the network namespace', () => {
    expect(threadnote5BaselineNetworkSandboxInvocation('linux', '/private/threadnote', ['--version'])).toEqual({
      arguments: ['--user', '--map-root-user', '--net', '--', '/private/threadnote', '--version'],
      command: '/usr/bin/unshare',
    });
  });
});

async function nativeExecutableFixture(path: string): Promise<Uint8Array> {
  const source = `${path}.c`;
  await writeFile(source, '#include <stdio.h>\nint main(void) { fputs("reviewed", stdout); return 0; }\n');
  const result = Bun.spawnSync(['/usr/bin/cc', source, '-o', path]);
  expect(result.exitCode).toBe(0);
  return await readFile(path);
}

function capturePlan() {
  return {
    judge: {
      executableSha256: 'f'.repeat(64),
      id: 'independent-plan-judge',
      protocol: 'threadnote-5-baseline-judge' as const,
      version: 1 as const,
    },
    observer: {
      executableSha256: 'a'.repeat(64),
      id: 'independent-agent-harness',
      protocol: 'threadnote-5-baseline-observer' as const,
      version: 1 as const,
    },
    suite: 'threadnote-5-baseline-capture-plan',
    trials: Array.from({length: 10}, (_, index) => ({
      allowedMemoryUris: [`threadnote://memory/expected-${index}`],
      budgetTokens: 1_500,
      homeFixturePath: `${process.cwd()}/threadnote-home-${index}`,
      homeFixtureSha256: `${index}`.padStart(64, '0'),
      repositoryFixturePath: `${process.cwd()}/threadnote-repository-${index}`,
      repositoryFixtureSha256: `${index + 10}`.padStart(64, '0'),
      requiredMemoryUris: [`threadnote://memory/expected-${index}`],
      task: `Task ${index}`,
      trialId: `trial-${index}`,
      wrongMemoryEligible: true,
    })),
    version: 1,
  };
}

function observerResponse(
  input: {readonly estimatedTokens: number; readonly milliseconds: number} = {
    estimatedTokens: 1_200,
    milliseconds: 15_000,
  },
) {
  const citedMemoryUris = ['threadnote://memory/expected-0'];
  const firstCitedPlan = 'Use threadnote://memory/expected-0 because it records the reviewed constraint.';
  const measurement = {
    estimatedTokensToFirstCitedPlan: input.estimatedTokens,
    firstCitedPlanSha256: sha256HexSync(firstCitedPlan),
    observerId: 'independent-agent-harness',
    requestSha256: 'b'.repeat(64),
    timeFromObserverRequestToFirstCitedPlanMilliseconds: input.milliseconds,
    trialId: 'trial-0',
    version: 1 as const,
  };
  return {
    citedMemoryUris,
    firstCitedPlan,
    measurementReceipt: {
      ...measurement,
      receiptSha256: threadnote5BaselineObserverMeasurementReceiptHash(measurement),
    },
    observerId: 'independent-agent-harness',
    protocol: 'threadnote-5-baseline-observer' as const,
    requestSha256: 'b'.repeat(64),
    trialId: 'trial-0',
    version: 1 as const,
  };
}

function judgeResponse() {
  const projection = {
    firstCitedPlanIndependentlyJudgedCorrect: true as const,
    firstCitedPlanSha256: 'c'.repeat(64),
    judgeId: 'independent-plan-judge',
    protocol: 'threadnote-5-baseline-judge' as const,
    requestSha256: 'd'.repeat(64),
    trialId: 'trial-0',
    version: 1 as const,
  };
  return {...projection, receiptSha256: threadnote5BaselineJudgeReceiptHash(projection)};
}
