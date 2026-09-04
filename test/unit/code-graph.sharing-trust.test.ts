import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path, Result} from 'effect';
import {TestClock} from 'effect/testing';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {putCasBytes, putCasFile, readVerifiedCasBlob, verifyCasBlob} from '../../src/code_graph/sharing/cas.js';
import {sha256Digest, sha256HexFromDigest} from '../../src/code_graph/sharing/digest.js';
import {graphSharingCasBlobPath} from '../../src/code_graph/sharing/layout.js';
import {
  lookupGraphShareTrustReceipt,
  removeGraphShareTrustReceipt,
  trustReceiptFromEnrollment,
  writeGraphShareTrustReceipt,
  type GraphShareTrustReceiptV1,
} from '../../src/code_graph/sharing/trust.js';
import {
  casProfilePointer,
  defaultGraphShareProfile,
  graphShareProfileDigest,
  parseGraphShareEnrollment,
} from '../../src/code_graph/sharing/profile.js';
import {SystemInfo} from '../../src/effect/system.js';

const sharingLayer = SystemInfo.layer.pipe(Layer.provideMerge(BunServices.layer));

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
      expect(new TextDecoder().decode(yield* readVerifiedCasBlob(casRoot, digest))).toBe('checkpoint-bytes');
      expect(yield* verifyCasBlob(casRoot, digest)).toBe(
        graphSharingCasBlobPath(path, casRoot, sha256HexFromDigest(digest)),
      );
      const source = path.join(home, 'blob.bin');
      const fileBytes = new TextEncoder().encode('file-checkpoint-bytes');
      yield* fs.writeFile(source, fileBytes);
      const fileDigest = yield* putCasFile(casRoot, source);
      expect(fileDigest).toBe(sha256Digest(fileBytes));
      expect(new TextDecoder().decode(yield* readVerifiedCasBlob(casRoot, fileDigest))).toBe('file-checkpoint-bytes');
      expect(yield* putCasFile(casRoot, source)).toBe(fileDigest);
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
    }).pipe(provideTestLayer(sharingLayer)),
  );

  effectIt.effect('fail-closes verifyCasBlob when the stored object is mutated', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-share-cas-mutate-'});
      const casRoot = path.join(home, 'cas');
      const bytes = new TextEncoder().encode('checkpoint-bytes');
      const digest = yield* putCasBytes(casRoot, bytes);
      yield* fs.writeFile(yield* verifyCasBlob(casRoot, digest), new TextEncoder().encode('mutated-checkpoint'));
      const result = yield* verifyCasBlob(casRoot, digest).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
    }).pipe(provideTestLayer(sharingLayer)),
  );

  effectIt.effect('does not drop another repository receipt when write and remove race', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-share-trust-lock-'});
        const first = receiptFor('b'.repeat(64), 'read-only');
        const second = receiptFor('c'.repeat(64), 'join');
        const third = receiptFor('d'.repeat(64), 'join');
        yield* writeGraphShareTrustReceipt(home, first);
        yield* writeGraphShareTrustReceipt(home, second);
        yield* Effect.all(
          [
            writeGraphShareTrustReceipt(home, {...first, accessMode: 'join'}),
            removeGraphShareTrustReceipt(home, second.repositoryId),
            writeGraphShareTrustReceipt(home, third),
          ],
          {concurrency: 'unbounded'},
        );
        expect((yield* lookupGraphShareTrustReceipt(home, first.repositoryId))?.accessMode).toBe('join');
        expect(yield* lookupGraphShareTrustReceipt(home, second.repositoryId)).toBeUndefined();
        expect((yield* lookupGraphShareTrustReceipt(home, third.repositoryId))?.accessMode).toBe('join');
      }).pipe(provideTestLayer(sharingLayer)),
    ),
  );
});

function receiptFor(
  repositoryId: string,
  accessMode: GraphShareTrustReceiptV1['accessMode'],
): GraphShareTrustReceiptV1 {
  const enrollment = parseGraphShareEnrollment({
    profile: casProfilePointer(graphShareProfileDigest(profile)),
    publisherKeyFingerprint: profile.trust.publisherKeys[0],
    repositoryId,
    schemaVersion: 1,
  });
  return trustReceiptFromEnrollment(
    enrollment,
    {...profile, repositoryId},
    graphShareProfileDigest(profile),
    accessMode,
  );
}
