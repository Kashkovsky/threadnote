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

  function findGitAddArgs(): readonly string[] | undefined {
    const call = vi
      .mocked(utils.runCommand)
      .mock.calls.find(([executable, args]) => executable === 'git' && args.includes('add'));
    return call?.[1];
  }

  it('publishes a multi-file skill as a bundle with a manifest', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const skillDir = join(config.agentContextHome, '.codex', 'skills', 'reviewer');
    await mkdir(join(skillDir, 'scripts'), {recursive: true});
    await writeFile(join(skillDir, 'SKILL.md'), '# Reviewer\n\nRun scripts/run.ts.\n');
    await writeFile(join(skillDir, 'scripts', 'run.ts'), 'export const run = () => 1;\n');
    mockPublishCommands();

    const result = await shareAgentArtifact(config, join(skillDir, 'SKILL.md'), {});

    expect(result.targetUri).toBe(
      'viking://user/denyskashkovskyi/memories/shared/default/agent-artifacts/skills/codex/reviewer/SKILL.md',
    );
    const sharedRoot = join(
      config.agentContextHome,
      'shared',
      'default',
      'agent-artifacts',
      'skills',
      'codex',
      'reviewer',
    );
    await expect(readFile(join(sharedRoot, 'scripts', 'run.ts'), 'utf8')).resolves.toBe(
      'export const run = () => 1;\n',
    );
    const manifest = JSON.parse(await readFile(join(sharedRoot, '.threadnote-bundle.json'), 'utf8'));
    expect(manifest.members.map((m: {path: string}) => m.path)).toEqual(['SKILL.md', 'scripts/run.ts']);
    const addArgs = findGitAddArgs();
    expect(addArgs).toContain('agent-artifacts/skills/codex/reviewer/SKILL.md');
    expect(addArgs).toContain('agent-artifacts/skills/codex/reviewer/scripts/run.ts');
    expect(addArgs).toContain('agent-artifacts/skills/codex/reviewer/.threadnote-bundle.json');
  });

  it('ignores runtime artifact dirs and local junk when bundling a skill', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const skillDir = join(config.agentContextHome, '.codex', 'skills', 'reviewer');
    await mkdir(join(skillDir, 'reviews', 'mobile', '1'), {recursive: true});
    await mkdir(join(skillDir, 'repos', 'coda'), {recursive: true});
    await writeFile(join(skillDir, 'SKILL.md'), '# Reviewer\n');
    await writeFile(join(skillDir, 'run.ts'), 'export const run = () => 1;\n');
    await writeFile(join(skillDir, '.DS_Store'), 'junk');
    await writeFile(join(skillDir, 'debug.log'), 'noise');
    await writeFile(join(skillDir, 'reviews', 'mobile', '1', 'state.json'), '{}');
    await writeFile(join(skillDir, 'repos', 'coda', 'CLAUDE.md'), '# nope\n');
    mockPublishCommands();

    await shareAgentArtifact(config, join(skillDir, 'SKILL.md'), {});

    const sharedRoot = join(
      config.agentContextHome,
      'shared',
      'default',
      'agent-artifacts',
      'skills',
      'codex',
      'reviewer',
    );
    const manifest = JSON.parse(await readFile(join(sharedRoot, '.threadnote-bundle.json'), 'utf8'));
    expect(manifest.members.map((m: {path: string}) => m.path)).toEqual(['SKILL.md', 'run.ts']);
    await expect(readFile(join(sharedRoot, 'reviews', 'mobile', '1', 'state.json'), 'utf8')).rejects.toThrow();
    await expect(readFile(join(sharedRoot, 'repos', 'coda', 'CLAUDE.md'), 'utf8')).rejects.toThrow();
  });

  it('blocks a binary skill member by default and includes it with allowBinary', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const skillDir = join(config.agentContextHome, '.codex', 'skills', 'reviewer');
    await mkdir(join(skillDir, 'assets'), {recursive: true});
    await writeFile(join(skillDir, 'SKILL.md'), '# Reviewer\n');
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x00, 0x01, 0x02, 0xff]);
    await writeFile(join(skillDir, 'assets', 'logo.png'), png);
    mockPublishCommands();

    await expect(shareAgentArtifact(config, join(skillDir, 'SKILL.md'), {})).rejects.toThrow(/binary file/);

    await shareAgentArtifact(config, join(skillDir, 'SKILL.md'), {allowBinary: true});
    const sharedRoot = join(
      config.agentContextHome,
      'shared',
      'default',
      'agent-artifacts',
      'skills',
      'codex',
      'reviewer',
    );
    await expect(readFile(join(sharedRoot, 'assets', 'logo.png'))).resolves.toEqual(png);
  });

  it('blocks a credential embedded in a binary member even with allowBinary', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const skillDir = join(config.agentContextHome, '.codex', 'skills', 'reviewer');
    await mkdir(skillDir, {recursive: true});
    await writeFile(join(skillDir, 'SKILL.md'), '# Reviewer\n');
    const secretBlob = Buffer.concat([Buffer.from([0x00, 0x01]), Buffer.from(`sk-${'a'.repeat(24)}`)]);
    await writeFile(join(skillDir, 'helper.bin'), secretBlob);
    mockPublishCommands();

    await expect(shareAgentArtifact(config, join(skillDir, 'SKILL.md'), {allowBinary: true})).rejects.toThrow(
      /embedded in binary file/,
    );
  });

  it('scrubs companion files and blocks a leaked credential in a script', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const skillDir = join(config.agentContextHome, '.codex', 'skills', 'reviewer');
    await mkdir(join(skillDir, 'scripts'), {recursive: true});
    await writeFile(join(skillDir, 'SKILL.md'), '# Reviewer\n');
    await writeFile(join(skillDir, 'scripts', 'run.ts'), `const token = "ghp_${'b'.repeat(36)}";\n`);
    mockPublishCommands();

    await expect(shareAgentArtifact(config, join(skillDir, 'SKILL.md'), {})).rejects.toThrow(/scripts\/run\.ts/);
  });

  it('does not materialize bundle companions when the SKILL.md OpenViking write fails', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const skillDir = join(config.agentContextHome, '.codex', 'skills', 'reviewer');
    await mkdir(join(skillDir, 'scripts'), {recursive: true});
    await writeFile(join(skillDir, 'SKILL.md'), '# Reviewer\n');
    await writeFile(join(skillDir, 'scripts', 'run.ts'), 'export const run = () => 1;\n');
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

    await expect(shareAgentArtifact(config, join(skillDir, 'SKILL.md'), {})).rejects.toThrow(/write failed/);
    const sharedRoot = join(
      config.agentContextHome,
      'shared',
      'default',
      'agent-artifacts',
      'skills',
      'codex',
      'reviewer',
    );
    await expect(readFile(join(sharedRoot, 'scripts', 'run.ts'), 'utf8')).rejects.toThrow();
  });

  async function seedSharedBundle(config: ShareRuntime): Promise<string> {
    const root = join(config.agentContextHome, 'shared', 'default', 'agent-artifacts', 'skills', 'claude', 'reviewer');
    await mkdir(join(root, 'scripts'), {recursive: true});
    await writeFile(join(root, 'SKILL.md'), '# Reviewer v1\n');
    await writeFile(join(root, 'scripts', 'run.ts'), 'export const run = () => 1;\n');
    return root;
  }

  it('installs a multi-file bundle tree and tracks it with a bundle sidecar', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const installHome = await mkdtemp(join(tmpdir(), 'threadnote-bundle-install-home-'));
    homes.push(installHome);
    process.env.HOME = installHome;
    await seedSharedBundle(config);

    await installSharedAgentArtifacts(config, {
      agent: 'claude',
      apply: true,
      kind: 'skill',
      name: 'reviewer',
      sync: false,
    });

    const installRoot = join(installHome, '.claude', 'skills', 'threadnote', 'default', 'reviewer');
    await expect(readFile(join(installRoot, 'SKILL.md'), 'utf8')).resolves.toBe('# Reviewer v1\n');
    await expect(readFile(join(installRoot, 'scripts', 'run.ts'), 'utf8')).resolves.toBe(
      'export const run = () => 1;\n',
    );
    await expect(readFile(join(installRoot, '.threadnote-bundle-install.json'), 'utf8')).resolves.toMatch(
      /scripts\/run\.ts/,
    );
  });

  it('updates a bundle member and protects local edits across members', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const installHome = await mkdtemp(join(tmpdir(), 'threadnote-bundle-update-home-'));
    homes.push(installHome);
    process.env.HOME = installHome;
    const sharedRoot = await seedSharedBundle(config);
    const installRoot = join(installHome, '.claude', 'skills', 'threadnote', 'default', 'reviewer');

    await installSharedAgentArtifacts(config, {
      agent: 'claude',
      apply: true,
      kind: 'skill',
      name: 'reviewer',
      sync: false,
    });

    // Upstream changes one member; reinstall adopts it.
    await writeFile(join(sharedRoot, 'scripts', 'run.ts'), 'export const run = () => 2;\n');
    expect((await listSharedAgentArtifacts(config, {sync: false})).artifacts[0]?.installStatus).toBe(
      'update_available',
    );
    await installSharedAgentArtifacts(config, {
      agent: 'claude',
      apply: true,
      kind: 'skill',
      name: 'reviewer',
      sync: false,
    });
    await expect(readFile(join(installRoot, 'scripts', 'run.ts'), 'utf8')).resolves.toBe(
      'export const run = () => 2;\n',
    );

    // Local edit to one member + upstream edit to a different member -> conflict.
    await writeFile(join(installRoot, 'SKILL.md'), '# Locally edited\n');
    await writeFile(join(sharedRoot, 'scripts', 'run.ts'), 'export const run = () => 3;\n');
    expect((await listSharedAgentArtifacts(config, {sync: false})).artifacts[0]?.installStatus).toBe(
      'remote_changed_and_local_modified',
    );
    await expect(
      installSharedAgentArtifacts(config, {agent: 'claude', apply: true, kind: 'skill', name: 'reviewer', sync: false}),
    ).rejects.toThrow(/Refusing to overwrite/);

    await installSharedAgentArtifacts(config, {
      agent: 'claude',
      apply: true,
      force: true,
      kind: 'skill',
      name: 'reviewer',
      sync: false,
    });
    await expect(readFile(join(installRoot, 'SKILL.md'), 'utf8')).resolves.toBe('# Reviewer v1\n');
    await expect(readFile(join(installRoot, 'scripts', 'run.ts'), 'utf8')).resolves.toBe(
      'export const run = () => 3;\n',
    );
  });
});
