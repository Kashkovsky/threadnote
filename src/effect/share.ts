import {fromPromise} from './errors.js';
import {
  installSharedAgentArtifacts as installSharedAgentArtifactsPromise,
  listSharedAgentArtifacts as listSharedAgentArtifactsPromise,
  removeMemoryUri as removeMemoryUriPromise,
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
} from '../share.js';

const effectify =
  <Args extends readonly unknown[], A>(operation: string, evaluate: (...args: Args) => Promise<A>) =>
  (...args: Args) =>
    fromPromise(operation, () => evaluate(...args));

export const runShareInit = effectify('initialize shared memory repository', runShareInitPromise);
export const runShareStatus = effectify('read shared memory status', runShareStatusPromise);
export const runShareSync = effectify('synchronize shared memory repository', runShareSyncPromise);
export const runShareConflicts = effectify('list shared memory conflicts', runShareConflictsPromise);
export const runShareConflictShow = effectify('show shared memory conflict', runShareConflictShowPromise);
export const runShareConflictResolve = effectify('resolve shared memory conflict', runShareConflictResolvePromise);
export const runSharePublish = effectify('publish shared memory', runSharePublishPromise);
export const runSharePublishArtifact = effectify('publish shared artifact', runSharePublishArtifactPromise);
export const runSharePublishBundle = effectify('publish shared artifact bundle', runSharePublishBundlePromise);
export const runShareInstallArtifacts = effectify('install shared artifacts', runShareInstallArtifactsPromise);
export const runShareUnpublish = effectify('unpublish shared memory', runShareUnpublishPromise);
export const runShareList = effectify('list shared memory teams', runShareListPromise);
export const runShareRename = effectify('rename shared memory team', runShareRenamePromise);
export const runShareSetUrl = effectify('set shared memory remote URL', runShareSetUrlPromise);
export const runShareRemove = effectify('remove shared memory team', runShareRemovePromise);
export const resolveShareConflict = effectify('resolve shared memory conflict', resolveShareConflictPromise);
export const listSharedAgentArtifacts = effectify('list shared agent artifacts', listSharedAgentArtifactsPromise);
export const installSharedAgentArtifacts = effectify(
  'install shared agent artifacts',
  installSharedAgentArtifactsPromise,
);
export const removeMemoryUri = effectify('remove shared memory', removeMemoryUriPromise);
