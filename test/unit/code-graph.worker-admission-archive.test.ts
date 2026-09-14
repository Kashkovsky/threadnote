import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path} from 'effect';
import {canonicalJson} from '../../src/code_graph/checkpoint/canonical_json.js';
import {writeDurablePrivateJsonFile} from '../../src/code_graph/sharing/atomic.js';
import type {GraphControlPolicy} from '../../src/code_graph/sharing/control_authorization.js';
import {
  graphWorkerAdmissionStatePath,
  readGraphWorkerAdmissionStore,
  retireGraphWorkerAdmissionsForPublishedSourceLocked,
} from '../../src/code_graph/sharing/control_result_admission.js';
import {withCoordinatorStateLock} from '../../src/code_graph/sharing/coordinator_lock.js';
import {sha256Digest} from '../../src/code_graph/sharing/digest.js';
import {
  graphWorkerAdmissionArchivePaths,
  parkGraphWorkerAdmissionReceipts,
  readGraphWorkerAdmissionArchive,
} from '../../src/code_graph/sharing/worker_admission_archive.js';
import {
  admitGraphWorkerAnnouncement,
  emptyGraphWorkerAdmissionStore,
  type GraphWorkerAdmissionReceiptV2,
} from '../../src/code_graph/sharing/worker_admission_state.js';
import {SystemInfo} from '../../src/effect/system.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const layer = SystemInfo.layer.pipe(Layer.provideMerge(BunServices.layer));
const policy: GraphControlPolicy = {
  audience: 'https://graph.example.test',
  grants: [],
  issuer: 'https://identity.example.test/',
  jwksUrl: 'https://identity.example.test/jwks.json',
  organization: 'acme',
  profileDigest: sha256Digest('profile'),
  repositoryId: 'a'.repeat(64),
  schemaVersion: 1,
};

function receipt(seed: number, sourceCommit: string): GraphWorkerAdmissionReceiptV2 {
  const authority = {
    expiresAt: 2000,
    graphAbi: 'b'.repeat(64),
    principalId: sha256Digest('principal'),
    profileDigest: policy.profileDigest,
    repositoryId: policy.repositoryId,
    signingPublicKey: 'c'.repeat(64),
    workerId: `gw_${'d'.repeat(32)}`,
  };
  const fields = {
    actionKey: 'e'.repeat(64),
    attestationDigest: sha256Digest(`attestation-${seed}`),
    batchId: sourceCommit.slice(0, 40),
    principalId: authority.principalId,
    profileDigest: authority.profileDigest,
    repositoryId: authority.repositoryId,
    resultManifestDigest: sha256Digest(`manifest-${seed}`),
    semanticDigest: sha256Digest(`semantic-${seed}`),
    workerId: authority.workerId,
  };
  const announcement = {
    algorithm: 'ed25519' as const,
    body: {
      ...fields,
      idempotencyKey: sha256Digest('threadnote.graph.worker.result-operation.v1\0' + canonicalJson(fields)),
    },
    publicKey: authority.signingPublicKey,
    schemaVersion: 1 as const,
    signature: seed.toString(16).padStart(128, '0'),
  };
  const admitted = admitGraphWorkerAnnouncement(emptyGraphWorkerAdmissionStore(), {
    announcement,
    authority,
    nowSeconds: 1000,
    sourceCommit,
  });
  if (admitted.status !== 'accepted') throw new Error('Expected receipt.');
  return admitted.receipt;
}

const fixture = Effect.fn('test.workerAdmissionArchive.fixture')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'worker-admission-archive-'});
  const hotPath = yield* graphWorkerAdmissionStatePath(home, policy);
  const hot = emptyGraphWorkerAdmissionStore();
  yield* writeDurablePrivateJsonFile(hotPath, hot);
  return {fs, home, hotPath, path};
});

