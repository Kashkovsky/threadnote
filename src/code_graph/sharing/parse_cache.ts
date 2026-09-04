import {Effect, FileSystem, Path, Schema} from 'effect';
import {canonicalJson} from '../checkpoint/canonical_json.js';
import type {BoundedCodeGraphFact} from '../fact_budget.js';
import type {CodeGraphStoreShape} from '../store_shape.js';
import type {CodeGraphDirectPersistentCapacityProtector} from '../store_models.js';
import type {CodeGraphInventoryFile, RepositoryIdentity} from '../types.js';
import {graphShareLanguageAndRole, graphShareParseActionKey} from './action.js';
import {decodeJsonBytes} from './atomic.js';
import {putCasBytes, readVerifiedCasBlob} from './cas.js';
import {
  graphShareControlAnnounceResult,
  graphShareControlGetCas,
  graphShareControlGetStatus,
  graphShareControlPutCas,
  graphShareControlPutTag,
  mirrorCoordinatorCasBlob,
} from './control_client.js';
import type {GraphShareResultAnnouncementV1} from './receipts.js';
import {
  enqueuePersistedGraphShareContribution,
  effectiveGraphShareContributionMode,
  readGraphShareContributionQueue,
  writeGraphShareContributionQueue,
} from './contribution.js';
import {sha256Digest, sha256HexFromDigest} from './digest.js';
import {graphSharingFailure, GraphSharingError} from './errors.js';
import {isGraphShareGitObjectId} from './git.js';
import {graphShareActionDiscoveryTag} from './namespace.js';
import {
  graphShareParseResultArtifact,
  parseGraphShareParseResult,
  type GraphShareParseResultV1,
} from './parse_result.js';
import {readGraphShareClientState, lookupGraphShareTrustReceipt, resolveGraphShareCasRoot} from './trust.js';

export const enqueueLocalGraphShareParseResults = Effect.fn('codeGraph.sharing.enqueueLocalParseResults')(
  function* (input: {
    readonly extractorSet: string;
    readonly facts: readonly BoundedCodeGraphFact[];
    readonly files: readonly CodeGraphInventoryFile[];
    readonly identity: Pick<RepositoryIdentity, 'headCommit' | 'repositoryId'>;
    readonly threadnoteHome: string;
  }) {
    const trust = yield* lookupGraphShareTrustReceipt(input.threadnoteHome, input.identity.repositoryId);
    const state = yield* readGraphShareClientState(input.threadnoteHome);
    const mode = effectiveGraphShareContributionMode(trust?.accessMode, state.contributionMode ?? 'off');
    if (mode === 'off') return {queued: 0};
    const casRoot = yield* resolveGraphShareCasRoot(input.threadnoteHome);
    const factsByPath = new Map(input.facts.map(fact => [fact.facts.path, fact]));
    const batchId = input.identity.headCommit.slice(0, 40);
    if (!/^[0-9a-f]{40}$/u.test(batchId)) return {queued: 0};
    let queued = 0;
    for (const file of input.files) {
      if (file.source !== 'commit' || !isGraphShareGitObjectId(file.blobId) || file.contentHash.length !== 64) continue;
      const fact = factsByPath.get(file.path);
      if (fact === undefined) continue;
      const artifact = graphShareParseResultArtifact({
        actionKey: graphShareParseActionKey({
          contentHash: file.contentHash,
          extractorSet: input.extractorSet,
          languageAndRole: graphShareLanguageAndRole(file.language, 'source'),
          normalizedPath: file.path,
          repositoryId: input.identity.repositoryId,
        }),
        contentHash: file.contentHash,
        extractorSet: input.extractorSet,
        facts: fact.facts,
        gitBlobId: file.blobId,
        languageAndRole: graphShareLanguageAndRole(file.language, 'source'),
        normalizedPath: file.path,
        repositoryId: input.identity.repositoryId,
      });
      const resultBytes = new TextEncoder().encode(canonicalJson(artifact));
      const resultManifestDigest = yield* putCasBytes(casRoot, resultBytes);
      const attestationDigest = yield* putCasBytes(
        casRoot,
        new TextEncoder().encode(
          canonicalJson({kind: 'contributor-self', payloadDigest: resultManifestDigest, schemaVersion: 1}),
        ),
      );
      const enqueued = yield* enqueuePersistedGraphShareContribution(
        input.threadnoteHome,
        input.identity.repositoryId,
        trust?.accessMode,
        {
          actionKey: artifact.actionKey,
          attestationDigest,
          batchId,
          resultManifestDigest,
          semanticDigest: artifact.semanticDigest,
        },
        mode,
      );
      if (enqueued.queued) queued += 1;
    }
    return {queued};
  },
);

