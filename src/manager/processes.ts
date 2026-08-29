import {Cause, Effect} from 'effect';
import {
  readManageableThreadnoteProcessDiagnostics,
  terminateThreadnoteProcess,
  ThreadnoteProcessTerminationError,
} from '../process/diagnostics.js';
import type {RuntimeConfig} from '../types.js';

export interface ManagerProcessApiResponse {
  readonly body: unknown;
  readonly status: number;
}

export interface ManagerProcessApiRequest {
  readonly body: Effect.Effect<Record<string, unknown>, unknown>;
  readonly config: RuntimeConfig;
  readonly method: string;
  readonly url: URL;
}

class ManagerProcessApiError extends Error {
  override readonly name = 'ManagerProcessApiError';

  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function isManagerProcessApiPath(pathname: string): boolean {
  return pathname === '/api/processes' || pathname.startsWith('/api/processes/');
}

export const handleManagerProcessRequest = Effect.fn('managerProcesses.handleRequest')(function* (
  request: ManagerProcessApiRequest,
) {
  if (!isManagerProcessApiPath(request.url.pathname)) return undefined;
  return yield* routeManagerProcessRequest(request).pipe(
    Effect.catchCause(cause => Effect.succeed(managerProcessErrorResponse(Cause.squash(cause)))),
  );
});

function routeManagerProcessRequest(request: ManagerProcessApiRequest) {
  return Effect.gen(function* () {
    if (request.method === 'GET' && request.url.pathname === '/api/processes') {
      return response(200, yield* readManageableThreadnoteProcessDiagnostics(request.config));
    }
    if (request.method !== 'POST' || request.url.pathname !== '/api/processes/terminate') {
      return response(404, {error: 'Not found'});
    }
    const body = yield* request.body.pipe(
      Effect.mapError(() => new ManagerProcessApiError('invalid-json', 'Provide a JSON object request body.', 400)),
    );
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new ManagerProcessApiError('invalid-json', 'Provide a JSON object request body.', 400);
    }
    if (body.confirm !== true) {
      throw new ManagerProcessApiError(
        'confirmation-required',
        'Confirm termination of the selected Threadnote process.',
        400,
      );
    }
    if (!Number.isSafeInteger(body.processId) || Number(body.processId) <= 0 || typeof body.processRef !== 'string') {
      throw new ManagerProcessApiError('invalid-process-target', 'The process target is invalid.', 400);
    }
    return response(
      200,
      yield* terminateThreadnoteProcess(request.config, {
        processId: Number(body.processId),
        processRef: body.processRef,
      }),
    );
  });
}

function managerProcessErrorResponse(error: unknown): ManagerProcessApiResponse {
  if (error instanceof ManagerProcessApiError) {
    return response(error.status, {code: error.code, error: error.message, retryAfterMilliseconds: 0});
  }
  if (error instanceof ThreadnoteProcessTerminationError) {
    const status =
      error.code === 'invalid-process-target'
        ? 400
        : error.code === 'process-permission-denied'
          ? 403
          : error.code === 'process-not-found'
            ? 404
            : error.code === 'process-signal-failed'
              ? 500
              : 409;
    return response(status, {code: error.code, error: error.message, retryAfterMilliseconds: 0});
  }
  return response(500, {
    code: 'process-operation-failed',
    error: 'The Threadnote process operation failed.',
    retryAfterMilliseconds: 0,
  });
}

function response(status: number, body: unknown): ManagerProcessApiResponse {
  return {body, status};
}