describe('signed worker admission cold archive', () => {
  effectIt.effect('recovers a segment written before its manifest commit while hot evidence remains', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const source = '1'.repeat(40);
      const candidate = receipt(1, source);
      yield* writeDurablePrivateJsonFile(f.hotPath, {...emptyGraphWorkerAdmissionStore(), receipts: [candidate]});
      const initial = yield* readGraphWorkerAdmissionArchive(f.hotPath, policy);
      expect((yield* parkGraphWorkerAdmissionReceipts(f.hotPath, policy, initial, source, [candidate])).status).toBe(
        'parked',
      );
      yield* writeDurablePrivateJsonFile(graphWorkerAdmissionArchivePaths(f.hotPath).manifest, initial.manifest);
      expect((yield* readGraphWorkerAdmissionStore(f.home, policy)).receipts).toEqual([candidate]);
      const retry = yield* parkGraphWorkerAdmissionReceipts(
        f.hotPath,
        policy,
        yield* readGraphWorkerAdmissionArchive(f.hotPath, policy),
        source,
        [candidate],
      );
      expect(retry.status).toBe('parked');
      yield* writeDurablePrivateJsonFile(f.hotPath, emptyGraphWorkerAdmissionStore());
      expect((yield* readGraphWorkerAdmissionStore(f.home, policy)).receipts).toEqual([candidate]);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('preserves one logical receipt through archive commit, hot removal, and source retirement', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const source = '1'.repeat(40);
      const candidate = receipt(1, source);
      yield* writeDurablePrivateJsonFile(f.hotPath, {
        ...emptyGraphWorkerAdmissionStore(),
        receipts: [candidate],
      });
      const initial = yield* readGraphWorkerAdmissionArchive(f.hotPath, policy);
      const parked = yield* parkGraphWorkerAdmissionReceipts(f.hotPath, policy, initial, source, [candidate]);
      expect(parked.status).toBe('parked');
      expect((yield* readGraphWorkerAdmissionStore(f.home, policy)).receipts).toEqual([candidate]);
      yield* writeDurablePrivateJsonFile(f.hotPath, {...emptyGraphWorkerAdmissionStore(), archiveStarted: true});
      expect((yield* readGraphWorkerAdmissionStore(f.home, policy)).receipts).toEqual([candidate]);
      const retired = yield* withCoordinatorStateLock(
        {threadnoteHome: f.home},
        retireGraphWorkerAdmissionsForPublishedSourceLocked(f.home, policy, source),
      );
      expect(retired.retired).toBe(1);
      expect((yield* readGraphWorkerAdmissionStore(f.home, policy)).receipts).toEqual([]);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('fails closed when a committed archive disappears after hot removal', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const source = '1'.repeat(40);
      const candidate = receipt(1, source);
      const initial = yield* readGraphWorkerAdmissionArchive(f.hotPath, policy);
      expect((yield* parkGraphWorkerAdmissionReceipts(f.hotPath, policy, initial, source, [candidate])).status).toBe(
        'parked',
      );
      yield* writeDurablePrivateJsonFile(f.hotPath, {...emptyGraphWorkerAdmissionStore(), archiveStarted: true});
      const paths = graphWorkerAdmissionArchivePaths(f.hotPath);
      yield* f.fs.remove(paths.manifest);
      yield* f.fs.remove(paths.segments, {recursive: true});
      expect(yield* readGraphWorkerAdmissionStore(f.home, policy).pipe(Effect.flip)).toMatchObject({
        kind: 'unavailable',
      });
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('rejects a changed hot overlap using the indexed full-receipt digest', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const source = '1'.repeat(40);
      const candidate = receipt(1, source);
      const initial = yield* readGraphWorkerAdmissionArchive(f.hotPath, policy);
      expect((yield* parkGraphWorkerAdmissionReceipts(f.hotPath, policy, initial, source, [candidate])).status).toBe(
        'parked',
      );
      yield* writeDurablePrivateJsonFile(f.hotPath, {
        ...emptyGraphWorkerAdmissionStore(),
        archiveStarted: true,
        receipts: [{...candidate, admittedAt: candidate.admittedAt + 1}],
      });
      expect(yield* readGraphWorkerAdmissionStore(f.home, policy, '2'.repeat(40)).pipe(Effect.flip)).toMatchObject({
        kind: 'unavailable',
      });
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('does not retire an indexed covered segment whose bytes have changed', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const source = '1'.repeat(40);
      const candidate = receipt(1, source);
      const initial = yield* readGraphWorkerAdmissionArchive(f.hotPath, policy);
      expect((yield* parkGraphWorkerAdmissionReceipts(f.hotPath, policy, initial, source, [candidate])).status).toBe(
        'parked',
      );
      yield* writeDurablePrivateJsonFile(f.hotPath, {...emptyGraphWorkerAdmissionStore(), archiveStarted: true});
      const paths = graphWorkerAdmissionArchivePaths(f.hotPath);
      const name = (yield* f.fs.readDirectory(paths.segments))[0];
      const target = f.path.join(paths.segments, name);
      const original = yield* f.fs.readFileString(target);
      yield* f.fs.writeFileString(target, `${original.slice(0, -2)}0\n`);
      expect(
        yield* withCoordinatorStateLock(
          {threadnoteHome: f.home},
          retireGraphWorkerAdmissionsForPublishedSourceLocked(f.home, policy, source),
        ).pipe(Effect.flip),
      ).toMatchObject({kind: 'unavailable'});
      expect(yield* f.fs.readDirectory(paths.segments)).toContain(name);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('quarantines a current hot result against a parked semantic alternative', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const parkedReceipt = receipt(1, '1'.repeat(40));
      const currentReceipt = receipt(2, '2'.repeat(40));
      const initial = yield* readGraphWorkerAdmissionArchive(f.hotPath, policy);
      yield* parkGraphWorkerAdmissionReceipts(f.hotPath, policy, initial, parkedReceipt.sourceCommit, [parkedReceipt]);
      yield* writeDurablePrivateJsonFile(f.hotPath, {...emptyGraphWorkerAdmissionStore(), receipts: [currentReceipt]});
      const view = yield* readGraphWorkerAdmissionStore(f.home, policy);
      expect(view.receipts).toHaveLength(2);
      expect(view.quarantine).toEqual([
        {
          actionKey: currentReceipt.announcement.body.actionKey,
          repositoryId: policy.repositoryId,
          semanticDigests: [
            currentReceipt.announcement.body.semanticDigest,
            parkedReceipt.announcement.body.semanticDigest,
          ].sort(),
        },
      ]);
      const paths = graphWorkerAdmissionArchivePaths(f.hotPath);
      const segments = yield* f.fs.readDirectory(paths.segments);
      yield* f.fs.writeFileString(f.path.join(paths.segments, segments[0]), '{');
      expect(yield* readGraphWorkerAdmissionStore(f.home, policy).pipe(Effect.flip)).toMatchObject({
        kind: 'unavailable',
      });
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('keeps indexed quarantine conservative until a same-size damaged segment is scrubbed', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const first = receipt(1, '1'.repeat(40));
      const second = receipt(2, '2'.repeat(40));
      const initial = yield* readGraphWorkerAdmissionArchive(f.hotPath, policy);
      const parkedFirst = yield* parkGraphWorkerAdmissionReceipts(f.hotPath, policy, initial, first.sourceCommit, [
        first,
      ]);
      if (parkedFirst.status !== 'parked') throw new Error('Expected parked receipt.');
      const parkedSecond = yield* parkGraphWorkerAdmissionReceipts(
        f.hotPath,
        policy,
        parkedFirst.archive,
        second.sourceCommit,
        [second],
      );
      expect(parkedSecond.status).toBe('parked');
      const segment = parkedFirst.archive.manifest.segments[0];
      const other = f.path.join(graphWorkerAdmissionArchivePaths(f.hotPath).segments, `${segment.digest}.json`);
      const original = yield* f.fs.readFileString(other);
      const changed = `${original.slice(0, -2)}${original.at(-2) === '1' ? '2' : '1'}\n`;
      expect(changed.length).toBe(original.length);
      yield* f.fs.writeFileString(other, changed);
      const selected = yield* readGraphWorkerAdmissionStore(f.home, policy, second.sourceCommit);
      expect(selected.receipts).toEqual([second]);
      expect(selected.quarantine).toHaveLength(1);
      expect(yield* readGraphWorkerAdmissionStore(f.home, policy).pipe(Effect.flip)).toMatchObject({
        kind: 'unavailable',
      });
    }).pipe(provideTestLayer(layer)),
  );
});
