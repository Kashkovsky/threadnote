import {Effect, Option} from 'effect';
import type {CodeGraphLanguagePackRegistryShape} from './languages/registry.js';
import {
  resolveRepositoryIdentityForExpectation,
  resolveRepositoryIdentityForExpectationAndWorktree,
} from './repository.js';
import type {CodeGraphLanguagePackStatus, RepositoryIdentity, RepositoryIdentityExpectation} from './types.js';

export function repositoryIdentityObservation(identity: RepositoryIdentity) {
  return {identity, worktreeChanged: undefined as boolean | undefined};
}

export function resolvePublishedRepositoryIdentityObservation(
  cwd: string,
  expected: RepositoryIdentityExpectation,
  observeWorktree: boolean,
) {
  return observeWorktree
    ? resolveRepositoryIdentityForExpectationAndWorktree(cwd, expected).pipe(
        Effect.map(observation => ({
          ...observation,
          worktreeChanged: observation.worktreeChanged as boolean | undefined,
        })),
      )
    : resolveRepositoryIdentityForExpectation(cwd, expected).pipe(
        Effect.map(identity => repositoryIdentityObservation(identity)),
      );
}

export function codeGraphLanguagePackStatuses(
  registry: CodeGraphLanguagePackRegistryShape,
): readonly CodeGraphLanguagePackStatus[] {
  return registry.packs.map(pack => ({
    assetCount: pack.assets.length,
    capabilities: [...pack.capabilities].sort(),
    extractorVersion: pack.extractor.version,
    id: pack.id,
    languages: [...new Set(pack.files.map(matcher => matcher.language))].sort(),
    resolutionDomain: pack.resolutionStrategy.domain,
    resolutionVersion: pack.resolutionStrategy.version,
    roles: [...new Set(pack.files.map(matcher => matcher.role))].sort(),
    version: pack.version,
    workspaceDetection: Option.isSome(pack.workspaceDetector),
  }));
}
