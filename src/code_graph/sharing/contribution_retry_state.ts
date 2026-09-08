import {Effect, FileSystem, Path} from 'effect';
import {readJsonFile, writePrivateJsonFile} from './atomic.js';
import {graphSharingContributionQueuePath, graphSharingLayout} from './layout.js';
import {graphSharingFailure} from './errors.js';
import {SHA256_DIGEST} from './digest.js';

interface ContributionRetryState {
  readonly failures: number;
  readonly identity: string;
  readonly nextAttempt: number;
}

export function graphShareContributionRetryDelay(failures: number, jitter: number, retryAfterMilliseconds = 0): number {
  const backoff = Math.min(300_000, 5_000 * 2 ** Math.min(6, Math.max(0, failures - 1)));
  return Math.max(retryAfterMilliseconds, Math.round(backoff * (1 + Math.max(0, Math.min(1, jitter)) * 0.2)));
}

const retryPath = Effect.fn('codeGraph.sharing.contributionRetryPath')(function* (home: string, repositoryId: string) {
  const path = yield* Path.Path;
  return `${graphSharingContributionQueuePath(path, graphSharingLayout(path, home).root, repositoryId)}.retry.json`;
});

export const readContributionRetryState = Effect.fn('codeGraph.sharing.readContributionRetryState')(function* (
  home: string,
  repositoryId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const target = yield* retryPath(home, repositoryId);
  if (!(yield* fs.exists(target))) return undefined;
  if (Number((yield* fs.stat(target)).size) > 4_096)
    return yield* graphSharingFailure('Contribution retry state exceeds the read limit.');
  const value = (yield* readJsonFile(target)) as Partial<ContributionRetryState> | null;
  if (
    value === null ||
    typeof value !== 'object' ||
    typeof value.identity !== 'string' ||
    !SHA256_DIGEST.test(value.identity) ||
    typeof value.failures !== 'number' ||
    !Number.isInteger(value.failures) ||
    value.failures < 1 ||
    value.failures > 7 ||
    typeof value.nextAttempt !== 'number' ||
    !Number.isSafeInteger(value.nextAttempt) ||
    value.nextAttempt < 0
  ) {
    return yield* graphSharingFailure('Contribution retry state is invalid.');
  }
  return value as ContributionRetryState;
});

// The repository delivery lease serializes this state across foreground and background runtimes.
export const writeContributionRetryState = Effect.fn('codeGraph.sharing.writeContributionRetryState')(function* (
  home: string,
  repositoryId: string,
  state: ContributionRetryState | undefined,
) {
  const target = yield* retryPath(home, repositoryId);
  if (state === undefined) yield* (yield* FileSystem.FileSystem).remove(target, {force: true});
  else yield* writePrivateJsonFile(target, state);
});
