import {Effect, FileSystem, Option} from 'effect';
import {casBlobPath, putCasBytes, readVerifiedCasBlobBounded} from '../cas.js';
import {graphSharingFailure} from '../errors.js';
import type {Sha256Digest} from '../digest.js';
import {
  assertProfileMatchesEnrollment,
  enrolledProfileBodyDigest,
  parseGraphShareProfilePointer,
  type GraphShareEnrollment,
} from '../profile.js';
import {
  GRAPH_SHARE_PROFILE_OCI_BODY_MAX_BYTES,
  GRAPH_SHARE_PROFILE_OCI_MANIFEST_MAX_BYTES,
  parseGraphShareProfileOciArtifact,
} from './oci_artifact.js';
import {makeGraphShareRegistryReader} from '../registry/reader.js';
import type {GraphShareTrustReceiptV1} from '../trust.js';

export interface GraphShareOciProfileTrustRoot {
  readonly profileDigest: Sha256Digest;
  readonly publisherKeyFingerprint: Sha256Digest;
  readonly registryCanonical: string;
  readonly repositoryId: string;
}

/** Verify against an independently approved root without writing CAS or a trust receipt. */
export const fetchGraphShareOciProfile = Effect.fn('codeGraph.sharing.fetchOciProfile')(function* (
  casRoot: string,
  enrollment: GraphShareEnrollment,
  trust: GraphShareOciProfileTrustRoot,
) {
  const pointer = parseGraphShareProfilePointer(enrollment.profile);
  if (pointer.kind !== 'oci') return yield* graphSharingFailure('Enrollment is not an OCI profile pointer.');
  const bodyDigest = enrolledProfileBodyDigest(enrollment);
  if (
    trust.repositoryId !== enrollment.repositoryId ||
    trust.profileDigest !== bodyDigest ||
    trust.publisherKeyFingerprint !== enrollment.publisherKeyFingerprint ||
    trust.registryCanonical !== pointer.registryReference
  )
    return yield* graphSharingFailure('OCI profile pointer differs from existing trusted authority.');

  const fs = yield* FileSystem.FileSystem;
  const cachedManifest = (yield* fs.exists(yield* casBlobPath(casRoot, pointer.manifestDigest)))
    ? Option.some(
        yield* readVerifiedCasBlobBounded(casRoot, pointer.manifestDigest, GRAPH_SHARE_PROFILE_OCI_MANIFEST_MAX_BYTES),
      )
    : Option.none<Uint8Array>();
  const cachedBody = (yield* fs.exists(yield* casBlobPath(casRoot, bodyDigest)))
    ? Option.some(yield* readVerifiedCasBlobBounded(casRoot, bodyDigest, GRAPH_SHARE_PROFILE_OCI_BODY_MAX_BYTES))
    : Option.none<Uint8Array>();
  let manifest: Uint8Array;
  let body: Uint8Array;
  if (Option.isSome(cachedManifest) && Option.isSome(cachedBody)) {
    manifest = cachedManifest.value;
    body = cachedBody.value;
  } else {
    const reader = yield* makeGraphShareRegistryReader(pointer.registryReference);
    manifest = yield* reader.readProfileManifest(pointer.manifestDigest);
    body = yield* reader.readProfileBlob(bodyDigest);
  }
  const profile = yield* Effect.try({
    try: () => parseGraphShareProfileOciArtifact(manifest, pointer.manifestDigest, body),
    catch: () => graphSharingFailure('OCI graph profile artifact is invalid.'),
  });
  if (profile.registry.canonical !== pointer.registryReference)
    return yield* graphSharingFailure('OCI profile canonical namespace differs from trusted registry.');
  yield* Effect.try({
    try: () => assertProfileMatchesEnrollment(profile, enrollment, bodyDigest),
    catch: () => graphSharingFailure('OCI graph profile does not match enrollment.'),
  });
  return {body, fromCache: Option.isSome(cachedManifest) && Option.isSome(cachedBody), manifest, profile};
});

/** Existing local trust is the authority for OCI reads during a v1-to-v2 migration. */
export const readTrustedGraphShareOciProfile = Effect.fn('codeGraph.sharing.readTrustedOciProfile')(function* (
  casRoot: string,
  enrollment: GraphShareEnrollment,
  trust: GraphShareTrustReceiptV1,
) {
  const fetched = yield* fetchGraphShareOciProfile(casRoot, enrollment, trust);
  if (!fetched.fromCache) {
    yield* putCasBytes(casRoot, fetched.manifest);
    yield* putCasBytes(casRoot, fetched.body);
  }
  return fetched.profile;
});
