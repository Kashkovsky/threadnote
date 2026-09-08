import {expect, it as effectIt} from '@effect/vitest';
import {Effect, Fiber} from 'effect';
import {TestClock} from 'effect/testing';
import {parseSha256Digest, sha256Digest} from '../../src/code_graph/sharing/digest.js';
import {graphSharingUnavailable} from '../../src/code_graph/sharing/errors.js';
import {graphShareRegistryRetentionRoot} from '../../src/code_graph/sharing/registry_retention.js';
import {uploadGraphShareRegistryArtifacts} from '../../src/code_graph/sharing/registry_publication_upload.js';

effectIt.effect(
  'finishes a supported large inventory after a partial attempt within the deadline at 100ms RTT',
  () =>
    Effect.gen(function* () {
      const bytes = new Uint8Array([1]);
      const entries = Array.from({length: 16_000}, (_, index) => ({digest: sha256Digest(String(index)), size: 1}));
      const publication = {
        descriptorBytes: bytes,
        descriptorDigest: sha256Digest(bytes),
        retention: graphShareRegistryRetentionRoot(entries),
      };
      const uploaded = new Set<string>();
      const failedDigest = publication.retention.entries[12_000].digest;
      let failed = false,
        active = 0,
        peak = 0,
        probes = 0;
      const manifests: string[] = [];
      const writer = {
        putBlob: (digest: string) =>
          Effect.acquireUseRelease(
            Effect.sync(() => {
              active++;
              peak = Math.max(peak, active);
            }),
            () =>
              Effect.gen(function* () {
                probes++;
                const existed = uploaded.has(digest);
                yield* Effect.sleep(existed ? 100 : 300);
                if (!failed && digest === failedDigest) {
                  failed = true;
                  return yield* graphSharingUnavailable('Transient fixture failure.');
                }
                uploaded.add(digest);
                return {digest: parseSha256Digest(digest), existed};
              }),
            () =>
              Effect.sync(() => {
                active--;
              }),
          ),
        putManifest: (reference: string, body: Uint8Array) =>
          Effect.sync(() => {
            expect(active).toBe(0);
            expect(uploaded.size).toBe(publication.retention.entries.length);
            manifests.push(reference);
            return sha256Digest(body);
          }),
      };
      const run = () =>
        uploadGraphShareRegistryArtifacts(publication, writer, () => Effect.succeed(bytes)).pipe(
          Effect.timeout('15 minutes'),
          Effect.result,
        );
      const first = yield* Effect.forkChild(run());
      yield* TestClock.adjust('15 minutes');
      expect((yield* Fiber.join(first))._tag).toBe('Failure');
      expect(uploaded.size).toBeGreaterThan(10_000);
      expect(manifests).toHaveLength(0);
      const second = yield* Effect.forkChild(run());
      yield* TestClock.adjust('15 minutes');
      expect((yield* Fiber.join(second))._tag).toBe('Success');
      expect(peak).toBe(8);
      expect(probes).toBeGreaterThan(publication.retention.entries.length);
      expect(manifests).toEqual([publication.retention.tag, publication.descriptorDigest]);
    }),
  60_000,
);
