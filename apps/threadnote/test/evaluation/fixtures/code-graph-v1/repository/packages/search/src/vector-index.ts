import {FileLock, withExclusiveFileLock} from '@fixture/core';

export class VectorIndexCoordinator extends FileLock {
  activate(): string {
    return ensureVectorIndex();
  }
}

export function ensureVectorIndex(): string {
  return withExclusiveFileLock(() => 'vectors-ready');
}
