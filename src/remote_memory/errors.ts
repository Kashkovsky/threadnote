export type RemoteMemoryErrorCode =
  | 'attestation_required'
  | 'conflict'
  | 'forbidden'
  | 'idempotency_mismatch'
  | 'invalid_request'
  | 'not_found'
  | 'rate_limited'
  | 'service_unavailable'
  | 'unauthorized';

export class RemoteMemoryError extends Error {
  readonly name = 'RemoteMemoryError';

  constructor(
    readonly code: RemoteMemoryErrorCode,
    message: string,
    readonly status: number,
    readonly details: Readonly<Record<string, boolean | number | string>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function remoteMemoryError(
  code: RemoteMemoryErrorCode,
  message: string,
  details: Readonly<Record<string, boolean | number | string>> = {},
): RemoteMemoryError {
  return new RemoteMemoryError(code, message, statusForCode(code), details);
}

export function publicRemoteMemoryError(cause: unknown): RemoteMemoryError {
  if (cause instanceof RemoteMemoryError) return cause;
  return remoteMemoryError('service_unavailable', 'Remote memory could not complete the request.');
}

function statusForCode(code: RemoteMemoryErrorCode): number {
  switch (code) {
    case 'unauthorized':
      return 401;
    case 'attestation_required':
    case 'forbidden':
      return 403;
    case 'not_found':
      return 404;
    case 'conflict':
    case 'idempotency_mismatch':
      return 409;
    case 'invalid_request':
      return 400;
    case 'rate_limited':
      return 429;
    case 'service_unavailable':
      return 503;
  }
}
