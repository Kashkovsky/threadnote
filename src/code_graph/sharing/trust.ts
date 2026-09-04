import {Effect, FileSystem, Path} from 'effect';
import {withExclusiveFileLock} from '../../effect/file_lock.js';
import {readJsonFile, writePrivateJsonFile} from './atomic.js';
import {graphSharingFailure} from './errors.js';
import {parseSha256Digest, SHA256_DIGEST, SHA256_HEX, type Sha256Digest} from './digest.js';
import {graphSharingLayout} from './layout.js';
import {parseGraphShareCoordinatorUrl, type GraphShareEnrollmentV1, type GraphShareProfileV1} from './profile.js';

const GRAPH_SHARE_TRUST_LOCK_OPTIONS = {
  heartbeatIntervalMilliseconds: 10_000,
  retryIntervalMilliseconds: 25,
  staleAfterMilliseconds: 30_000,
  waitTimeoutMilliseconds: 30_000,
} as const;

export const GRAPH_SHARE_TRUST_SCHEMA_VERSION = 1 as const;
export const GRAPH_SHARE_ACCESS_MODES = ['join', 'read-only'] as const;
export type GraphShareAccessMode = (typeof GRAPH_SHARE_ACCESS_MODES)[number];

export interface GraphShareTrustReceiptV1 {
  readonly accessMode: GraphShareAccessMode;
  readonly organization: string;
  readonly policyVersion: 1;
  readonly profileDigest: Sha256Digest;
  readonly publisherKeyFingerprint: Sha256Digest;
  readonly registryCanonical: string;
  readonly repositoryId: string;
}

export interface GraphShareTrustDocumentV1 {
  readonly receipts: readonly GraphShareTrustReceiptV1[];
  readonly schemaVersion: typeof GRAPH_SHARE_TRUST_SCHEMA_VERSION;
}

export interface GraphShareClientStateV1 {
  readonly casRoot?: string;
  readonly contributionMode?: 'dedicated' | 'idle' | 'off' | 'passive';
  readonly coordinatorUrl?: string;
  readonly schemaVersion: 1;
}

export const readGraphShareTrustDocument = Effect.fn('codeGraph.sharing.readTrustDocument')(function* (
  threadnoteHome: string,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const layout = graphSharingLayout(path, threadnoteHome);
  if (!(yield* fs.exists(layout.trustReceiptsPath))) {
    return {receipts: [], schemaVersion: GRAPH_SHARE_TRUST_SCHEMA_VERSION} satisfies GraphShareTrustDocumentV1;
  }
  return parseTrustDocument(yield* readJsonFile(layout.trustReceiptsPath));
});

export const lookupGraphShareTrustReceipt = Effect.fn('codeGraph.sharing.lookupTrustReceipt')(function* (
  threadnoteHome: string,
  repositoryId: string,
) {
  const document = yield* readGraphShareTrustDocument(threadnoteHome);
  return document.receipts.find(receipt => receipt.repositoryId === repositoryId);
});

export const writeGraphShareTrustReceipt = Effect.fn('codeGraph.sharing.writeTrustReceipt')(function* (
  threadnoteHome: string,
  receipt: GraphShareTrustReceiptV1,
) {
  return yield* withGraphShareTrustReceiptsLock(
    threadnoteHome,
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const layout = graphSharingLayout(path, threadnoteHome);
      const document = yield* readGraphShareTrustDocument(threadnoteHome);
      const receipts = [...document.receipts.filter(item => item.repositoryId !== receipt.repositoryId), receipt].sort(
        (left, right) => (left.repositoryId < right.repositoryId ? -1 : left.repositoryId > right.repositoryId ? 1 : 0),
      );
      yield* writePrivateJsonFile(layout.trustReceiptsPath, {
        receipts,
        schemaVersion: GRAPH_SHARE_TRUST_SCHEMA_VERSION,
      } satisfies GraphShareTrustDocumentV1);
      return receipt;
    }),
  );
});

