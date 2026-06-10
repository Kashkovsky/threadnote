import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  installSharedAgentArtifacts,
  listSharedAgentArtifacts,
  runShareInstallArtifacts,
  shareAgentArtifact,
} from '../../src/share.js';
import type {CommandResult, ShareRuntime} from '../../src/types.js';
import * as utils from '../../src/utils.js';

vi.mock('../../src/utils.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/utils.js')>();
  return {
    ...actual,
    maybeRun: vi.fn(),
    openVikingCliForMode: vi.fn().mockResolvedValue('/ov'),
    requiredExecutable: vi.fn().mockResolvedValue('git'),
    runCommand: vi.fn(),
    sleep: vi.fn().mockResolvedValue(undefined),
  };
});

const ok = (stdout = ''): CommandResult => ({exitCode: 0, stdout, stderr: ''});
const fail = (stderr = '[NOT_FOUND]'): CommandResult => ({exitCode: 1, stdout: '', stderr});

async function makeRuntime(): Promise<ShareRuntime> {
  const home = await mkdtemp(join(tmpdir(), 'threadnote-share-artifacts-'));
  const worktree = join(home, 'shared', 'default');
  const gitdir = join(home, 'share', 'teams', 'default.gitdir');
  await mkdir(join(home, 'share'), {recursive: true});
  await mkdir(worktree, {recursive: true});
  await writeFile(
    join(home, 'share', 'teams.json'),
    `${JSON.stringify(
      {
        defaultTeam: 'default',
        teams: {
          default: {
            addedAt: '2026-06-10T00:00:00.000Z',
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
    user: 'denyskashkovskyi',
  };
}

function mockPublishCommands(): void {
  vi.mocked(utils.runCommand).mockImplementation(async (executable, args) => {
    if (executable === '/ov' && args[0] === 'stat') {
      return fail();
    }
    if (executable === '/ov' && (args[0] === 'mkdir' || args[0] === 'write')) {
      return ok('ok');
    }
    if (executable === 'git' && (args.includes('add') || args.includes('commit') || args.includes('push'))) {
      return ok('ok');
    }
    return ok();
  });
  vi.mocked(utils.maybeRun).mockImplementation(async (dryRun, executable, args, options) =>
    dryRun ? undefined : vi.mocked(utils.runCommand)(executable, args, options),
  );
}

describe('shared agent artifacts', () => {
  const homes: string[] = [];
  const originalHome = process.env.HOME;

  beforeEach(() => {
    vi.mocked(utils.runCommand).mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    vi.restoreAllMocks();
    await Promise.all(homes.splice(0).map(home => rm(home, {force: true, recursive: true})));
  });

  it('publishes a Codex skill into the shared artifact catalog and indexes it', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const sourcePath = join(config.agentContextHome, '.codex', 'skills', 'reviewer', 'SKILL.md');
    await mkdir(join(sourcePath, '..'), {recursive: true});
    await writeFile(sourcePath, '# Reviewer\n\nReview local diffs.\n');
    mockPublishCommands();

    const result = await shareAgentArtifact(config, sourcePath, {});

    expect(result.targetUri).toBe(
      'viking://user/denyskashkovskyi/memories/shared/default/agent-artifacts/skills/codex/reviewer/SKILL.md',
    );
    expect(vi.mocked(utils.runCommand).mock.calls).toEqual(
      expect.arrayContaining([
        [
          '/ov',
          expect.arrayContaining([
            'write',
            'viking://user/denyskashkovskyi/memories/shared/default/agent-artifacts/skills/codex/reviewer/SKILL.md',
          ]),
          {allowFailure: true},
        ],
        [
          'git',
          [
            '-C',
            join(config.agentContextHome, 'shared', 'default'),
            'add',
            '--',
            'agent-artifacts/skills/codex/reviewer/SKILL.md',
          ],
          {allowFailure: true},
        ],
      ]),
    );
  });

  it('refuses to overwrite a different shared artifact unless forced', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const sourcePath = join(config.agentContextHome, '.claude', 'commands', 'review.md');
    const sharedPath = join(config.agentContextHome, 'shared', 'default', 'agent-artifacts', 'commands', 'claude');
    await mkdir(join(sourcePath, '..'), {recursive: true});
    await mkdir(sharedPath, {recursive: true});
    await writeFile(sourcePath, 'new command\n');
    await writeFile(join(sharedPath, 'review.md'), 'old command\n');
    mockPublishCommands();

    await expect(shareAgentArtifact(config, sourcePath, {})).rejects.toThrow(/already exists with different content/);
    await expect(readFile(join(sharedPath, 'review.md'), 'utf8')).resolves.toBe('old command\n');
  });

  it('does not leave a shared artifact file behind when OpenViking write fails', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const sourcePath = join(config.agentContextHome, '.codex', 'skills', 'reviewer', 'SKILL.md');
    await mkdir(join(sourcePath, '..'), {recursive: true});
    await writeFile(sourcePath, '# Reviewer\n');
    vi.mocked(utils.runCommand).mockImplementation(async (executable, args) => {
      if (executable === '/ov' && args[0] === 'stat') {
        return fail();
      }
      if (executable === '/ov' && args[0] === 'mkdir') {
        return ok('ok');
      }
      if (executable === '/ov' && args[0] === 'write') {
        return fail('write failed');
      }
      return ok();
    });

    await expect(shareAgentArtifact(config, sourcePath, {})).rejects.toThrow(/write failed/);

    await expect(
      readFile(
        join(
          config.agentContextHome,
          'shared',
          'default',
          'agent-artifacts',
          'skills',
          'codex',
          'reviewer',
          'SKILL.md',
        ),
        'utf8',
      ),
    ).rejects.toThrow();
  });

  it('installs shared artifacts into namespaced local agent paths only when applied', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const installHome = await mkdtemp(join(tmpdir(), 'threadnote-artifact-install-home-'));
    homes.push(installHome);
    process.env.HOME = installHome;
    const sharedSkill = join(
      config.agentContextHome,
      'shared',
      'default',
      'agent-artifacts',
      'skills',
      'claude',
      'triage',
      'SKILL.md',
    );
    await mkdir(join(sharedSkill, '..'), {recursive: true});
    await writeFile(sharedSkill, '# Triage\n');

    await runShareInstallArtifacts(config, {apply: true, sync: false});

    await expect(
      readFile(join(installHome, '.claude', 'skills', 'threadnote', 'default', 'triage', 'SKILL.md'), 'utf8'),
    ).resolves.toBe('# Triage\n');
  });

  it('lists shared artifacts with install status', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const installHome = await mkdtemp(join(tmpdir(), 'threadnote-artifact-list-home-'));
    homes.push(installHome);
    process.env.HOME = installHome;
    const sharedSkill = join(
      config.agentContextHome,
      'shared',
      'default',
      'agent-artifacts',
      'skills',
      'codex',
      'reviewer',
      'SKILL.md',
    );
    await mkdir(join(sharedSkill, '..'), {recursive: true});
    await writeFile(sharedSkill, '# Reviewer\n');

    const result = await listSharedAgentArtifacts(config, {sync: false});

    expect(result.team).toBe('default');
    expect(result.artifacts).toMatchObject([
      {
        artifact: {agent: 'codex', kind: 'skill', name: 'reviewer'},
        installStatus: 'not_installed',
      },
    ]);
  });

  it('requires disambiguation when installing a shared artifact name with multiple matches', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const installHome = await mkdtemp(join(tmpdir(), 'threadnote-artifact-ambiguous-home-'));
    homes.push(installHome);
    process.env.HOME = installHome;
    const codexSkill = join(
      config.agentContextHome,
      'shared',
      'default',
      'agent-artifacts',
      'skills',
      'codex',
      'reviewer',
      'SKILL.md',
    );
    const claudeSkill = join(
      config.agentContextHome,
      'shared',
      'default',
      'agent-artifacts',
      'skills',
      'claude',
      'reviewer',
      'SKILL.md',
    );
    await mkdir(join(codexSkill, '..'), {recursive: true});
    await mkdir(join(claudeSkill, '..'), {recursive: true});
    await writeFile(codexSkill, '# Codex Reviewer\n');
    await writeFile(claudeSkill, '# Claude Reviewer\n');

    await expect(installSharedAgentArtifacts(config, {apply: true, name: 'reviewer', sync: false})).rejects.toThrow(
      /ambiguous/,
    );

    await installSharedAgentArtifacts(config, {
      agent: 'codex',
      apply: true,
      kind: 'skill',
      name: 'reviewer',
      sync: false,
    });

    await expect(
      readFile(join(installHome, '.codex', 'skills', 'threadnote', 'default', 'reviewer', 'SKILL.md'), 'utf8'),
    ).resolves.toBe('# Codex Reviewer\n');
  });

  it('reports update available when the shared artifact changes after install', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const installHome = await mkdtemp(join(tmpdir(), 'threadnote-artifact-update-home-'));
    homes.push(installHome);
    process.env.HOME = installHome;
    const sharedSkill = join(
      config.agentContextHome,
      'shared',
      'default',
      'agent-artifacts',
      'skills',
      'codex',
      'reviewer',
      'SKILL.md',
    );
    await mkdir(join(sharedSkill, '..'), {recursive: true});
    await writeFile(sharedSkill, '# Reviewer v1\n');

    await installSharedAgentArtifacts(config, {
      agent: 'codex',
      apply: true,
      kind: 'skill',
      name: 'reviewer',
      sync: false,
    });
    await writeFile(sharedSkill, '# Reviewer v2\n');

    const listed = await listSharedAgentArtifacts(config, {sync: false});

    expect(listed.artifacts).toMatchObject([
      {
        artifact: {agent: 'codex', kind: 'skill', name: 'reviewer'},
        installStatus: 'update_available',
      },
    ]);

    await installSharedAgentArtifacts(config, {
      agent: 'codex',
      apply: true,
      kind: 'skill',
      name: 'reviewer',
      sync: false,
    });

    await expect(
      readFile(join(installHome, '.codex', 'skills', 'threadnote', 'default', 'reviewer', 'SKILL.md'), 'utf8'),
    ).resolves.toBe('# Reviewer v2\n');
  });

  it('protects local modifications when the shared artifact changes too', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const installHome = await mkdtemp(join(tmpdir(), 'threadnote-artifact-local-mod-home-'));
    homes.push(installHome);
    process.env.HOME = installHome;
    const sharedSkill = join(
      config.agentContextHome,
      'shared',
      'default',
      'agent-artifacts',
      'skills',
      'codex',
      'reviewer',
      'SKILL.md',
    );
    const installPath = join(installHome, '.codex', 'skills', 'threadnote', 'default', 'reviewer', 'SKILL.md');
    await mkdir(join(sharedSkill, '..'), {recursive: true});
    await writeFile(sharedSkill, '# Reviewer v1\n');

    await installSharedAgentArtifacts(config, {
      agent: 'codex',
      apply: true,
      kind: 'skill',
      name: 'reviewer',
      sync: false,
    });
    await writeFile(sharedSkill, '# Reviewer v2\n');
    await writeFile(installPath, '# Local edit\n');

    const listed = await listSharedAgentArtifacts(config, {sync: false});

    expect(listed.artifacts[0]?.installStatus).toBe('remote_changed_and_local_modified');
    await expect(
      installSharedAgentArtifacts(config, {
        agent: 'codex',
        apply: true,
        kind: 'skill',
        name: 'reviewer',
        sync: false,
      }),
    ).rejects.toThrow(/Refusing to overwrite/);

    await installSharedAgentArtifacts(config, {
      agent: 'codex',
      apply: true,
      force: true,
      kind: 'skill',
      name: 'reviewer',
      sync: false,
    });

    await expect(readFile(installPath, 'utf8')).resolves.toBe('# Reviewer v2\n');
  });
});
