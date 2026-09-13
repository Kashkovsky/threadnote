import {Schema} from 'effect';
import {canonicalJson} from '../checkpoint/canonical_json.js';
import {compareCodeUnits} from '../ordering.js';
import {sha256Digest, SHA256_DIGEST, SHA256_HEX} from './digest.js';
import type {GraphWorkerResultAnnouncement} from './worker_announcement.js';
import type {GraphWorkerResultAuthority} from './worker_result.js';

export const GRAPH_WORKER_ADMISSION_MAX_RECEIPTS = 1024;
export const GRAPH_WORKER_ADMISSION_MAX_STATE_BYTES = 2_097_152;
export const GRAPH_WORKER_ADMISSION_SCHEMA_VERSION = 1 as const;

const strict = {onExcessProperty: 'error'} as const;
const digest = Schema.String.check(Schema.isPattern(SHA256_DIGEST));
const hex = Schema.String.check(Schema.isPattern(SHA256_HEX));
const seconds = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
const announcementBody = Schema.Struct({
  actionKey: hex,
  attestationDigest: digest,
  batchId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u)),
  idempotencyKey: digest,
  principalId: digest,
  profileDigest: digest,
  repositoryId: hex,
  resultManifestDigest: digest,
  semanticDigest: digest,
  workerId: Schema.String.check(Schema.isPattern(/^gw_[0-9a-f]{32}$/u)),
});
const announcement = Schema.Struct({
  algorithm: Schema.Literal('ed25519'),
  body: announcementBody,
  publicKey: hex,
  schemaVersion: Schema.Literal(1),
  signature: Schema.String.check(Schema.isPattern(/^[0-9a-f]{128}$/u)),
});
const receipt = Schema.Struct({
  admittedAt: seconds,
  announcement,
  announcementDigest: digest,
  authorityExpiresAt: seconds,
  graphAbi: hex,
  signedBodyDigest: digest,
});
const quarantine = Schema.Struct({
  actionKey: hex,
  repositoryId: hex,
  semanticDigests: Schema.Array(digest).check(
    Schema.isMinLength(2),
    Schema.isMaxLength(GRAPH_WORKER_ADMISSION_MAX_RECEIPTS),
  ),
});
const storeSchema = Schema.Struct({
  quarantine: Schema.Array(quarantine).check(Schema.isMaxLength(GRAPH_WORKER_ADMISSION_MAX_RECEIPTS)),
  receipts: Schema.Array(receipt).check(Schema.isMaxLength(GRAPH_WORKER_ADMISSION_MAX_RECEIPTS)),
  schemaVersion: Schema.Literal(GRAPH_WORKER_ADMISSION_SCHEMA_VERSION),
});

export type GraphWorkerAdmissionReceiptV1 = typeof receipt.Type;
export type GraphWorkerAdmissionQuarantineV1 = typeof quarantine.Type;
export type GraphWorkerAdmissionStoreV1 = typeof storeSchema.Type;
export type GraphWorkerAdmissionStatus =
  'accepted' | 'quarantined' | 'duplicate' | 'operation-conflict' | 'capacity-exceeded' | 'invalid-authority';

export type GraphWorkerAdmissionResult =
  | {
      readonly status: 'accepted' | 'quarantined' | 'duplicate';
      readonly receipt: GraphWorkerAdmissionReceiptV1;
      readonly store: GraphWorkerAdmissionStoreV1;
    }
  | {
      readonly status: 'operation-conflict' | 'capacity-exceeded' | 'invalid-authority';
      readonly store: GraphWorkerAdmissionStoreV1;
    };

export function emptyGraphWorkerAdmissionStore(): GraphWorkerAdmissionStoreV1 {
  return {quarantine: [], receipts: [], schemaVersion: GRAPH_WORKER_ADMISSION_SCHEMA_VERSION};
}

/** Validate bounded private state after loading it. Signed authority must still be reverified by the caller. */
export function parseGraphWorkerAdmissionStore(value: unknown): GraphWorkerAdmissionStoreV1 {
  const parsed = Schema.decodeUnknownSync(storeSchema, strict)(value);
  if (
    parsed.receipts.some(
      item =>
        item.authorityExpiresAt <= item.admittedAt ||
        item.signedBodyDigest !== sha256Digest(canonicalJson(item.announcement.body)) ||
        item.announcementDigest !== sha256Digest(canonicalJson(item.announcement)) ||
        item.announcement.body.idempotencyKey !== operationId(item.announcement.body),
    ) ||
    !strictlySorted(parsed.receipts.map(item => item.announcement.body.idempotencyKey)) ||
    canonicalJson(parsed.quarantine) !== canonicalJson(quarantineFor(parsed.receipts))
  )
    throw new Error('Graph worker admission state is invalid.');
  return parsed;
}

