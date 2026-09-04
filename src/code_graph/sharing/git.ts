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
