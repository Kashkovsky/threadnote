import {Console, Effect, FileSystem} from 'effect';
import {isFileLockTimeout} from './file_lock.js';
import {withMemoryUriLocks} from './memory_lock.js';
import {withSharedRepositoryLock} from './share_lock.js';
import {
  installSharedAgentArtifacts as installSharedAgentArtifactsEffect,
  listSharedAgentArtifacts as listSharedAgentArtifactsEffect,
  listShareConflicts as listShareConflictsEffect,
  removeMemoryUri as removeMemoryUriEffect,
  refreshSharedReposInBackground as refreshSharedReposInBackgroundEffect,
  resolveShareConflict as resolveShareConflictEffect,
  resolveTeam as resolveTeamEffect,
  runShareConflictResolve as runShareConflictResolveEffect,
  runShareConflicts as runShareConflictsEffect,
  runShareConflictShow as runShareConflictShowEffect,
  runShareInit as runShareInitEffect,
  runShareInstallArtifacts as runShareInstallArtifactsEffect,
  runShareList as runShareListEffect,
  runSharePublish as runSharePublishEffect,
  runSharePublishArtifact as runSharePublishArtifactEffect,
  runSharePublishBundle as runSharePublishBundleEffect,
  runShareRemove as runShareRemoveEffect,
  runShareRename as runShareRenameEffect,
  runShareSetUrl as runShareSetUrlEffect,
  runShareStatus as runShareStatusEffect,
  runShareSync as runShareSyncEffect,
  runShareUnpublish as runShareUnpublishEffect,
  shareAgentArtifact as shareAgentArtifactEffect,
  shareBundlePack as shareBundlePackEffect,
  showShareConflict as showShareConflictEffect,
  SHARED_BACKGROUND_FETCH_INTERVAL_MILLISECONDS,
  sharedUriFor,
  syncSharedReposBeforeAgentRead as syncSharedReposBeforeAgentReadEffect,
} from '../share.js';
import type {
  ShareConflictOptions,
  ShareConflictResolveOptions,
  ShareConflictShowOptions,
  ShareInitOptions,
  ShareInstallArtifactsOptions,
  ShareListArtifactsOptions,
  ShareListOptions,
  SharePublishArtifactOptions,
  SharePublishOptions,
  ShareRemoveOptions,
  ShareRenameOptions,
  ShareSetUrlOptions,
  ShareStatusOptions,
  ShareSyncOptions,
  ShareUnpublishOptions,
  ShareRuntime,
} from '../types.js';

const SHARED_REPOSITORY_READ_LOCK_WAIT_TIMEOUT_MILLISECONDS = 250;

export const runShareInit = (config: ShareRuntime, remoteUrl: string, options: ShareInitOptions) =>
  withSharedRepositoryLock(config, runShareInitEffect(config, remoteUrl, options));
export const runShareStatus = (config: ShareRuntime, options: ShareStatusOptions) =>
  withSharedRepositoryLock(config, runShareStatusEffect(config, options));
export const runShareSync = (config: ShareRuntime, options: ShareSyncOptions) =>
  withSharedRepositoryLock(config, runShareSyncEffect(config, options));
