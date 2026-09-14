import {Effect, FileSystem, Option} from 'effect';
import {casBlobPath, putCasBytes, readVerifiedCasBlobBounded} from './cas.js';
import {graphSharingFailure} from './errors.js';
import {
  assertProfileMatchesEnrollment,
  enrolledProfileBodyDigest,
  parseGraphShareProfilePointer,
  type GraphShareEnrollment,
} from './profile.js';
import {
  GRAPH_SHARE_PROFILE_OCI_BODY_MAX_BYTES,
  GRAPH_SHARE_PROFILE_OCI_MANIFEST_MAX_BYTES,
  parseGraphShareProfileOciArtifact,
} from './profile_oci_artifact.js';
import {makeGraphShareRegistryReader} from './registry_reader.js';
import type {GraphShareTrustReceiptV1} from './trust.js';

/** Existing local trust is the authority for OCI reads during a v1-to-v2 migration. */
export const readTrustedGraphShareOciProfile = Effect.fn('codeGraph.sharing.readTrustedOciProfile')(function* (
  casRoot: string,
  enrollment: GraphShareEnrollment,
  trust: GraphShareTrustReceiptV1,
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
  if (Option.isNone(cachedManifest) || Option.isNone(cachedBody)) {
    yield* putCasBytes(casRoot, manifest);
    yield* putCasBytes(casRoot, body);
  }
  return profile;
});
