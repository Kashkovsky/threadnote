import {execFileSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Effect} from 'effect';
import {afterEach, describe, expect, it} from 'vitest';
import {
  CODE_GRAPH_GIT_WORKTREE_REGISTRATION_LIMITS,
  captureCodeGraphGitWorktreeRegistration,
  codeGraphGitWorktreeAdminNameKeys,
  parseBoundedGitDirectoryOutput,
  scanCodeGraphGitWorktreeRegistry,
  type CodeGraphGitWorktreeRegistryRequest,
} from '../../src/code_graph/git_worktree_registration.js';
import {CommandExecutor} from '../../src/effect/command.js';
import {resolveRepositoryIdentity} from '../../src/code_graph/repository.js';
import {runEffect} from '../helpers/effect-runtime.js';

const roots: string[] = [];
const CHECKOUT_ID = 'a'.repeat(64);

afterEach(() => {
  for (const root of roots.splice(0).reverse()) rmSync(root, {force: true, recursive: true});
});

describe('code graph common-gitdir worktree authority', () => {
  it('captures main versus linked registration without exposing the linked admin child', async () => {
    const root = localRepository();
    git(root, ['branch', 'linked']);
    const linked = join(temporaryRoot('threadnote-linked-worktree-'), 'offline-candidate');
    git(root, ['worktree', 'add', linked, 'linked']);
    const [mainIdentity, linkedIdentity] = await Promise.all([
      runEffect(resolveRepositoryIdentity(root)),
      runEffect(resolveRepositoryIdentity(linked)),
    ]);

    const main = await runEffect(captureCodeGraphGitWorktreeRegistration(mainIdentity));
    const registration = await runEffect(captureCodeGraphGitWorktreeRegistration(linkedIdentity));

    expect(main).toEqual({kind: 'main'});
    expect(registration).toMatchObject({kind: 'linked', adminNameKeys: expect.any(Array)});
    expect(JSON.stringify(registration)).not.toContain('offline-candidate');
    expect(JSON.stringify(registration)).not.toContain(mainIdentity.gitCommonDirectory);

    git(root, ['worktree', 'remove', '--force', linked]);
  });

  it('captures git-dir through the bounded binary command boundary and returns path-free failures', async () => {
    const root = localRepository();
    const identity = await runEffect(resolveRepositoryIdentity(root));
    let observedOptions: {readonly maxOutputBytes?: number; readonly timeoutMs?: number} | undefined;
    const registration = await runEffect(
      Effect.gen(function* () {
        const command = yield* CommandExecutor;
        const executeBytes = command.executeBytes;
        if (executeBytes === undefined) return yield* Effect.fail(new Error('binary command adapter is unavailable'));
        const recording = CommandExecutor.of({
          ...command,
          executeBytes: (executable, args, options) => {
            if (executable === 'git' && args.includes('--git-dir')) observedOptions = options;
            return executeBytes(executable, args, options);
          },
        });
        return yield* captureCodeGraphGitWorktreeRegistration(identity).pipe(
          Effect.provideService(CommandExecutor, recording),
        );
      }),
    );
    const privatePath = join(temporaryRoot('threadnote-private-missing-'), 'not-a-repository');
    const failure = await runEffect(
      captureCodeGraphGitWorktreeRegistration({...identity, repoRoot: privatePath}).pipe(Effect.flip),
    );

    expect(registration).toEqual({kind: 'main'});
    expect(observedOptions).toMatchObject({
      maxOutputBytes: CODE_GRAPH_GIT_WORKTREE_REGISTRATION_LIMITS.gitDirectoryOutputBytes,
      timeoutMs: CODE_GRAPH_GIT_WORKTREE_REGISTRATION_LIMITS.gitDirectoryTimeoutMilliseconds,
    });
    expect(failure.message).toBe('Unable to verify the Git worktree registration.');
    expect(JSON.stringify(failure)).not.toContain(privatePath);
  });

  it('preserves a linked registration after its worktree folder becomes unavailable', async () => {
    const root = localRepository();
    git(root, ['branch', 'linked']);
    const linked = join(temporaryRoot('threadnote-linked-worktree-'), 'linked');
    const unavailable = `${linked}-unavailable`;
    git(root, ['worktree', 'add', linked, 'linked']);
    const linkedIdentity = await runEffect(resolveRepositoryIdentity(linked));
    const registration = await runEffect(captureCodeGraphGitWorktreeRegistration(linkedIdentity));
    expect(registration.kind).toBe('linked');

    renameSync(linked, unavailable);
    roots.push(unavailable);
    const observation = await scanCodeGraphGitWorktreeRegistry({
      adminNameKeys: registration.kind === 'linked' ? registration.adminNameKeys : [],
      checkoutId: linkedIdentity.checkoutId,
      gitCommonDirectory: linkedIdentity.gitCommonDirectory,
      protocol: 1,
    });

    expect(observation).toMatchObject({state: 'present'});
    expect(JSON.stringify(observation)).not.toContain(linked);
    renameSync(unavailable, linked);
    roots.splice(roots.indexOf(unavailable), 1);
    git(root, ['worktree', 'remove', '--force', linked]);
  });

  it.each(['directory', 'file'] as const)(
    'treats a matching partial %s admin child as registered without opening it',
    async kind => {
      const common = commonDirectoryFixture();
      const name = `partial-${kind}`;
      const child = join(common, 'worktrees', name);
      if (kind === 'directory') mkdirSync(child);
      if (kind === 'file') writeFileSync(child, 'partial registration');

      const observation = await scanCodeGraphGitWorktreeRegistry(request(common, name));

      expect(observation).toMatchObject({state: 'present'});
    },
  );

  it.skipIf(process.platform === 'win32')(
    'treats a matching symlink admin child as registered without following it',
    async () => {
      const common = commonDirectoryFixture();
      const name = 'partial-symlink';
      symlinkSync(temporaryRoot('threadnote-external-admin-'), join(common, 'worktrees', name));

      expect(await scanCodeGraphGitWorktreeRegistry(request(common, name))).toMatchObject({state: 'present'});
    },
  );

  it.skipIf(process.platform === 'win32')(
    'does not open a gitdir backlink or a registered path that would block forever',
    async () => {
      const common = commonDirectoryFixture();
      const adminName = 'blocked-registered-path';
      const child = join(common, 'worktrees', adminName);
      const fifo = join(temporaryRoot('threadnote-blocked-worktree-'), 'offline.fifo');
      mkdirSync(child);
      execFileSync('mkfifo', [fifo]);
      writeFileSync(join(child, 'gitdir'), `${fifo}\n`);

      const observation = await completesWithin(scanCodeGraphGitWorktreeRegistry(request(common, adminName)), 500);

      expect(observation).toMatchObject({state: 'present'});
    },
  );

  it.skipIf(process.platform !== 'linux')(
    'enumerates unrelated invalid UTF-8 POSIX names without decoding or opening them',
    async () => {
      const common = commonDirectoryFixture();
      const root = Buffer.from(join(common, 'worktrees'));
      const invalidChild = Buffer.concat([root, Buffer.from('/'), Buffer.from([0xff, 0xfe])]);
      mkdirSync(invalidChild);

      const observation = await scanCodeGraphGitWorktreeRegistry(request(common, 'absent-target'));

      expect(observation).toMatchObject({entryCount: 1, state: 'absent'});
    },
  );

  it('treats a stably missing registry root as complete-empty', async () => {
    const missing = temporaryRoot('threadnote-common-missing-');
    const missingObservation = await scanCodeGraphGitWorktreeRegistry(request(missing, 'absent-target'));

    expect(missingObservation).toMatchObject({entryCount: 0, registryRootKind: 'missing', state: 'absent'});
  });

  it.skipIf(process.platform === 'win32')('treats a symlinked registry root as unknown', async () => {
    const symlinked = temporaryRoot('threadnote-common-symlink-');
    symlinkSync(temporaryRoot('threadnote-registry-external-'), join(symlinked, 'worktrees'));
    const symlinkObservation = await scanCodeGraphGitWorktreeRegistry(request(symlinked, 'absent-target'));

    expect(symlinkObservation).toEqual({reason: 'ambiguous', state: 'unknown'});
  });

  it('returns unknown instead of a partial absence when the immediate-name bound is exceeded', async () => {
    const common = commonDirectoryFixture();
    for (let index = 0; index <= CODE_GRAPH_GIT_WORKTREE_REGISTRATION_LIMITS.maxAdminNames; index += 1) {
      writeFileSync(join(common, 'worktrees', `entry-${index}`), '');
    }

    const observation = await scanCodeGraphGitWorktreeRegistry(request(common, 'absent-target'));

    expect(observation).toEqual({reason: 'ambiguous', state: 'unknown'});
  });

  it('parses one bounded exact git-dir record without trimming path bytes', () => {
    expect(parseBoundedGitDirectoryOutput(Buffer.from('/private/worktree admin \n'))).toBe('/private/worktree admin ');
    expect(parseBoundedGitDirectoryOutput(Buffer.from('/private/one\n/private/two\n'))).toBeUndefined();
    expect(parseBoundedGitDirectoryOutput(Uint8Array.of(0xff, 0x0a))).toBeUndefined();
    expect(parseBoundedGitDirectoryOutput(Buffer.from('/private/no-terminator'))).toBeUndefined();
    expect(
      parseBoundedGitDirectoryOutput(
        Buffer.alloc(CODE_GRAPH_GIT_WORKTREE_REGISTRATION_LIMITS.gitDirectoryOutputBytes + 1, 0x61),
      ),
    ).toBeUndefined();
  });

  it('derives deterministic checkout-bound exact and conservative name keys', () => {
    const exact = codeGraphGitWorktreeAdminNameKeys(CHECKOUT_ID, 'Solaris');
    const repeated = codeGraphGitWorktreeAdminNameKeys(CHECKOUT_ID, Buffer.from('Solaris'));
    const folded = codeGraphGitWorktreeAdminNameKeys(CHECKOUT_ID, 'solaris');

    expect(exact).toEqual(repeated);
    expect(exact).toHaveLength(2);
    expect(exact.some(key => folded.includes(key))).toBe(true);
    expect(codeGraphGitWorktreeAdminNameKeys('b'.repeat(64), 'Solaris')).not.toEqual(exact);
    expect(JSON.stringify(exact)).not.toContain('Solaris');
    expect(codeGraphGitWorktreeAdminNameKeys(CHECKOUT_ID, Uint8Array.of(0xff, 0xfe))).toHaveLength(1);
  });
});

function request(common: string, adminName: string): CodeGraphGitWorktreeRegistryRequest {
  return {
    adminNameKeys: codeGraphGitWorktreeAdminNameKeys(CHECKOUT_ID, adminName),
    checkoutId: CHECKOUT_ID,
    gitCommonDirectory: common,
    protocol: 1,
  };
}

function commonDirectoryFixture(): string {
  const common = temporaryRoot('threadnote-common-gitdir-');
  mkdirSync(join(common, 'worktrees'));
  return common;
}

function localRepository(): string {
  const root = temporaryRoot('threadnote-registration-repository-');
  git(root, ['init', '-q']);
  git(root, [
    '-c',
    'user.name=Threadnote Test',
    '-c',
    'user.email=test@threadnote.local',
    'commit',
    '--allow-empty',
    '-qm',
    'fixture',
  ]);
  return root;
}

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', ['-C', cwd, ...args], {stdio: 'pipe'});
}

async function completesWithin<A>(promise: Promise<A>, milliseconds: number): Promise<A> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('operation exceeded bounded test deadline')), milliseconds);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
