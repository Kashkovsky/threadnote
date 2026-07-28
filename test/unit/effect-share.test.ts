import {Effect, Fiber} from 'effect';
import {afterEach, describe, expect, it, vi} from 'vitest';

const shareMocks = vi.hoisted(() => ({
  resolveTeam: vi.fn(),
  runShareConflicts: vi.fn(),
  runSharePublish: vi.fn(),
  runShareSync: vi.fn(),
  shareAgentArtifact: vi.fn(),
  shareBundlePack: vi.fn(),
  refreshSharedReposInBackground: vi.fn(),
  syncSharedReposBeforeAgentRead: vi.fn(),
  sharedUriFor: vi.fn(),
  unused: vi.fn(),
}));

vi.mock('../../src/share.js', () => ({
  installSharedAgentArtifacts: shareMocks.unused,
  listShareConflicts: shareMocks.unused,
  listSharedAgentArtifacts: shareMocks.unused,
  removeMemoryUri: shareMocks.unused,
  refreshSharedReposInBackground: shareMocks.refreshSharedReposInBackground,
  resolveShareConflict: shareMocks.unused,
  resolveTeam: shareMocks.resolveTeam,
  runShareConflictResolve: shareMocks.unused,
  runShareConflicts: shareMocks.runShareConflicts,
  runShareConflictShow: shareMocks.unused,
  runShareInit: shareMocks.unused,
  runShareInstallArtifacts: shareMocks.unused,
  runShareList: shareMocks.unused,
  runSharePublish: shareMocks.runSharePublish,
  runSharePublishArtifact: shareMocks.unused,
  runSharePublishBundle: shareMocks.unused,
  runShareRemove: shareMocks.unused,
  runShareRename: shareMocks.unused,
  runShareSetUrl: shareMocks.unused,
  runShareStatus: shareMocks.unused,
  runShareSync: shareMocks.runShareSync,
  runShareUnpublish: shareMocks.unused,
  shareAgentArtifact: shareMocks.shareAgentArtifact,
  shareBundlePack: shareMocks.shareBundlePack,
  SHARED_BACKGROUND_FETCH_INTERVAL_MILLISECONDS: 300_000,
  sharedUriFor: shareMocks.sharedUriFor,
  showShareConflict: shareMocks.unused,
  syncSharedReposBeforeAgentRead: shareMocks.syncSharedReposBeforeAgentRead,
}));

import {
  runShareConflicts,
  runSharePublish,
  runShareSync,
  syncSharedReposBeforeAgentRead,
} from '../../src/effect/share.js';
import {mkdtemp, rm} from '../helpers/effect-filesystem.js';
import {runEffect} from '../helpers/effect-runtime.js';

