import {ensureVectorIndex, refreshRecallIndex} from '@fixture/search';

export function runApplication(): readonly string[] {
  return [ensureVectorIndex(), refreshRecallIndex()];
}
