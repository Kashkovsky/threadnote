import {compareCodeUnits} from '../ordering.js';
import type {GraphWorkerAdmissionReceiptV1, GraphWorkerAdmissionStoreV1} from './worker_admission_state.js';

/** Pick one deterministic signed receipt per action for the exact publication source. */
export function selectGraphWorkerReceiptsForSource(
  store: GraphWorkerAdmissionStoreV1,
  source: {
    readonly actionKeys: readonly string[];
    readonly profileDigest: string;
    readonly repositoryId: string;
    readonly sourceCommit: string;
  },
): {
  readonly quarantined: readonly string[];
  readonly selected: readonly GraphWorkerAdmissionReceiptV1[];
  readonly skippedLate: readonly GraphWorkerAdmissionReceiptV1[];
} {
  const requested = source.actionKeys.length === 0 ? undefined : new Set(source.actionKeys);
  const quarantined = new Set(
    store.quarantine.filter(item => item.repositoryId === source.repositoryId).map(item => item.actionKey),
  );
  const byAction = new Map<string, GraphWorkerAdmissionReceiptV1>();
  const skippedLate: GraphWorkerAdmissionReceiptV1[] = [];
  for (const receipt of store.receipts) {
    const body = receipt.announcement.body;
    if (body.repositoryId !== source.repositoryId || body.profileDigest !== source.profileDigest) continue;
    if (requested !== undefined && !requested.has(body.actionKey)) continue;
    if (quarantined.has(body.actionKey)) continue;
    if (body.batchId !== source.sourceCommit.slice(0, 40)) {
      skippedLate.push(receipt);
      continue;
    }
    const previous = byAction.get(body.actionKey);
    if (previous === undefined || compareCodeUnits(body.idempotencyKey, previous.announcement.body.idempotencyKey) < 0)
      byAction.set(body.actionKey, receipt);
  }
  return {
    quarantined: [...quarantined].sort(compareCodeUnits),
    selected: [...byAction.values()].sort((a, b) =>
      compareCodeUnits(a.announcement.body.actionKey, b.announcement.body.actionKey),
    ),
    skippedLate: skippedLate.sort((a, b) =>
      compareCodeUnits(a.announcement.body.idempotencyKey, b.announcement.body.idempotencyKey),
    ),
  };
}
