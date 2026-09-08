import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer} from 'effect';
import {TestClock} from 'effect/testing';
import * as FC from 'effect/testing/FastCheck';
import {it} from 'vitest';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {
  enqueuePersistedGraphShareContribution,
  acknowledgeGraphShareContributions,
  readGraphShareContributionQueue,
  removeAcknowledgedGraphShareContributions,
} from '../../src/code_graph/sharing/contribution.js';
import {sha256Digest} from '../../src/code_graph/sharing/digest.js';
import {SystemInfo} from '../../src/effect/system.js';

const sharingLayer = SystemInfo.layer.pipe(Layer.provideMerge(BunServices.layer));

const announcement = {
  actionKey: 'a'.repeat(64),
  attestationDigest: sha256Digest('1'),
  batchId: 'b'.repeat(40),
  resultManifestDigest: sha256Digest('2'),
  semanticDigest: sha256Digest('3'),
};

describe('graph share contribution queue persistence', () => {
  it('acknowledgement preserves unsent order and is idempotent without mutating its inputs', () => {
    FC.assert(
      FC.property(FC.array(FC.boolean(), {maxLength: 32}), flags => {
        const announcements = flags.map((_, index) => ({
          ...announcement,
          batchId: index.toString(16).padStart(40, '0'),
        }));
        const queue = {announcements, mode: 'passive' as const, schemaVersion: 1 as const};
        const sent = announcements.filter((_, index) => flags[index]);
        const before = JSON.stringify({queue, sent});
        const remaining = removeAcknowledgedGraphShareContributions(queue, sent);
        expect(remaining.announcements).toEqual(announcements.filter((_, index) => !flags[index]));
        expect(removeAcknowledgedGraphShareContributions(remaining, sent)).toEqual(remaining);
        expect(JSON.stringify({queue, sent})).toBe(before);
      }),
      {numRuns: 50},
    );
  });

  effectIt.effect('acknowledges a drained snapshot without dropping contributions queued during upload', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-queue-ack-'});
        const repositoryId = 'c'.repeat(64);
        yield* enqueuePersistedGraphShareContribution(home, repositoryId, 'join', announcement, 'passive');
        const snapshot = yield* readGraphShareContributionQueue(home, repositoryId, 'passive');
        const added = {...announcement, actionKey: 'd'.repeat(64)};
        yield* enqueuePersistedGraphShareContribution(home, repositoryId, 'join', added, 'passive');
        yield* acknowledgeGraphShareContributions(home, repositoryId, snapshot.announcements, 'passive');
        yield* acknowledgeGraphShareContributions(home, repositoryId, snapshot.announcements, 'passive');
        expect((yield* readGraphShareContributionQueue(home, repositoryId, 'passive')).announcements).toEqual([added]);
      }).pipe(provideTestLayer(sharingLayer)),
    ),
  );

  effectIt.effect('retains every distinct contribution from concurrent producers', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-queue-concurrent-'});
        const repositoryId = 'c'.repeat(64);
        const additions = Array.from({length: 12}, (_, index) => ({
          ...announcement,
          actionKey: index.toString(16).padStart(64, '0'),
        }));
        yield* Effect.forEach(
          additions,
          item => enqueuePersistedGraphShareContribution(home, repositoryId, 'join', item, 'passive'),
          {concurrency: 12},
        );
        const persisted = yield* readGraphShareContributionQueue(home, repositoryId, 'passive');
        expect(new Set(persisted.announcements.map(item => item.actionKey))).toEqual(
          new Set(additions.map(item => item.actionKey)),
        );
      }).pipe(provideTestLayer(sharingLayer)),
    ),
  );

  effectIt.effect('queues locally when the coordinator is down and round-trips the queue', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-share-queue-'});
      const repositoryId = 'c'.repeat(64);
      const first = yield* enqueuePersistedGraphShareContribution(home, repositoryId, 'join', announcement, 'passive');
      expect(first.queued).toBe(true);
      if ((yield* SystemInfo).platform !== 'win32') {
        expect((yield* fs.stat(`${home}/graph-sharing/contribution`)).mode & 0o777).toBe(0o700);
      }
      const duplicate = yield* enqueuePersistedGraphShareContribution(
        home,
        repositoryId,
        'join',
        announcement,
        'passive',
      );
      expect(duplicate.queued).toBe(false);
      const loaded = yield* readGraphShareContributionQueue(home, repositoryId, 'passive');
      expect(loaded.announcements).toHaveLength(1);
      const blocked = yield* enqueuePersistedGraphShareContribution(
        home,
        `${repositoryId.slice(0, -1)}d`,
        'read-only',
        announcement,
        'passive',
      );
      expect(blocked.queued).toBe(false);
    }).pipe(provideTestLayer(sharingLayer)),
  );
});
