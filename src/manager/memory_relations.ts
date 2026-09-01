import {Data, Effect} from 'effect';
import {assertMemoryDocumentSchemaWritable, type MemoryRelation} from '../memory/document.js';
import {isMemoryId} from '../memory/identity_alias.js';
import {
  MemoryRelationWriteError,
  normalizeMemoryRelationInputs,
  resolveAuthoredMemoryRelations,
} from '../memory/relations.js';
import {readMemoryRecordsByUri} from '../memory/index.js';
import {writeDurableMemory} from '../mcp/server/memory.js';
import {MemoryIdentityResolutionError} from '../recall/memory_identity.js';
import {sharedTeamNameForUri} from '../share/index.js';
import {parseResourceId, resourceIdIsWithin} from '../storage/resource-id.js';
import {readAnonymousTelemetryDiagnostic} from '../telemetry/diagnostic.js';
import {uriSegment} from '../manifest.js';
import type {RuntimeConfig} from '../types.js';
import {MemoryPointerNotFound} from '../memory/relocation.js';

export class ManagerMemoryRelationsError extends Data.TaggedError('ManagerMemoryRelationsError')<{
  readonly code:
    | 'memory-relations-conflict'
    | 'memory-relations-forbidden'
    | 'memory-relations-invalid'
    | 'memory-relations-not-found'
    | 'memory-relations-operation-failed'
    | 'memory-relations-verification-failed';
  readonly message: string;
  readonly status: 400 | 403 | 404 | 409 | 500;
}> {}

export interface ManagerMemoryRelationsResponse {
  readonly content: string;
  readonly memoryId: string;
  readonly relations: readonly MemoryRelation[];
  readonly uri: string;
}

interface ManagerMemoryRelationsInput {
  readonly expectedContent: string;
  readonly relations: readonly {readonly type: string; readonly uri: string}[];
  readonly uri: string;
}

/** Structured, CAS-protected relation replacement for Manager's memory editor. */
export const updateManagerMemoryRelations = Effect.fn('manager.updateMemoryRelations')(function* (
  config: RuntimeConfig,
  body: Record<string, unknown>,
) {
  const input = yield* Effect.try({
    catch: cause =>
      cause instanceof ManagerMemoryRelationsError
        ? cause
        : relationError(cause instanceof Error ? cause.message : 'Invalid relation editor input.'),
    try: () => parseManagerMemoryRelationsInput(body),
  });
  const canonicalUri = yield* Effect.try({
    catch: cause => relationError(cause instanceof Error ? cause.message : 'Invalid source memory URI.'),
    try: () => parseResourceId(input.uri).canonicalUri,
  });
  const memoryRoot = `threadnote://user/${uriSegment(config.user)}/memories`;
  if (!resourceIdIsWithin(canonicalUri, memoryRoot)) {
    return yield* Effect.fail(
      relationError(
        'Manager can only edit relations on the current user memory corpus.',
        403,
        'memory-relations-forbidden',
      ),
    );
  }
  const sharedTeam = sharedTeamNameForUri(config, canonicalUri);
  const allowedUriScopes = [sharedTeam ? `${memoryRoot}/shared/${uriSegment(sharedTeam)}` : memoryRoot];
  const [source] = yield* readMemoryRecordsByUri(config, [canonicalUri]).pipe(
    Effect.mapError(() => relationOperationError()),
  );
  if (!source)
    return yield* Effect.fail(
      relationError('The memory no longer exists. Reload and retry.', 404, 'memory-relations-not-found'),
    );
  if (source.content !== input.expectedContent) {
    return yield* Effect.fail(
      relationError('The memory changed after it was opened. Reload and retry.', 409, 'memory-relations-conflict'),
    );
  }
  yield* Effect.try({
    catch: cause =>
      relationError(
        cause instanceof Error ? cause.message : 'The memory schema is not writable.',
        409,
        'memory-relations-conflict',
      ),
    try: () => assertMemoryDocumentSchemaWritable(source.content),
  });
  const sourceMemoryId = source.metadata.memoryId;
  if (!isMemoryId(sourceMemoryId ?? '')) {
    return yield* Effect.fail(
      relationError('Structured relations require an identity-bearing memory.', 409, 'memory-relations-conflict'),
    );
  }
  const checkedSourceMemoryId = sourceMemoryId!;
  const resolved = yield* resolveAuthoredMemoryRelations(config, input.relations, {
    allowedUriScopes,
    sourceMemoryId: checkedSourceMemoryId,
  }).pipe(Effect.mapError(relationResolutionError));
  const writeResult = yield* writeDurableMemory(config, {
    bodyText: source.body,
    expectedReplaceContent: input.expectedContent,
    expectedSourceContent: resolved.targets,
    metadata: {...source.metadata, relations: resolved.relations},
    operation: 'replace',
    replaceUri: canonicalUri,
  });
  if (writeResult.isError) {
    const argumentFailure = readAnonymousTelemetryDiagnostic(writeResult)?.errorType === 'McpArgumentError';
    return yield* Effect.fail(
      argumentFailure
        ? relationError(toolErrorMessage(writeResult.content), 409, 'memory-relations-conflict')
        : relationOperationError(),
    );
  }
  const [stored] = yield* readMemoryRecordsByUri(config, [canonicalUri]).pipe(
    Effect.mapError(() => relationOperationError()),
  );
  if (!stored || stored.metadata.memoryId !== checkedSourceMemoryId) {
    return yield* Effect.fail(
      relationError(
        'The relation update could not be verified. Reload the memory.',
        500,
        'memory-relations-verification-failed',
      ),
    );
  }
  return {
    content: stored.content,
    memoryId: checkedSourceMemoryId,
    relations: stored.metadata.relations ?? [],
    uri: stored.uri,
  } satisfies ManagerMemoryRelationsResponse;
});

