import {access, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Effect} from 'effect';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {clearAutoShareStateForTest, publishShareGitChange} from '../../src/share.js';
import {
  runShareRemove as runShareRemoveEffect,
  runShareRename as runShareRenameEffect,
  runShareSetUrl as runShareSetUrlEffect,
  syncSharedReposBeforeAgentRead,
} from '../../src/effect/share.js';
import type {CommandResult, ShareRuntime, ShareTeamsFile} from '../../src/types.js';
import * as utils from '../../src/utils.js';
import {runEffect} from '../helpers/effect-runtime.js';

const runShareRemove = (...args: Parameters<typeof runShareRemoveEffect>) => runEffect(runShareRemoveEffect(...args));
const runShareRename = (...args: Parameters<typeof runShareRenameEffect>) => runEffect(runShareRenameEffect(...args));
const runShareSetUrl = (...args: Parameters<typeof runShareSetUrlEffect>) => runEffect(runShareSetUrlEffect(...args));

vi.mock('../../src/utils.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/utils.js')>();
  return {
    ...actual,
    requiredExecutable: vi.fn().mockReturnValue(Effect.succeed('git')),
    runCommand: vi.fn(),
    sleep: vi.fn().mockReturnValue(Effect.void),
  };
});

const ok = (stdout = ''): CommandResult => ({exitCode: 0, stderr: '', stdout});

async function makeRuntime(): Promise<ShareRuntime> {
  const home = await mkdtemp(join(tmpdir(), 'threadnote-share-admin-'));
  const worktree = join(home, 'share', 'worktrees', 'default');
  const gitdir = join(home, 'share', 'teams', 'default.gitdir');
  await mkdir(join(worktree, 'durable', 'projects', 'threadnote'), {recursive: true});
  await mkdir(gitdir, {recursive: true});
  await writeFile(
    join(worktree, 'durable', 'projects', 'threadnote', 'manager.md'),
    'MEMORY\nkind: durable\nstatus: active\n\nBody\n',
  );
  await mkdir(join(home, 'share'), {recursive: true});
  await writeFile(
    join(home, 'share', 'teams.json'),
    `${JSON.stringify(
      {
        defaultTeam: 'default',
        teams: {
          default: {
            addedAt: '2026-06-05T00:00:00.000Z',
            gitdir,
            name: 'default',
            remote: 'git@example.com:old/memories.git',
            worktree,
          },
        },
        version: 1,
      },
      undefined,
      2,
    )}\n`,
  );
  return {account: 'local', agentContextHome: home, agentId: 'threadnote', user: 'denys'};
}

async function readTeams(config: ShareRuntime): Promise<ShareTeamsFile> {
  return JSON.parse(await readFile(join(config.agentContextHome, 'share', 'teams.json'), 'utf8')) as ShareTeamsFile;
}

