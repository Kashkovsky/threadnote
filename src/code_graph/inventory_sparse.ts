import {Effect, FileSystem, Option, Path} from 'effect';
import {
  compileThreadnoteIgnore,
  type CodeGraphInventoryOptions,
  type CodeGraphOverlayObservation,
  type GitTreeEntry,
  isOverlayAdmissionControlPath,
  readDirtyOverlay,
  sameInventoryPathSet,
} from './inventory.js';
import {codeGraphInventoryReuseContract, readCodeGraphInventoryReuseEnvironment} from './inventory_reuse.js';
import {codeGraphInventoryExclusionReason} from './inventory_policy.js';
import {BUILTIN_LANGUAGE_PACK_REGISTRY} from './languages/registry.js';
import type {CodeGraphWorkspace} from './languages/types.js';
import {compareCodeUnits} from './ordering.js';
import type {CodeGraphReusableCleanBaseSlice} from './store_models.js';
import type {CodeGraphInventoryFile, RepositoryIdentity} from './types.js';

/**
 * Changed-path-only dirty admission over a persisted clean base. The complete
 * base inventory remains in SQLite; this projection never represents it as a
 * JavaScript array.
 */
export interface CodeGraphReusableOverlayAdmission {
  readonly base: CodeGraphReusableCleanBaseSlice;
  readonly diagnostics: readonly string[];
  readonly files: readonly CodeGraphInventoryFile[];
  readonly overlayFingerprint: string;
  readonly parsedFiles: number;
  readonly skipped: number;
  readonly workspace: CodeGraphWorkspace;
}

/**
 * Admit an unchanged-file-set dirty overlay from only the requested persisted
 * rows. Deletions and resolution-context changes deliberately retain the full
 * inventory fallback until their dependency closure is represented sparsely.
 */
export const inventoryRepositoryFromReusableCleanBaseSlice = Effect.fn(
  'codeGraph.inventoryRepositoryFromReusableBaseSlice',
)(function* (
  identity: RepositoryIdentity,
  base: CodeGraphReusableCleanBaseSlice,
  options: CodeGraphInventoryOptions & {readonly overlayObservation: CodeGraphOverlayObservation},
) {
  const receipt = base.receipt.inventory;
  if (
    receipt === undefined ||
    base.snapshot.repositoryId !== identity.repositoryId ||
    base.snapshot.commit !== identity.headCommit ||
    base.snapshot.dirty ||
    base.snapshot.baseSnapshotId !== undefined
  ) {
    return Option.none<CodeGraphReusableOverlayAdmission>();
  }
  const languagePacks = options.languagePacks ?? BUILTIN_LANGUAGE_PACK_REGISTRY;
  const includeOpaqueCorpusAssets = options.includeOpaqueCorpusAssets !== false;
  if (
    receipt.includeOpaqueCorpusAssets !== includeOpaqueCorpusAssets ||
    receipt.contract !== codeGraphInventoryReuseContract(languagePacks, includeOpaqueCorpusAssets)
  ) {
    return Option.none<CodeGraphReusableOverlayAdmission>();
  }
  const observation = options.overlayObservation;
  if (
    observation.changedPaths.length === 0 ||
    observation.changedPaths.length > 200 ||
    observation.addedPaths.length > 0 ||
    observation.deletedPaths.length > 0 ||
    observation.untrackedPaths.length > 0
  ) {
    return Option.none<CodeGraphReusableOverlayAdmission>();
  }
  const baseByPath = new Map(base.files.map(file => [file.path, file]));
  const requestedChanged = new Set(observation.changedPaths);
  if (
    requestedChanged.size !== observation.changedPaths.length ||
    baseByPath.size !== requestedChanged.size ||
    [...requestedChanged].some(
      relative =>
        !baseByPath.has(relative) ||
        isOverlayAdmissionControlPath(relative) ||
        languagePacks.isResolutionContext(relative),
    )
  ) {
    return Option.none<CodeGraphReusableOverlayAdmission>();
  }
  const observedFiles = new Map(observation.files.map(file => [file.path, file]));
  if (
    observedFiles.size !== observation.changedPaths.length ||
    observation.changedPaths.some(relative => {
      const file = observedFiles.get(relative);
      return file === undefined || codeGraphInventoryExclusionReason(relative, file.size) !== undefined;
    })
  ) {
    return Option.none<CodeGraphReusableOverlayAdmission>();
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* readCodeGraphInventoryReuseEnvironment(identity, fs, path);
  if (environment.fingerprint !== receipt.environmentFingerprint) {
    return Option.none<CodeGraphReusableOverlayAdmission>();
  }
  const projectRoots = [
    ...new Set([
      ...receipt.workspace.projects.map(project => project.root),
      ...receipt.workspace.workspaces.map(workspace => workspace.root),
    ]),
  ].sort(compareCodeUnits);
  const sourceRoots = [...new Set(receipt.workspace.projects.flatMap(project => project.sourceRoots))].sort(
    compareCodeUnits,
  );
  const committedTreeEntries = new Map(
    base.files.map(file => [
      file.path,
      {blobId: file.blobId, mode: file.mode, path: file.path, size: file.size} satisfies GitTreeEntry,
    ]),
  );
  const overlay = yield* readDirtyOverlay(
    identity,
    path,
    environment.threadnoteIgnore,
    compileThreadnoteIgnore(environment.threadnoteIgnore),
    options.cachedCommittedFileKeys ?? new Set(),
    languagePacks,
    projectRoots,
    sourceRoots,
    new Map(),
    committedTreeEntries,
    requestedChanged,
    includeOpaqueCorpusAssets,
    options.onContentBatch,
    options.onOverlayStart,
    observation,
  );
  if (
    !overlay.dirty ||
    overlay.fingerprint === undefined ||
    !sameInventoryPathSet(overlay.changed, requestedChanged) ||
    overlay.skipped !== 0 ||
    overlay.policySkippedDelta !== 0 ||
    overlay.files.length !== requestedChanged.size ||
    overlay.files.some(file => observedFiles.get(file.path)?.contentHash !== file.contentHash)
  ) {
    return Option.none<CodeGraphReusableOverlayAdmission>();
  }
  return Option.some({
    base,
    diagnostics: [
      ...receipt.diagnostics,
      `Reused persisted clean inventory admission for ${requestedChanged.size} changed path(s) without hydrating the complete base.`,
    ],
    files: overlay.files,
    overlayFingerprint: overlay.fingerprint,
    parsedFiles: overlay.parsedPaths.size,
    skipped: receipt.skipped,
    workspace: receipt.workspace,
  } satisfies CodeGraphReusableOverlayAdmission);
});
