import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {putCasBytes, verifyCasBlob} from '../../src/code_graph/sharing/cas.js';
import {sha256Digest} from '../../src/code_graph/sharing/digest.js';
import {
  lookupGraphShareTrustReceipt,
  removeGraphShareTrustReceipt,
  trustReceiptFromEnrollment,
  writeGraphShareTrustReceipt,
} from '../../src/code_graph/sharing/trust.js';
import {
  casProfilePointer,
  defaultGraphShareProfile,
  graphShareProfileDigest,
  parseGraphShareEnrollment,
} from '../../src/code_graph/sharing/profile.js';

const profile = defaultGraphShareProfile({
  branch: 'refs/heads/main',
  canonicalRemote: 'github.com/acme/monorepo',
  organization: 'acme',
  publisherKeyFingerprint: `sha256:${'a'.repeat(64)}`,
  repositoryId: 'b'.repeat(64),
});

describe('graph share trust and CAS', () => {
  effectIt.effect('round-trips digest-addressed blobs and join/leave receipts', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-share-trust-'});
      const casRoot = path.join(home, 'cas');
      const bytes = new TextEncoder().encode('checkpoint-bytes');
      const digest = yield* putCasBytes(casRoot, bytes);
      expect(digest).toBe(sha256Digest(bytes));
      expect(new TextDecoder().decode(yield* verifyCasBlob(casRoot, digest))).toBe('checkpoint-bytes');
      const enrollment = parseGraphShareEnrollment({
        profile: casProfilePointer(graphShareProfileDigest(profile)),
        publisherKeyFingerprint: profile.trust.publisherKeys[0],
        repositoryId: profile.repositoryId,
        schemaVersion: 1,
      });
      const readOnly = trustReceiptFromEnrollment(enrollment, profile, graphShareProfileDigest(profile), 'read-only');
      yield* writeGraphShareTrustReceipt(home, readOnly);
      expect((yield* lookupGraphShareTrustReceipt(home, profile.repositoryId))?.accessMode).toBe('read-only');
      yield* writeGraphShareTrustReceipt(
        home,
        trustReceiptFromEnrollment(enrollment, profile, graphShareProfileDigest(profile), 'join'),
      );
      expect((yield* lookupGraphShareTrustReceipt(home, profile.repositoryId))?.accessMode).toBe('join');
      yield* removeGraphShareTrustReceipt(home, profile.repositoryId);
      expect(yield* lookupGraphShareTrustReceipt(home, profile.repositoryId)).toBeUndefined();
    }).pipe(provideTestLayer(BunServices.layer)),
  );
});
