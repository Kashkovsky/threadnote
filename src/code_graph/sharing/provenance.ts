import {Effect, FileSystem, Path} from 'effect';
import {readJsonFile, writePrivateJsonFile} from './atomic.js';
import {parseSha256Digest, SHA256_HEX, type Sha256Digest} from './digest.js';
import {graphSharingFailure} from './errors.js';
import {graphSharingLayout, graphSharingProvenancePath} from './layout.js';

export interface SharedGraphProvenanceV1 {
  readonly checkpointDigest: Sha256Digest;
  readonly frontierCommit: string;
  readonly profileDigest: Sha256Digest;
  readonly repositoryId: string;
  readonly schemaVersion: 1;
  readonly snapshotId: string;
}

export const writeSharedGraphProvenance = Effect.fn('codeGraph.sharing.writeProvenance')(function* (
  threadnoteHome: string,
  checkoutId: string,
  provenance: SharedGraphProvenanceV1,
) {
  const path = yield* Path.Path;
  const layout = graphSharingLayout(path, threadnoteHome);
  yield* writePrivateJsonFile(graphSharingProvenancePath(path, layout.provenanceRoot, checkoutId), provenance);
});

export const readSharedGraphProvenance = Effect.fn('codeGraph.sharing.readProvenance')(function* (
  threadnoteHome: string,
  checkoutId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const layout = graphSharingLayout(path, threadnoteHome);
  const target = graphSharingProvenancePath(path, layout.provenanceRoot, checkoutId);
  if (!(yield* fs.exists(target))) return undefined;
  return parseProvenance(yield* readJsonFile(target));
});

export const removeSharedGraphProvenance = Effect.fn('codeGraph.sharing.removeProvenance')(function* (
  threadnoteHome: string,
  checkoutId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const layout = graphSharingLayout(path, threadnoteHome);
  const target = graphSharingProvenancePath(path, layout.provenanceRoot, checkoutId);
  if (yield* fs.exists(target)) yield* fs.remove(target, {force: true});
});

export function sharedGraphQuerySource(
  provenance: SharedGraphProvenanceV1,
  localCommit: string,
): {
  readonly deltaCount: number;
  readonly frontierCommit: string;
  readonly kind: 'shared-base-plus-local-overlay';
  readonly localCommit: string;
  readonly profileDigest: Sha256Digest;
} {
  return {
    deltaCount: 0,
    frontierCommit: provenance.frontierCommit,
    kind: 'shared-base-plus-local-overlay',
    localCommit,
    profileDigest: provenance.profileDigest,
  };
}

function parseProvenance(value: unknown): SharedGraphProvenanceV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !('schemaVersion' in value)) {
    throw graphSharingFailure('Shared graph provenance is invalid.');
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    typeof record.snapshotId !== 'string' ||
    typeof record.frontierCommit !== 'string'
  ) {
    throw graphSharingFailure('Shared graph provenance is invalid.');
  }
  if (typeof record.repositoryId !== 'string' || !SHA256_HEX.test(record.repositoryId)) {
    throw graphSharingFailure('Shared graph provenance repository identity is invalid.');
  }
  return {
    checkpointDigest: parseSha256Digest(String(record.checkpointDigest)),
    frontierCommit: record.frontierCommit,
    profileDigest: parseSha256Digest(String(record.profileDigest)),
    repositoryId: record.repositoryId,
    schemaVersion: 1,
    snapshotId: record.snapshotId,
  };
}