export const monitorSharedRepositories = Effect.fn('share.monitorRepositories')(function* (config: ShareRuntime) {
  const refresh = (force: boolean) =>
    withSharedRepositoryLock(config, refreshSharedReposInBackgroundEffect(config, force)).pipe(
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
  return yield* withSharedRepositoryLock(config, syncSharedReposBeforeAgentReadEffect(config), {
    waitTimeoutMilliseconds: SHARED_REPOSITORY_READ_LOCK_WAIT_TIMEOUT_MILLISECONDS,
  }).pipe(
    Effect.catchIf(isFileLockTimeout, () =>
      Effect.succeed({syncedTeams: [] as readonly string[], warnings: [] as readonly string[]}),
    ),
  );
});
export const runShareConflicts = (config: ShareRuntime, options: ShareConflictOptions) =>
  withSharedRepositoryLock(config, runShareConflictsEffect(config, options));
export const runShareConflictShow = (config: ShareRuntime, reference: string, options: ShareConflictShowOptions) =>
  withSharedRepositoryLock(config, runShareConflictShowEffect(config, reference, options));
export const listShareConflicts = (config: ShareRuntime, options: ShareConflictOptions) =>
  withSharedRepositoryLock(config, listShareConflictsEffect(config, options));
export const showShareConflict = (config: ShareRuntime, reference: string, options: ShareConflictShowOptions) =>
  withSharedRepositoryLock(config, showShareConflictEffect(config, reference, options));
export const runShareConflictResolve = (
  config: ShareRuntime,
  reference: string,
  options: ShareConflictResolveOptions,
) => withSharedRepositoryLock(config, runShareConflictResolveEffect(config, reference, options));
export const runSharePublish = Effect.fn('share.publish')(function* (
  config: ShareRuntime,
  sourceUri: string,
  options: SharePublishOptions,
) {
  const publish = runSharePublishEffect(config, sourceUri, options);
  if (options.dryRun === true || options.preview === true) {
    return yield* publish;
  }
  return yield* withSharedRepositoryLock(
    config,
    Effect.gen(function* () {
      const team = yield* resolveTeamEffect(config, options.team);
      const targetUri = sharedUriFor(config, sourceUri, team.name);
      const fs = yield* FileSystem.FileSystem;
      const resolvedPublish = runSharePublishEffect(config, sourceUri, {...options, team: team.name});
      return yield* withMemoryUriLocks(fs, config.agentContextHome, [sourceUri, targetUri], resolvedPublish);
    }),
  );
});
export const runSharePublishArtifact = (
  config: ShareRuntime,
  sourcePath: string,
  options: SharePublishArtifactOptions,
) => withSharedRepositoryLock(config, runSharePublishArtifactEffect(config, sourcePath, options));
export const runSharePublishBundle = (
  config: ShareRuntime,
  manifestPath: string,
  options: SharePublishArtifactOptions,
) => withSharedRepositoryLock(config, runSharePublishBundleEffect(config, manifestPath, options));
export const shareAgentArtifact = (config: ShareRuntime, sourcePath: string, options: SharePublishArtifactOptions) =>
  withSharedRepositoryLock(config, shareAgentArtifactEffect(config, sourcePath, options));
export const shareBundlePack = (config: ShareRuntime, manifestPath: string, options: SharePublishArtifactOptions) =>
  withSharedRepositoryLock(config, shareBundlePackEffect(config, manifestPath, options));
export const runShareInstallArtifacts = (config: ShareRuntime, options: ShareInstallArtifactsOptions) =>
  withSharedRepositoryLock(config, runShareInstallArtifactsEffect(config, options));
export const runShareUnpublish = (config: ShareRuntime, sourceUri: string, options: ShareUnpublishOptions) =>
  withSharedRepositoryLock(config, runShareUnpublishEffect(config, sourceUri, options));
export const runShareList = (config: ShareRuntime, options: ShareListOptions) => runShareListEffect(config, options);
export const runShareRename = (config: ShareRuntime, options: ShareRenameOptions) =>
  withSharedRepositoryLock(config, runShareRenameEffect(config, options));
export const runShareSetUrl = (config: ShareRuntime, remoteUrl: string, options: ShareSetUrlOptions) =>
  withSharedRepositoryLock(config, runShareSetUrlEffect(config, remoteUrl, options));
export const runShareRemove = (config: ShareRuntime, options: ShareRemoveOptions) =>
  withSharedRepositoryLock(config, runShareRemoveEffect(config, options));
export const resolveShareConflict = (config: ShareRuntime, reference: string, options: ShareConflictResolveOptions) =>
  withSharedRepositoryLock(config, resolveShareConflictEffect(config, reference, options));
export const listSharedAgentArtifacts = (config: ShareRuntime, options: ShareListArtifactsOptions) =>
  withSharedRepositoryLock(config, listSharedAgentArtifactsEffect(config, options));
export const installSharedAgentArtifacts = (config: ShareRuntime, options: ShareInstallArtifactsOptions) =>
  withSharedRepositoryLock(config, installSharedAgentArtifactsEffect(config, options));
export const removeMemoryUri = removeMemoryUriEffect;