export const removeGraphShareTrustReceipt = Effect.fn('codeGraph.sharing.removeTrustReceipt')(function* (
  threadnoteHome: string,
  repositoryId: string,
) {
  yield* withGraphShareTrustReceiptsLock(
    threadnoteHome,
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const layout = graphSharingLayout(path, threadnoteHome);
      const document = yield* readGraphShareTrustDocument(threadnoteHome);
      yield* writePrivateJsonFile(layout.trustReceiptsPath, {
        receipts: document.receipts.filter(item => item.repositoryId !== repositoryId),
        schemaVersion: GRAPH_SHARE_TRUST_SCHEMA_VERSION,
      } satisfies GraphShareTrustDocumentV1);
    }),
  );
});

export function trustReceiptFromEnrollment(
  enrollment: GraphShareEnrollmentV1,
  profile: GraphShareProfileV1,
  digest: Sha256Digest,
  accessMode: GraphShareAccessMode,
): GraphShareTrustReceiptV1 {
  return {
    accessMode,
    organization: profile.organization,
    policyVersion: 1,
    profileDigest: digest,
    publisherKeyFingerprint: parseSha256Digest(enrollment.publisherKeyFingerprint),
    registryCanonical: profile.registry.canonical,
    repositoryId: enrollment.repositoryId,
  };
}

export const readGraphShareClientState = Effect.fn('codeGraph.sharing.readClientState')(function* (
  threadnoteHome: string,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const layout = graphSharingLayout(path, threadnoteHome);
  if (!(yield* fs.exists(layout.clientStatePath))) return {schemaVersion: 1 as const} satisfies GraphShareClientStateV1;
  return parseClientState(yield* readJsonFile(layout.clientStatePath));
});

export const writeGraphShareClientState = Effect.fn('codeGraph.sharing.writeClientState')(function* (
  threadnoteHome: string,
  casRoot: string | undefined,
) {
  yield* patchGraphShareClientState(threadnoteHome, {casRoot});
});

export const writeGraphShareContributionMode = Effect.fn('codeGraph.sharing.writeContributionMode')(function* (
  threadnoteHome: string,
  contributionMode: GraphShareClientStateV1['contributionMode'],
) {
  return yield* patchGraphShareClientState(threadnoteHome, {contributionMode});
});

export const writeGraphShareCoordinatorUrl = Effect.fn('codeGraph.sharing.writeCoordinatorUrl')(function* (
  threadnoteHome: string,
  coordinatorUrl: string | undefined,
) {
  return yield* patchGraphShareClientState(threadnoteHome, {coordinatorUrl});
});

export const patchGraphShareClientState = Effect.fn('codeGraph.sharing.patchClientState')(function* (
  threadnoteHome: string,
  patch: {
    readonly casRoot?: string | undefined;
    readonly contributionMode?: GraphShareClientStateV1['contributionMode'];
    readonly coordinatorUrl?: string | undefined;
  },
) {
  return yield* withGraphShareClientStateLock(
    threadnoteHome,
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const layout = graphSharingLayout(path, threadnoteHome);
      const current = yield* readGraphShareClientState(threadnoteHome);
      const casRoot = patch.casRoot !== undefined ? patch.casRoot : current.casRoot;
      const contributionMode = patch.contributionMode !== undefined ? patch.contributionMode : current.contributionMode;
      const coordinatorUrl = patch.coordinatorUrl !== undefined ? patch.coordinatorUrl : current.coordinatorUrl;
      const state: GraphShareClientStateV1 = {
        schemaVersion: 1,
        ...(casRoot !== undefined && casRoot.trim().length > 0 ? {casRoot} : {}),
        ...(contributionMode === undefined ? {} : {contributionMode}),
        ...(coordinatorUrl === undefined || coordinatorUrl.trim().length === 0
          ? {}
          : {coordinatorUrl: parseGraphShareCoordinatorUrl(coordinatorUrl)}),
      };
      yield* writePrivateJsonFile(layout.clientStatePath, state);
      return state;
    }),
  );
});

