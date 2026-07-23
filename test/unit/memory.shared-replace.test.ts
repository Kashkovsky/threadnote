import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Effect} from 'effect';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {runRemember} from '../../src/memory.js';
import type {CommandResult, RuntimeConfig} from '../../src/types.js';
import * as utils from '../../src/utils.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';

const runTestEffect = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect);

vi.mock('../../src/utils.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/utils.js')>();
  return {
    ...actual,
    maybeRun: vi.fn(),
    openVikingCliForMode: vi.fn().mockReturnValue(Effect.succeed('/ov')),
    requiredExecutable: vi.fn().mockReturnValue(Effect.succeed('git')),
    runCommand: vi.fn(),
    sleep: vi.fn().mockReturnValue(Effect.void),
  };
});

const ok = (stdout = ''): CommandResult => ({exitCode: 0, stdout, stderr: ''});
const fail = (stderr: string): CommandResult => ({exitCode: 1, stdout: '', stderr});

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
    user: 'test-user',
  };
}

describe('remember shared replacement', () => {
  const homes: string[] = [];

  beforeEach(() => {
    vi.mocked(utils.maybeRun).mockImplementation((dryRun, executable, args, options) =>
      dryRun ? Effect.succeed(undefined) : vi.mocked(utils.runCommand)(executable, args, options),
    );
    vi.mocked(utils.openVikingCliForMode).mockReturnValue(Effect.succeed('/ov'));
    vi.mocked(utils.requiredExecutable).mockReturnValue(Effect.succeed('git'));
    vi.mocked(utils.runCommand).mockReset();
  });

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

    const sharedUri = 'viking://user/test-user/memories/shared/default/durable/projects/mobile-native/auth.md';
    await runTestEffect(
      runRemember(config, {
        dryRun: true,
        kind: 'durable',
        replace: sharedUri,
        sourceAgentClient: 'codex',
        text: 'Updated shared auth memory.',
      }).pipe(Effect.provide(ApplicationLayer)),
    );

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

  it('keeps the project from the storage path when the caller requests a different one', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: readonly unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    const sharedUri = 'viking://user/test-user/memories/shared/default/durable/projects/mobile-native/auth.md';
    await runTestEffect(
      runRemember(config, {
        dryRun: true,
        kind: 'durable',
        project: 'coda', // differs from the path project (mobile-native)
        replace: sharedUri,
        sourceAgentClient: 'codex',
        text: 'Updated shared auth memory.',
      }).pipe(Effect.provide(ApplicationLayer)),
    );

    const output = logs.join('\n');
    // Frontmatter tracks the path, not the differing request — no divergence.
    expect(output).toContain('project: mobile-native');
    expect(output).not.toContain('project: coda');
    expect(output).toContain('keeping shared memory project "mobile-native"');
    expect(output).toContain('ignoring requested "coda"');
  });

  it('does not warn when the caller project matches the storage path', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: readonly unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    const sharedUri = 'viking://user/test-user/memories/shared/default/durable/projects/mobile-native/auth.md';
    await runTestEffect(
      runRemember(config, {
        dryRun: true,
        kind: 'durable',
        project: 'mobile-native', // matches the path project → no drift
        replace: sharedUri,
        sourceAgentClient: 'codex',
        text: 'Updated shared auth memory.',
      }).pipe(Effect.provide(ApplicationLayer)),
    );

    const output = logs.join('\n');
    expect(output).toContain('project: mobile-native');
    expect(output).not.toContain('keeping shared memory project');
  });

  it('rejects non-durable shared replacements', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    await expect(
      runTestEffect(
        runRemember(config, {
          dryRun: true,
          kind: 'handoff',
          replace: 'viking://user/test-user/memories/shared/default/durable/projects/foo/bar.md',
          text: 'Not shareable.',
        }).pipe(Effect.provide(ApplicationLayer)),
      ),
    ).rejects.toThrow(/only supports durable/);
  });

  it('surfaces git push failures instead of reporting a successful shared update', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const sharedUri = 'viking://user/test-user/memories/shared/default/durable/projects/mobile-native/auth.md';
    vi.mocked(utils.runCommand).mockImplementation((executable, args) => {
      if (executable === '/ov' && args[0] === 'stat') {
        return Effect.succeed(ok());
      }
      if (executable === '/ov' && args[0] === 'write') {
        return Effect.succeed(ok('written'));
      }
      if (executable === 'git' && args.includes('add')) {
        return Effect.succeed(ok());
      }
      if (executable === 'git' && args.includes('commit')) {
        return Effect.succeed(ok('[main abc123] share'));
      }
      if (executable === 'git' && args.includes('push')) {
        return Effect.succeed(fail('permission denied'));
      }
      return Effect.succeed(ok());
    });

    await expect(
      runTestEffect(
        runRemember(config, {
          kind: 'durable',
          replace: sharedUri,
          sourceAgentClient: 'codex',
          text: 'Updated shared auth memory.',
        }).pipe(Effect.provide(ApplicationLayer)),
      ),
    ).rejects.toThrow(/git push failed/);
  });
});
