import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Clock, Effect, FileSystem, Layer, Ref} from 'effect';
import * as FC from 'effect/testing/FastCheck';
import {SystemInfo} from '../../src/effect/system.js';
import {canonicalJson} from '../../src/code_graph/checkpoint/canonical_json.js';
import {graphShareParseActionKey} from '../../src/code_graph/sharing/action.js';
import {GRAPH_SHARE_OCI_EMPTY_CONFIG_DIGEST} from '../../src/code_graph/sharing/descriptor.js';
import {sha256Digest} from '../../src/code_graph/sharing/digest.js';
import {graphSharingUnavailable} from '../../src/code_graph/sharing/errors.js';
import {graphShareParseResultArtifact} from '../../src/code_graph/sharing/parse_result.js';
import {defaultGraphShareProfile, graphShareProfileDigest} from '../../src/code_graph/sharing/profile.js';
import {createGraphWorkerResultArtifact} from '../../src/code_graph/sharing/worker_result.js';
import {
  graphWorkerRegistryForProfile,
  uploadGraphWorkerArtifactClosure,
} from '../../src/code_graph/sharing/worker_registry_upload.js';
import {makeGraphWorkerSigner} from '../../src/code_graph/sharing/worker_signing.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const layer = SystemInfo.layer.pipe(Layer.provideMerge(BunServices.layer));

const fixture = Effect.fn('test.workerRegistryUpload.fixture')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'graph-worker-upload-'});
  const signer = yield* makeGraphWorkerSigner(home, sha256Digest('upload fixture'));
  const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
  const action = {
    contentHash: 'a'.repeat(64),
    extractorSet: 'b'.repeat(64),
    languageAndRole: 'typescript:source',
    normalizedPath: 'src/index.ts',
    repositoryId: 'c'.repeat(64),
  };
  const result = graphShareParseResultArtifact({
    ...action,
    actionKey: graphShareParseActionKey(action),
    facts: {path: action.normalizedPath, diagnostics: [], edges: [], symbols: []},
    gitBlobId: 'd'.repeat(40),
  });
  const authority = {
    expiresAt: now + 3600,
    graphAbi: 'e'.repeat(64),
    principalId: sha256Digest('principal'),
    profileDigest: sha256Digest('profile'),
    repositoryId: action.repositoryId,
    signingPublicKey: signer.publicKey,
    workerId: 'gw_' + 'f'.repeat(32),
  };
  const artifact = yield* createGraphWorkerResultArtifact({
    metadata: {
      batchId: '1'.repeat(40),
      graphAbi: authority.graphAbi,
      identityClass: 'oauth-principal',
      issuedAt: now,
      partialCoverage: false,
      platform: {architecture: 'x64', os: 'linux'},
      principalId: authority.principalId,
      profileDigest: authority.profileDigest,
      releaseIdentity: '4.6.11-local.gfixture',
      repositoryId: authority.repositoryId,
      resourceLimits: [],
      sourceCommit: '1'.repeat(40),
      workerId: authority.workerId,
    },
    resultBytes: new TextEncoder().encode(canonicalJson(result)),
    signer,
  });
  return {artifact, authority};
});