export const resolveGraphShareCasRoot = Effect.fn('codeGraph.sharing.resolveCasRoot')(function* (
  threadnoteHome: string,
  casRoot?: string,
) {
  const path = yield* Path.Path;
  if (casRoot !== undefined && casRoot.trim().length > 0) return path.resolve(casRoot.trim());
  const state = yield* readGraphShareClientState(threadnoteHome);
  if (state.casRoot !== undefined && state.casRoot.trim().length > 0) return path.resolve(state.casRoot);
  return graphSharingLayout(path, threadnoteHome).casRoot;
});

function withGraphShareTrustReceiptsLock<A, E, R>(threadnoteHome: string, effect: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const layout = graphSharingLayout(path, threadnoteHome);
    return yield* withExclusiveFileLock(fs, layout.trustReceiptsLockPath, GRAPH_SHARE_TRUST_LOCK_OPTIONS, effect);
  });
}

function withGraphShareClientStateLock<A, E, R>(threadnoteHome: string, effect: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const layout = graphSharingLayout(path, threadnoteHome);
    return yield* withExclusiveFileLock(fs, layout.clientStateLockPath, GRAPH_SHARE_TRUST_LOCK_OPTIONS, effect);
  });
}

function parseTrustDocument(value: unknown): GraphShareTrustDocumentV1 {
  if (!isRecord(value) || value.schemaVersion !== GRAPH_SHARE_TRUST_SCHEMA_VERSION || !Array.isArray(value.receipts)) {
    throw graphSharingFailure('Trust receipts file is invalid.');
  }
  return {
    receipts: value.receipts.map(parseTrustReceipt),
    schemaVersion: GRAPH_SHARE_TRUST_SCHEMA_VERSION,
  };
}

function parseTrustReceipt(value: unknown): GraphShareTrustReceiptV1 {
  if (!isRecord(value) || value.policyVersion !== 1) {
    throw graphSharingFailure('Trust receipt is invalid.');
  }
  if (value.accessMode !== 'join' && value.accessMode !== 'read-only') {
    throw graphSharingFailure('Trust receipt access mode is invalid.');
  }
  return {
    accessMode: value.accessMode,
    organization: requiredText(value.organization),
    policyVersion: 1,
    profileDigest: requiredDigest(value.profileDigest),
    publisherKeyFingerprint: requiredDigest(value.publisherKeyFingerprint),
    registryCanonical: requiredText(value.registryCanonical),
    repositoryId: requiredHex(value.repositoryId),
  };
}

function parseClientState(value: unknown): GraphShareClientStateV1 {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw graphSharingFailure('Graph-sharing client state is invalid.');
  }
  if (value.casRoot !== undefined && (typeof value.casRoot !== 'string' || value.casRoot.trim().length === 0)) {
    throw graphSharingFailure('Graph-sharing CAS root is invalid.');
  }
  const contributionMode =
    value.contributionMode === 'off' ||
    value.contributionMode === 'passive' ||
    value.contributionMode === 'idle' ||
    value.contributionMode === 'dedicated'
      ? value.contributionMode
      : undefined;
  if (value.contributionMode !== undefined && contributionMode === undefined) {
    throw graphSharingFailure('Graph-sharing contribution mode is invalid.');
  }
  const coordinatorUrl =
    value.coordinatorUrl === undefined ? undefined : parseGraphShareCoordinatorUrl(String(value.coordinatorUrl));
  return {
    schemaVersion: 1,
    ...(value.casRoot === undefined ? {} : {casRoot: value.casRoot}),
    ...(contributionMode === undefined ? {} : {contributionMode}),
    ...(coordinatorUrl === undefined ? {} : {coordinatorUrl}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredText(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 512) {
    throw graphSharingFailure('Trust receipt text field is invalid.');
  }
  return value;
}

function requiredDigest(value: unknown): Sha256Digest {
  if (typeof value !== 'string' || !SHA256_DIGEST.test(value)) {
    throw graphSharingFailure('Trust receipt digest is invalid.');
  }
  return value as Sha256Digest;
}

function requiredHex(value: unknown): string {
  if (typeof value !== 'string' || !SHA256_HEX.test(value)) {
    throw graphSharingFailure('Trust receipt repository identity is invalid.');
  }
  return value;
}
