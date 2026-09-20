import {Effect} from 'effect';
import {inventoryRepository, worktreeBuildRequestState, type CodeGraphInventory} from '../../inventory.js';
import {codeGraphScopeIdentityCompatible} from '../../scope/identity.js';
import {CodeGraphIndexOperationError, sameOverlayState, WorktreeChangedDuringIndex} from '../shared.js';
import {repositoryIdentityMatchesExpectation, resolveRepositoryIdentity} from '../../repository.js';
import type {RepositoryIdentity} from '../../types.js';

export const verifyIndexInput = Effect.fn('codeGraph.verifyIndexInput')(function* (
  identity: RepositoryIdentity,
  verifyOverlay: boolean,
  threadnoteHome: string,
  requestedOverlay?: {readonly dirty: boolean; readonly fingerprint?: string},
  scopeInventory?: Pick<
    CodeGraphInventory,
    'scope' | 'scopeProject' | 'scopeInventoryFingerprint' | 'scopeIncludeOpaqueCorpusAssets' | 'scopeIncludeOverlay'
  >,
) {
  const verifiedIdentity = yield* resolveRepositoryIdentity(identity.repoRoot);
  if (
    !repositoryIdentityMatchesExpectation(verifiedIdentity, identity) ||
    (verifyOverlay && verifiedIdentity.headCommit !== identity.headCommit)
  ) {
    return yield* WorktreeChangedDuringIndex.make({});
  }
  if (!verifyOverlay) return;
  if (!requestedOverlay) {
    return yield* CodeGraphIndexOperationError.make({
      message: 'Pointer activation requires an exact worktree build request state.',
    });
  }
  if (scopeInventory?.scopeProject !== undefined) {
    const observation = yield* inventoryRepository(verifiedIdentity, {
      project: scopeInventory.scopeProject,
      includeOpaqueCorpusAssets: scopeInventory.scopeIncludeOpaqueCorpusAssets,
      includeOverlay: scopeInventory.scopeIncludeOverlay,
      scopeObservationOnly: true,
    });
    if (
      !codeGraphScopeIdentityCompatible(scopeInventory.scope, observation.scope) ||
      observation.scopeInventoryFingerprint !== scopeInventory.scopeInventoryFingerprint
    ) {
      return yield* WorktreeChangedDuringIndex.make({});
    }
  }
  const verifiedOverlay = yield* worktreeBuildRequestState(verifiedIdentity, threadnoteHome, scopeInventory?.scope);
  if (!sameOverlayState(verifiedOverlay, requestedOverlay)) {
    return yield* WorktreeChangedDuringIndex.make({});
  }
});
