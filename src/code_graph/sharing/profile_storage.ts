import {Effect} from 'effect';
import {decodeJsonBytes} from './atomic.js';
import {readVerifiedCasBlob, readVerifiedCasBlobBounded} from './cas.js';
import {graphSharingFailure} from './errors.js';
import {
  assertProfileMatchesEnrollment,
  enrolledProfileBodyDigest,
  graphShareProfileDigest,
  parseGraphShareProfile,
  parseGraphShareProfilePointer,
  type GraphShareEnrollment,
  type GraphShareProfileV1,
} from './profile.js';
import {
  GRAPH_SHARE_PROFILE_OCI_BODY_MAX_BYTES,
  GRAPH_SHARE_PROFILE_OCI_MANIFEST_MAX_BYTES,
  parseGraphShareProfileOciArtifact,
} from './profile_oci_artifact.js';
import type {GraphShareTrustReceiptV1} from './trust.js';

export const readTrustedGraphShareContributionProfile = Effect.fn('codeGraph.sharing.readContributionProfile')(
  function* (trust: GraphShareTrustReceiptV1, casRoot: string) {
    const value = yield* decodeJsonBytes(yield* readVerifiedCasBlobBounded(casRoot, trust.profileDigest, 65_536));
    const profile = yield* Effect.try({
      try: () => parseGraphShareProfile(value),
      catch: () => graphSharingFailure('Trusted graph contribution profile is invalid.'),
    });
    if (
      graphShareProfileDigest(profile) !== trust.profileDigest ||
      profile.repositoryId !== trust.repositoryId ||
      profile.organization !== trust.organization ||
      profile.registry.canonical !== trust.registryCanonical ||
      !profile.trust.publisherKeys.includes(trust.publisherKeyFingerprint)
    )
      return yield* graphSharingFailure('Trusted graph contribution profile is outside its trust receipt.');
    return profile;
  },
);

export const readGraphShareEnrolledProfile = Effect.fn('codeGraph.sharing.readEnrolledProfile')(function* (
  casRoot: string,
  enrollment: GraphShareEnrollment,
) {
  const pointer = parseGraphShareProfilePointer(enrollment.profile);
  const bodyDigest = enrolledProfileBodyDigest(enrollment);
  let profile: GraphShareProfileV1;
  if (pointer.kind === 'cas') {
    const body = yield* readVerifiedCasBlob(casRoot, bodyDigest);
    const value = yield* decodeJsonBytes(body);
    profile = yield* Effect.try({
      try: () => parseGraphShareProfile(value),
      catch: () => graphSharingFailure('Persisted graph profile is invalid.'),
    });
  } else {
    const body = yield* readVerifiedCasBlobBounded(casRoot, bodyDigest, GRAPH_SHARE_PROFILE_OCI_BODY_MAX_BYTES);
    const manifest = yield* readVerifiedCasBlobBounded(
      casRoot,
      pointer.manifestDigest,
      GRAPH_SHARE_PROFILE_OCI_MANIFEST_MAX_BYTES,
    );
    profile = yield* Effect.try({
      try: () => parseGraphShareProfileOciArtifact(manifest, pointer.manifestDigest, body),
      catch: () => graphSharingFailure('Persisted OCI graph profile artifact is invalid.'),
    });
  }
  if (pointer.kind === 'oci' && pointer.registryReference !== profile.registry.canonical)
    return yield* graphSharingFailure(
      'OCI enrollment namespace differs from the persisted canonical profile registry.',
    );
  yield* Effect.try({
    try: () => assertProfileMatchesEnrollment(profile, enrollment, graphShareProfileDigest(profile)),
    catch: () => graphSharingFailure('Persisted graph profile does not match enrollment.'),
  });
  return profile;
});
