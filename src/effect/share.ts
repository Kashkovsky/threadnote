import {Console, Effect, FileSystem} from 'effect';
import {fromPromise, fromSync} from './errors.js';
import {withMemoryUriLocks} from './memory_lock.js';
import {withSharedRepositoryLock} from './share_lock.js';
import {
  installSharedAgentArtifacts as installSharedAgentArtifactsPromise,
  listSharedAgentArtifacts as listSharedAgentArtifactsPromise,
  listShareConflicts as listShareConflictsPromise,
  removeMemoryUri as removeMemoryUriPromise,
  refreshSharedReposInBackground as refreshSharedReposInBackgroundPromise,
  resolveShareConflict as resolveShareConflictPromise,
  runShareConflictResolve as runShareConflictResolvePromise,
  runShareConflicts as runShareConflictsPromise,
  runShareConflictShow as runShareConflictShowPromise,
  runShareInit as runShareInitPromise,
  runShareInstallArtifacts as runShareInstallArtifactsPromise,
  runShareList as runShareListPromise,
  runSharePublish as runSharePublishPromise,
  runSharePublishArtifact as runSharePublishArtifactPromise,
  runSharePublishBundle as runSharePublishBundlePromise,
  runShareRemove as runShareRemovePromise,
  runShareRename as runShareRenamePromise,
  runShareSetUrl as runShareSetUrlPromise,
  runShareStatus as runShareStatusPromise,
  runShareSync as runShareSyncPromise,
  runShareUnpublish as runShareUnpublishPromise,
  resolveTeam,
  shareAgentArtifact as shareAgentArtifactPromise,
  shareBundlePack as shareBundlePackPromise,
  showShareConflict as showShareConflictPromise,
  SHARED_BACKGROUND_FETCH_INTERVAL_MILLISECONDS,
  sharedUriFor,
  syncSharedReposBeforeAgentRead as syncSharedReposBeforeAgentReadPromise,
} from '../share.js';
import type {SharePublishOptions, ShareRuntime} from '../types.js';

const effectify =
  <Args extends readonly unknown[], A>(operation: string, evaluate: (...args: Args) => Promise<A>) =>
  (...args: Args) =>
    fromPromise(operation, () => evaluate(...args));

const effectifyLocked =
  <Args extends readonly unknown[], A>(
    operation: string,
    evaluate: (config: ShareRuntime, ...args: Args) => Promise<A>,
  ) =>
  (config: ShareRuntime, ...args: Args) =>
    withSharedRepositoryLock(
      config,
      fromPromise(operation, () => evaluate(config, ...args)),
    );

export const runShareInit = effectifyLocked('initialize shared memory repository', runShareInitPromise);
export const runShareStatus = effectifyLocked('read shared memory status', runShareStatusPromise);
export const runShareSync = effectifyLocked('synchronize shared memory repository', runShareSyncPromise);
export const monitorSharedRepositories = Effect.fn('share.monitorRepositories')(function* (config: ShareRuntime) {
  const refresh = (force: boolean) =>
    effectifyLocked('refresh shared memory repositories', refreshSharedReposInBackgroundPromise)(config, force).pipe(
      Effect.catch(error =>
        Console.error(`share auto-fetch failed: ${error instanceof Error ? error.message : String(error)}`),
      ),
    );
  yield* refresh(true);
  while (true) {
    yield* Effect.sleep(SHARED_BACKGROUND_FETCH_INTERVAL_MILLISECONDS);
    yield* refresh(false);
  }
});
export const syncSharedReposBeforeAgentRead = Effect.fn('share.syncBeforeAgentRead')(function* (config: ShareRuntime) {
  return yield* withSharedRepositoryLock(
    config,
    fromPromise('synchronize shared memories before agent read', () => syncSharedReposBeforeAgentReadPromise(config)),
  );
});
export const runShareConflicts = effectifyLocked('list shared memory conflicts', runShareConflictsPromise);
export const runShareConflictShow = effectifyLocked('show shared memory conflict', runShareConflictShowPromise);
export const listShareConflicts = effectifyLocked('list shared memory conflicts', listShareConflictsPromise);
export const showShareConflict = effectifyLocked('show shared memory conflict', showShareConflictPromise);
export const runShareConflictResolve = effectifyLocked(
  'resolve shared memory conflict',
  runShareConflictResolvePromise,
);
export const runSharePublish = Effect.fn('share.publish')(function* (
  config: ShareRuntime,
  sourceUri: string,
  options: SharePublishOptions,
) {
  const publish = fromPromise('publish shared memory', () => runSharePublishPromise(config, sourceUri, options));
  if (options.dryRun === true || options.preview === true) {
    return yield* publish;
  }
  return yield* withSharedRepositoryLock(
    config,
    Effect.gen(function* () {
      const team = yield* fromPromise('resolve shared memory team', () => resolveTeam(config, options.team));
      const targetUri = yield* fromSync('resolve shared memory target', () =>
        sharedUriFor(config, sourceUri, team.name),
      );
      const fs = yield* FileSystem.FileSystem;
      const resolvedPublish = fromPromise('publish shared memory', () =>
        runSharePublishPromise(config, sourceUri, {...options, team: team.name}),
      );
      return yield* withMemoryUriLocks(fs, config.agentContextHome, [sourceUri, targetUri], resolvedPublish);
    }),
  );
});
export const runSharePublishArtifact = effectifyLocked('publish shared artifact', runSharePublishArtifactPromise);
export const runSharePublishBundle = effectifyLocked('publish shared artifact bundle', runSharePublishBundlePromise);
export const shareAgentArtifact = effectifyLocked('publish shared artifact', shareAgentArtifactPromise);
export const shareBundlePack = effectifyLocked('publish shared artifact bundle', shareBundlePackPromise);
export const runShareInstallArtifacts = effectifyLocked('install shared artifacts', runShareInstallArtifactsPromise);
export const runShareUnpublish = effectifyLocked('unpublish shared memory', runShareUnpublishPromise);
export const runShareList = effectify('list shared memory teams', runShareListPromise);
export const runShareRename = effectifyLocked('rename shared memory team', runShareRenamePromise);
export const runShareSetUrl = effectifyLocked('set shared memory remote URL', runShareSetUrlPromise);
export const runShareRemove = effectifyLocked('remove shared memory team', runShareRemovePromise);
export const resolveShareConflict = effectifyLocked('resolve shared memory conflict', resolveShareConflictPromise);
export const listSharedAgentArtifacts = effectifyLocked('list shared agent artifacts', listSharedAgentArtifactsPromise);
export const installSharedAgentArtifacts = effectifyLocked(
  'install shared agent artifacts',
  installSharedAgentArtifactsPromise,
);
export const removeMemoryUri = effectify('remove shared memory', removeMemoryUriPromise);
