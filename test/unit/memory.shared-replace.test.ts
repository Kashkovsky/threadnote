import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {runRemember} from '../../src/memory.js';
import type {RuntimeConfig} from '../../src/types.js';

async function makeRuntime(): Promise<RuntimeConfig> {
  const home = await mkdtemp(join(tmpdir(), 'threadnote-shared-replace-'));
  const worktree = join(home, 'shared', 'default');
  const gitdir = join(home, 'share', 'teams', 'default.gitdir');
  await mkdir(join(home, 'share'), {recursive: true});
  await writeFile(
    join(home, 'share', 'teams.json'),
    `${JSON.stringify(
      {
        defaultTeam: 'default',
        teams: {
          default: {
            addedAt: '2026-06-03T00:00:00.000Z',
            gitdir,
            name: 'default',
            remote: 'git@example.com:team/memories.git',
            worktree,
          },
        },
        version: 1,
      },
      undefined,
      2,
    )}\n`,
  );
  return {
    account: 'local',
    agentContextHome: home,
    agentId: 'threadnote',
    host: '127.0.0.1',
    manifestPath: join(home, 'manifest.json'),
    openVikingVersion: '0.0.0',
    port: 1933,
    user: 'denyskashkovskyi',
  };
}

describe('remember shared replacement', () => {
  const homes: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(homes.splice(0).map(home => rm(home, {force: true, recursive: true})));
  });

  it('updates a shared replaceUri in place instead of writing personal memory and forgetting shared copy', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: readonly unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    const sharedUri = 'viking://user/denyskashkovskyi/memories/shared/default/durable/projects/mobile-native/auth.md';
    await runRemember(config, {
      dryRun: true,
      kind: 'durable',
      replace: sharedUri,
      sourceAgentClient: 'codex',
      text: 'Updated shared auth memory.',
    });

    const output = logs.join('\n');
    expect(output).toContain(sharedUri);
    expect(output).toContain('project: mobile-native');
    expect(output).toContain('topic: auth');
    expect(output).toContain('--mode replace');
    expect(output).toContain('share: update durable/projects/mobile-native/auth.md');
    expect(output).toContain('Updated shared memory:');
    expect(output).not.toContain('supersedes:');
    expect(output).not.toContain(` rm ${sharedUri}`);
    expect(output).not.toContain('memories/durable/projects/mobile-native/auth.md --from-file');
  });

  it('rejects non-durable shared replacements', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    await expect(
      runRemember(config, {
        dryRun: true,
        kind: 'handoff',
        replace: 'viking://user/denyskashkovskyi/memories/shared/default/durable/projects/foo/bar.md',
        text: 'Not shareable.',
      }),
    ).rejects.toThrow(/only supports durable/);
  });
});
