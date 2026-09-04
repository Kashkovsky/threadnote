import {describe, expect, it as effectIt} from '@effect/vitest';
import {Effect, Result} from 'effect';
import {
  generateGraphSharePublisherKey,
  graphShareFrontierCanonicalBytes,
  parseGraphShareFrontierManifest,
  signGraphShareFrontier,
  verifyGraphShareFrontier,
  type GraphShareFrontierManifestV1,
} from '../../src/code_graph/sharing/artifacts.js';
import {sha256Digest} from '../../src/code_graph/sharing/digest.js';

const MANIFEST: GraphShareFrontierManifestV1 = {
  branch: 'refs/heads/main',
  checkpoint: {
    manifestDigest: `sha256:${'1'.repeat(64)}`,
    snapshotId: 'cgsn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    sourceCommit: 'a'.repeat(40),
  },
  deltas: [],
  generation: 1,
  graphAbi: 'c'.repeat(64),
  graphContentId: 'cgc_' + 'd'.repeat(40),
  logicalGraphDigest: `sha256:${'2'.repeat(64)}`,
  previousManifestDigest: null,
  profileDigest: `sha256:${'3'.repeat(64)}`,
  publisherFence: 1,
  repositoryId: 'e'.repeat(64),
  schemaVersion: 1,
  snapshotId: 'cgsn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  sourceCommit: 'a'.repeat(40),
};

describe('graph share frontier signatures', () => {
  effectIt.effect('signs generation-one frontiers and fail-closes on tamper', () =>
    Effect.gen(function* () {
      const key = yield* generateGraphSharePublisherKey();
      const signed = yield* signGraphShareFrontier(key, MANIFEST);
      expect(signed.payloadDigest).toBe(sha256Digest(graphShareFrontierCanonicalBytes(MANIFEST)));
      yield* verifyGraphShareFrontier(key.fingerprint, MANIFEST, signed.envelope);
      const parsed = parseGraphShareFrontierManifest({...MANIFEST, deltas: []});
      yield* verifyGraphShareFrontier(key.fingerprint, parsed, signed.envelope);
      const tampered = {...MANIFEST, sourceCommit: 'b'.repeat(40)};
      const result = yield* verifyGraphShareFrontier(key.fingerprint, tampered, signed.envelope).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
    }),
  );
});