export const drainQueuedGraphShareContributions = Effect.fn('codeGraph.sharing.drainQueuedContributions')(
  function* (input: {readonly identity: Pick<RepositoryIdentity, 'repositoryId'>; readonly threadnoteHome: string}) {
    const trust = yield* lookupGraphShareTrustReceipt(input.threadnoteHome, input.identity.repositoryId);
    const state = yield* readGraphShareClientState(input.threadnoteHome);
    const mode = effectiveGraphShareContributionMode(trust?.accessMode, state.contributionMode ?? 'off');
    if (mode === 'off' || state.coordinatorUrl === undefined) return {sent: 0};
    const queue = yield* readGraphShareContributionQueue(input.threadnoteHome, input.identity.repositoryId, mode);
    if (queue.announcements.length === 0) return {sent: 0};
    const casRoot = yield* resolveGraphShareCasRoot(input.threadnoteHome);
    const remaining = [];
    let sent = 0;
    for (const announcement of queue.announcements) {
      const drained = yield* drainOneAnnouncement(casRoot, state.coordinatorUrl, announcement).pipe(
        Effect.catchIf(
          error => Schema.is(GraphSharingError)(error) && error.kind === 'unavailable',
          () => Effect.succeed(false),
        ),
      );
      if (drained) sent += 1;
      else remaining.push(announcement);
    }
    yield* writeGraphShareContributionQueue(input.threadnoteHome, input.identity.repositoryId, {
      ...queue,
      announcements: remaining,
    });
    return {sent};
  },
);

export const hydrateSharedParseCache = Effect.fn('codeGraph.sharing.hydrateSharedParseCache')(function* (input: {
  readonly databasePath: string;
  readonly identity: RepositoryIdentity;
  readonly persistentCapacityProtector: CodeGraphDirectPersistentCapacityProtector;
  readonly store: CodeGraphStoreShape;
  readonly threadnoteHome: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(input.databasePath))) return {hydrated: 0};
  const state = yield* readGraphShareClientState(input.threadnoteHome);
  if (state.coordinatorUrl === undefined) return {hydrated: 0};
  const status = yield* graphShareControlGetStatus(state.coordinatorUrl).pipe(
    Effect.catchIf(
      error => Schema.is(GraphSharingError)(error) && error.kind === 'unavailable',
      () => Effect.void,
    ),
  );
  if (status === undefined || status.repositoryId !== input.identity.repositoryId) return {hydrated: 0};
  const quarantinedActionKeys = quarantinedGraphShareActionKeys(status.receipts);
  const casRoot = yield* resolveGraphShareCasRoot(input.threadnoteHome);
  let hydrated = 0;
  for (const receipt of status.receipts.slice(0, 256)) {
    if (quarantinedActionKeys.has(receipt.actionKey)) continue;
    const bytes = yield* graphShareControlGetCas(state.coordinatorUrl, receipt.resultManifestDigest).pipe(
      Effect.catchIf(
        error => Schema.is(GraphSharingError)(error),
        () => Effect.void,
      ),
    );
    if (bytes === undefined) continue;
    const parsed = yield* decodeJsonBytes(bytes).pipe(
      Effect.flatMap(value =>
        Effect.try({
          try: () => parseGraphShareParseResult(value),
          catch: cause =>
            Schema.is(GraphSharingError)(cause)
              ? cause
              : graphSharingFailure('Parse-result artifact is invalid.', cause),
        }),
      ),
      Effect.orElseSucceed(() => undefined),
    );
    if (
      parsed === undefined ||
      !admitsSharedParseCacheHydrate({
        identityRepositoryId: input.identity.repositoryId,
        parsed,
        quarantinedActionKeys,
        receipt,
      })
    ) {
      continue;
    }
    yield* putCasBytes(casRoot, bytes);
    const language = parsed.languageAndRole.split(':')[0] ?? 'unknown';
    yield* input.store.cacheFacts(
      input.databasePath,
      [
        {
          blobId: parsed.gitBlobId,
          contentHash: parsed.contentHash,
          language,
          mode: '100644',
          path: parsed.normalizedPath,
          size: 1,
          source: 'commit',
        },
      ],
      [parsed.facts],
      parsed.extractorSet,
      input.persistentCapacityProtector,
    );
    hydrated += 1;
  }
  return {hydrated};
});

