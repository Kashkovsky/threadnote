import {provideTestLayer} from '../helpers/effect-layer.js';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from '../helpers/node-fs.js';
import {tmpdir} from '../helpers/node-os.js';
import {join} from '../helpers/node-path.js';
import {describe, expect, it} from '@effect/vitest';
import {Effect} from 'effect';
import {CommandExecutor, CommandFailed, type CommandOptions} from '../../src/effect/command.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {worktreeStatusWithPrivateCache} from '../../src/code_graph/git_status_cache.js';
import type {RepositoryIdentity} from '../../src/code_graph/types.js';

const HASH = 'a'.repeat(64);
const STATUS_ARGUMENTS = ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--renames'] as const;

describe('code graph private Git status cache', () => {
  it.effect('reuses and refreshes only the private index while preserving exact status output', () => {
    let root: string | undefined;
    return Effect.gen(function* () {
      root = mkdtempSync(join(tmpdir(), 'threadnote-git-status-cache-'));
      const repository = join(root, 'repository');
      const gitDirectory = join(repository, '.git');
      const sourceIndex = join(gitDirectory, 'index');
      const home = join(root, 'home');
      mkdirSync(gitDirectory, {recursive: true});
      mkdirSync(home, {recursive: true});
      writeFileSync(sourceIndex, 'source-index-v1');
      const identity = repositoryIdentity(repository);
      const base = yield* CommandExecutor;
      const calls: Array<{args: readonly string[]; options?: CommandOptions}> = [];
      const command = CommandExecutor.of({
        ...base,
        execute: (executable, args, options) => {
          expect(executable).toBe('git');
          calls.push({args, options});
          if (args.includes('rev-parse')) return Effect.succeed(result(`${sourceIndex}\n`));
          if (args.includes('update-index')) return Effect.succeed(result(''));
          if (args.includes('fsmonitor--daemon')) return Effect.succeed(result(''));
          if (args.includes('status')) return Effect.succeed(result(' M src/index.ts\0'));
          return Effect.fail(commandFailure(args));
        },
      });
      const observe = () =>
        worktreeStatusWithPrivateCache(identity, home, STATUS_ARGUMENTS, {minimumIndexBytes: 1}).pipe(
          Effect.provideService(CommandExecutor, command),
        );

      expect((yield* observe()).stdout).toBe(' M src/index.ts\0');
      expect(calls.filter(call => call.args.includes('update-index'))).toHaveLength(2);
      assertPrivateStatusCall(calls.at(-1), home);

      expect((yield* observe()).stdout).toBe(' M src/index.ts\0');
      expect(calls.filter(call => call.args.includes('update-index'))).toHaveLength(2);
      assertPrivateStatusCall(calls.at(-1), home);

      writeFileSync(sourceIndex, 'source-index-v2');
      expect((yield* observe()).stdout).toBe(' M src/index.ts\0');
      expect(calls.filter(call => call.args.includes('update-index'))).toHaveLength(4);
      assertPrivateStatusCall(calls.at(-1), home);
      expect(calls.every(call => !call.args.includes('--no-optional-locks') || call.args.includes('rev-parse'))).toBe(
        true,
      );
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => (root === undefined ? undefined : rmSync(root, {force: true, recursive: true}))),
      ),
      provideTestLayer(ApplicationLayer),
    );
  });

  it.effect('falls back to the read-only status command when private-index setup is unavailable', () => {
    let root: string | undefined;
    return Effect.gen(function* () {
      root = mkdtempSync(join(tmpdir(), 'threadnote-git-status-fallback-'));
      const repository = join(root, 'repository');
      const gitDirectory = join(repository, '.git');
      const sourceIndex = join(gitDirectory, 'index');
      const home = join(root, 'home');
      mkdirSync(gitDirectory, {recursive: true});
      mkdirSync(home, {recursive: true});
      writeFileSync(sourceIndex, 'source-index-v1');
      const calls: Array<{args: readonly string[]; options?: CommandOptions}> = [];
      const base = yield* CommandExecutor;
      const command = CommandExecutor.of({
        ...base,
        execute: (executable, args, options) => {
          expect(executable).toBe('git');
          calls.push({args, options});
          if (args.includes('rev-parse')) return Effect.succeed(result(`${sourceIndex}\n`));
          if (args.includes('update-index')) return Effect.fail(commandFailure(args));
          if (args.includes('status')) return Effect.succeed(result('?? src/new.ts\0'));
          return Effect.fail(commandFailure(args));
        },
      });

      const observed = yield* worktreeStatusWithPrivateCache(repositoryIdentity(repository), home, STATUS_ARGUMENTS, {
        minimumIndexBytes: 1,
      }).pipe(Effect.provideService(CommandExecutor, command));

      expect(observed.stdout).toBe('?? src/new.ts\0');
      const fallback = calls.at(-1);
      expect(fallback?.args.slice(0, 3)).toEqual(['--no-optional-locks', '-C', repository]);
      expect(fallback?.options?.trustedGitIndexFile).toBeUndefined();
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => (root === undefined ? undefined : rmSync(root, {force: true, recursive: true}))),
      ),
      provideTestLayer(ApplicationLayer),
    );
  });
});

function assertPrivateStatusCall(
  call: {args: readonly string[]; options?: CommandOptions} | undefined,
  home: string,
): void {
  expect(call?.args).toContain('status');
  expect(call?.args).toContain('core.fsmonitor=true');
  expect(call?.args).toContain('core.untrackedCache=true');
  expect(call?.options?.trustedGitIndexFile?.startsWith(home)).toBe(true);
}

function repositoryIdentity(repoRoot: string): RepositoryIdentity {
  return {
    caseMode: 'sensitive',
    checkoutId: HASH,
    displayName: 'fixture',
    gitCommonDirectory: join(repoRoot, '.git'),
    headCommit: 'b'.repeat(40),
    objectFormat: 'sha1',
    repoRoot,
    repositoryId: HASH,
    worktreeId: 'c'.repeat(64),
  };
}

function result(stdout: string) {
  return {exitCode: 0, stderr: '', stdout};
}

function commandFailure(args: readonly string[]) {
  return new CommandFailed({
    args,
    executable: 'git',
    exitCode: 1,
    message: 'unsupported private index',
    stderr: 'unsupported private index',
    stdout: '',
  });
}
