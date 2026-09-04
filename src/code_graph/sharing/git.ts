import {Effect} from 'effect';
import {runCommandEffect} from '../../effect/command.js';
import {SystemInfo} from '../../effect/system.js';

export const GRAPH_SHARE_GIT_OBJECT_ID = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/u;

export function isGraphShareGitObjectId(value: string): boolean {
  return GRAPH_SHARE_GIT_OBJECT_ID.test(value);
}

export function graphShareCommitIsAncestor(repoRoot: string, ancestor: string, descendant: string) {
  return Effect.gen(function* () {
    if (!isGraphShareGitObjectId(ancestor) || !isGraphShareGitObjectId(descendant)) return false;
    if (ancestor === descendant) return true;
    const system = yield* SystemInfo;
    const result = yield* runCommandEffect(
      'git',
      ['-C', repoRoot, 'merge-base', '--is-ancestor', '--', ancestor, descendant],
      {
        allowFailure: true,
        env: {...system.environment(), GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0'},
        maxOutputBytes: 4_096,
        timeoutMs: 10_000,
      },
    );
    return result.exitCode === 0;
  });
}

export function graphShareCommitDiffStats(repoRoot: string, from: string, to: string) {
  return Effect.gen(function* () {
    if (!isGraphShareGitObjectId(from) || !isGraphShareGitObjectId(to) || from === to) {
      return {changedBytes: 0, changedFiles: 0};
    }
    const system = yield* SystemInfo;
    const result = yield* runCommandEffect('git', ['-C', repoRoot, 'diff', '--numstat', '--', from, to], {
      allowFailure: true,
      env: {...system.environment(), GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0'},
      maxOutputBytes: 1_048_576,
      timeoutMs: 10_000,
    });
    if (result.exitCode !== 0) return {changedBytes: 0, changedFiles: 0};
    let changedBytes = 0;
    let changedFiles = 0;
    for (const line of result.stdout.split('\n')) {
      const match = /^(\d+|-)\t(\d+|-)\t/u.exec(line);
      if (match === null) continue;
      changedFiles += 1;
      changedBytes += (match[1] === '-' ? 0 : Number(match[1])) + (match[2] === '-' ? 0 : Number(match[2]));
    }
    return {changedBytes, changedFiles};
  });
}

export function graphShareBlobExists(repoRoot: string, blobId: string) {
  return Effect.gen(function* () {
    if (!isGraphShareGitObjectId(blobId)) return false;
    const system = yield* SystemInfo;
    const result = yield* runCommandEffect('git', ['-C', repoRoot, 'cat-file', '-e', '--', blobId], {
      allowFailure: true,
      env: {...system.environment(), GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0'},
      maxOutputBytes: 4_096,
      timeoutMs: 10_000,
    });
    return result.exitCode === 0;
  });
}
