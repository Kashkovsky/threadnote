import {Data, Effect} from 'effect';
import {assertMemoryDocumentSchemaWritable, type MemoryRelation} from '../memory/document.js';
import {isMemoryId} from '../memory/identity_alias.js';
import {normalizeMemoryRelationInputs, resolveAuthoredMemoryRelations} from '../memory/relations.js';
import {readMemoryRecordsByUri} from '../memory/index.js';
import {writeDurableMemory} from '../mcp/server/memory.js';
import {sharedTeamNameForUri} from '../share/index.js';
import {parseResourceId, resourceIdIsWithin} from '../storage/resource-id.js';
import {uriSegment} from '../manifest.js';
import type {RuntimeConfig} from '../types.js';

export class ManagerMemoryRelationsError extends Data.TaggedError('ManagerMemoryRelationsError')<{
  readonly message: string;
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
  const input = parseManagerMemoryRelationsInput(body);
  const canonicalUri = parseResourceId(input.uri).canonicalUri;
  const memoryRoot = `threadnote://user/${uriSegment(config.user)}/memories`;
  if (!resourceIdIsWithin(canonicalUri, memoryRoot)) {
    return yield* Effect.fail(relationError('Manager can only edit relations on the current user memory corpus.'));
  }
  const sharedTeam = sharedTeamNameForUri(config, canonicalUri);
  const allowedUriScopes = [sharedTeam ? `${memoryRoot}/shared/${uriSegment(sharedTeam)}` : memoryRoot];
  const [source] = yield* readMemoryRecordsByUri(config, [canonicalUri]);
  if (!source) return yield* Effect.fail(relationError('The memory no longer exists. Reload and retry.'));
  if (source.content !== input.expectedContent) {
    return yield* Effect.fail(relationError('The memory changed after it was opened. Reload and retry.'));
  }
  yield* Effect.try({
    catch: cause => relationError(cause instanceof Error ? cause.message : 'The memory schema is not writable.'),
    try: () => assertMemoryDocumentSchemaWritable(source.content),
  });
  const sourceMemoryId = source.metadata.memoryId;
  if (!isMemoryId(sourceMemoryId ?? '')) {
    return yield* Effect.fail(relationError('Structured relations require an identity-bearing memory.'));
  }
  const checkedSourceMemoryId = sourceMemoryId!;
  const resolved = yield* resolveAuthoredMemoryRelations(config, input.relations, {
    allowedUriScopes,
    sourceMemoryId: checkedSourceMemoryId,
  }).pipe(Effect.mapError(cause => relationError(cause instanceof Error ? cause.message : String(cause))));
  const writeResult = yield* writeDurableMemory(config, {
    bodyText: source.body,
    expectedReplaceContent: input.expectedContent,
    expectedSourceContent: resolved.targets,
    metadata: {...source.metadata, relations: resolved.relations},
    operation: 'replace',
    replaceUri: canonicalUri,
  });
  if (writeResult.isError) {
    return yield* Effect.fail(relationError(toolErrorMessage(writeResult.content)));
  }
  const [stored] = yield* readMemoryRecordsByUri(config, [canonicalUri]);
  if (!stored || stored.metadata.memoryId !== checkedSourceMemoryId) {
    return yield* Effect.fail(relationError('The relation update could not be verified. Reload the memory.'));
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
  const normalized = normalizeMemoryRelationInputs(relations);
  return {expectedContent: body.expectedContent, relations: normalized, uri: body.uri};
}

function relationError(message: string): ManagerMemoryRelationsError {
  return new ManagerMemoryRelationsError({message});
}

function toolErrorMessage(content: readonly unknown[]): string {
  const text = content.find(
    item => item && typeof item === 'object' && 'text' in item && typeof item.text === 'string',
  ) as {readonly text?: string} | undefined;
  return text?.text ?? 'Threadnote could not update the memory relations.';
}
