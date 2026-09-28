import type {Path} from 'effect';
import {validatePortableSegment} from '@threadnote/store/resource-id';

export function resourceAccountMutationLockPath(path: Path.Path, home: string, account: string): string {
  validatePortableSegment(account, account);
  return path.join(home, 'locks', 'resources', account, 'mutations.lock');
}

export function resourceAccountMutationGenerationPath(path: Path.Path, home: string, account: string): string {
  validatePortableSegment(account, account);
  return path.join(home, 'locks', 'resources', account, 'canonical-generation-v1');
}
