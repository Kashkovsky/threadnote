import {canonicalJson} from '../checkpoint/canonical_json.js';
import {compareCodeUnits} from '../ordering.js';
import {sha256Digest, type Sha256Digest} from './digest.js';
import {graphSharingFailure} from './errors.js';

export interface GraphShareLogicalModel {
  readonly records: ReadonlyMap<string, string>;
}

export interface GraphShareLogicalDeltaV1 {
  readonly baseCommit: string;
  readonly baseLogicalDigest: Sha256Digest;
  readonly baseSnapshotId: string;
  readonly deletions: readonly string[];
  readonly graphAbi: string;
  readonly targetCommit: string;
  readonly targetLogicalDigest: Sha256Digest;
  readonly upserts: readonly {readonly key: string; readonly value: string}[];
}

export function emptyLogicalGraph(): GraphShareLogicalModel {
  return {records: new Map()};
}

export function setLogicalRecord(model: GraphShareLogicalModel, key: string, value: string): GraphShareLogicalModel {
  const records = new Map(model.records);
  records.set(key, value);
  return {records};
}

export function deleteLogicalRecord(model: GraphShareLogicalModel, key: string): GraphShareLogicalModel {
  const records = new Map(model.records);
  records.delete(key);
  return {records};
}

export function logicalGraphDigest(model: GraphShareLogicalModel): Sha256Digest {
  return sha256Digest(
    canonicalJson(
      Object.fromEntries([...model.records.entries()].sort(([left], [right]) => compareCodeUnits(left, right))),
    ),
  );
}

export function diffLogicalGraphs(
  base: GraphShareLogicalModel,
  target: GraphShareLogicalModel,
  meta: {
    readonly baseCommit: string;
    readonly baseSnapshotId: string;
    readonly graphAbi: string;
    readonly targetCommit: string;
  },
): GraphShareLogicalDeltaV1 {
  const deletions = [...base.records.keys()].filter(key => !target.records.has(key)).sort(compareCodeUnits);
  const upserts = [...target.records.entries()]
    .filter(([key, value]) => base.records.get(key) !== value)
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([key, value]) => ({key, value}));
  return {
    ...meta,
    baseLogicalDigest: logicalGraphDigest(base),
    deletions,
    targetLogicalDigest: logicalGraphDigest(target),
    upserts,
  };
}

export function applyLogicalDelta(
  base: GraphShareLogicalModel,
  delta: GraphShareLogicalDeltaV1,
): GraphShareLogicalModel {
  if (logicalGraphDigest(base) !== delta.baseLogicalDigest) {
    throw graphSharingFailure('Delta base digest does not match the selected graph.');
  }
  let next = base;
  for (const key of delta.deletions) next = deleteLogicalRecord(next, key);
  for (const upsert of delta.upserts) next = setLogicalRecord(next, upsert.key, upsert.value);
  if (logicalGraphDigest(next) !== delta.targetLogicalDigest) {
    throw graphSharingFailure('Delta target digest does not match the applied records.');
  }
  return next;
}

export function compactLogicalGraph(model: GraphShareLogicalModel): GraphShareLogicalModel {
  return {records: new Map(model.records)};
}

export function selectNewestPublishedAncestor<T extends {readonly sourceCommit: string}>(
  published: readonly T[],
  isAncestorOfHead: (commit: string) => boolean,
): T | undefined {
  for (let index = published.length - 1; index >= 0; index -= 1) {
    const candidate = published[index];
    if (candidate !== undefined && isAncestorOfHead(candidate.sourceCommit)) return candidate;
  }
  return undefined;
}
