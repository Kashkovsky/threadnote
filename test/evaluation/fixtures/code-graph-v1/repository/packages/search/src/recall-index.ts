import {withExclusiveFileLock} from '@fixture/core';

export function refreshRecallIndex(): string {
  return withExclusiveFileLock(() => 'recall-ready');
}