export function parseManagerMemoryRelationsInput(body: Record<string, unknown>): ManagerMemoryRelationsInput {
  const unsupported = Object.keys(body).filter(key => !new Set(['expectedContent', 'relations', 'uri']).has(key));
  if (unsupported.length > 0) throw relationError(`Unsupported relation editor field: ${unsupported.sort()[0]}.`);
  if (typeof body.uri !== 'string' || !body.uri.trim()) throw relationError('uri is required.');
  if (typeof body.expectedContent !== 'string' || !body.expectedContent) {
    throw relationError('expectedContent is required for relation updates.');
  }
  if (!Array.isArray(body.relations)) throw relationError('relations must be an array.');
  const relations = body.relations.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw relationError(`relations[${index}] must contain type and uri.`);
    }
    const relation = value as Record<string, unknown>;
    if (
      Object.keys(relation).some(key => key !== 'type' && key !== 'uri') ||
      typeof relation.type !== 'string' ||
      typeof relation.uri !== 'string'
    ) {
      throw relationError(`relations[${index}] must contain only text type and uri fields.`);
    }
    return {type: relation.type, uri: relation.uri};
  });
  let normalized: readonly {readonly type: MemoryRelation['type']; readonly uri: string}[];
  try {
    normalized = normalizeMemoryRelationInputs(relations);
  } catch (cause) {
    throw relationError(cause instanceof Error ? cause.message : 'Invalid memory relations.');
  }
  return {expectedContent: body.expectedContent, relations: normalized, uri: body.uri};
}

function relationError(
  message: string,
  status: ManagerMemoryRelationsError['status'] = 400,
  code: ManagerMemoryRelationsError['code'] = 'memory-relations-invalid',
): ManagerMemoryRelationsError {
  return new ManagerMemoryRelationsError({code, message, status});
}

function relationOperationError(): ManagerMemoryRelationsError {
  return relationError(
    'Threadnote could not update the memory relations. Reload and retry.',
    500,
    'memory-relations-operation-failed',
  );
}

function relationResolutionError(cause: unknown): ManagerMemoryRelationsError {
  if (cause instanceof MemoryRelationWriteError || cause instanceof MemoryPointerNotFound) {
    return relationError(cause.message);
  }
  if (cause instanceof MemoryIdentityResolutionError) {
    return cause.reason === 'ambiguous' || cause.reason === 'live-mismatch'
      ? relationError(cause.message, 409, 'memory-relations-conflict')
      : relationError(cause.message);
  }
  return relationOperationError();
}

function toolErrorMessage(content: readonly unknown[]): string {
  const text = content.find(
    item => item && typeof item === 'object' && 'text' in item && typeof item.text === 'string',
  ) as {readonly text?: string} | undefined;
  return text?.text ?? 'Threadnote could not update the memory relations.';
}
