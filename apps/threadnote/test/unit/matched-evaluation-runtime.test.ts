import {chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {sha256HexSync} from '@threadnote/platform/sha256';
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

describe('matched evaluation runtime integrity', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, {force: true, recursive: true})));
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