describe('worker OCI closure upload', () => {
  effectIt.effect('binds the worker destination to the signed profile and a distinct normalized repository', () =>
    Effect.gen(function* () {
      const {authority} = yield* fixture();
      const base = defaultGraphShareProfile({
        branch: 'main',
        canonicalRemote: 'github.com/acme/repo',
        organization: 'acme',
        publisherKeyFingerprint: sha256Digest('publisher'),
        repositoryId: authority.repositoryId,
      });
      const profile = {
        ...base,
        registry: {
          canonical: 'oci://registry.example.test/acme/canonical',
          worker: 'oci://registry.example.test/acme/worker',
        },
      };
      const scoped = {...authority, profileDigest: graphShareProfileDigest(profile)};
      expect(graphWorkerRegistryForProfile(profile, scoped)).toBe(profile.registry.worker);
      const changed = {...profile, registry: {...profile.registry, worker: 'oci://registry.example.test/acme/other'}};
      expect(() => graphWorkerRegistryForProfile(changed, scoped)).toThrow();
      const alias = {
        ...profile,
        registry: {
          canonical: 'oci://registry.example.test/acme/worker',
          worker: 'oci://registry.example.test:443/acme/worker',
        },
      };
      expect(() =>
        graphWorkerRegistryForProfile(alias, {...authority, profileDigest: graphShareProfileDigest(alias)}),
      ).toThrow();
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('uploads exact signed blobs before the digest manifest and replays after unknown ACK', () =>
    Effect.gen(function* () {
      const {artifact, authority} = yield* fixture();
      const blobs = new Map<string, Uint8Array>();
      const manifests: string[] = [];
      let failAck = true;
      const writer = {
        putBlob: (digest: string, bytes: Uint8Array) =>
          Effect.sync(() => {
            expect(sha256Digest(bytes)).toBe(digest);
            const existed = blobs.has(digest);
            blobs.set(digest, new Uint8Array(bytes));
            return {digest: sha256Digest(bytes), existed};
          }),
        putManifest: (reference: string, bytes: Uint8Array) =>
          Effect.gen(function* () {
            expect(blobs.size).toBe(3);
            expect(reference).toBe(artifact.manifestDigest);
            expect(sha256Digest(bytes)).toBe(reference);
            manifests.push(reference);
            if (failAck) {
              failAck = false;
              return yield* graphSharingUnavailable('Unknown ACK fixture.');
            }
            return sha256Digest(bytes);
          }),
      };
      const input = {artifact, authority, isAuthorized: Effect.succeed(true), writer};
      expect((yield* Effect.result(uploadGraphWorkerArtifactClosure(input)))._tag).toBe('Failure');
      expect((yield* uploadGraphWorkerArtifactClosure(input)).manifestDigest).toBe(artifact.manifestDigest);
      expect(manifests).toEqual([artifact.manifestDigest, artifact.manifestDigest]);
      expect(blobs.get(GRAPH_SHARE_OCI_EMPTY_CONFIG_DIGEST)).toEqual(new TextEncoder().encode('{}'));
      expect(blobs.get(sha256Digest(artifact.resultBytes))).toEqual(artifact.resultBytes);
      expect(blobs.get(sha256Digest(artifact.attestationBytes))).toEqual(artifact.attestationBytes);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('refuses foreign authority or revocation before manifest publication', () =>
    Effect.gen(function* () {
      const {artifact, authority} = yield* fixture();
      const allowed = yield* Ref.make(true);
      let blobCalls = 0;
      let manifestCalls = 0;
      const writer = {
        putBlob: (digest: string, bytes: Uint8Array) =>
          Effect.gen(function* () {
            blobCalls++;
            if (blobCalls === 1) yield* Ref.set(allowed, false);
            return {digest: sha256Digest(bytes), existed: false};
          }),
        putManifest: (_reference: string, bytes: Uint8Array) =>
          Effect.sync(() => {
            manifestCalls++;
            return sha256Digest(bytes);
          }),
      };
      const input = {artifact, authority, isAuthorized: Ref.get(allowed), writer};
      expect(
        (yield* Effect.result(
          uploadGraphWorkerArtifactClosure({...input, authority: {...authority, principalId: sha256Digest('foreign')}}),
        ))._tag,
      ).toBe('Failure');
      expect(blobCalls).toBe(0);
      expect((yield* Effect.result(uploadGraphWorkerArtifactClosure(input)))._tag).toBe('Failure');
      expect(blobCalls).toBe(1);
      expect(manifestCalls).toBe(0);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('redacts a failed authorization check before submitting any blob', () =>
    Effect.gen(function* () {
      const {artifact, authority} = yield* fixture();
      let calls = 0;
      const writer = {
        putBlob: () =>
          Effect.sync(() => {
            calls++;
            return {digest: sha256Digest('unused'), existed: false};
          }),
        putManifest: () =>
          Effect.sync(() => {
            calls++;
            return sha256Digest('unused');
          }),
      };
      const result = yield* Effect.result(
        uploadGraphWorkerArtifactClosure({
          artifact,
          authority,
          isAuthorized: Effect.fail({detail: 'synthetic-private-detail'}),
          writer,
        }),
      );
      expect(result).toMatchObject({
        failure: {kind: 'unavailable', message: 'Graph worker authorization check failed.'},
      });
      expect(JSON.stringify(result)).not.toContain('synthetic-private-detail');
      expect(calls).toBe(0);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect.prop(
    'never submits a manifest when authority is revoked before a write boundary',
    {revokeAfterBlobs: FC.integer({min: 0, max: 3})},
    ({revokeAfterBlobs}) =>
      Effect.gen(function* () {
        const {artifact, authority} = yield* fixture();
        let blobs = 0;
        let manifests = 0;
        const writer = {
          putBlob: (_digest: string, bytes: Uint8Array) =>
            Effect.sync(() => {
              blobs++;
              return {digest: sha256Digest(bytes), existed: false};
            }),
          putManifest: (_reference: string, bytes: Uint8Array) =>
            Effect.sync(() => {
              manifests++;
              return sha256Digest(bytes);
            }),
        };
        const isAuthorized = Effect.sync(() => blobs < revokeAfterBlobs);
        expect(
          (yield* Effect.result(uploadGraphWorkerArtifactClosure({artifact, authority, isAuthorized, writer})))._tag,
        ).toBe('Failure');
        expect(blobs).toBe(revokeAfterBlobs);
        expect(manifests).toBe(0);
      }).pipe(provideTestLayer(layer)),
    {fastCheck: {numRuns: 16}},
  );
});
