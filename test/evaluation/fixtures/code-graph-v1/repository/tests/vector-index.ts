import {VectorIndexCoordinator} from '@fixture/search';

export function vectorIndexContract(): string {
  return new VectorIndexCoordinator().activate();
}
