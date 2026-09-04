import {Effect, FileSystem, Path} from 'effect';
import {readJsonFile, writePrivateJsonFile} from './atomic.js';
import {SHA256_DIGEST} from './digest.js';
import {graphSharingFailure} from './errors.js';
import {graphSharingContributionQueuePath, graphSharingLayout} from './layout.js';
import {GRAPH_SHARE_ACTION_KEY} from './action.js';
import type {GraphShareResultAnnouncementV1} from './receipts.js';

export const GRAPH_SHARE_CONTRIBUTION_MODES = ['off', 'passive', 'idle', 'dedicated'] as const;
export type GraphShareContributionMode = (typeof GRAPH_SHARE_CONTRIBUTION_MODES)[number];

export interface GraphShareContributionQueueV1 {
  readonly announcements: readonly GraphShareResultAnnouncementV1[];
  readonly mode: GraphShareContributionMode;
  readonly schemaVersion: 1;
}

export function emptyGraphShareContributionQueue(
  mode: GraphShareContributionMode = 'off',
): GraphShareContributionQueueV1 {
  return {announcements: [], mode, schemaVersion: 1};
}

export function effectiveGraphShareContributionMode(
  accessMode: 'join' | 'read-only' | undefined,
  requested: GraphShareContributionMode,
): GraphShareContributionMode {
  if (accessMode !== 'join') return 'off';
  if (requested === 'dedicated') return 'passive';
  return requested;
}

export function enqueueGraphShareContribution(
  queue: GraphShareContributionQueueV1,
  announcement: GraphShareResultAnnouncementV1,
  accessMode: 'join' | 'read-only' | undefined,
): {readonly conflict: boolean; readonly queued: boolean; readonly queue: GraphShareContributionQueueV1} {
  const mode = effectiveGraphShareContributionMode(accessMode, queue.mode);
  if (mode === 'off') return {conflict: false, queued: false, queue};
  const duplicate = queue.announcements.some(
    item =>
      item.actionKey === announcement.actionKey &&
      item.resultManifestDigest === announcement.resultManifestDigest &&
      item.attestationDigest === announcement.attestationDigest &&
      item.semanticDigest === announcement.semanticDigest,
  );
  if (duplicate) return {conflict: false, queued: false, queue};
  const conflict = queue.announcements.some(
    item => item.actionKey === announcement.actionKey && item.semanticDigest !== announcement.semanticDigest,
  );
  return {
    conflict,
    queued: true,
    queue: {...queue, announcements: [...queue.announcements, announcement], mode},
  };
}

export function drainGraphShareContribution(queue: GraphShareContributionQueueV1): {
  readonly remaining: GraphShareContributionQueueV1;
  readonly sent: readonly GraphShareResultAnnouncementV1[];
} {
  return {
    remaining: {...queue, announcements: []},
    sent: queue.announcements,
  };
}

export function parseGraphShareContributionQueue(value: unknown): GraphShareContributionQueueV1 {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw graphSharingFailure('Contribution queue is invalid.');
  }
  if (!isContributionMode(value.mode) || !Array.isArray(value.announcements)) {
    throw graphSharingFailure('Contribution queue is invalid.');
  }
  return {
    announcements: value.announcements.map(parseQueuedAnnouncement),
    mode: value.mode,
    schemaVersion: 1,
  };
}

export const readGraphShareContributionQueue = Effect.fn('codeGraph.sharing.readContributionQueue')(function* (
  threadnoteHome: string,
  repositoryId: string,
  mode: GraphShareContributionMode,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const queuePath = graphSharingContributionQueuePath(
    path,
    graphSharingLayout(path, threadnoteHome).root,
    repositoryId,
  );
  if (!(yield* fs.exists(queuePath))) return emptyGraphShareContributionQueue(mode);
  return parseGraphShareContributionQueue(yield* readJsonFile(queuePath));
});

export const writeGraphShareContributionQueue = Effect.fn('codeGraph.sharing.writeContributionQueue')(function* (
  threadnoteHome: string,
  repositoryId: string,
  queue: GraphShareContributionQueueV1,
) {
  const path = yield* Path.Path;
  yield* writePrivateJsonFile(
    graphSharingContributionQueuePath(path, graphSharingLayout(path, threadnoteHome).root, repositoryId),
    queue,
  );
  return queue;
});

export const enqueuePersistedGraphShareContribution = Effect.fn('codeGraph.sharing.enqueuePersistedContribution')(
  function* (
    threadnoteHome: string,
    repositoryId: string,
    accessMode: 'join' | 'read-only' | undefined,
    announcement: GraphShareResultAnnouncementV1,
    mode: GraphShareContributionMode,
  ) {
    const current = yield* readGraphShareContributionQueue(threadnoteHome, repositoryId, mode);
    const next = enqueueGraphShareContribution({...current, mode}, announcement, accessMode);
    if (next.queued) yield* writeGraphShareContributionQueue(threadnoteHome, repositoryId, next.queue);
    return next;
  },
);

function parseQueuedAnnouncement(value: unknown): GraphShareResultAnnouncementV1 {
  if (!isRecord(value)) throw graphSharingFailure('Contribution announcement is invalid.');
  const announcement: GraphShareResultAnnouncementV1 = {
    actionKey: value.actionKey as GraphShareResultAnnouncementV1['actionKey'],
    attestationDigest: value.attestationDigest as GraphShareResultAnnouncementV1['attestationDigest'],
    batchId: value.batchId as string,
    resultManifestDigest: value.resultManifestDigest as GraphShareResultAnnouncementV1['resultManifestDigest'],
    semanticDigest: value.semanticDigest as GraphShareResultAnnouncementV1['semanticDigest'],
  };
  if (typeof value.actionKey !== 'string' || !GRAPH_SHARE_ACTION_KEY.test(value.actionKey)) {
    throw graphSharingFailure('Contribution announcement action key is invalid.');
  }
  if (typeof value.batchId !== 'string' || !/^[0-9a-f]{40}$/u.test(value.batchId)) {
    throw graphSharingFailure('Contribution announcement batch is invalid.');
  }
  if (typeof value.attestationDigest !== 'string' || !SHA256_DIGEST.test(value.attestationDigest)) {
    throw graphSharingFailure('Contribution announcement attestation digest is invalid.');
  }
  if (typeof value.resultManifestDigest !== 'string' || !SHA256_DIGEST.test(value.resultManifestDigest)) {
    throw graphSharingFailure('Contribution announcement result digest is invalid.');
  }
  if (typeof value.semanticDigest !== 'string' || !SHA256_DIGEST.test(value.semanticDigest)) {
    throw graphSharingFailure('Contribution announcement semantic digest is invalid.');
  }
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(Object.keys(announcement).sort())) {
    throw graphSharingFailure('Contribution announcement contains unsupported fields.');
  }
  return announcement;
}

function isContributionMode(value: unknown): value is GraphShareContributionMode {
  return typeof value === 'string' && (GRAPH_SHARE_CONTRIBUTION_MODES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