export function quarantinedGraphShareActionKeys(
  receipts: readonly {readonly actionKey: string; readonly semanticDigest: string}[],
): ReadonlySet<string> {
  const digests = new Map<string, Set<string>>();
  for (const receipt of receipts) {
    const existing = digests.get(receipt.actionKey) ?? new Set<string>();
    existing.add(receipt.semanticDigest);
    digests.set(receipt.actionKey, existing);
  }
  return new Set(
    [...digests].filter(([, semanticDigests]) => semanticDigests.size > 1).map(([actionKey]) => actionKey),
  );
}

export interface VerifiedGraphShareParseReceipt {
  readonly announcement: GraphShareResultAnnouncementV1;
  readonly parsed: GraphShareParseResultV1;
}

export const verifyGraphShareParseReceipt = Effect.fn('codeGraph.sharing.verifyParseReceipt')(function* (input: {
  readonly announcement: GraphShareResultAnnouncementV1;
  readonly casRoot: string;
  readonly graphAbi?: string;
  readonly repositoryId: string;
}) {
  const resultBytes = yield* readVerifiedCasBlob(input.casRoot, input.announcement.resultManifestDigest);
  if (sha256Digest(resultBytes) !== input.announcement.resultManifestDigest) {
    return yield* graphSharingFailure('Parse-result CAS digest does not match the receipt.');
  }
  const parsed = parseGraphShareParseResult(yield* decodeJsonBytes(resultBytes));
  if (
    !admitsSharedParseCacheHydrate({
      identityRepositoryId: input.repositoryId,
      parsed,
      quarantinedActionKeys: new Set(),
      receipt: input.announcement,
    })
  ) {
    return yield* graphSharingFailure('Parse-result action key or repository does not match the receipt.');
  }
  if (parsed.semanticDigest !== input.announcement.semanticDigest) {
    return yield* graphSharingFailure('Parse-result semantic digest does not match the receipt.');
  }
  const attestationBytes = yield* readVerifiedCasBlob(input.casRoot, input.announcement.attestationDigest);
  const attestation = yield* decodeJsonBytes(attestationBytes);
  if (!isContributorSelfAttestation(attestation, input.announcement.resultManifestDigest)) {
    return yield* graphSharingFailure('Parse-result attestation does not match the receipt.');
  }
  if (input.graphAbi !== undefined && !/^[0-9a-f]{64}$/u.test(input.graphAbi)) {
    return yield* graphSharingFailure('Publisher graph ABI is invalid.');
  }
  return {announcement: input.announcement, parsed} satisfies VerifiedGraphShareParseReceipt;
});