describe('Effect share transaction', () => {
  const homes: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    await Promise.all(homes.splice(0).map(home => rm(home, {force: true, recursive: true})));
  });

  it('pins the resolved default team for both target locking and publication', async () => {
    const agentContextHome = await mkdtemp('threadnote-effect-share-');
    homes.push(agentContextHome);
    let simulatedDefault = 'alpha';
    let publishedTeam: string | undefined;
    shareMocks.resolveTeam.mockImplementation(() =>
      Effect.sync(() => {
        simulatedDefault = 'beta';
        return {
          config: {
            addedAt: '2026-07-23T00:00:00.000Z',
            gitdir: '/test/alpha.git',
            name: 'alpha',
            remote: 'git@example.com:test/alpha.git',
            worktree: '/test/alpha',
          },
          name: 'alpha',
        };
      }),
    );
    shareMocks.sharedUriFor.mockReturnValue(
      'threadnote://user/test-user/memories/shared/alpha/durable/projects/threadnote/recall.md',
    );
    shareMocks.runSharePublish.mockImplementation((_config, _sourceUri, options) =>
      Effect.sync(() => {
        publishedTeam = options.team ?? simulatedDefault;
      }),
    );

    await runEffect(
      runSharePublish(
        {
          account: 'local',
          agentContextHome,
          agentId: 'threadnote',
          user: 'test-user',
        },
        'threadnote://user/test-user/memories/durable/projects/threadnote/recall.md',
        {},
      ),
    );

    expect(publishedTeam).toBe('alpha');
    expect(shareMocks.runSharePublish).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(String),
      expect.objectContaining({team: 'alpha'}),
    );
  });

  it('keeps explicit sync blocked when an interrupted auto-sync Promise is still running', async () => {
    const agentContextHome = await mkdtemp('threadnote-effect-share-sync-');
    homes.push(agentContextHome);
    const events: string[] = [];
    let markFirstStarted: (() => void) | undefined;
    let releaseFirst: (() => void) | undefined;
    const firstStarted = new Promise<void>(resolve => {
      markFirstStarted = resolve;
    });
    const firstBlocked = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    const config = {
      account: 'local',
      agentContextHome,
      agentId: 'threadnote',
      user: 'test-user',
    };

    await runEffect(
      Effect.gen(function* () {
        shareMocks.syncSharedReposBeforeAgentRead.mockImplementationOnce(() =>
          Effect.gen(function* () {
            events.push('first:start');
            markFirstStarted?.();
            yield* Effect.promise(() => firstBlocked);
            events.push('first:end');
            return {syncedTeams: [], warnings: []};
          }),
        );
        shareMocks.runShareSync.mockImplementationOnce(() =>
          Effect.sync(() => {
            events.push('second:start');
          }),
        );

        const first = yield* Effect.forkChild(syncSharedReposBeforeAgentRead(config));
        yield* Effect.promise(() => firstStarted);
        const interruption = yield* Effect.forkChild(Fiber.interrupt(first));
        yield* Effect.yieldNow;
        const second = yield* Effect.forkChild(runShareSync(config, {}));
        yield* Effect.yieldNow;
        expect(events).toEqual(['first:start']);
        yield* Effect.sync(() => releaseFirst?.());
        yield* Fiber.join(interruption);
        yield* Fiber.join(second);
      }),
    );

    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('lets automatic reads silently use the local snapshot when the share lock is busy', async () => {
    const agentContextHome = await mkdtemp('threadnote-effect-share-read-lock-');
    homes.push(agentContextHome);
    let markSyncStarted: (() => void) | undefined;
    let releaseSync: (() => void) | undefined;
    const syncStarted = new Promise<void>(resolve => {
      markSyncStarted = resolve;
    });
    const syncBlocked = new Promise<void>(resolve => {
      releaseSync = resolve;
    });
    let automaticReadEntered = false;
    const config = {
      account: 'local',
      agentContextHome,
      agentId: 'threadnote',
      user: 'test-user',
    };

    await runEffect(
      Effect.gen(function* () {
        shareMocks.runShareSync.mockImplementationOnce(() =>
          Effect.gen(function* () {
            markSyncStarted?.();
            yield* Effect.promise(() => syncBlocked);
          }),
        );
        shareMocks.syncSharedReposBeforeAgentRead.mockImplementationOnce(() =>
          Effect.sync(() => {
            automaticReadEntered = true;
            return {syncedTeams: [], warnings: []};
          }),
        );
        const explicitSync = yield* Effect.forkChild(runShareSync(config, {}));
        yield* Effect.promise(() => syncStarted);
        const startedAt = Date.now();
        const automaticRead = yield* syncSharedReposBeforeAgentRead(config);
        const elapsed = Date.now() - startedAt;
        releaseSync?.();
        yield* Fiber.join(explicitSync);

        expect(automaticRead).toEqual({syncedTeams: [], warnings: []});
        expect(elapsed).toBeLessThan(2_000);
        expect(automaticReadEntered).toBe(false);
      }),
    );
  });

  it('keeps sync blocked while conflict inspection refreshes pending state', async () => {
    const agentContextHome = await mkdtemp('threadnote-effect-share-conflicts-');
    homes.push(agentContextHome);
    const events: string[] = [];
    let markInspectionStarted: (() => void) | undefined;
    let releaseInspection: (() => void) | undefined;
    const inspectionStarted = new Promise<void>(resolve => {
      markInspectionStarted = resolve;
    });
    const inspectionBlocked = new Promise<void>(resolve => {
      releaseInspection = resolve;
    });
    const config = {
      account: 'local',
      agentContextHome,
      agentId: 'threadnote',
      user: 'test-user',
    };
    shareMocks.runShareConflicts.mockImplementationOnce(() =>
      Effect.gen(function* () {
        events.push('inspection:start');
        markInspectionStarted?.();
        yield* Effect.promise(() => inspectionBlocked);
        events.push('inspection:end');
        return [];
      }),
    );
    shareMocks.runShareSync.mockImplementationOnce(() =>
      Effect.sync(() => {
        events.push('sync:start');
      }),
    );

    await runEffect(
      Effect.gen(function* () {
        const inspection = yield* Effect.forkChild(runShareConflicts(config, {}));
        yield* Effect.promise(() => inspectionStarted);
        const sync = yield* Effect.forkChild(runShareSync(config, {}));
        yield* Effect.yieldNow;
        expect(events).toEqual(['inspection:start']);
        yield* Effect.sync(() => releaseInspection?.());
        yield* Fiber.join(inspection);
        yield* Fiber.join(sync);
      }),
    );

    expect(events).toEqual(['inspection:start', 'inspection:end', 'sync:start']);
  });
});