/** A bounded, strict UTF-8/JSON boundary for loading the private receipt document. */
export function parseGraphWorkerAdmissionBytes(bytes: Uint8Array): GraphWorkerAdmissionStoreV1 {
  if (bytes.byteLength > GRAPH_WORKER_ADMISSION_MAX_STATE_BYTES)
    throw new Error('Graph worker admission state exceeds its byte limit.');
  try {
    return parseGraphWorkerAdmissionStore(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)));
  } catch {
    throw new Error('Graph worker admission state is invalid.');
  }
}

/**
 * Pure commit transition. The caller must verify the announcement signature, OCI closure, attestation,
 * current principal/grant/worker binding, and policy immediately before committing this returned state.
 * Network and cryptographic verification belong outside the coordinator's short mutation lock.
 */
export function admitGraphWorkerAnnouncement(
  store: GraphWorkerAdmissionStoreV1,
  input: {
    readonly announcement: GraphWorkerResultAnnouncement;
    readonly authority: GraphWorkerResultAuthority;
    readonly nowSeconds: number;
  },
): GraphWorkerAdmissionResult {
  let signed: typeof announcement.Type;
  try {
    signed = Schema.decodeSync(announcement, strict)(input.announcement);
  } catch {
    return {status: 'invalid-authority', store};
  }
  const {authority, nowSeconds} = input;
  if (
    !Number.isSafeInteger(nowSeconds) ||
    nowSeconds < 0 ||
    !Number.isSafeInteger(authority.expiresAt) ||
    authority.expiresAt <= nowSeconds ||
    !SHA256_HEX.test(authority.graphAbi) ||
    signed.publicKey !== authority.signingPublicKey ||
    signed.body.workerId !== authority.workerId ||
    signed.body.principalId !== authority.principalId ||
    signed.body.repositoryId !== authority.repositoryId ||
    signed.body.profileDigest !== authority.profileDigest
  )
    return {status: 'invalid-authority', store};

  const announcementDigest = sha256Digest(canonicalJson(signed));
  const prior = store.receipts.find(item => item.announcement.body.idempotencyKey === signed.body.idempotencyKey);
  if (prior !== undefined) {
    if (prior.announcementDigest !== announcementDigest || prior.graphAbi !== authority.graphAbi)
      return {status: 'operation-conflict', store};
    return {status: 'duplicate', receipt: prior, store};
  }
  if (signed.body.idempotencyKey !== operationId(signed.body)) return {status: 'invalid-authority', store};
  if (store.receipts.length >= GRAPH_WORKER_ADMISSION_MAX_RECEIPTS) return {status: 'capacity-exceeded', store};

  const admitted: GraphWorkerAdmissionReceiptV1 = {
    admittedAt: nowSeconds,
    announcement: signed,
    announcementDigest,
    authorityExpiresAt: authority.expiresAt,
    graphAbi: authority.graphAbi,
    signedBodyDigest: sha256Digest(canonicalJson(signed.body)),
  };
  const receipts = [...store.receipts, admitted].sort((left, right) =>
    compareCodeUnits(left.announcement.body.idempotencyKey, right.announcement.body.idempotencyKey),
  );
  const next = {
    quarantine: quarantineFor(receipts),
    receipts,
    schemaVersion: GRAPH_WORKER_ADMISSION_SCHEMA_VERSION,
  };
  const quarantined = next.quarantine.some(
    item => item.repositoryId === signed.body.repositoryId && item.actionKey === signed.body.actionKey,
  );
  return {status: quarantined ? 'quarantined' : 'accepted', receipt: admitted, store: next};
}

function quarantineFor(receipts: readonly GraphWorkerAdmissionReceiptV1[]): GraphWorkerAdmissionQuarantineV1[] {
  const byAction = new Map<string, {repositoryId: string; actionKey: string; digests: Set<string>}>();
  for (const item of receipts) {
    const {repositoryId, actionKey, semanticDigest} = item.announcement.body;
    const key = `${repositoryId}:${actionKey}`;
    const entry = byAction.get(key) ?? {repositoryId, actionKey, digests: new Set<string>()};
    entry.digests.add(semanticDigest);
    byAction.set(key, entry);
  }
  return [...byAction.values()]
    .filter(item => item.digests.size > 1)
    .map(item => ({
      actionKey: item.actionKey,
      repositoryId: item.repositoryId,
      semanticDigests: [...item.digests].sort(compareCodeUnits),
    }))
    .sort(
      (left, right) =>
        compareCodeUnits(left.repositoryId, right.repositoryId) || compareCodeUnits(left.actionKey, right.actionKey),
    );
}

function strictlySorted(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || compareCodeUnits(values[index - 1], value) < 0);
}

function operationId(body: typeof announcementBody.Type): string {
  const {idempotencyKey, ...fields} = body;
  void idempotencyKey;
  return sha256Digest('threadnote.graph.worker.result-operation.v1\0' + canonicalJson(fields));
}
