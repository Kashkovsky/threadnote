import {Option} from 'effect';
import type {CodeGraphLanguagePackRegistryShape} from './languages/registry.js';
import {compareCodeUnits} from './ordering.js';
import type {CodeGraphInventoryFile} from './types.js';

export class CodeGraphIndexOperationError extends Error {
  readonly _tag = 'CodeGraphIndexOperationError' as const;
}
export function sameOverlayState(
  left: {readonly dirty: boolean; readonly fingerprint?: string},
  right: {readonly dirty: boolean; readonly fingerprint?: string},
): boolean {
  return left.dirty === right.dirty && (!left.dirty || left.fingerprint === right.fingerprint);
}

export function sameInventoryPaths(
  left: readonly CodeGraphInventoryFile[],
  right: readonly CodeGraphInventoryFile[],
): boolean {
  return left.length === right.length && left.every((file, index) => file.path === right[index]?.path);
}

export function codeGraphInventoryFileChanged(
  base: CodeGraphInventoryFile | undefined,
  current: CodeGraphInventoryFile,
  languagePacks: CodeGraphLanguagePackRegistryShape,
  changedPackIds: ReadonlySet<string>,
): boolean {
  return (
    !base ||
    base.contentHash !== current.contentHash ||
    base.language !== current.language ||
    base.mode !== current.mode ||
    base.size !== current.size ||
    base.source !== current.source ||
    Option.match(languagePacks.match(current.path), {
      onNone: () => false,
      onSome: match => changedPackIds.has(match.pack.id),
    })
  );
}

export function inventoryFilesForPaths(
  files: readonly CodeGraphInventoryFile[],
  paths: readonly string[],
): readonly CodeGraphInventoryFile[] | undefined {
  const selected: CodeGraphInventoryFile[] = [];
  let fileIndex = 0;
  for (const path of paths) {
    while (fileIndex < files.length && compareCodeUnits(files[fileIndex]!.path, path) < 0) fileIndex += 1;
    const file = files[fileIndex];
    if (!file || file.path !== path) return undefined;
    selected.push(file);
  }
  return selected;
}

export class WorktreeChangedDuringIndex extends Error {
  override readonly name = 'WorktreeChangedDuringIndex';

  constructor() {
    super('Worktree files changed during code graph indexing; retry the operation.');
  }
}

export class RepositoryRegistrationLost extends Error {
  override readonly name = 'RepositoryRegistrationLost';
}

export class RepositoryMaintenanceInterrupted extends Error {
  override readonly name = 'RepositoryMaintenanceInterrupted';

  constructor() {
    super('Code graph indexing was superseded by repair or purge; retry the operation.');
  }
}
