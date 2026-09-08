import {Effect} from 'effect';
import {decodeJsonBytes} from './atomic.js';
import {readVerifiedCasBlob} from './cas.js';
import {graphSharingFailure} from './errors.js';
import {graphShareProfileDigest, parseGraphShareProfile} from './profile.js';
import {
  readGraphShareClientState,
  resolveGraphShareCasRoot,
  type GraphShareAccessMode,
  type GraphShareRepositoryClientV1,
  type GraphShareTrustReceiptV1,
} from './trust.js';

export const resolveGraphShareRepositoryClient = Effect.fn('codeGraph.sharing.resolveRepositoryClient')(function* (
  threadnoteHome: string,
  trust: GraphShareTrustReceiptV1,
) {
  if (trust.client !== undefined) return trust.client;
  const casRoot = yield* resolveGraphShareCasRoot(threadnoteHome);
  const value = yield* decodeJsonBytes(yield* readVerifiedCasBlob(casRoot, trust.profileDigest));
  const profile = yield* Effect.try({
    try: () => parseGraphShareProfile(value),
    catch: () => graphSharingFailure('The trusted repository profile is invalid.'),
  });
  if (
    graphShareProfileDigest(profile) !== trust.profileDigest ||
    profile.repositoryId !== trust.repositoryId ||
    profile.organization !== trust.organization ||
    profile.registry.canonical !== trust.registryCanonical ||
    !profile.trust.publisherKeys.includes(trust.publisherKeyFingerprint)
  ) {
    return yield* graphSharingFailure('The local repository profile does not match its trust receipt.');
  }
  const legacy = yield* readGraphShareClientState(threadnoteHome);
  return {
    casRoot,
    contributionMode: legacyGraphShareContributionMode(
      trust.accessMode,
      legacy.contributionMode,
      profile.contribution.defaultMode,
    ),
    ...(profile.coordinator === undefined ? {} : {coordinatorUrl: profile.coordinator.url}),
  } satisfies GraphShareRepositoryClientV1;
});

export function legacyGraphShareContributionMode(
  accessMode: GraphShareAccessMode,
  requested: GraphShareRepositoryClientV1['contributionMode'] | undefined,
  defaultMode: GraphShareRepositoryClientV1['contributionMode'],
): 'off' | 'passive' {
  return accessMode !== 'join' || requested === 'off' || defaultMode === 'off' ? 'off' : 'passive';
}
