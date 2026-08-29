export type {
  AutoShareSyncResult,
  ChangedFile,
  ResolvedTeam,
  ShareArtifactMetadata,
  ShareArtifactResult,
  ShareConflictDetail,
  ShareConflictResolveResult,
  ShareConflictSummary,
  SharedArtifactFile,
  SharedArtifactInstallResult,
  SharedArtifactInstallStatus,
  SharedArtifactListResult,
  SharedArtifactSummary,
  SharedMemoryUriParts,
} from './share/core.js';
export {
  clearAutoShareStateForTest,
  assertShareTeamWritable,
  DEFAULT_GIT_REMOTE_NAME,
  ensureSharedDirectoryChain,
  isInSharedNamespace,
  markSharedAutoSyncDeferred,
  normalizeTeamName,
  parentUri,
  personalUriFor,
  readTeamsFile,
  removeMemoryUri,
  resolveTeam,
  resourceExists,
  resourceUriToWorktreeRelative,
  setMemoryVisibility,
  SHARED_BACKGROUND_FETCH_INTERVAL_MILLISECONDS,
  sharedDirectoryChain,
  sharedMemoryUriParts,
  sharedTeamNameForUri,
  sharedUriFor,
  shareTeamAccess,
  stripPersonalProvenance,
  writeMemoryFile,
} from './share/core.js';
export {
  runShareInit,
  runShareList,
  runShareRemove,
  runShareRename,
  runShareSetAccess,
  runShareSetUrl,
  runShareStatus,
  runShareUnpublish,
  shareUnpublishTargetDisposition,
} from './share/admin.js';
export {refreshSharedReposInBackground, runShareSync, syncSharedReposBeforeAgentRead} from './share/sync.js';
export {
  listShareConflicts,
  resolveShareConflict,
  runShareConflictResolve,
  runShareConflicts,
  runShareConflictShow,
  showShareConflict,
} from './share/conflicts.js';
export {
  assertSharedWorktreeFileReady,
  listChangedFiles,
  mergeChanges,
  publishShareGitChange,
  writeSharedWorktreeFile,
} from './share/git.js';
export {
  runSharePublish,
  runSharePublishArtifact,
  runSharePublishBundle,
  shareAgentArtifact,
  shareBundlePack,
} from './share/artifact_publish.js';
export {
  installSharedAgentArtifacts,
  listSharedAgentArtifacts,
  runShareInstallArtifacts,
} from './share/artifact_install.js';
export {applyScrubber, scrubberBlocker} from './scrubber.js';
