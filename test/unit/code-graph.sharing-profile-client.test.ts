import {expect, it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {graphRegistryFixture} from '../helpers/graph-registry.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {putCasBytes, readVerifiedCasBlob} from '../../src/code_graph/sharing/cas.js';
import {sha256Digest} from '../../src/code_graph/sharing/digest.js';
import {graphSharingCasBlobPath} from '../../src/code_graph/sharing/layout.js';
import {readTrustedGraphShareOciProfile} from '../../src/code_graph/sharing/profile/client.js';
import {graphShareProfileOciArtifact} from '../../src/code_graph/sharing/profile/oci_artifact.js';
import {defaultGraphShareProfile, ociProfilePointer} from '../../src/code_graph/sharing/profile.js';
import {trustReceiptFromEnrollment} from '../../src/code_graph/sharing/trust.js';

const canonicalRegistry = 'oci://registry.example.test/acme/canonical';

effectIt.effect('imports a v2 OCI profile only through existing exact authority and reuses verified local CAS', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cas = yield* fs.makeTempDirectoryScoped({prefix: 'graph-profile-client-'});
    const registry = yield* graphRegistryFixture();
    const profile = {
      ...defaultGraphShareProfile({
        branch: 'refs/heads/main',
        canonicalRemote: 'github.com/acme/example',
        organization: 'acme',
        publisherKeyFingerprint: sha256Digest('publisher'),
        repositoryId: 'a'.repeat(64),
      }),
      registry: {canonical: canonicalRegistry, worker: 'oci://registry.example.test/acme/worker'},
    };
    const artifact = graphShareProfileOciArtifact(profile);
    const enrollment = {
      profile: ociProfilePointer(canonicalRegistry, artifact.manifestDigest),
      profileDigest: artifact.profileDigest,
      publisherKeyFingerprint: profile.trust.publisherKeys[0],
      repositoryId: profile.repositoryId,
      schemaVersion: 2 as const,
    };
    const trust = trustReceiptFromEnrollment(enrollment, profile, artifact.profileDigest, 'read-only');
    registry.manifests.set(artifact.manifestDigest, artifact.manifestBytes);
    registry.blobs.set(artifact.profileDigest, artifact.profileBytes);

    for (const wrong of [
      {...trust, registryCanonical: 'oci://other.example.test/acme/canonical'},
      {...trust, publisherKeyFingerprint: sha256Digest('other')},
      {...trust, profileDigest: sha256Digest('other')},
    ]) {
      expect(
        (yield* Effect.result(registry.provide(readTrustedGraphShareOciProfile(cas, enrollment, wrong))))._tag,
      ).toBe('Failure');
    }
    expect(registry.requests).toHaveLength(0);

    expect(yield* registry.provide(readTrustedGraphShareOciProfile(cas, enrollment, trust))).toEqual(profile);
    expect(registry.requests.map(request => request.pathname)).toEqual([
      `/v2/acme/canonical/manifests/${artifact.manifestDigest}`,
      `/v2/acme/canonical/blobs/${artifact.profileDigest}`,
    ]);
    expect(Uint8Array.from(yield* readVerifiedCasBlob(cas, artifact.manifestDigest))).toEqual(artifact.manifestBytes);
    expect(Uint8Array.from(yield* readVerifiedCasBlob(cas, artifact.profileDigest))).toEqual(artifact.profileBytes);

    registry.state.outage = true;
    expect(yield* registry.provide(readTrustedGraphShareOciProfile(cas, enrollment, trust))).toEqual(profile);
    expect(registry.requests).toHaveLength(2);

    const bodyPath = graphSharingCasBlobPath(path, cas, artifact.profileDigest.slice('sha256:'.length));
    yield* fs.writeFileString(bodyPath, '{}');
    expect((yield* Effect.result(registry.provide(readTrustedGraphShareOciProfile(cas, enrollment, trust))))._tag).toBe(
      'Failure',
    );
    expect(registry.requests).toHaveLength(2);
    yield* fs.remove(bodyPath);
    registry.state.outage = false;
    expect(yield* registry.provide(readTrustedGraphShareOciProfile(cas, enrollment, trust))).toEqual(profile);
    expect(registry.requests).toHaveLength(4);
    expect(yield* putCasBytes(cas, artifact.profileBytes)).toBe(artifact.profileDigest);
  }).pipe(provideTestLayer(ApplicationLayer)),
);
