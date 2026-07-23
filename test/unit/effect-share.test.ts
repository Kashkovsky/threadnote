import {NodeCrypto, NodeFileSystem, NodePath} from '@effect/platform-node';
import {Effect, Layer} from 'effect';
import {afterEach, describe, expect, it, vi} from 'vitest';

const shareMocks = vi.hoisted(() => ({
  resolveTeam: vi.fn(),
  runSharePublish: vi.fn(),
  sharedUriFor: vi.fn(),
  unused: vi.fn(),
}));

vi.mock('../../src/share.js', () => ({
  installSharedAgentArtifacts: shareMocks.unused,
  listSharedAgentArtifacts: shareMocks.unused,
  removeMemoryUri: shareMocks.unused,
  resolveShareConflict: shareMocks.unused,
  resolveTeam: shareMocks.resolveTeam,
  runShareConflictResolve: shareMocks.unused,
  runShareConflicts: shareMocks.unused,
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
  runShareSync: shareMocks.unused,
  runShareUnpublish: shareMocks.unused,
  sharedUriFor: shareMocks.sharedUriFor,
}));

import {runSharePublish} from '../../src/effect/share.js';
import {mkdtemp, rm} from '../helpers/effect-filesystem.js';

const TestLayer = Layer.mergeAll(NodeCrypto.layer, NodeFileSystem.layer, NodePath.layer);

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
    shareMocks.resolveTeam.mockImplementation(async () => {
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
    });
    shareMocks.sharedUriFor.mockReturnValue(
      'viking://user/test-user/memories/shared/alpha/durable/projects/threadnote/recall.md',
    );
    shareMocks.runSharePublish.mockImplementation(async (_config, _sourceUri, options) => {
      publishedTeam = options.team ?? simulatedDefault;
    });

    await Effect.runPromise(
      runSharePublish(
        {
          account: 'local',
          agentContextHome,
          agentId: 'threadnote',
          user: 'test-user',
        },
        'viking://user/test-user/memories/durable/projects/threadnote/recall.md',
        {},
      ).pipe(Effect.provide(TestLayer)),
    );

    expect(publishedTeam).toBe('alpha');
    expect(shareMocks.runSharePublish).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(String),
      expect.objectContaining({team: 'alpha'}),
    );
  });
});
