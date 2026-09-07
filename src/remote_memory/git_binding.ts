import {remoteMemoryError} from './errors.js';

export interface GitMemoryBinding {
  readonly tenantId: string;
  readonly shareId: string;
}

export function requireGitMemoryBinding(binding: GitMemoryBinding | undefined): GitMemoryBinding {
  if (
    !binding ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(binding.tenantId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(binding.shareId)
  ) {
    throw remoteMemoryError('invalid_request', 'Git memory requires an explicit tenant/share binding.');
  }
  return Object.freeze({tenantId: binding.tenantId, shareId: binding.shareId});
}

export function assertGitMemoryBinding(binding: GitMemoryBinding | undefined, scope: GitMemoryBinding): void {
  if (binding && (binding.tenantId !== scope.tenantId || binding.shareId !== scope.shareId)) {
    throw remoteMemoryError('forbidden', 'The memory share is outside this Git deployment binding.');
  }
}