describe('share administration', () => {
  const homes: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    clearAutoShareStateForTest();
    vi.mocked(utils.requiredExecutable).mockReturnValue(Effect.succeed('git'));
    vi.mocked(utils.runCommand).mockImplementation(() => Effect.succeed(ok()));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    clearAutoShareStateForTest();
    vi.restoreAllMocks();
    await Promise.all(homes.splice(0).map(home => rm(home, {force: true, recursive: true})));
  });

  it('renames a share team, moves its worktree/gitdir, and updates teams.json', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);

    await runShareRename(config, {team: 'default', to: 'friends'});

    const teams = await readTeams(config);
    expect(teams.defaultTeam).toBe('friends');
    expect(teams.teams.friends?.name).toBe('friends');
    expect(teams.teams.friends?.worktree).toBe(join(config.agentContextHome, 'share', 'worktrees', 'friends'));
    expect(teams.teams.default).toBeUndefined();
    await access(join(config.agentContextHome, 'share', 'worktrees', 'friends'));
    await access(join(config.agentContextHome, 'data', 'local', 'user', 'denys', 'memories', 'shared', 'friends'));
    await access(join(config.agentContextHome, 'share', 'teams', 'friends.gitdir'));
  });

  it('changes the configured remote URL and verifies it with fetch', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);

    await runShareSetUrl(config, 'git@example.com:new/memories.git', {team: 'default'});

    const teams = await readTeams(config);
    expect(teams.teams.default?.remote).toBe('git@example.com:new/memories.git');
    expect(
      vi
        .mocked(utils.runCommand)
        .mock.calls.some(
          ([executable, args]) =>
            executable === 'git' &&
            args[0] === '-C' &&
            args[2] === 'remote' &&
            args[3] === 'set-url' &&
            args[5] === '--' &&
            args[6] === 'git@example.com:new/memories.git',
        ),
    ).toBe(true);
    expect(
      vi
        .mocked(utils.runCommand)
        .mock.calls.some(([executable, args]) => executable === 'git' && args.includes('fetch')),
    ).toBe(true);
  });

  it('uses a literal path separator for git rm during shared deletions', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);

    await runEffect(
      publishShareGitChange(join(config.agentContextHome, 'share-worktree'), '-dash.md', 'remove dash', {
        push: false,
        verb: 'rm',
      }),
    );

    expect(vi.mocked(utils.runCommand)).toHaveBeenCalledWith(
      'git',
      ['-C', join(config.agentContextHome, 'share-worktree'), 'rm', '--', '-dash.md'],
      {allowFailure: true},
    );
  });

  it('bounds automatic share fetch and upstream inspection commands', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);

    await runEffect(syncSharedReposBeforeAgentRead(config));

    expect(vi.mocked(utils.runCommand)).toHaveBeenCalledWith(
      'git',
      ['-C', join(config.agentContextHome, 'share', 'worktrees', 'default'), 'fetch', 'origin'],
      {allowFailure: true, timeoutMs: 5_000},
    );
    expect(vi.mocked(utils.runCommand)).toHaveBeenCalledWith(
      'git',
      ['-C', join(config.agentContextHome, 'share', 'worktrees', 'default'), 'rev-list', '--count', 'HEAD..@{u}'],
      {allowFailure: true, timeoutMs: 5_000},
    );
  });

  it('shares one fetch across twelve restarted reader states', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);

    for (let reader = 0; reader < 12; reader += 1) {
      clearAutoShareStateForTest();
      await runEffect(syncSharedReposBeforeAgentRead(config));
    }

    const commands = vi.mocked(utils.runCommand).mock.calls;
    const fetches = commands.filter(([, args]) => args[2] === 'fetch');
    const inspections = commands.filter(([, args]) => args[2] === 'rev-list');
    expect(fetches).toHaveLength(1);
    expect(inspections).toHaveLength(1);
    expect(commands).toHaveLength(2);
    await expect(
      readFile(join(config.agentContextHome, 'share', 'fetch-receipts', 'default.json'), 'utf8'),
    ).resolves.toContain('"succeeded":true');
  });

  it('serializes concurrent process states and reuses the completed fetch receipt', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    let markFetchStarted: (() => void) | undefined;
    let releaseFetch: (() => void) | undefined;
    const fetchStarted = new Promise<void>(resolve => {
      markFetchStarted = resolve;
    });
    const fetchBlocked = new Promise<void>(resolve => {
      releaseFetch = resolve;
    });
    vi.mocked(utils.runCommand).mockImplementation((_executable, args) => {
      if (args[2] === 'fetch') {
        return Effect.promise(async () => {
          markFetchStarted?.();
          await fetchBlocked;
          return ok();
        });
      }
      return Effect.succeed(ok());
    });

    const first = runEffect(syncSharedReposBeforeAgentRead(config));
    await fetchStarted;
    clearAutoShareStateForTest();
    const second = runEffect(syncSharedReposBeforeAgentRead(config));
    await new Promise(resolve => setTimeout(resolve, 40));
    releaseFetch?.();
    const results = await Promise.all([first, second]);

    const commands = vi.mocked(utils.runCommand).mock.calls;
    expect(commands.filter(([, args]) => args[2] === 'fetch')).toHaveLength(1);
    expect(commands.filter(([, args]) => args[2] === 'rev-list')).toHaveLength(1);
    expect(results).toEqual([
      {syncedTeams: [], warnings: []},
      {syncedTeams: [], warnings: []},
    ]);
  });

  it('repairs a corrupt fetch receipt by performing one fresh fetch', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const receipt = join(config.agentContextHome, 'share', 'fetch-receipts', 'default.json');
    await mkdir(join(config.agentContextHome, 'share', 'fetch-receipts'), {recursive: true});
    await writeFile(receipt, '{not-json\n');

    await runEffect(syncSharedReposBeforeAgentRead(config));

    expect(vi.mocked(utils.runCommand).mock.calls.filter(([, args]) => args[2] === 'fetch')).toHaveLength(1);
    await expect(readFile(receipt, 'utf8').then(content => JSON.parse(content))).resolves.toMatchObject({
      succeeded: true,
      team: 'default',
      version: 1,
    });
  });

  it('can preserve shared durable memories locally before removing a share', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);

    await runShareRemove(config, {preserveLocal: true, team: 'default'});

    const teams = await readTeams(config);
    expect(teams.teams.default).toBeUndefined();
    await expect(
      readFile(
        join(
          config.agentContextHome,
          'data',
          'local',
          'user',
          'denys',
          'memories',
          'durable',
          'projects',
          'threadnote',
          'manager.md',
        ),
        'utf8',
      ),
    ).resolves.toContain('Body');
    await expect(
      access(join(config.agentContextHome, 'data', 'local', 'user', 'denys', 'memories', 'shared', 'default')),
    ).rejects.toThrow();
  });
});
