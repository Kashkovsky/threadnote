import {describe, expect, it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import * as FC from 'fast-check';
import {canonicalJson} from '../../src/code_graph/checkpoint/canonical_json.js';
import {sha256Digest} from '../../src/code_graph/sharing/digest.js';
import {
  admitGraphWorkerAnnouncement,
  emptyGraphWorkerAdmissionStore,
} from '../../src/code_graph/sharing/worker/admission_state.js';
import type {GraphWorkerResultAnnouncement} from '../../src/code_graph/sharing/worker/announcement.js';
import {selectGraphWorkerReceiptsForSource} from '../../src/code_graph/sharing/worker/receipts.js';
import {fcEffectProp} from '../helpers/fast-check-property.js';

const repositoryId = 'a'.repeat(64);
const profileDigest = sha256Digest('profile');
const sourceCommit = `${'b'.repeat(40)}${'c'.repeat(24)}`;
const actionKey = 'd'.repeat(64);
const authority = {
  expiresAt: 2_000,
  graphAbi: 'e'.repeat(64),
  principalId: sha256Digest('principal'),
  profileDigest,
  repositoryId,
  signingPublicKey: 'f'.repeat(64),
  workerId: `gw_${'1'.repeat(32)}`,
};

function announcement(seed: number, action = actionKey, semantic = 1, batch = sourceCommit.slice(0, 40)) {
  const fields = {
    actionKey: action,
    attestationDigest: sha256Digest(`attestation-${seed}`),
    batchId: batch,
    principalId: authority.principalId,
    profileDigest,
    repositoryId,
    resultManifestDigest: sha256Digest(`manifest-${seed}`),
    semanticDigest: sha256Digest(`semantic-${semantic}`),
    workerId: authority.workerId,
  };
  return {
    algorithm: 'ed25519',
    body: {
      ...fields,
      idempotencyKey: sha256Digest('threadnote.graph.worker.result-operation.v1\0' + canonicalJson(fields)),
    },
    publicKey: authority.signingPublicKey,
    schemaVersion: 1,
    signature: seed.toString(16).padStart(128, '0'),
  } as GraphWorkerResultAnnouncement;
}

function admitted(items: readonly GraphWorkerResultAnnouncement[]) {
  return items.reduce(
    (store, item) =>
      admitGraphWorkerAnnouncement(store, {
        announcement: item,
        authority,
        nowSeconds: 1_000,
        sourceCommit: item.body.batchId === sourceCommit.slice(0, 40) ? sourceCommit : item.body.batchId,
      }).store,
    emptyGraphWorkerAdmissionStore(),
  );
}

const source = {actionKeys: [] as string[], profileDigest, repositoryId, sourceCommit};

describe('signed worker receipt selection', () => {
  fcEffectProp(
    effectIt,
    'is independent of admission order and retains deterministic same-semantic alternatives',
    {ranks: FC.tuple(FC.integer(), FC.integer(), FC.integer())},
    ({ranks}) =>
      Effect.sync(() => {
        const items = [announcement(1), announcement(2), announcement(3, '2'.repeat(64))];
        const permuted = items
          .map((item, index) => ({item, rank: ranks[index], index}))
          .sort((a, b) => a.rank - b.rank || a.index - b.index)
          .map(row => row.item);
        const left = selectGraphWorkerReceiptsForSource(admitted(items), source);
        const right = selectGraphWorkerReceiptsForSource(admitted(permuted), source);
        expect(right).toEqual(left);
        expect(left.candidateGroups).toHaveLength(2);
        expect(
          left.candidateGroups
            .find(row => row.actionKey === actionKey)
            ?.alternatives.map(item => item.announcement.body.idempotencyKey),
        ).toEqual([items[0].body.idempotencyKey, items[1].body.idempotencyKey].sort());
      }),
    {fastCheck: {numRuns: 30}},
  );

  effectIt.effect('skips late source prefixes and quarantines all conflicting semantics', () =>
    Effect.sync(() => {
      const store = admitted([
        announcement(1),
        announcement(2, actionKey, 2),
        announcement(3, '2'.repeat(64), 1, '3'.repeat(40)),
      ]);
      const selected = selectGraphWorkerReceiptsForSource(store, source);
      expect(selected.quarantined).toEqual([actionKey]);
      expect(selected.candidateGroups).toEqual([]);
      expect(selected.skippedLate).toHaveLength(1);
    }),
  );

  effectIt.effect('distinguishes SHA-256 commits with the same batch prefix', () =>
    Effect.sync(() => {
      const samePrefixOtherCommit = `${sourceCommit.slice(0, 40)}${'e'.repeat(24)}`;
      const signed = announcement(4);
      const store = admitGraphWorkerAnnouncement(emptyGraphWorkerAdmissionStore(), {
        announcement: signed,
        authority,
        nowSeconds: 1_000,
        sourceCommit: samePrefixOtherCommit,
      }).store;
      const selected = selectGraphWorkerReceiptsForSource(store, source);
      expect(selected.candidateGroups).toHaveLength(0);
      expect(selected.skippedLate).toHaveLength(1);
    }),
  );
});
