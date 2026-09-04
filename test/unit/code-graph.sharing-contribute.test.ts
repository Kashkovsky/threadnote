import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer} from 'effect';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {
  enqueuePersistedGraphShareContribution,
  readGraphShareContributionQueue,
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
  effectIt.effect('queues locally when the coordinator is down and round-trips the queue', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-share-queue-'});
      const repositoryId = 'c'.repeat(64);
      const first = yield* enqueuePersistedGraphShareContribution(home, repositoryId, 'join', announcement, 'passive');
      expect(first.queued).toBe(true);
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