export const hydratePublisherParseCache = Effect.fn('codeGraph.sharing.hydratePublisherParseCache')(function* (input: {
  readonly databasePath: string;
  readonly persistentCapacityProtector: CodeGraphDirectPersistentCapacityProtector;
  readonly store: CodeGraphStoreShape;
  readonly verified: readonly VerifiedGraphShareParseReceipt[];
}) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(input.databasePath)) || input.verified.length === 0) return {hydrated: 0};
  let hydrated = 0;
  for (const item of input.verified) {
    const language = item.parsed.languageAndRole.split(':')[0] ?? 'unknown';
    yield* input.store.cacheFacts(
      input.databasePath,
      [
        {
          blobId: item.parsed.gitBlobId,
          contentHash: item.parsed.contentHash,
          language,
          mode: '100644',
          path: item.parsed.normalizedPath,
          size: 1,
          source: 'commit',
        },
      ],
      [item.parsed.facts],
      item.parsed.extractorSet,
      input.persistentCapacityProtector,
    );
    hydrated += 1;
  }
  return {hydrated};
});

function isContributorSelfAttestation(value: unknown, payloadDigest: string): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify(['kind', 'payloadDigest', 'schemaVersion']) &&
    (value as {kind: unknown}).kind === 'contributor-self' &&
    (value as {schemaVersion: unknown}).schemaVersion === 1 &&
    (value as {payloadDigest: unknown}).payloadDigest === payloadDigest
  );
}

export function admitsSharedParseCacheHydrate(input: {
  readonly identityRepositoryId: string;
  readonly parsed: GraphShareParseResultV1;
  readonly quarantinedActionKeys: ReadonlySet<string>;
  readonly receipt: {readonly actionKey: string};
}): boolean {
  if (input.parsed.repositoryId !== input.identityRepositoryId) return false;
  if (input.quarantinedActionKeys.has(input.receipt.actionKey)) return false;
  const expected = graphShareParseActionKey({
    contentHash: input.parsed.contentHash,
    extractorSet: input.parsed.extractorSet,
    languageAndRole: input.parsed.languageAndRole,
    normalizedPath: input.parsed.normalizedPath,
    repositoryId: input.parsed.repositoryId,
  });
  return input.parsed.actionKey === input.receipt.actionKey && input.parsed.actionKey === expected;
}

export const mirrorCoordinatorCasBlobs = Effect.fn('codeGraph.sharing.mirrorCoordinatorCasBlobs')(function* (
  casRoot: string,
  coordinatorUrl: string,
  digests: readonly string[],
) {
  for (const digest of digests) {
    yield* mirrorCoordinatorCasBlob(casRoot, coordinatorUrl, digest);
  }
});

const drainOneAnnouncement = Effect.fn('codeGraph.sharing.drainOneAnnouncement')(function* (
  casRoot: string,
  coordinatorUrl: string,
  announcement: GraphShareResultAnnouncementV1,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const resultPath = path.join(casRoot, 'sha256', sha256HexFromDigest(announcement.resultManifestDigest));
  const attestationPath = path.join(casRoot, 'sha256', sha256HexFromDigest(announcement.attestationDigest));
  if (!(yield* fs.exists(resultPath)) || !(yield* fs.exists(attestationPath))) return false;
  const resultBytes = yield* fs.readFile(resultPath);
  const attestationBytes = yield* fs.readFile(attestationPath);
  yield* graphShareControlPutCas(coordinatorUrl, resultBytes);
  yield* graphShareControlPutCas(coordinatorUrl, attestationBytes);
  yield* graphShareControlPutTag(
    coordinatorUrl,
    graphShareActionDiscoveryTag(announcement.actionKey),
    announcement.resultManifestDigest,
  ).pipe(Effect.ignore);
  const announced = yield* graphShareControlAnnounceResult(
    coordinatorUrl,
    announcement,
    announcement.resultManifestDigest,
  );
  return announced.status === 200 || announced.status === 201 || announced.status === 409;
});
