import {describe, expect, it} from 'vitest';
import * as FC from 'effect/testing/FastCheck';
import {
  announceGraphShareResult,
  emptyGraphShareReceiptStore,
  selectGraphShareResultsForFrozenBatch,
  type GraphShareResultAnnouncementV1,
} from '../../src/code_graph/sharing/receipts.js';
import {
  lateResultAdmitted,
  observeCanonicalHead,
  freezeGraphShareBatch,
  idleGraphShareFrontier,
  publishGraphShareBatch,
  verifyGraphShareBatch,
  assembleGraphShareBatch,
} from '../../src/code_graph/sharing/frontier.js';
import type {Sha256Digest} from '../../src/code_graph/sharing/digest.js';

const digest = (character: string): Sha256Digest => `sha256:${character.repeat(64)}`;

describe('graph share receipts and frozen batches', () => {
  it('is order-independent and duplicate-idempotent for identical announcements', () => {
    FC.assert(
      FC.property(FC.array(announcementArb(), {maxLength: 6, minLength: 1}), announcements => {
        const shuffled = [...announcements].reverse();
        let left = emptyGraphShareReceiptStore();
        let right = emptyGraphShareReceiptStore();
        for (const announcement of announcements) {
          left = announceGraphShareResult(left, announcement).store;
          left = announceGraphShareResult(left, announcement).store;
        }
        for (const announcement of shuffled) {
          right = announceGraphShareResult(right, announcement).store;
        }
        expect(left.receipts).toHaveLength(uniqueKeys(announcements).length);
        expect(right.receipts.map(receiptKey).sort()).toEqual(left.receipts.map(receiptKey).sort());
      }),
      {numRuns: 25},
    );
  });

  it('quarantines one action key with two semantic digests and never first-writer-wins', () => {
    const first: GraphShareResultAnnouncementV1 = {
      actionKey: 'a'.repeat(64),
      attestationDigest: digest('1'),
      batchId: 'b'.repeat(40),
      resultManifestDigest: digest('2'),
      semanticDigest: digest('3'),
    };
    const second = {
      ...first,
      attestationDigest: digest('4'),
      resultManifestDigest: digest('5'),
      semanticDigest: digest('6'),
    };
    const accepted = announceGraphShareResult(emptyGraphShareReceiptStore(), first);
    expect(accepted.status).toBe('accepted');
    const quarantined = announceGraphShareResult(accepted.store, second);
    expect(quarantined.status).toBe('quarantined');
    const collided = announceGraphShareResult(accepted.store, {...first, semanticDigest: digest('9')});
    expect(collided.status).toBe('quarantined');
    const selected = selectGraphShareResultsForFrozenBatch(quarantined.store, {
      actionKeys: [first.actionKey],
      batchId: first.batchId,
    });
    expect(selected.selected).toEqual([]);
    expect(selected.quarantined).toEqual([first.actionKey]);
  });

  it('rejects late results from a different frozen batch', () => {
    let machine = idleGraphShareFrontier();
    machine = observeCanonicalHead(machine, {
      commit: 'c'.repeat(40),
      isDescendantOfPublished: true,
      nowSeconds: 0,
    });
    machine = freezeGraphShareBatch(machine, {
      actionKeys: ['a'.repeat(64)],
      changedBytes: 1,
      changedFiles: 1,
      nowSeconds: 30,
      thresholds: {maximumAgeSeconds: 30, maximumChangedBytes: 1, maximumChangedFiles: 1},
    });
    expect(machine.phase).toBe('frozen');
    expect(lateResultAdmitted(machine, machine.frozenBatchId ?? '')).toBe(true);
    expect(lateResultAdmitted(machine, 'd'.repeat(40))).toBe(false);
    const late: GraphShareResultAnnouncementV1 = {
      actionKey: 'a'.repeat(64),
      attestationDigest: digest('1'),
      batchId: 'd'.repeat(40),
      resultManifestDigest: digest('2'),
      semanticDigest: digest('3'),
    };
    const selected = selectGraphShareResultsForFrozenBatch(
      announceGraphShareResult(emptyGraphShareReceiptStore(), late).store,
      {
        actionKeys: [late.actionKey],
        batchId: machine.frozenBatchId ?? '',
      },
    );
    expect(selected.skippedLate).toHaveLength(1);
    expect(selected.selected).toEqual([]);
  });

  it('coalesces collecting commits into one frozen batch', () => {
    let machine = idleGraphShareFrontier();
    machine = observeCanonicalHead(machine, {commit: '1'.repeat(40), isDescendantOfPublished: true, nowSeconds: 0});
    machine = observeCanonicalHead(machine, {commit: '2'.repeat(40), isDescendantOfPublished: true, nowSeconds: 1});
    machine = observeCanonicalHead(machine, {commit: '3'.repeat(40), isDescendantOfPublished: true, nowSeconds: 2});
    machine = freezeGraphShareBatch(machine, {
      actionKeys: [],
      changedBytes: 10,
      changedFiles: 3,
      nowSeconds: 2,
      thresholds: {maximumAgeSeconds: 30, maximumChangedBytes: 1, maximumChangedFiles: 1},
    });
    expect(machine.phase).toBe('frozen');
    expect(machine.buildingFrontier).toBe('3'.repeat(40));
    machine = assembleGraphShareBatch(machine);
    machine = verifyGraphShareBatch(machine);
    machine = publishGraphShareBatch(machine, digest('9'));
    expect(machine.generation).toBe(1);
    expect(machine.publishedFrontier).toBe('3'.repeat(40));
  });
});

function receiptKey(announcement: GraphShareResultAnnouncementV1): string {
  return `${announcement.actionKey}:${announcement.resultManifestDigest}:${announcement.attestationDigest}:${announcement.semanticDigest}`;
}

function uniqueKeys(announcements: readonly GraphShareResultAnnouncementV1[]): string[] {
  return [...new Set(announcements.map(receiptKey))];
}

function announcementArb() {
  return FC.tuple(hex(64), hex(64), hex(40), hex(64), hex(64)).map(
    ([actionKey, attestation, batchId, result, semantic]) =>
      ({
        actionKey,
        attestationDigest: digestFromHex(attestation),
        batchId,
        resultManifestDigest: digestFromHex(result),
        semanticDigest: digestFromHex(semantic),
      }) satisfies GraphShareResultAnnouncementV1,
  );
}

function hex(length: number) {
  return FC.array(FC.constantFrom(...'0123456789abcdef'), {maxLength: length, minLength: length}).map(characters =>
    characters.join(''),
  );
}

function digestFromHex(value: string): Sha256Digest {
  return `sha256:${value}`;
}
