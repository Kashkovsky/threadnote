import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Effect} from 'effect';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {shareAgentArtifact, shareBundlePack} from '../../src/share.js';
import {
  installSharedAgentArtifacts as installSharedAgentArtifactsEffect,
  listSharedAgentArtifacts as listSharedAgentArtifactsEffect,
  runShareInstallArtifacts as runShareInstallArtifactsEffect,
} from '../../src/effect/share.js';
import type {CommandResult, ShareRuntime} from '../../src/types.js';
import * as utils from '../../src/utils.js';
import {runEffect} from '../helpers/effect-runtime.js';

const runShareInstallArtifacts = (...args: Parameters<typeof runShareInstallArtifactsEffect>) =>
  runEffect(runShareInstallArtifactsEffect(...args));
const listSharedAgentArtifacts = (...args: Parameters<typeof listSharedAgentArtifactsEffect>) =>
  runEffect(listSharedAgentArtifactsEffect(...args));
const installSharedAgentArtifacts = (...args: Parameters<typeof installSharedAgentArtifactsEffect>) =>
  runEffect(installSharedAgentArtifactsEffect(...args));

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
    user: 'test-user',
  };
}

function mockPublishCommands(): void {
  vi.mocked(utils.runCommand).mockImplementation((executable, args) => {
    if (executable === '/ov' && args[0] === 'stat') {
      return Effect.succeed(fail());
    }
    if (executable === '/ov' && (args[0] === 'mkdir' || args[0] === 'write')) {
      return Effect.succeed(ok('ok'));
    }
    if (executable === 'git' && (args.includes('add') || args.includes('commit') || args.includes('push'))) {
      return Effect.succeed(ok('ok'));
    }
    return Effect.succeed(ok());
  });
  vi.mocked(utils.maybeRun).mockImplementation((dryRun, executable, args, options) =>
    dryRun ? Effect.succeed(undefined) : vi.mocked(utils.runCommand)(executable, args, options),
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

    const result = await runEffect(shareAgentArtifact(config, sourcePath, {}));

    expect(result.targetUri).toBe(
      'viking://user/test-user/memories/shared/default/agent-artifacts/skills/codex/reviewer/SKILL.md',
    );
    expect(vi.mocked(utils.runCommand).mock.calls).toEqual(
      expect.arrayContaining([
        [
          '/ov',
          expect.arrayContaining([
            'write',
            'viking://user/test-user/memories/shared/default/agent-artifacts/skills/codex/reviewer/SKILL.md',
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

    await expect(runEffect(shareAgentArtifact(config, sourcePath, {}))).rejects.toThrow(
      /already exists with different content/,
    );
    await expect(readFile(join(sharedPath, 'review.md'), 'utf8')).resolves.toBe('old command\n');
  });

  it('does not leave a shared artifact file behind when OpenViking write fails', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const sourcePath = join(config.agentContextHome, '.codex', 'skills', 'reviewer', 'SKILL.md');
    await mkdir(join(sourcePath, '..'), {recursive: true});
    await writeFile(sourcePath, '# Reviewer\n');
    vi.mocked(utils.runCommand).mockImplementation((executable, args) => {
      if (executable === '/ov' && args[0] === 'stat') {
        return Effect.succeed(fail());
      }
      if (executable === '/ov' && args[0] === 'mkdir') {
        return Effect.succeed(ok('ok'));
      }
      if (executable === '/ov' && args[0] === 'write') {
        return Effect.succeed(fail('write failed'));
      }
      return Effect.succeed(ok());
    });

    await expect(runEffect(shareAgentArtifact(config, sourcePath, {}))).rejects.toThrow(/write failed/);

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

    const result = await runEffect(shareAgentArtifact(config, join(skillDir, 'SKILL.md'), {}));

    expect(result.targetUri).toBe(
      'viking://user/test-user/memories/shared/default/agent-artifacts/skills/codex/reviewer/SKILL.md',
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

    await runEffect(shareAgentArtifact(config, join(skillDir, 'SKILL.md'), {}));

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

    await expect(runEffect(shareAgentArtifact(config, join(skillDir, 'SKILL.md'), {}))).rejects.toThrow(/binary file/);

    await runEffect(shareAgentArtifact(config, join(skillDir, 'SKILL.md'), {allowBinary: true}));
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

    await expect(
      runEffect(shareAgentArtifact(config, join(skillDir, 'SKILL.md'), {allowBinary: true})),
    ).rejects.toThrow(/embedded in binary file/);
  });

  it('scrubs companion files and blocks a leaked credential in a script', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const skillDir = join(config.agentContextHome, '.codex', 'skills', 'reviewer');
    await mkdir(join(skillDir, 'scripts'), {recursive: true});
    await writeFile(join(skillDir, 'SKILL.md'), '# Reviewer\n');
    await writeFile(join(skillDir, 'scripts', 'run.ts'), `const token = "ghp_${'b'.repeat(36)}";\n`);
    mockPublishCommands();

    await expect(runEffect(shareAgentArtifact(config, join(skillDir, 'SKILL.md'), {}))).rejects.toThrow(
      /scripts\/run\.ts/,
    );
  });

  it('does not materialize bundle companions when the SKILL.md OpenViking write fails', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const skillDir = join(config.agentContextHome, '.codex', 'skills', 'reviewer');
    await mkdir(join(skillDir, 'scripts'), {recursive: true});
    await writeFile(join(skillDir, 'SKILL.md'), '# Reviewer\n');
    await writeFile(join(skillDir, 'scripts', 'run.ts'), 'export const run = () => 1;\n');
    vi.mocked(utils.runCommand).mockImplementation((executable, args) => {
      if (executable === '/ov' && args[0] === 'stat') {
        return Effect.succeed(fail());
      }
      if (executable === '/ov' && args[0] === 'mkdir') {
        return Effect.succeed(ok('ok'));
      }
      if (executable === '/ov' && args[0] === 'write') {
        return Effect.succeed(fail('write failed'));
      }
      return Effect.succeed(ok());
    });

    await expect(runEffect(shareAgentArtifact(config, join(skillDir, 'SKILL.md'), {}))).rejects.toThrow(/write failed/);
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

  const PACK_TOKEN = '${THREADNOTE_PACK_ROOT}';

  async function makeReviewerManifestRepo(): Promise<string> {
    const repo = await mkdtemp(join(tmpdir(), 'threadnote-pack-src-'));
    homes.push(repo);
    await mkdir(join(repo, '.claude', 'skills', 'review-pr'), {recursive: true});
    await mkdir(join(repo, '.claude', 'skills', 'pr-status'), {recursive: true});
    await mkdir(join(repo, 'scripts'), {recursive: true});
    await mkdir(join(repo, 'lib'), {recursive: true});
    await writeFile(join(repo, '.claude', 'skills', 'review-pr', 'SKILL.md'), '# Review PR\n\nRun scripts/vcs.ts.\n');
    await writeFile(join(repo, '.claude', 'skills', 'pr-status', 'SKILL.md'), '# PR Status\n');
    await writeFile(
      join(repo, 'scripts', 'vcs.ts'),
      `const foreign = "/Users/yaroslavvoloshchuk/code/reviewer/scripts";\nconst here = "${repo}/scripts";\nimport "../lib/types";\n`,
    );
    await writeFile(join(repo, 'lib', 'types.ts'), 'export type T = string;\n');
    await writeFile(
      join(repo, 'threadnote-bundle.json'),
      `${JSON.stringify({
        agent: 'claude',
        deps: {cli: ['gh', 'glab'], mcp: ['mcp__pal__clink'], runtime: ['bun']},
        description: 'PR review constellation',
        include: ['scripts', 'lib'],
        name: 'reviewer',
        pathRewrites: [{from: '/Users/yaroslavvoloshchuk/code/reviewer'}],
        skills: ['.claude/skills/review-pr', '.claude/skills/pr-status'],
        version: 1,
      })}\n`,
    );
    return repo;
  }

  it('publishes a constellation pack, tokenizing hardcoded repo-root paths', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const repo = await makeReviewerManifestRepo();
    mockPublishCommands();

    const result = await runEffect(shareBundlePack(config, join(repo, 'threadnote-bundle.json'), {}));

    expect(result.targetUri).toBe(
      'viking://user/test-user/memories/shared/default/agent-artifacts/packs/claude/reviewer/reviewer.pack.md',
    );
    const packRoot = join(
      config.agentContextHome,
      'shared',
      'default',
      'agent-artifacts',
      'packs',
      'claude',
      'reviewer',
    );
    const sharedVcs = await readFile(join(packRoot, 'files', 'scripts', 'vcs.ts'), 'utf8');
    expect(sharedVcs).toContain(`${PACK_TOKEN}/scripts`);
    expect(sharedVcs).not.toContain('/Users/yaroslavvoloshchuk');
    expect(sharedVcs).not.toContain(repo);
    const packJson = JSON.parse(await readFile(join(packRoot, 'reviewer.pack.json'), 'utf8'));
    expect(packJson.deps.mcp).toEqual(['mcp__pal__clink']);
    expect(packJson.members.map((m: {path: string}) => m.path)).toContain('scripts/vcs.ts');
    const addArgs = findGitAddArgs();
    expect(addArgs).toContain('agent-artifacts/packs/claude/reviewer/reviewer.pack.md');
    expect(addArgs).toContain('agent-artifacts/packs/claude/reviewer/files/scripts/vcs.ts');
  });

  it('blocks a residual local path that no pathRewrite covers', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const repo = await makeReviewerManifestRepo();
    await writeFile(join(repo, 'scripts', 'leak.ts'), 'const home = "/Users/someone/secret/notes";\n');
    mockPublishCommands();

    await expect(runEffect(shareBundlePack(config, join(repo, 'threadnote-bundle.json'), {}))).rejects.toThrow(
      /scripts\/leak\.ts/,
    );
  });

  async function seedSharedPack(config: ShareRuntime): Promise<string> {
    const packRoot = join(
      config.agentContextHome,
      'shared',
      'default',
      'agent-artifacts',
      'packs',
      'claude',
      'reviewer',
    );
    await mkdir(join(packRoot, 'files', '.claude', 'skills', 'review-pr'), {recursive: true});
    await mkdir(join(packRoot, 'files', 'scripts'), {recursive: true});
    await writeFile(join(packRoot, 'reviewer.pack.md'), '---\nname: reviewer\nkind: pack\n---\n\n# reviewer\n');
    await writeFile(
      join(packRoot, 'reviewer.pack.json'),
      `${JSON.stringify({
        artifact: {agent: 'claude', kind: 'pack', name: 'reviewer'},
        deps: {cli: ['gh'], mcp: ['mcp__pal__clink'], os: [], runtime: ['bun']},
        members: [],
        version: 1,
      })}\n`,
    );
    await writeFile(join(packRoot, 'files', '.claude', 'skills', 'review-pr', 'SKILL.md'), '# Review PR\n');
    await writeFile(join(packRoot, 'files', 'scripts', 'vcs.ts'), 'const root = "${THREADNOTE_PACK_ROOT}/scripts";\n');
    return packRoot;
  }

  it('installs a pack tree, expands the pack-root token, and surfaces requirements', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const installHome = await mkdtemp(join(tmpdir(), 'threadnote-pack-install-home-'));
    homes.push(installHome);
    process.env.HOME = installHome;
    await seedSharedPack(config);

    const result = await installSharedAgentArtifacts(config, {
      agent: 'claude',
      apply: true,
      kind: 'pack',
      name: 'reviewer',
      sync: false,
    });

    const installRoot = join(installHome, '.claude', 'skills', 'threadnote-packs', 'default', 'reviewer');
    await expect(readFile(join(installRoot, '.claude', 'skills', 'review-pr', 'SKILL.md'), 'utf8')).resolves.toBe(
      '# Review PR\n',
    );
    const installedVcs = await readFile(join(installRoot, 'scripts', 'vcs.ts'), 'utf8');
    expect(installedVcs).toBe(`const root = "${installRoot}/scripts";\n`);
    expect(installedVcs.includes('${THREADNOTE_PACK_ROOT}')).toBe(false);
    await expect(readFile(join(installRoot, '.threadnote-bundle-install.json'), 'utf8')).resolves.toMatch(
      /scripts\/vcs\.ts/,
    );
    expect(result.messages.join('\n')).toContain('mcp__pal__clink');
  });

  it('reports current after install despite token expansion, and update_available on change', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const installHome = await mkdtemp(join(tmpdir(), 'threadnote-pack-status-home-'));
    homes.push(installHome);
    process.env.HOME = installHome;
    const packRoot = await seedSharedPack(config);

    await installSharedAgentArtifacts(config, {
      agent: 'claude',
      apply: true,
      kind: 'pack',
      name: 'reviewer',
      sync: false,
    });

    // Token expansion changes installed bytes vs shared bytes; status must still
    // read as current (not perpetually update_available).
    expect((await listSharedAgentArtifacts(config, {sync: false})).artifacts[0]?.installStatus).toBe('current');

    await writeFile(join(packRoot, 'files', 'scripts', 'vcs.ts'), 'const root = "${THREADNOTE_PACK_ROOT}/scripts2";\n');
    expect((await listSharedAgentArtifacts(config, {sync: false})).artifacts[0]?.installStatus).toBe(
      'update_available',
    );
  });

  it('does not expand the pack-root token in a multi-file skill bundle', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const installHome = await mkdtemp(join(tmpdir(), 'threadnote-skill-token-home-'));
    homes.push(installHome);
    process.env.HOME = installHome;
    const root = join(config.agentContextHome, 'shared', 'default', 'agent-artifacts', 'skills', 'claude', 'docskill');
    await mkdir(join(root, 'scripts'), {recursive: true});
    await writeFile(join(root, 'SKILL.md'), '# Doc skill\n');
    await writeFile(join(root, 'scripts', 'note.ts'), 'const t = "${THREADNOTE_PACK_ROOT}";\n');

    await installSharedAgentArtifacts(config, {
      agent: 'claude',
      apply: true,
      kind: 'skill',
      name: 'docskill',
      sync: false,
    });

    const installRoot = join(installHome, '.claude', 'skills', 'threadnote', 'default', 'docskill');
    await expect(readFile(join(installRoot, 'scripts', 'note.ts'), 'utf8')).resolves.toBe(
      'const t = "${THREADNOTE_PACK_ROOT}";\n',
    );
  });

  it('reads a pristine pack as current even when the install sidecar is missing', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const installHome = await mkdtemp(join(tmpdir(), 'threadnote-pack-nosidecar-home-'));
    homes.push(installHome);
    process.env.HOME = installHome;
    await seedSharedPack(config);

    await installSharedAgentArtifacts(config, {
      agent: 'claude',
      apply: true,
      kind: 'pack',
      name: 'reviewer',
      sync: false,
    });
    const installRoot = join(installHome, '.claude', 'skills', 'threadnote-packs', 'default', 'reviewer');
    await rm(join(installRoot, '.threadnote-bundle-install.json'), {force: true});

    expect((await listSharedAgentArtifacts(config, {sync: false})).artifacts[0]?.installStatus).toBe('current');
  });

  it('installs only the .pack.json member list, not files orphaned in files/', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const installHome = await mkdtemp(join(tmpdir(), 'threadnote-pack-orphan-home-'));
    homes.push(installHome);
    process.env.HOME = installHome;
    const packRoot = join(
      config.agentContextHome,
      'shared',
      'default',
      'agent-artifacts',
      'packs',
      'claude',
      'reviewer',
    );
    await mkdir(join(packRoot, 'files', 'scripts'), {recursive: true});
    await writeFile(join(packRoot, 'reviewer.pack.md'), '---\nname: reviewer\nkind: pack\n---\n\n# reviewer\n');
    await writeFile(
      join(packRoot, 'reviewer.pack.json'),
      `${JSON.stringify({
        artifact: {agent: 'claude', kind: 'pack', name: 'reviewer'},
        deps: {cli: [], mcp: [], os: [], runtime: []},
        members: [{binary: false, path: 'scripts/keep.ts', sha256: 'x'}],
        version: 1,
      })}\n`,
    );
    await writeFile(join(packRoot, 'files', 'scripts', 'keep.ts'), 'keep\n');
    await writeFile(join(packRoot, 'files', 'scripts', 'orphan.ts'), 'orphan\n');

    await installSharedAgentArtifacts(config, {
      agent: 'claude',
      apply: true,
      kind: 'pack',
      name: 'reviewer',
      sync: false,
    });

    const installRoot = join(installHome, '.claude', 'skills', 'threadnote-packs', 'default', 'reviewer');
    await expect(readFile(join(installRoot, 'scripts', 'keep.ts'), 'utf8')).resolves.toBe('keep\n');
    await expect(readFile(join(installRoot, 'scripts', 'orphan.ts'), 'utf8')).rejects.toThrow();
  });

  it('rejects a pack manifest with a non-absolute pathRewrite', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const repo = await makeReviewerManifestRepo();
    await writeFile(
      join(repo, 'threadnote-bundle.json'),
      `${JSON.stringify({
        agent: 'claude',
        include: ['scripts', 'lib'],
        name: 'reviewer',
        pathRewrites: [{from: 'lib'}],
        skills: ['.claude/skills/review-pr'],
        version: 1,
      })}\n`,
    );
    mockPublishCommands();

    await expect(runEffect(shareBundlePack(config, join(repo, 'threadnote-bundle.json'), {}))).rejects.toThrow(
      /absolute repo-root path/,
    );
  });

  it('blocks publishing a pack whose member already contains the reserved token', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const repo = await makeReviewerManifestRepo();
    await writeFile(join(repo, 'scripts', 'tok.ts'), 'const x = "${THREADNOTE_PACK_ROOT}/y";\n');
    mockPublishCommands();

    await expect(runEffect(shareBundlePack(config, join(repo, 'threadnote-bundle.json'), {}))).rejects.toThrow(
      /reserved/,
    );
  });

  it('rejects a pack manifest include entry that escapes the pack root', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const repo = await makeReviewerManifestRepo();
    await writeFile(
      join(repo, 'threadnote-bundle.json'),
      `${JSON.stringify({
        agent: 'claude',
        include: ['../secret'],
        name: 'reviewer',
        skills: ['.claude/skills/review-pr'],
        version: 1,
      })}\n`,
    );
    mockPublishCommands();

    await expect(runEffect(shareBundlePack(config, join(repo, 'threadnote-bundle.json'), {}))).rejects.toThrow(
      /within the pack root/,
    );
  });

  it('keeps a pack and a same-named skill in separate install roots', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const installHome = await mkdtemp(join(tmpdir(), 'threadnote-collision-home-'));
    homes.push(installHome);
    process.env.HOME = installHome;
    await seedSharedBundle(config); // skills/claude/reviewer (multi-file skill)
    await seedSharedPack(config); // packs/claude/reviewer (pack)

    await installSharedAgentArtifacts(config, {
      agent: 'claude',
      apply: true,
      kind: 'pack',
      name: 'reviewer',
      sync: false,
    });
    await installSharedAgentArtifacts(config, {
      agent: 'claude',
      apply: true,
      kind: 'skill',
      name: 'reviewer',
      sync: false,
    });

    const skillRoot = join(installHome, '.claude', 'skills', 'threadnote', 'default', 'reviewer');
    const packRoot = join(installHome, '.claude', 'skills', 'threadnote-packs', 'default', 'reviewer');
    // Installing the skill must not have destroyed the pack tree (separate roots).
    await expect(readFile(join(packRoot, 'scripts', 'vcs.ts'), 'utf8')).resolves.toContain('/scripts');
    await expect(readFile(join(skillRoot, 'scripts', 'run.ts'), 'utf8')).resolves.toBe('export const run = () => 1;\n');
  });

  it('skips an incomplete pack index (no .pack.json) without breaking discovery of other artifacts', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const installHome = await mkdtemp(join(tmpdir(), 'threadnote-ghost-pack-home-'));
    homes.push(installHome);
    process.env.HOME = installHome;
    const skill = join(
      config.agentContextHome,
      'shared',
      'default',
      'agent-artifacts',
      'skills',
      'claude',
      'triage',
      'SKILL.md',
    );
    await mkdir(join(skill, '..'), {recursive: true});
    await writeFile(skill, '# Triage\n');
    const ghost = join(config.agentContextHome, 'shared', 'default', 'agent-artifacts', 'packs', 'claude', 'ghost');
    await mkdir(ghost, {recursive: true});
    await writeFile(join(ghost, 'ghost.pack.md'), '---\nname: ghost\nkind: pack\n---\n');

    const result = await listSharedAgentArtifacts(config, {sync: false});
    const names = result.artifacts.map(entry => entry.artifact.name);
    expect(names).toContain('triage');
    expect(names).not.toContain('ghost');
  });

  it('does not crash listing when a .pack.json member is missing from files/', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const installHome = await mkdtemp(join(tmpdir(), 'threadnote-missing-member-home-'));
    homes.push(installHome);
    process.env.HOME = installHome;
    const packRoot = join(
      config.agentContextHome,
      'shared',
      'default',
      'agent-artifacts',
      'packs',
      'claude',
      'reviewer',
    );
    await mkdir(join(packRoot, 'files', 'scripts'), {recursive: true});
    await writeFile(join(packRoot, 'reviewer.pack.md'), '---\nname: reviewer\nkind: pack\n---\n');
    await writeFile(
      join(packRoot, 'reviewer.pack.json'),
      `${JSON.stringify({
        artifact: {agent: 'claude', kind: 'pack', name: 'reviewer'},
        deps: {cli: [], mcp: [], os: [], runtime: []},
        members: [{binary: false, path: 'scripts/missing.ts', sha256: 'x'}],
        version: 1,
      })}\n`,
    );

    const result = await listSharedAgentArtifacts(config, {sync: false});
    expect(result.artifacts.map(entry => entry.artifact.name)).toContain('reviewer');
  });

  it('blocks a residual /home path in a pack member', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const repo = await makeReviewerManifestRepo();
    await writeFile(join(repo, 'scripts', 'deploy.ts'), 'const key = "/home/deploy/.ssh/id_rsa";\n');
    mockPublishCommands();

    await expect(runEffect(shareBundlePack(config, join(repo, 'threadnote-bundle.json'), {}))).rejects.toThrow(
      /scripts\/deploy\.ts/,
    );
  });

  it('blocks a residual local path in a code member even with --redact', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const repo = await makeReviewerManifestRepo();
    await writeFile(join(repo, 'scripts', 'leak.ts'), 'const home = "/Users/someone/secret/x";\n');
    mockPublishCommands();

    await expect(
      runEffect(shareBundlePack(config, join(repo, 'threadnote-bundle.json'), {redact: true})),
    ).rejects.toThrow(/scripts\/leak\.ts/);
  });

  it('flags a locally-edited member removed upstream as a conflict, not a silent update', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const installHome = await mkdtemp(join(tmpdir(), 'threadnote-removed-member-home-'));
    homes.push(installHome);
    process.env.HOME = installHome;
    const packRoot = join(
      config.agentContextHome,
      'shared',
      'default',
      'agent-artifacts',
      'packs',
      'claude',
      'reviewer',
    );
    await mkdir(join(packRoot, 'files', 'scripts'), {recursive: true});
    await writeFile(join(packRoot, 'reviewer.pack.md'), '---\nname: reviewer\nkind: pack\n---\n');
    const writeManifest = async (members: Array<{path: string}>): Promise<void> =>
      writeFile(
        join(packRoot, 'reviewer.pack.json'),
        `${JSON.stringify({artifact: {agent: 'claude', kind: 'pack', name: 'reviewer'}, deps: {}, members, version: 1})}\n`,
      );
    await writeManifest([{path: 'scripts/a.ts'}, {path: 'scripts/b.ts'}]);
    await writeFile(join(packRoot, 'files', 'scripts', 'a.ts'), 'a\n');
    await writeFile(join(packRoot, 'files', 'scripts', 'b.ts'), 'b\n');
    await installSharedAgentArtifacts(config, {
      agent: 'claude',
      apply: true,
      kind: 'pack',
      name: 'reviewer',
      sync: false,
    });

    const installRoot = join(installHome, '.claude', 'skills', 'threadnote-packs', 'default', 'reviewer');
    await writeFile(join(installRoot, 'scripts', 'b.ts'), 'b-local-edit\n');
    await writeManifest([{path: 'scripts/a.ts'}]);
    await rm(join(packRoot, 'files', 'scripts', 'b.ts'), {force: true});

    expect((await listSharedAgentArtifacts(config, {sync: false})).artifacts[0]?.installStatus).toBe(
      'remote_changed_and_local_modified',
    );
    await expect(
      installSharedAgentArtifacts(config, {agent: 'claude', apply: true, kind: 'pack', name: 'reviewer', sync: false}),
    ).rejects.toThrow(/Refusing to overwrite/);
  });

  it('rolls back a pack publish, materializing nothing when an OpenViking write fails', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const repo = await makeReviewerManifestRepo();
    vi.mocked(utils.runCommand).mockImplementation((executable, args) => {
      if (executable === '/ov' && args[0] === 'stat') {
        return Effect.succeed(fail());
      }
      if (executable === '/ov' && args[0] === 'mkdir') {
        return Effect.succeed(ok('ok'));
      }
      if (executable === '/ov' && args[0] === 'write') {
        return Effect.succeed(fail('write failed'));
      }
      return Effect.succeed(ok());
    });

    await expect(runEffect(shareBundlePack(config, join(repo, 'threadnote-bundle.json'), {}))).rejects.toThrow(
      /write failed/,
    );
    const packRoot = join(
      config.agentContextHome,
      'shared',
      'default',
      'agent-artifacts',
      'packs',
      'claude',
      'reviewer',
    );
    await expect(readFile(join(packRoot, 'reviewer.pack.json'), 'utf8')).rejects.toThrow();
    await expect(readFile(join(packRoot, 'files', 'scripts', 'vcs.ts'), 'utf8')).rejects.toThrow();
  });

  it('tokenizes a repo-root path embedded in pack deps', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const repo = await makeReviewerManifestRepo();
    await writeFile(
      join(repo, 'threadnote-bundle.json'),
      `${JSON.stringify({
        agent: 'claude',
        deps: {cli: [`${repo}/bin/tool`]},
        include: ['scripts', 'lib'],
        name: 'reviewer',
        pathRewrites: [{from: '/Users/yaroslavvoloshchuk/code/reviewer'}],
        skills: ['.claude/skills/review-pr'],
        version: 1,
      })}\n`,
    );
    mockPublishCommands();

    await runEffect(shareBundlePack(config, join(repo, 'threadnote-bundle.json'), {}));

    const packRoot = join(
      config.agentContextHome,
      'shared',
      'default',
      'agent-artifacts',
      'packs',
      'claude',
      'reviewer',
    );
    const json = await readFile(join(packRoot, 'reviewer.pack.json'), 'utf8');
    expect(json).toContain('${THREADNOTE_PACK_ROOT}/bin/tool');
    expect(json).not.toContain(repo);
  });

  it('protects work when the sidecar is gone and a member differs: blocks without --force, applies with it', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const installHome = await mkdtemp(join(tmpdir(), 'threadnote-nosidecar-update-home-'));
    homes.push(installHome);
    process.env.HOME = installHome;
    const packRoot = await seedSharedPack(config);

    await installSharedAgentArtifacts(config, {
      agent: 'claude',
      apply: true,
      kind: 'pack',
      name: 'reviewer',
      sync: false,
    });
    const installRoot = join(installHome, '.claude', 'skills', 'threadnote-packs', 'default', 'reviewer');
    await rm(join(installRoot, '.threadnote-bundle-install.json'), {force: true});
    await writeFile(
      join(packRoot, 'files', 'scripts', 'vcs.ts'),
      'const root = "${THREADNOTE_PACK_ROOT}/scripts-v2";\n',
    );

    // Without a baseline the mismatch is ambiguous (local edit vs upstream
    // change), so it is treated protectively and blocked until --force.
    expect((await listSharedAgentArtifacts(config, {sync: false})).artifacts[0]?.installStatus).toBe('local_modified');
    await expect(
      installSharedAgentArtifacts(config, {agent: 'claude', apply: true, kind: 'pack', name: 'reviewer', sync: false}),
    ).rejects.toThrow(/Refusing to overwrite/);

    await installSharedAgentArtifacts(config, {
      agent: 'claude',
      apply: true,
      force: true,
      kind: 'pack',
      name: 'reviewer',
      sync: false,
    });
    await expect(readFile(join(installRoot, 'scripts', 'vcs.ts'), 'utf8')).resolves.toContain('/scripts-v2');
  });

  it('blocks a text member whose residual rewrite-root path the tokenizer leaves intact', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const repo = await makeReviewerManifestRepo();
    // `${repo}-logs` is a sibling of the repo root: the tokenizer will not rewrite
    // it (the `-` is not a path boundary), so the residual-root check must block.
    await writeFile(join(repo, 'scripts', 'log.ts'), `const dir = "${repo}-logs/run";\n`);
    mockPublishCommands();

    await expect(runEffect(shareBundlePack(config, join(repo, 'threadnote-bundle.json'), {}))).rejects.toThrow(
      /scripts\/log\.ts/,
    );
  });

  it('accepts a skill entry given as a path to SKILL.md', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const repo = await makeReviewerManifestRepo();
    await writeFile(
      join(repo, 'threadnote-bundle.json'),
      `${JSON.stringify({
        agent: 'claude',
        include: [],
        name: 'reviewer',
        pathRewrites: [{from: '/Users/yaroslavvoloshchuk/code/reviewer'}],
        skills: ['.claude/skills/review-pr/SKILL.md'],
        version: 1,
      })}\n`,
    );
    mockPublishCommands();

    const result = await runEffect(shareBundlePack(config, join(repo, 'threadnote-bundle.json'), {}));
    expect(result.targetUri).toContain('packs/claude/reviewer/reviewer.pack.md');
  });

  it('refuses to install a pack with an unreadable declared member without --force', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const installHome = await mkdtemp(join(tmpdir(), 'threadnote-incomplete-pack-home-'));
    homes.push(installHome);
    process.env.HOME = installHome;
    const packRoot = join(
      config.agentContextHome,
      'shared',
      'default',
      'agent-artifacts',
      'packs',
      'claude',
      'reviewer',
    );
    await mkdir(join(packRoot, 'files', 'scripts'), {recursive: true});
    await writeFile(join(packRoot, 'reviewer.pack.md'), '---\nname: reviewer\nkind: pack\n---\n');
    await writeFile(
      join(packRoot, 'reviewer.pack.json'),
      `${JSON.stringify({
        artifact: {agent: 'claude', kind: 'pack', name: 'reviewer'},
        deps: {cli: [], mcp: [], os: [], runtime: []},
        members: [
          {binary: false, path: 'scripts/a.ts', sha256: 'x'},
          {binary: false, path: 'scripts/missing.ts', sha256: 'y'},
        ],
        version: 1,
      })}\n`,
    );
    await writeFile(join(packRoot, 'files', 'scripts', 'a.ts'), 'a\n');
    // scripts/missing.ts is declared but absent from files/.

    await expect(
      installSharedAgentArtifacts(config, {agent: 'claude', apply: true, kind: 'pack', name: 'reviewer', sync: false}),
    ).rejects.toThrow(/unreadable|Retry after sync/);
  });

  it('warns (without blocking) about a non-home machine-local path it cannot rewrite', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const repo = await makeReviewerManifestRepo();
    await writeFile(join(repo, 'scripts', 'deploy.ts'), 'const dir = "/opt/work/secrets/run";\n');
    mockPublishCommands();

    const result = await runEffect(shareBundlePack(config, join(repo, 'threadnote-bundle.json'), {}));
    expect(result.messages.join('\n')).toContain('/opt/work/secrets/run');
    expect(result.messages.join('\n')).toMatch(/machine-local/);
  });

  it('re-publishes a changed pack with --force, leaving the new version in place', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const repo = await makeReviewerManifestRepo();
    mockPublishCommands();
    await runEffect(shareBundlePack(config, join(repo, 'threadnote-bundle.json'), {}));

    await writeFile(
      join(repo, 'scripts', 'vcs.ts'),
      `const v = 2;\nconst here = "${repo}/scripts";\nimport '../lib/types';\n`,
    );
    // Differing content must be refused without --force, then replace cleanly with it.
    await expect(runEffect(shareBundlePack(config, join(repo, 'threadnote-bundle.json'), {}))).rejects.toThrow(
      /already exists with different content/,
    );
    await runEffect(shareBundlePack(config, join(repo, 'threadnote-bundle.json'), {force: true}));

    const packRoot = join(
      config.agentContextHome,
      'shared',
      'default',
      'agent-artifacts',
      'packs',
      'claude',
      'reviewer',
    );
    const sharedVcs = await readFile(join(packRoot, 'files', 'scripts', 'vcs.ts'), 'utf8');
    expect(sharedVcs).toContain('v = 2');
    expect(sharedVcs).toContain('${THREADNOTE_PACK_ROOT}/scripts');
    expect(sharedVcs).not.toContain(repo);
  });

  it('skips a pack whose .pack.json member path escapes the pack root (no traversal write)', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const installHome = await mkdtemp(join(tmpdir(), 'threadnote-traversal-home-'));
    homes.push(installHome);
    process.env.HOME = installHome;
    const packRoot = join(
      config.agentContextHome,
      'shared',
      'default',
      'agent-artifacts',
      'packs',
      'claude',
      'reviewer',
    );
    await mkdir(join(packRoot, 'files'), {recursive: true});
    await writeFile(join(packRoot, 'reviewer.pack.md'), '---\nname: reviewer\nkind: pack\n---\n');
    await writeFile(
      join(packRoot, 'reviewer.pack.json'),
      `${JSON.stringify({
        artifact: {agent: 'claude', kind: 'pack', name: 'reviewer'},
        deps: {cli: [], mcp: [], os: [], runtime: []},
        members: [{binary: false, path: '../../../../../../escape.ts', sha256: 'x'}],
        version: 1,
      })}\n`,
    );
    await writeFile(join(packRoot, 'files', 'a.ts'), 'a\n');

    // The unsafe member path makes discovery skip the whole pack, so install finds
    // nothing to install — and crucially writes nothing outside the install root.
    await expect(
      installSharedAgentArtifacts(config, {agent: 'claude', apply: true, kind: 'pack', name: 'reviewer', sync: false}),
    ).rejects.toThrow(/No shared agent artifacts/);
    await expect(readFile(join(installHome, 'escape.ts'), 'utf8')).rejects.toThrow();
  });

  it('normalizes a trailing-slash pathRewrites entry so a bare-directory reference is rewritten', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const repo = await makeReviewerManifestRepo();
    await writeFile(
      join(repo, 'threadnote-bundle.json'),
      `${JSON.stringify({
        agent: 'claude',
        include: ['scripts', 'lib'],
        name: 'reviewer',
        pathRewrites: [{from: '/Users/yaroslavvoloshchuk/code/reviewer'}, {from: '/opt/acme/reviewer/'}],
        skills: ['.claude/skills/review-pr'],
        version: 1,
      })}\n`,
    );
    await writeFile(join(repo, 'scripts', 'opt.ts'), 'const d = "/opt/acme/reviewer";\n');
    mockPublishCommands();

    await runEffect(shareBundlePack(config, join(repo, 'threadnote-bundle.json'), {}));

    const packRoot = join(
      config.agentContextHome,
      'shared',
      'default',
      'agent-artifacts',
      'packs',
      'claude',
      'reviewer',
    );
    const sharedOpt = await readFile(join(packRoot, 'files', 'scripts', 'opt.ts'), 'utf8');
    expect(sharedOpt).toContain('${THREADNOTE_PACK_ROOT}');
    expect(sharedOpt).not.toContain('/opt/acme/reviewer');
  });
});
