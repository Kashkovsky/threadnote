import {Effect, Schema} from 'effect';
import {parseMemoryDocument} from '../memory/document.js';
import {isMemoryId, memoryIdFromIdentityAlias} from '../memory/identity_alias.js';
import {resourceIdIsWithin} from '../storage/resource-id.js';
import {loadRecallMemoryIdentities} from './index.js';

interface MemoryIdentityRuntime {
  readonly account: string;
  readonly agentContextHome: string;
  readonly manifestPath?: string;
  readonly user: string;
}

export class MemoryIdentityResolutionError extends Schema.TaggedError<MemoryIdentityResolutionError>()(
  'MemoryIdentityResolutionError',
  {
    message: Schema.String,
    memoryId: Schema.String,
    reason: Schema.Literals(['ambiguous', 'live-mismatch', 'not-found', 'scope-required']),
  },
) {}

export interface ResolvedMemoryIdentityAlias {
  readonly canonicalUri: string;
  readonly expectedMemoryId?: string;
  readonly requestedUri: string;
}

interface MemoryIdentityCandidate {
  readonly identityConflict?: boolean;
  readonly memoryId?: string;
  readonly status?: string;
  readonly uri: string;
}

export type MemoryIdentityCandidateResolution =
  {readonly state: 'ambiguous'} | {readonly state: 'not-found'} | {readonly state: 'resolved'; readonly uri: string};

/** Shared pure classifier keeps Context Brief alias emission and later reads on the same authorization contract. */
export function classifyMemoryIdentityCandidates(
  candidates: readonly MemoryIdentityCandidate[],
  memoryId: string,
  allowedUriScopes: readonly string[],
): MemoryIdentityCandidateResolution {
  if (allowedUriScopes.length === 0) return {state: 'not-found'};
  const matches = candidates.filter(
    candidate =>
      candidate.memoryId === memoryId && allowedUriScopes.some(scope => resourceIdIsWithin(candidate.uri, scope)),
  );
  const activeMatches = matches.filter(candidate => candidate.status === 'active');
  const identityConflict = matches.some(candidate => candidate.identityConflict === true);
  if (activeMatches.length === 1 && !identityConflict) return {state: 'resolved', uri: activeMatches[0]!.uri};
  return activeMatches.length === 0 && !identityConflict ? {state: 'not-found'} : {state: 'ambiguous'};
}

/** Resolve only inside the caller-authorized recall corpus; conflicts and missing IDs fail closed. */
export const resolveMemoryIdentityAliases = Effect.fn('recall.resolveMemoryIdentityAliases')(function* (
  config: MemoryIdentityRuntime,
  inputs: readonly string[],
  allowedUriScopes: readonly string[],
  options: {readonly validateNow?: boolean} = {},
) {
  const memoryIds = [...new Set(inputs.flatMap(input => memoryIdFromIdentityAlias(input) ?? []).filter(isMemoryId))];
  if (memoryIds.length === 0) {
    return inputs.map(input => ({canonicalUri: input, expectedMemoryId: undefined, requestedUri: input}));
  }
  if (allowedUriScopes.length === 0) {
    return yield* Effect.fail(
      new MemoryIdentityResolutionError({
        memoryId: memoryIds[0]!,
        message: 'Stable memory identity resolution requires an explicit non-empty authorized URI scope.',
        reason: 'scope-required',
      }),
    );
  }
  const candidates = yield* loadRecallMemoryIdentities(config, {
    allowedUriScopes,
    memoryIds,
    validateNow: options.validateNow,
  });

  const resolved: ResolvedMemoryIdentityAlias[] = [];
  for (const input of inputs) {
    const memoryId = memoryIdFromIdentityAlias(input);
    if (memoryId === undefined) {
      resolved.push({canonicalUri: input, expectedMemoryId: undefined, requestedUri: input});
      continue;
    }
    const candidate = classifyMemoryIdentityCandidates(candidates, memoryId, allowedUriScopes);
    if (candidate.state !== 'resolved') {
      const reason = candidate.state;
      return yield* Effect.fail(
        new MemoryIdentityResolutionError({
          memoryId,
          message:
            reason === 'not-found'
              ? 'Stable memory identity does not resolve inside the authorized active corpus.'
              : 'Stable memory identity is ambiguous or conflicted inside the authorized corpus.',
          reason,
        }),
      );
    }
    resolved.push({canonicalUri: candidate.uri, expectedMemoryId: memoryId, requestedUri: input});
  }
  return resolved;
});

/** Re-check live bytes after index resolution so stale indexes or URI reuse cannot cross identities. */
export const verifyResolvedMemoryIdentity = Effect.fn('recall.verifyResolvedMemoryIdentity')(function* (
  resolved: ResolvedMemoryIdentityAlias,
  canonicalUri: string,
  content: string,
) {
  if (resolved.expectedMemoryId === undefined) return;
  const observedMemoryId = parseMemoryDocument(canonicalUri, content)?.metadata.memoryId;
  if (observedMemoryId !== resolved.expectedMemoryId) {
    return yield* Effect.fail(
      new MemoryIdentityResolutionError({
        memoryId: resolved.expectedMemoryId,
        message: 'Stable memory identity no longer matches the live memory bytes; refresh recall and retry.',
        reason: 'live-mismatch',
      }),
    );
  }
});
