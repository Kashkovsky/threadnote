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
  readonly client?: GraphShareRepositoryClientV1;
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

export interface GraphShareRepositoryClientV1 {
  readonly casRoot: string;
  readonly contributionMode: NonNullable<GraphShareClientStateV1['contributionMode']>;
  readonly coordinatorUrl?: string;
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
  options?: {readonly preserveContributionMode?: boolean},
) {
  return yield* withGraphShareTrustReceiptsLock(
    threadnoteHome,
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const layout = graphSharingLayout(path, threadnoteHome);
      const document = yield* readGraphShareTrustDocument(threadnoteHome);
      const previous = document.receipts.find(item => item.repositoryId === receipt.repositoryId);
      const stored =
        options?.preserveContributionMode &&
        previous?.accessMode === 'join' &&
        receipt.accessMode === 'join' &&
        previous.profileDigest === receipt.profileDigest &&
        previous.client !== undefined &&
        receipt.client !== undefined
          ? {...receipt, client: {...receipt.client, contributionMode: previous.client.contributionMode}}
          : receipt;
      const receipts = [...document.receipts.filter(item => item.repositoryId !== receipt.repositoryId), stored].sort(
        (left, right) => (left.repositoryId < right.repositoryId ? -1 : left.repositoryId > right.repositoryId ? 1 : 0),
      );
      yield* writePrivateJsonFile(layout.trustReceiptsPath, {
        receipts,
        schemaVersion: GRAPH_SHARE_TRUST_SCHEMA_VERSION,
      } satisfies GraphShareTrustDocumentV1);
      return stored;
    }),
  );
});

export const writeGraphShareRepositoryContributionMode = Effect.fn('codeGraph.sharing.writeRepositoryContributionMode')(
  function* (
    threadnoteHome: string,
    expected: GraphShareTrustReceiptV1,
    client: GraphShareRepositoryClientV1,
    requested: GraphShareRepositoryClientV1['contributionMode'],
  ) {
    return yield* withGraphShareTrustReceiptsLock(
      threadnoteHome,
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const document = yield* readGraphShareTrustDocument(threadnoteHome);
        const current = document.receipts.find(item => item.repositoryId === expected.repositoryId);
        if (current === undefined || current.profileDigest !== expected.profileDigest) return 'off' as const;
        const mode = current.accessMode === 'join' ? requested : 'off';
        const updated = {...current, client: {...(current.client ?? client), contributionMode: mode}};
        yield* writePrivateJsonFile(graphSharingLayout(path, threadnoteHome).trustReceiptsPath, {
          ...document,
          receipts: document.receipts.map(item => (item.repositoryId === current.repositoryId ? updated : item)),
        });
        return mode;
      }),
    );
  },
);

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
    yield* fs.makeDirectory(layout.root, {recursive: true, mode: 0o700});
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
    ...(value.client === undefined ? {} : {client: parseRepositoryClient(value.client)}),
    organization: requiredText(value.organization),
    policyVersion: 1,
    profileDigest: requiredDigest(value.profileDigest),
    publisherKeyFingerprint: requiredDigest(value.publisherKeyFingerprint),
    registryCanonical: requiredText(value.registryCanonical),
    repositoryId: requiredHex(value.repositoryId),
  };
}

function parseRepositoryClient(value: unknown): GraphShareRepositoryClientV1 {
  if (!isRecord(value)) throw graphSharingFailure('Repository graph-sharing settings are invalid.');
  const parsed = parseClientState({...value, schemaVersion: 1});
  if (parsed.casRoot === undefined || parsed.contributionMode === undefined) {
    throw graphSharingFailure('Repository graph-sharing settings are incomplete.');
  }
  return {
    casRoot: parsed.casRoot,
    contributionMode: parsed.contributionMode,
    ...(parsed.coordinatorUrl === undefined ? {} : {coordinatorUrl: parsed.coordinatorUrl}),
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
