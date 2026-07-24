import {chmod, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {listShareConflicts, showShareConflict} from '../../src/share.js';
import {
  resolveShareConflict as resolveShareConflictEffect,
  runShareInit as runShareInitEffect,
  runShareSync as runShareSyncEffect,
  syncSharedReposBeforeAgentRead as syncSharedReposBeforeAgentReadEffect,
} from '../../src/effect/share.js';
import type {ShareRuntime, ShareTeamsFile} from '../../src/types.js';
import {runCommand} from '../../src/utils.js';
import {runEffect} from '../helpers/effect-runtime.js';

const runShareInit = (...args: Parameters<typeof runShareInitEffect>) => runEffect(runShareInitEffect(...args));
const runShareSync = (...args: Parameters<typeof runShareSyncEffect>) => runEffect(runShareSyncEffect(...args));
const syncSharedReposBeforeAgentRead = (...args: Parameters<typeof syncSharedReposBeforeAgentReadEffect>) =>
  runEffect(syncSharedReposBeforeAgentReadEffect(...args));
const resolveShareConflict = (...args: Parameters<typeof resolveShareConflictEffect>) =>
  runEffect(resolveShareConflictEffect(...args));

interface TestShareRepo {
  readonly config: ShareRuntime;
  readonly home: string;
  readonly remote: string;
  readonly root: string;
  readonly seed: string;
  readonly worktree: string;
}

interface TestShareTeam {
  readonly gitdir: string;
  readonly name: string;
  readonly remote: string;
  readonly seed: string;
  readonly worktree: string;
}

const homes: string[] = [];
const GIT_ENV_KEYS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_PREFIX',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_QUARANTINE_PATH',
] as const;
const savedGitEnv = new Map<string, string | undefined>();
let savedThreadnoteOv: string | undefined;
let savedFakeOvStore: string | undefined;

async function git(args: readonly string[], cwd?: string): Promise<void> {
  await runEffect(runCommand('git', args, {cwd}));
}

async function gitOutput(args: readonly string[], cwd?: string): Promise<string> {
  const result = await runEffect(runCommand('git', args, {cwd}));
  return result.stdout.trim();
}

function fakeOvFile(store: string, uri: string): string {
  return join(store, `${Buffer.from(uri).toString('base64url')}.txt`);
}

function fakeOvStatFailureFile(store: string, uri: string): string {
  return join(store, `${Buffer.from(uri).toString('base64url')}.stat-failure`);
}

async function installFakeOv(root: string): Promise<{readonly ov: string; readonly store: string}> {
  const bin = join(root, 'bin');
  const store = join(root, 'ov-store');
  await mkdir(bin, {recursive: true});
  await mkdir(store, {recursive: true});
  const ov = join(bin, 'ov');
  await writeFile(
    ov,
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const store = process.env.THREADNOTE_FAKE_OV_STORE;
function fileFor(uri) {
  return path.join(store, Buffer.from(uri).toString('base64url') + '.txt');
}
function markerFor(uri) {
  return path.join(store, Buffer.from(uri).toString('base64url') + '.dir');
}
const args = process.argv.slice(2);
const command = args[0];
const uri = args[1];
if (command === 'stat') {
  const failure = path.join(store, Buffer.from(uri).toString('base64url') + '.stat-failure');
  if (fs.existsSync(failure)) {
    process.stderr.write('Error: [INTERNAL] forced stat failure\\n');
    process.exit(2);
  }
  if (fs.existsSync(fileFor(uri)) || fs.existsSync(markerFor(uri))) process.exit(0);
  process.stderr.write('Error: [NOT_FOUND] resource does not exist\\n');
  process.exit(1);
}
if (command === 'mkdir') {
  fs.writeFileSync(markerFor(uri), '');
  process.exit(0);
}
if (command === 'read') {
  const file = fileFor(uri);
  if (!fs.existsSync(file)) process.exit(1);
  process.stdout.write(fs.readFileSync(file, 'utf8'));
  process.exit(0);
}
if (command === 'write') {
  const from = args[args.indexOf('--from-file') + 1];
  fs.copyFileSync(from, fileFor(uri));
  process.exit(0);
}
if (command === 'rm') {
  fs.rmSync(fileFor(uri), {force: true});
  fs.rmSync(markerFor(uri), {force: true});
  process.exit(0);
}
if (command === 'reindex' || command === 'wait') {
  process.exit(0);
}
process.stderr.write('unsupported fake ov command: ' + args.join(' ') + '\\n');
process.exit(2);
`,
    'utf8',
  );
  await chmod(ov, 0o700);
  return {ov, store};
}

async function makeShareRepo(): Promise<TestShareRepo> {
  const root = await mkdtemp(join(tmpdir(), 'threadnote-share-sync-'));
  homes.push(root);

  const remote = join(root, 'remote.git');
  const seed = join(root, 'seed');
  await mkdir(seed, {recursive: true});
  await git(['init', '--bare', remote]);
  await git(['init'], seed);
  await git(['checkout', '-b', 'main'], seed);
  await git(['config', 'user.email', 'threadnote-test@example.com'], seed);
  await git(['config', 'user.name', 'Threadnote Test'], seed);
  await writeFile(join(seed, 'README.md'), '# Shared memories\n', 'utf8');
  await git(['add', 'README.md'], seed);
  await git(['commit', '-m', 'initial'], seed);
  await git(['remote', 'add', 'origin', remote], seed);
  await git(['push', '-u', 'origin', 'main'], seed);
  await git(['checkout', '-b', 'other'], seed);
  await writeFile(join(seed, 'other.md'), 'other branch\n', 'utf8');
  await git(['add', 'other.md'], seed);
  await git(['commit', '-m', 'other branch'], seed);
  await git(['push', 'origin', 'other'], seed);
  await git(['checkout', 'main'], seed);
  await git(['--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main']);

  const home = join(root, 'home');
  const worktree = join(home, 'data', 'viking', 'local', 'user', 'denys', 'memories', 'shared', 'default');
  const gitdir = join(home, 'share', 'teams', 'default.gitdir');
  await mkdir(dirname(worktree), {recursive: true});
  await mkdir(dirname(gitdir), {recursive: true});
  await git(['clone', `--separate-git-dir=${gitdir}`, '--branch', 'main', '--', remote, worktree]);
  await git(['config', 'user.email', 'threadnote-test@example.com'], worktree);
  await git(['config', 'user.name', 'Threadnote Test'], worktree);

  const config: ShareRuntime = {account: 'local', agentContextHome: home, agentId: 'threadnote', user: 'denys'};
  const teams: ShareTeamsFile = {
    defaultTeam: 'default',
    teams: {
      default: {
        addedAt: new Date(0).toISOString(),
        gitdir,
        name: 'default',
        remote,
        worktree,
      },
    },
    version: 1,
  };
  await mkdir(join(home, 'share'), {recursive: true});
  await writeFile(join(home, 'share', 'teams.json'), `${JSON.stringify(teams, undefined, 2)}\n`, 'utf8');
  return {config, home, remote, root, seed, worktree};
}

async function addShareTeam(repo: TestShareRepo, name: string): Promise<TestShareTeam> {
  const teamRoot = join(repo.root, `team-${name}`);
  const remote = join(teamRoot, 'remote.git');
  const seed = join(teamRoot, 'seed');
  await mkdir(seed, {recursive: true});
  await git(['init', '--bare', remote]);
  await git(['init'], seed);
  await git(['checkout', '-b', 'main'], seed);
  await git(['config', 'user.email', 'threadnote-test@example.com'], seed);
  await git(['config', 'user.name', 'Threadnote Test'], seed);
  await writeFile(join(seed, 'README.md'), '# Shared memories\n', 'utf8');
  await git(['add', 'README.md'], seed);
  await git(['commit', '-m', 'initial'], seed);
  await git(['remote', 'add', 'origin', remote], seed);
  await git(['push', '-u', 'origin', 'main'], seed);
  await git(['--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main']);

  const worktree = join(repo.home, 'data', 'viking', 'local', 'user', 'denys', 'memories', 'shared', name);
  const gitdir = join(repo.home, 'share', 'teams', `${name}.gitdir`);
  await mkdir(dirname(worktree), {recursive: true});
  await mkdir(dirname(gitdir), {recursive: true});
  await git(['clone', `--separate-git-dir=${gitdir}`, '--branch', 'main', '--', remote, worktree]);
  await git(['config', 'user.email', 'threadnote-test@example.com'], worktree);
  await git(['config', 'user.name', 'Threadnote Test'], worktree);

  const teamsPath = join(repo.home, 'share', 'teams.json');
  const existingTeams = JSON.parse(await readFile(teamsPath, 'utf8')) as ShareTeamsFile;
  const teams: ShareTeamsFile = {
    ...existingTeams,
    teams: {
      ...existingTeams.teams,
      [name]: {
        addedAt: new Date(0).toISOString(),
        gitdir,
        name,
        remote,
        worktree,
      },
    },
  };
  await writeFile(teamsPath, `${JSON.stringify(teams, undefined, 2)}\n`, 'utf8');
  return {gitdir, name, remote, seed, worktree};
}

async function makeSeededRemote(root: string): Promise<string> {
  const remote = join(root, 'remote.git');
  const seed = join(root, 'seed');
  await mkdir(seed, {recursive: true});
  await git(['init', '--bare', remote]);
  await git(['init'], seed);
  await git(['checkout', '-b', 'main'], seed);
  await git(['config', 'user.email', 'threadnote-test@example.com'], seed);
  await git(['config', 'user.name', 'Threadnote Test'], seed);
  await writeFile(join(seed, 'README.md'), '# Shared memories\n', 'utf8');
  await git(['add', 'README.md'], seed);
  await git(['commit', '-m', 'initial'], seed);
  await git(['remote', 'add', 'origin', remote], seed);
  await git(['push', '-u', 'origin', 'main'], seed);
  await git(['--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  return remote;
}

describe('share sync git handling', () => {
  beforeEach(() => {
    savedGitEnv.clear();
    for (const key of GIT_ENV_KEYS) {
      savedGitEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    savedThreadnoteOv = process.env.THREADNOTE_OV;
    savedFakeOvStore = process.env.THREADNOTE_FAKE_OV_STORE;
    delete process.env.THREADNOTE_OV;
    delete process.env.THREADNOTE_FAKE_OV_STORE;
  });

  afterEach(async () => {
    await Promise.all(homes.splice(0).map(home => rm(home, {force: true, recursive: true})));
    for (const key of GIT_ENV_KEYS) {
      const value = savedGitEnv.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    savedGitEnv.clear();
    if (savedThreadnoteOv === undefined) {
      delete process.env.THREADNOTE_OV;
    } else {
      process.env.THREADNOTE_OV = savedThreadnoteOv;
    }
    if (savedFakeOvStore === undefined) {
      delete process.env.THREADNOTE_FAKE_OV_STORE;
    } else {
      process.env.THREADNOTE_FAKE_OV_STORE = savedFakeOvStore;
    }
  });

  it('auto-commits root Claude guidance and rebases onto the configured upstream', async () => {
    const {config, worktree} = await makeShareRepo();
    await writeFile(join(worktree, 'CLAUDE.md'), '# Shared Claude guidance\n', 'utf8');

    await runShareSync(config, {message: 'share: test sync', push: false});

    await expect(gitOutput(['status', '--porcelain'], worktree)).resolves.toBe('');
    await expect(gitOutput(['ls-files', 'CLAUDE.md'], worktree)).resolves.toBe('CLAUDE.md');
    await expect(gitOutput(['log', '-1', '--format=%s', '--', 'CLAUDE.md'], worktree)).resolves.toBe(
      'share: test sync',
    );
  });

  it('syncs all configured teams when no team is provided', async () => {
    const repo = await makeShareRepo();
    const friends = await addShareTeam(repo, 'friends');
    const {ov, store} = await installFakeOv(repo.root);
    process.env.THREADNOTE_OV = ov;
    process.env.THREADNOTE_FAKE_OV_STORE = store;
    const defaultRelativePath = 'durable/projects/threadnote/default.md';
    const friendsRelativePath = 'durable/projects/threadnote/friends.md';
    const defaultUri = 'viking://user/denys/memories/shared/default/durable/projects/threadnote/default.md';
    const friendsUri = 'viking://user/denys/memories/shared/friends/durable/projects/threadnote/friends.md';

    await mkdir(join(repo.seed, 'durable', 'projects', 'threadnote'), {recursive: true});
    await writeFile(
      join(repo.seed, defaultRelativePath),
      'MEMORY\nkind: durable\nstatus: active\n\ndefault body\n',
      'utf8',
    );
    await git(['add', defaultRelativePath], repo.seed);
    await git(['commit', '-m', 'add default shared memory'], repo.seed);
    await git(['push', 'origin', 'main'], repo.seed);

    await mkdir(join(friends.seed, 'durable', 'projects', 'threadnote'), {recursive: true});
    await writeFile(
      join(friends.seed, friendsRelativePath),
      'MEMORY\nkind: durable\nstatus: active\n\nfriends body\n',
      'utf8',
    );
    await git(['add', friendsRelativePath], friends.seed);
    await git(['commit', '-m', 'add friends shared memory'], friends.seed);
    await git(['push', 'origin', 'main'], friends.seed);

    await runShareSync(repo.config, {push: false});

    await expect(readFile(fakeOvFile(store, defaultUri), 'utf8')).resolves.toContain('default body');
    await expect(readFile(fakeOvFile(store, friendsUri), 'utf8')).resolves.toContain('friends body');
  });

  it('syncs only the requested team when team is provided', async () => {
    const repo = await makeShareRepo();
    const friends = await addShareTeam(repo, 'friends');
    const {ov, store} = await installFakeOv(repo.root);
    process.env.THREADNOTE_OV = ov;
    process.env.THREADNOTE_FAKE_OV_STORE = store;
    const defaultRelativePath = 'durable/projects/threadnote/default.md';
    const friendsRelativePath = 'durable/projects/threadnote/friends.md';
    const defaultUri = 'viking://user/denys/memories/shared/default/durable/projects/threadnote/default.md';
    const friendsUri = 'viking://user/denys/memories/shared/friends/durable/projects/threadnote/friends.md';

    await mkdir(join(repo.seed, 'durable', 'projects', 'threadnote'), {recursive: true});
    await writeFile(
      join(repo.seed, defaultRelativePath),
      'MEMORY\nkind: durable\nstatus: active\n\ndefault body\n',
      'utf8',
    );
    await git(['add', defaultRelativePath], repo.seed);
    await git(['commit', '-m', 'add default shared memory'], repo.seed);
    await git(['push', 'origin', 'main'], repo.seed);

    await mkdir(join(friends.seed, 'durable', 'projects', 'threadnote'), {recursive: true});
    await writeFile(
      join(friends.seed, friendsRelativePath),
      'MEMORY\nkind: durable\nstatus: active\n\nfriends body\n',
      'utf8',
    );
    await git(['add', friendsRelativePath], friends.seed);
    await git(['commit', '-m', 'add friends shared memory'], friends.seed);
    await git(['push', 'origin', 'main'], friends.seed);

    await runShareSync(repo.config, {push: false, team: 'friends'});

    await expect(readFile(fakeOvFile(store, friendsUri), 'utf8')).resolves.toContain('friends body');
    await expect(readFile(fakeOvFile(store, defaultUri), 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('does not let inherited git environment redirect share init into the caller repo', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-share-init-env-'));
    homes.push(root);
    const remote = await makeSeededRemote(root);

    const callerRepo = join(root, 'caller');
    await mkdir(callerRepo, {recursive: true});
    await git(['init'], callerRepo);
    await git(['checkout', '-b', 'main'], callerRepo);
    await git(['config', 'user.email', 'threadnote-test@example.com'], callerRepo);
    await git(['config', 'user.name', 'Threadnote Test'], callerRepo);
    await writeFile(join(callerRepo, 'tracked.txt'), 'caller repo\n', 'utf8');
    await git(['add', 'tracked.txt'], callerRepo);
    await git(['commit', '-m', 'caller initial'], callerRepo);
    const callerHead = await gitOutput(['rev-parse', 'HEAD'], callerRepo);

    const callerGitDir = join(callerRepo, '.git');
    process.env.GIT_DIR = callerGitDir;
    process.env.GIT_COMMON_DIR = callerGitDir;
    process.env.GIT_WORK_TREE = callerRepo;
    process.env.GIT_INDEX_FILE = join(callerGitDir, 'index');

    const home = join(root, 'home');
    const {ov, store} = await installFakeOv(root);
    process.env.THREADNOTE_OV = ov;
    process.env.THREADNOTE_FAKE_OV_STORE = store;
    const config: ShareRuntime = {account: 'local', agentContextHome: home, agentId: 'threadnote', user: 'denys'};

    await runShareInit(config, remote, {push: false, team: 'threadnote'});

    await expect(gitOutput(['rev-parse', 'HEAD'], callerRepo)).resolves.toBe(callerHead);
    await expect(gitOutput(['status', '--porcelain'], callerRepo)).resolves.toBe('');
    await expect(gitOutput(['log', '-1', '--format=%s'], callerRepo)).resolves.toBe('caller initial');
  });

  it('stops before rebase when non-shareable untracked files remain', async () => {
    const {config, worktree} = await makeShareRepo();
    await writeFile(join(worktree, 'local.txt'), 'local only\n', 'utf8');

    await expect(runShareSync(config, {message: 'share: test sync', push: false})).rejects.toThrow(
      /did not auto-commit/,
    );
    await expect(gitOutput(['status', '--porcelain'], worktree)).resolves.toContain('?? local.txt');
  });

  it('refuses to ingest upstream shared memories that match the scrubber', async () => {
    const {config, root, seed} = await makeShareRepo();
    const {ov, store} = await installFakeOv(root);
    process.env.THREADNOTE_OV = ov;
    process.env.THREADNOTE_FAKE_OV_STORE = store;
    const relativePath = 'durable/projects/threadnote/leak.md';
    const uri = 'viking://user/denys/memories/shared/default/durable/projects/threadnote/leak.md';
    await mkdir(join(seed, 'durable', 'projects', 'threadnote'), {recursive: true});
    await writeFile(
      join(seed, relativePath),
      [
        'MEMORY',
        'kind: durable',
        'status: active',
        '',
        ['aws_session_token=', 'abcdefghijklmnopqrstuvwxyz0123456789ABCD'].join(''),
      ].join('\n') + '\n',
      'utf8',
    );
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'add unsafe shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);

    await runShareSync(config, {push: false});

    await expect(readFile(fakeOvFile(store, uri), 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('strips personal provenance and managed metadata before ingesting upstream shared memories', async () => {
    const {config, root, seed} = await makeShareRepo();
    const {ov, store} = await installFakeOv(root);
    process.env.THREADNOTE_OV = ov;
    process.env.THREADNOTE_FAKE_OV_STORE = store;
    const relativePath = 'durable/projects/threadnote/shared.md';
    const uri = 'viking://user/denys/memories/shared/default/durable/projects/threadnote/shared.md';
    await mkdir(join(seed, 'durable', 'projects', 'threadnote'), {recursive: true});
    await writeFile(
      join(seed, relativePath),
      [
        'MEMORY',
        'kind: durable',
        'status: active',
        'references: viking://user/alice/memories/durable/projects/threadnote/local.md',
        '',
        'shared body',
        '',
        '<!-- MEMORY_FIELDS',
        '{',
        '  "version": 1',
        '}',
        '-->',
      ].join('\n'),
      'utf8',
    );
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'add shared memory with provenance'], seed);
    await git(['push', 'origin', 'main'], seed);

    await runShareSync(config, {push: false});

    await expect(readFile(fakeOvFile(store, uri), 'utf8')).resolves.toBe(
      ['MEMORY', 'kind: durable', 'status: active', '', 'shared body'].join('\n'),
    );
  });

  it('clears a pending added reindex when OpenViking only differs by the final newline', async () => {
    const {config, home, root, seed, worktree} = await makeShareRepo();
    const {ov, store} = await installFakeOv(root);
    process.env.THREADNOTE_OV = ov;
    process.env.THREADNOTE_FAKE_OV_STORE = store;
    const relativePath = 'durable/projects/threadnote/shared.md';
    const uri = 'viking://user/denys/memories/shared/default/durable/projects/threadnote/shared.md';
    await mkdir(join(seed, 'durable', 'projects', 'threadnote'), {recursive: true});
    await writeFile(join(seed, relativePath), 'MEMORY\nkind: durable\nstatus: active\n\nshared body', 'utf8');
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'add shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);
    await runShareSync(config, {push: false});
    await writeFile(fakeOvFile(store, uri), 'MEMORY\nkind: durable\nstatus: active\n\nshared body\n', 'utf8');

    const pendingPath = join(home, 'share', 'auto-sync-pending-reindexes.json');
    await writeFile(
      pendingPath,
      `${JSON.stringify(
        {
          teams: {
            default: [{path: join(worktree, relativePath), relativePath, status: 'added'}],
          },
          version: 1,
        },
        undefined,
        2,
      )}\n`,
      'utf8',
    );

    await runShareSync(config, {push: false});

    await expect(readFile(fakeOvFile(store, uri), 'utf8')).resolves.toBe(
      'MEMORY\nkind: durable\nstatus: active\n\nshared body\n',
    );
    await expect(readFile(pendingPath, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('does not ingest shared agent artifacts as memory conflicts', async () => {
    const {config, home, root, seed} = await makeShareRepo();
    const {ov, store} = await installFakeOv(root);
    process.env.THREADNOTE_OV = ov;
    process.env.THREADNOTE_FAKE_OV_STORE = store;
    const relativePath = 'agent-artifacts/skills/codex/reviewer/SKILL.md';
    const uri = 'viking://user/denys/memories/shared/default/agent-artifacts/skills/codex/reviewer/SKILL.md';
    await mkdir(dirname(join(seed, relativePath)), {recursive: true});
    await writeFile(join(seed, relativePath), '# Reviewer\n\nReview pull requests.\n', 'utf8');
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'add shared skill'], seed);
    await git(['push', 'origin', 'main'], seed);

    await runShareSync(config, {push: false});

    await expect(readFile(join(home, 'share', 'auto-sync-pending-reindexes.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readFile(fakeOvFile(store, uri), 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
    await expect(runEffect(listShareConflicts(config, {team: 'default'}))).resolves.toEqual([]);
  });

  it('replaces a divergent OpenViking resource when replaying a pending added reindex', async () => {
    const {config, home, root, seed, worktree} = await makeShareRepo();
    const {ov, store} = await installFakeOv(root);
    process.env.THREADNOTE_OV = ov;
    process.env.THREADNOTE_FAKE_OV_STORE = store;
    const relativePath = 'durable/projects/threadnote/shared.md';
    const uri = 'viking://user/denys/memories/shared/default/durable/projects/threadnote/shared.md';
    await mkdir(join(seed, 'durable', 'projects', 'threadnote'), {recursive: true});
    await writeFile(join(seed, relativePath), 'MEMORY\nkind: durable\nstatus: active\n\nshared body\n', 'utf8');
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'add shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);
    await runShareSync(config, {push: false});
    await writeFile(fakeOvFile(store, uri), 'MEMORY\nkind: durable\nstatus: active\n\nlocal edit\n', 'utf8');

    const pendingPath = join(home, 'share', 'auto-sync-pending-reindexes.json');
    await writeFile(
      pendingPath,
      `${JSON.stringify(
        {
          teams: {
            default: [{path: join(worktree, relativePath), relativePath, status: 'added'}],
          },
          version: 1,
        },
        undefined,
        2,
      )}\n`,
      'utf8',
    );

    await runShareSync(config, {push: false});

    await expect(readFile(fakeOvFile(store, uri), 'utf8')).resolves.toBe(
      'MEMORY\nkind: durable\nstatus: active\n\nshared body',
    );
    await expect(readFile(pendingPath, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('shows and resolves a pending added conflict by taking shared content', async () => {
    const {config, home, root, seed, worktree} = await makeShareRepo();
    const {ov, store} = await installFakeOv(root);
    process.env.THREADNOTE_OV = ov;
    process.env.THREADNOTE_FAKE_OV_STORE = store;
    const relativePath = 'durable/projects/threadnote/shared.md';
    const id = `default:${relativePath}`;
    const uri = 'viking://user/denys/memories/shared/default/durable/projects/threadnote/shared.md';
    await mkdir(join(seed, 'durable', 'projects', 'threadnote'), {recursive: true});
    await writeFile(join(seed, relativePath), 'MEMORY\nkind: durable\nstatus: active\n\nshared body\n', 'utf8');
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'add shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);
    await runShareSync(config, {push: false});
    await writeFile(fakeOvFile(store, uri), 'MEMORY\nkind: durable\nstatus: active\n\nlocal edit\n', 'utf8');

    const pendingPath = join(home, 'share', 'auto-sync-pending-reindexes.json');
    await writeFile(
      pendingPath,
      `${JSON.stringify(
        {
          teams: {
            default: [{path: join(worktree, relativePath), relativePath, status: 'added'}],
          },
          version: 1,
        },
        undefined,
        2,
      )}\n`,
      'utf8',
    );

    const conflicts = await runEffect(listShareConflicts(config, {team: 'default'}));
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      id,
      reason: 'local OpenViking content differs from the newly added shared file',
      status: 'added',
    });
    const detail = await runEffect(showShareConflict(config, id));
    expect(detail.diff).toContain('local edit');
    expect(detail.diff).toContain('shared body');

    const result = await resolveShareConflict(config, id, {take: 'shared'});

    expect(result.backupPath).toContain('conflict-backups');
    await expect(readFile(fakeOvFile(store, uri), 'utf8')).resolves.toBe(
      'MEMORY\nkind: durable\nstatus: active\n\nshared body',
    );
    await expect(readFile(pendingPath, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
  }, 10000);

  it('resolves a pending added conflict by publishing local content to the shared repo', async () => {
    const {config, home, root, seed, worktree} = await makeShareRepo();
    const {ov, store} = await installFakeOv(root);
    process.env.THREADNOTE_OV = ov;
    process.env.THREADNOTE_FAKE_OV_STORE = store;
    const relativePath = 'durable/projects/threadnote/shared.md';
    const id = `default:${relativePath}`;
    const uri = 'viking://user/denys/memories/shared/default/durable/projects/threadnote/shared.md';
    await mkdir(join(seed, 'durable', 'projects', 'threadnote'), {recursive: true});
    await writeFile(join(seed, relativePath), 'MEMORY\nkind: durable\nstatus: active\n\nshared body\n', 'utf8');
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'add shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);
    await runShareSync(config, {push: false});
    await writeFile(fakeOvFile(store, uri), 'MEMORY\nkind: durable\nstatus: active\n\nlocal edit\n', 'utf8');

    const pendingPath = join(home, 'share', 'auto-sync-pending-reindexes.json');
    await writeFile(
      pendingPath,
      `${JSON.stringify(
        {
          teams: {
            default: [{path: join(worktree, relativePath), relativePath, status: 'added'}],
          },
          version: 1,
        },
        undefined,
        2,
      )}\n`,
      'utf8',
    );

    await resolveShareConflict(config, id, {push: false, take: 'local'});

    await expect(readFile(join(worktree, relativePath), 'utf8')).resolves.toBe(
      'MEMORY\nkind: durable\nstatus: active\n\nlocal edit\n',
    );
    await expect(readFile(fakeOvFile(store, uri), 'utf8')).resolves.toBe(
      'MEMORY\nkind: durable\nstatus: active\n\nlocal edit\n',
    );
    await expect(readFile(pendingPath, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
    await expect(gitOutput(['log', '-1', '--format=%s'], worktree)).resolves.toBe(`share: resolve ${relativePath}`);
  }, 10000);

  it('resolves a pending added conflict from an explicit merged file', async () => {
    const {config, home, root, seed, worktree} = await makeShareRepo();
    const {ov, store} = await installFakeOv(root);
    process.env.THREADNOTE_OV = ov;
    process.env.THREADNOTE_FAKE_OV_STORE = store;
    const relativePath = 'durable/projects/threadnote/shared.md';
    const id = `default:${relativePath}`;
    const uri = 'viking://user/denys/memories/shared/default/durable/projects/threadnote/shared.md';
    await mkdir(join(seed, 'durable', 'projects', 'threadnote'), {recursive: true});
    await writeFile(join(seed, relativePath), 'MEMORY\nkind: durable\nstatus: active\n\nshared body\n', 'utf8');
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'add shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);
    await runShareSync(config, {push: false});
    await writeFile(fakeOvFile(store, uri), 'MEMORY\nkind: durable\nstatus: active\n\nlocal edit\n', 'utf8');

    const pendingPath = join(home, 'share', 'auto-sync-pending-reindexes.json');
    await writeFile(
      pendingPath,
      `${JSON.stringify(
        {
          teams: {
            default: [{path: join(worktree, relativePath), relativePath, status: 'added'}],
          },
          version: 1,
        },
        undefined,
        2,
      )}\n`,
      'utf8',
    );
    const mergedPath = join(root, 'merged.md');
    await writeFile(mergedPath, 'MEMORY\nkind: durable\nstatus: active\n\nmerged body\n', 'utf8');

    await resolveShareConflict(config, id, {fromFile: mergedPath, push: false});

    await expect(readFile(join(worktree, relativePath), 'utf8')).resolves.toBe(
      'MEMORY\nkind: durable\nstatus: active\n\nmerged body\n',
    );
    await expect(readFile(fakeOvFile(store, uri), 'utf8')).resolves.toBe(
      'MEMORY\nkind: durable\nstatus: active\n\nmerged body\n',
    );
    await expect(readFile(pendingPath, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
  }, 10000);

  it('resolves a pending modified conflict by taking shared content', async () => {
    const {config, home, root, seed, worktree} = await makeShareRepo();
    const {ov, store} = await installFakeOv(root);
    process.env.THREADNOTE_OV = ov;
    process.env.THREADNOTE_FAKE_OV_STORE = store;
    const relativePath = 'durable/projects/threadnote/shared.md';
    const id = `default:${relativePath}`;
    const uri = 'viking://user/denys/memories/shared/default/durable/projects/threadnote/shared.md';
    const oldContent = 'MEMORY\nkind: durable\nstatus: active\n\nold shared';
    const newContent = 'MEMORY\nkind: durable\nstatus: active\n\nnew shared';
    await mkdir(join(seed, 'durable', 'projects', 'threadnote'), {recursive: true});
    await writeFile(join(seed, relativePath), `${oldContent}\n`, 'utf8');
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'add shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);
    await runShareSync(config, {push: false});
    await writeFile(join(seed, relativePath), newContent, 'utf8');
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'update shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);
    await git(['-C', worktree, 'fetch', 'origin']);
    await git(['-C', worktree, 'rebase', '@{u}']);
    await writeFile(fakeOvFile(store, uri), 'MEMORY\nkind: durable\nstatus: active\n\nlocal edit\n', 'utf8');

    const pendingPath = join(home, 'share', 'auto-sync-pending-reindexes.json');
    await writeFile(
      pendingPath,
      `${JSON.stringify(
        {
          teams: {
            default: [
              {path: join(worktree, relativePath), previousContent: oldContent, relativePath, status: 'modified'},
            ],
          },
          version: 1,
        },
        undefined,
        2,
      )}\n`,
      'utf8',
    );

    await resolveShareConflict(config, id, {take: 'shared'});

    await expect(readFile(fakeOvFile(store, uri), 'utf8')).resolves.toBe(newContent);
    await expect(readFile(join(worktree, relativePath), 'utf8')).resolves.toBe(newContent);
    await expect(readFile(pendingPath, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
  }, 10000);

  it('resolves a pending modified conflict by publishing local content', async () => {
    const {config, home, root, seed, worktree} = await makeShareRepo();
    const {ov, store} = await installFakeOv(root);
    process.env.THREADNOTE_OV = ov;
    process.env.THREADNOTE_FAKE_OV_STORE = store;
    const relativePath = 'durable/projects/threadnote/shared.md';
    const id = `default:${relativePath}`;
    const uri = 'viking://user/denys/memories/shared/default/durable/projects/threadnote/shared.md';
    const oldContent = 'MEMORY\nkind: durable\nstatus: active\n\nold shared';
    const newContent = 'MEMORY\nkind: durable\nstatus: active\n\nnew shared';
    const localContent = 'MEMORY\nkind: durable\nstatus: active\n\nlocal edit\n';
    await mkdir(join(seed, 'durable', 'projects', 'threadnote'), {recursive: true});
    await writeFile(join(seed, relativePath), `${oldContent}\n`, 'utf8');
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'add shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);
    await runShareSync(config, {push: false});
    await writeFile(join(seed, relativePath), newContent, 'utf8');
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'update shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);
    await git(['-C', worktree, 'fetch', 'origin']);
    await git(['-C', worktree, 'rebase', '@{u}']);
    await writeFile(fakeOvFile(store, uri), localContent, 'utf8');

    const pendingPath = join(home, 'share', 'auto-sync-pending-reindexes.json');
    await writeFile(
      pendingPath,
      `${JSON.stringify(
        {
          teams: {
            default: [
              {path: join(worktree, relativePath), previousContent: oldContent, relativePath, status: 'modified'},
            ],
          },
          version: 1,
        },
        undefined,
        2,
      )}\n`,
      'utf8',
    );

    await resolveShareConflict(config, id, {push: false, take: 'local'});

    await expect(readFile(join(worktree, relativePath), 'utf8')).resolves.toBe(localContent);
    await expect(readFile(fakeOvFile(store, uri), 'utf8')).resolves.toBe(localContent);
    await expect(readFile(pendingPath, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
    await expect(gitOutput(['log', '-1', '--format=%s'], worktree)).resolves.toBe(`share: resolve ${relativePath}`);
  }, 10000);

  it('resolves a pending removed conflict by taking the shared deletion', async () => {
    const {config, home, root, seed, worktree} = await makeShareRepo();
    const {ov, store} = await installFakeOv(root);
    process.env.THREADNOTE_OV = ov;
    process.env.THREADNOTE_FAKE_OV_STORE = store;
    const relativePath = 'durable/projects/threadnote/shared.md';
    const id = `default:${relativePath}`;
    const uri = 'viking://user/denys/memories/shared/default/durable/projects/threadnote/shared.md';
    const oldContent = 'MEMORY\nkind: durable\nstatus: active\n\nold shared';
    await mkdir(join(seed, 'durable', 'projects', 'threadnote'), {recursive: true});
    await writeFile(join(seed, relativePath), `${oldContent}\n`, 'utf8');
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'add shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);
    await runShareSync(config, {push: false});
    await rm(join(seed, relativePath));
    await git(['add', '-A'], seed);
    await git(['commit', '-m', 'delete shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);
    await git(['-C', worktree, 'fetch', 'origin']);
    await git(['-C', worktree, 'rebase', '@{u}']);
    await writeFile(fakeOvFile(store, uri), 'MEMORY\nkind: durable\nstatus: active\n\nlocal edit\n', 'utf8');

    const pendingPath = join(home, 'share', 'auto-sync-pending-reindexes.json');
    await writeFile(
      pendingPath,
      `${JSON.stringify(
        {
          teams: {
            default: [
              {path: join(worktree, relativePath), previousContent: oldContent, relativePath, status: 'removed'},
            ],
          },
          version: 1,
        },
        undefined,
        2,
      )}\n`,
      'utf8',
    );

    const statFailurePath = fakeOvStatFailureFile(store, uri);
    await writeFile(statFailurePath, '', 'utf8');
    await expect(resolveShareConflict(config, id, {take: 'shared'})).rejects.toThrow(/forced stat failure/);
    await expect(readFile(fakeOvFile(store, uri), 'utf8')).resolves.toContain('local edit');
    await expect(readFile(pendingPath, 'utf8')).resolves.toContain(relativePath);

    await rm(statFailurePath);
    await resolveShareConflict(config, id, {take: 'shared'});

    await expect(readFile(fakeOvFile(store, uri), 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
    await expect(readFile(join(worktree, relativePath), 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
    await expect(readFile(pendingPath, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
  }, 10000);

  it('resolves a pending removed conflict by restoring local content to the shared repo', async () => {
    const {config, home, root, seed, worktree} = await makeShareRepo();
    const {ov, store} = await installFakeOv(root);
    process.env.THREADNOTE_OV = ov;
    process.env.THREADNOTE_FAKE_OV_STORE = store;
    const relativePath = 'durable/projects/threadnote/shared.md';
    const id = `default:${relativePath}`;
    const uri = 'viking://user/denys/memories/shared/default/durable/projects/threadnote/shared.md';
    const oldContent = 'MEMORY\nkind: durable\nstatus: active\n\nold shared';
    const localContent = 'MEMORY\nkind: durable\nstatus: active\n\nlocal edit\n';
    await mkdir(join(seed, 'durable', 'projects', 'threadnote'), {recursive: true});
    await writeFile(join(seed, relativePath), `${oldContent}\n`, 'utf8');
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'add shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);
    await runShareSync(config, {push: false});
    await rm(join(seed, relativePath));
    await git(['add', '-A'], seed);
    await git(['commit', '-m', 'delete shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);
    await git(['-C', worktree, 'fetch', 'origin']);
    await git(['-C', worktree, 'rebase', '@{u}']);
    await writeFile(fakeOvFile(store, uri), localContent, 'utf8');

    const pendingPath = join(home, 'share', 'auto-sync-pending-reindexes.json');
    await writeFile(
      pendingPath,
      `${JSON.stringify(
        {
          teams: {
            default: [
              {path: join(worktree, relativePath), previousContent: oldContent, relativePath, status: 'removed'},
            ],
          },
          version: 1,
        },
        undefined,
        2,
      )}\n`,
      'utf8',
    );

    await resolveShareConflict(config, id, {push: false, take: 'local'});

    await expect(readFile(join(worktree, relativePath), 'utf8')).resolves.toBe(localContent);
    await expect(readFile(fakeOvFile(store, uri), 'utf8')).resolves.toBe(localContent);
    await expect(readFile(pendingPath, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
    await expect(gitOutput(['log', '-1', '--format=%s'], worktree)).resolves.toBe(`share: resolve ${relativePath}`);
  }, 10000);

  it('keeps pending conflict inspection available when previous shared content fails scrubbing', async () => {
    const {config, home, root, worktree} = await makeShareRepo();
    const {ov, store} = await installFakeOv(root);
    process.env.THREADNOTE_OV = ov;
    process.env.THREADNOTE_FAKE_OV_STORE = store;
    const relativePath = 'durable/projects/threadnote/shared.md';
    const uri = 'viking://user/denys/memories/shared/default/durable/projects/threadnote/shared.md';
    const sharedContent = 'MEMORY\nkind: durable\nstatus: active\n\nsafe remote body\n';
    await mkdir(dirname(join(worktree, relativePath)), {recursive: true});
    await writeFile(join(worktree, relativePath), sharedContent, 'utf8');
    await writeFile(fakeOvFile(store, uri), 'MEMORY\nkind: durable\nstatus: active\n\nlocal body\n', 'utf8');
    const pendingPath = join(home, 'share', 'auto-sync-pending-reindexes.json');
    await writeFile(
      pendingPath,
      `${JSON.stringify(
        {
          teams: {
            default: [
              {
                path: join(worktree, relativePath),
                previousContent:
                  'MEMORY\nkind: durable\nstatus: active\n\naws_session_token=abcdefghijklmnopqrstuvwxyz0123456789ABCD\n',
                relativePath,
                status: 'modified',
              },
            ],
          },
          version: 1,
        },
        undefined,
        2,
      )}\n`,
      'utf8',
    );

    const conflicts = await runEffect(listShareConflicts(config, {team: 'default'}));
    const detail = await runEffect(showShareConflict(config, `default:${relativePath}`));

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      hasPreviousContent: false,
      reason: expect.stringContaining('previous shared content is not readable'),
    });
    expect(detail.sharedContent).toContain('safe remote body');
    expect(detail.previousContent).toBeUndefined();

    await resolveShareConflict(config, `default:${relativePath}`, {take: 'shared'});

    await expect(readFile(fakeOvFile(store, uri), 'utf8')).resolves.toContain('safe remote body');
    await expect(readFile(pendingPath, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('replaces divergent OpenViking content when replaying a pending modified reindex after restart', async () => {
    const {config, home, root, seed, worktree} = await makeShareRepo();
    const {ov, store} = await installFakeOv(root);
    process.env.THREADNOTE_OV = ov;
    process.env.THREADNOTE_FAKE_OV_STORE = store;
    const relativePath = 'durable/projects/threadnote/shared.md';
    const uri = 'viking://user/denys/memories/shared/default/durable/projects/threadnote/shared.md';
    const oldContent = 'MEMORY\nkind: durable\nstatus: active\n\nold shared';
    const newContent = 'MEMORY\nkind: durable\nstatus: active\n\nnew shared';
    await mkdir(join(seed, 'durable', 'projects', 'threadnote'), {recursive: true});
    await writeFile(join(seed, relativePath), `${oldContent}\n`, 'utf8');
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'add shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);
    await runShareSync(config, {push: false});
    await writeFile(join(seed, relativePath), newContent, 'utf8');
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'update shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);
    await git(['-C', worktree, 'fetch', 'origin']);
    await git(['-C', worktree, 'rebase', '@{u}']);
    await writeFile(fakeOvFile(store, uri), 'MEMORY\nkind: durable\nstatus: active\n\nlocal edit\n', 'utf8');

    const pendingPath = join(home, 'share', 'auto-sync-pending-reindexes.json');
    await writeFile(
      pendingPath,
      `${JSON.stringify(
        {
          teams: {
            default: [
              {path: join(worktree, relativePath), previousContent: oldContent, relativePath, status: 'modified'},
            ],
          },
          version: 1,
        },
        undefined,
        2,
      )}\n`,
      'utf8',
    );

    await runShareSync(config, {push: false});

    await expect(readFile(fakeOvFile(store, uri), 'utf8')).resolves.toBe(newContent);
    await expect(readFile(pendingPath, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('deletes a divergent OpenViking resource when the shared file is deleted', async () => {
    const {config, root, seed} = await makeShareRepo();
    const {ov, store} = await installFakeOv(root);
    process.env.THREADNOTE_OV = ov;
    process.env.THREADNOTE_FAKE_OV_STORE = store;
    const relativePath = 'durable/projects/threadnote/shared.md';
    const uri = 'viking://user/denys/memories/shared/default/durable/projects/threadnote/shared.md';
    await mkdir(join(seed, 'durable', 'projects', 'threadnote'), {recursive: true});
    await writeFile(join(seed, relativePath), 'MEMORY\nkind: durable\nstatus: active\n\nold shared\n', 'utf8');
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'add shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);
    await runShareSync(config, {push: false});
    await writeFile(fakeOvFile(store, uri), 'MEMORY\nkind: durable\nstatus: active\n\nlocal edit\n', 'utf8');

    await rm(join(seed, relativePath));
    await git(['add', '-A'], seed);
    await git(['commit', '-m', 'delete shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);

    await runShareSync(config, {push: false});

    await expect(readFile(fakeOvFile(store, uri), 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('keeps a shared deletion pending when OpenViking stat fails transiently', async () => {
    const {config, home, root, seed} = await makeShareRepo();
    const {ov, store} = await installFakeOv(root);
    process.env.THREADNOTE_OV = ov;
    process.env.THREADNOTE_FAKE_OV_STORE = store;
    const relativePath = 'durable/projects/threadnote/shared.md';
    const uri = 'viking://user/denys/memories/shared/default/durable/projects/threadnote/shared.md';
    await mkdir(join(seed, 'durable', 'projects', 'threadnote'), {recursive: true});
    await writeFile(join(seed, relativePath), 'MEMORY\nkind: durable\nstatus: active\n\nold shared\n', 'utf8');
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'add shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);
    await runShareSync(config, {push: true});
    await git(['pull', '--rebase', 'origin', 'main'], seed);

    await rm(join(seed, relativePath));
    await git(['add', '-A'], seed);
    await git(['commit', '-m', 'delete shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);
    const statFailurePath = fakeOvStatFailureFile(store, uri);
    await writeFile(statFailurePath, '', 'utf8');

    const firstResult = await syncSharedReposBeforeAgentRead(config);

    expect(firstResult.syncedTeams).toEqual(['default']);
    expect(firstResult.warnings.some(warning => warning.includes('1 pending shared memory ingest failure'))).toBe(true);
    await expect(readFile(fakeOvFile(store, uri), 'utf8')).resolves.toContain('old shared');
    const pendingPath = join(home, 'share', 'auto-sync-pending-reindexes.json');
    await expect(readFile(pendingPath, 'utf8')).resolves.toContain(relativePath);

    await rm(statFailurePath);
    const secondResult = await syncSharedReposBeforeAgentRead(config);

    expect(secondResult.syncedTeams).toEqual(['default']);
    await expect(readFile(fakeOvFile(store, uri), 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
    await expect(readFile(pendingPath, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('restores a dirty pending file before retrying its OpenViking ingest', async () => {
    const {config, home, root, seed, worktree} = await makeShareRepo();
    const {ov, store} = await installFakeOv(root);
    process.env.THREADNOTE_OV = ov;
    process.env.THREADNOTE_FAKE_OV_STORE = store;
    const relativePath = 'durable/projects/threadnote/shared.md';
    const uri = 'viking://user/denys/memories/shared/default/durable/projects/threadnote/shared.md';
    const remoteContent = 'MEMORY\nkind: durable\nstatus: active\n\nremote body\n';
    await mkdir(join(seed, 'durable', 'projects', 'threadnote'), {recursive: true});
    await writeFile(join(seed, relativePath), remoteContent, 'utf8');
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'add shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);
    await runShareSync(config, {push: true});
    await git(['pull', '--rebase', 'origin', 'main'], seed);

    await writeFile(
      join(worktree, relativePath),
      'MEMORY\nkind: durable\nstatus: active\n\nlocal dirty edit\n',
      'utf8',
    );
    await writeFile(fakeOvFile(store, uri), 'MEMORY\nkind: durable\nstatus: active\n\nstale cache\n', 'utf8');
    const pendingPath = join(home, 'share', 'auto-sync-pending-reindexes.json');
    await writeFile(
      pendingPath,
      `${JSON.stringify(
        {
          teams: {
            default: [{path: join(worktree, relativePath), relativePath, status: 'added'}],
          },
          version: 1,
        },
        undefined,
        2,
      )}\n`,
      'utf8',
    );

    const result = await syncSharedReposBeforeAgentRead(config);

    expect(result.syncedTeams).toEqual(['default']);
    expect(result.warnings.some(warning => warning.includes('restored 1 tracked shared file'))).toBe(true);
    await expect(readFile(join(worktree, relativePath), 'utf8')).resolves.toBe(remoteContent);
    await expect(readFile(fakeOvFile(store, uri), 'utf8')).resolves.toContain('remote body');
    await expect(readFile(pendingPath, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('rewrites equivalent OpenViking content with duplicate managed metadata', async () => {
    const {config, root, seed} = await makeShareRepo();
    const {ov, store} = await installFakeOv(root);
    process.env.THREADNOTE_OV = ov;
    process.env.THREADNOTE_FAKE_OV_STORE = store;
    const relativePath = 'durable/projects/threadnote/shared.md';
    const uri = 'viking://user/denys/memories/shared/default/durable/projects/threadnote/shared.md';
    const trailer = ['<!-- MEMORY_FIELDS', '{', '  "version": 1', '}', '-->'].join('\n');
    const remoteContent = `MEMORY\nkind: durable\nstatus: active\n\nremote body\n\n${trailer}\n`;
    await mkdir(dirname(join(seed, relativePath)), {recursive: true});
    await writeFile(join(seed, relativePath), remoteContent, 'utf8');
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'add shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);
    await writeFile(fakeOvFile(store, uri), `${remoteContent.trim()}\n\n${trailer}\n`, 'utf8');

    const result = await syncSharedReposBeforeAgentRead(config);

    expect(result.syncedTeams).toEqual(['default']);
    const stored = await readFile(fakeOvFile(store, uri), 'utf8');
    expect(stored).toContain('remote body');
    expect(stored).not.toContain('<!-- MEMORY_FIELDS');
  });

  it('leaves equivalent OpenViking content with one managed metadata trailer byte-for-byte unchanged', async () => {
    const {config, root, seed} = await makeShareRepo();
    const {ov, store} = await installFakeOv(root);
    process.env.THREADNOTE_OV = ov;
    process.env.THREADNOTE_FAKE_OV_STORE = store;
    const relativePath = 'durable/projects/threadnote/shared.md';
    const uri = 'viking://user/denys/memories/shared/default/durable/projects/threadnote/shared.md';
    const trailer = ['<!-- MEMORY_FIELDS', '{', '  "version": 1', '}', '-->'].join('\n');
    const remoteContent = `MEMORY\nkind: durable\nstatus: active\n\nremote body\n\n${trailer}\n`;
    await mkdir(dirname(join(seed, relativePath)), {recursive: true});
    await writeFile(join(seed, relativePath), remoteContent, 'utf8');
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'add shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);
    await writeFile(fakeOvFile(store, uri), remoteContent, 'utf8');

    const result = await syncSharedReposBeforeAgentRead(config);

    expect(result.syncedTeams).toEqual(['default']);
    await expect(readFile(fakeOvFile(store, uri), 'utf8')).resolves.toBe(remoteContent);
  });

  it('restores dirty tracked shared files before automatic sync', async () => {
    const {config, root, seed, worktree} = await makeShareRepo();
    const {ov, store} = await installFakeOv(root);
    process.env.THREADNOTE_OV = ov;
    process.env.THREADNOTE_FAKE_OV_STORE = store;
    const relativePath = 'durable/projects/threadnote/shared.md';
    const uri = 'viking://user/denys/memories/shared/default/durable/projects/threadnote/shared.md';
    await mkdir(join(seed, 'durable', 'projects', 'threadnote'), {recursive: true});
    await writeFile(join(seed, relativePath), 'MEMORY\nkind: durable\nstatus: active\n\nold shared\n', 'utf8');
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'add shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);
    await runShareSync(config, {push: true});
    await git(['pull', '--rebase', 'origin', 'main'], seed);

    await writeFile(
      join(worktree, relativePath),
      'MEMORY\nkind: durable\nstatus: active\n\nlocal dirty edit\n',
      'utf8',
    );
    await writeFile(join(seed, relativePath), 'MEMORY\nkind: durable\nstatus: active\n\nremote update\n', 'utf8');
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'update shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);

    const result = await syncSharedReposBeforeAgentRead(config);

    expect(result.syncedTeams).toEqual(['default']);
    expect(result.warnings.some(warning => warning.includes('restored 1 tracked shared file'))).toBe(true);
    await expect(gitOutput(['status', '--porcelain'], worktree)).resolves.toBe('');
    await expect(readFile(join(worktree, relativePath), 'utf8')).resolves.toContain('remote update');
    await expect(readFile(fakeOvFile(store, uri), 'utf8')).resolves.toContain('remote update');
  });

  it('leaves an in-progress rebase untouched when retrying pending ingestion', async () => {
    const {config, home, seed, worktree} = await makeShareRepo();
    const relativePath = 'durable/projects/threadnote/shared.md';
    const oldContent = 'MEMORY\nkind: durable\nstatus: active\n\nold shared\n';
    await mkdir(dirname(join(seed, relativePath)), {recursive: true});
    await writeFile(join(seed, relativePath), oldContent, 'utf8');
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'add shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);
    await git(['pull', '--rebase', 'origin', 'main'], worktree);

    await writeFile(
      join(worktree, relativePath),
      'MEMORY\nkind: durable\nstatus: active\n\nlocal resolution\n',
      'utf8',
    );
    await git(['add', relativePath], worktree);
    await git(['commit', '-m', 'local shared edit'], worktree);
    await writeFile(join(seed, relativePath), 'MEMORY\nkind: durable\nstatus: active\n\nremote resolution\n', 'utf8');
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'remote shared edit'], seed);
    await git(['push', 'origin', 'main'], seed);
    await git(['fetch', 'origin'], worktree);
    const rebase = await runEffect(runCommand('git', ['rebase', 'origin/main'], {allowFailure: true, cwd: worktree}));
    expect(rebase.exitCode).not.toBe(0);
    await writeFile(
      join(home, 'share', 'auto-sync-pending-reindexes.json'),
      `${JSON.stringify(
        {
          teams: {
            default: [{path: join(worktree, relativePath), relativePath, status: 'modified'}],
          },
          version: 1,
        },
        undefined,
        2,
      )}\n`,
      'utf8',
    );
    const statusBefore = await gitOutput(['status', '--porcelain'], worktree);
    const indexBefore = await gitOutput(['ls-files', '-u'], worktree);
    const contentBefore = await readFile(join(worktree, relativePath), 'utf8');

    const result = await syncSharedReposBeforeAgentRead(config);

    expect(result.syncedTeams).toEqual([]);
    expect(result.warnings.some(warning => warning.includes('Git operation already in progress'))).toBe(true);
    expect(result.warnings.some(warning => warning.includes('continued for other remote changes'))).toBe(false);
    await expect(gitOutput(['status', '--porcelain'], worktree)).resolves.toBe(statusBefore);
    await expect(gitOutput(['ls-files', '-u'], worktree)).resolves.toBe(indexBefore);
    await expect(readFile(join(worktree, relativePath), 'utf8')).resolves.toBe(contentBefore);
  });

  it('leaves an in-progress merge index and worktree untouched', async () => {
    const {config, root, seed, worktree} = await makeShareRepo();
    const {ov, store} = await installFakeOv(root);
    process.env.THREADNOTE_OV = ov;
    process.env.THREADNOTE_FAKE_OV_STORE = store;
    const relativePath = 'durable/projects/threadnote/shared.md';
    await mkdir(dirname(join(seed, relativePath)), {recursive: true});
    await writeFile(join(seed, relativePath), 'MEMORY\nkind: durable\nstatus: active\n\nremote body\n', 'utf8');
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'add shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);
    await git(['fetch', 'origin'], worktree);
    await git(['merge', '--no-ff', '--no-commit', 'origin/main'], worktree);
    const statusBefore = await gitOutput(['status', '--porcelain'], worktree);
    const indexBefore = await gitOutput(['diff', '--cached', '--binary'], worktree);
    const contentBefore = await readFile(join(worktree, relativePath), 'utf8');

    const result = await syncSharedReposBeforeAgentRead(config);

    expect(result.syncedTeams).toEqual([]);
    expect(result.warnings.some(warning => warning.includes('Git operation already in progress'))).toBe(true);
    await expect(gitOutput(['status', '--porcelain'], worktree)).resolves.toBe(statusBefore);
    await expect(gitOutput(['diff', '--cached', '--binary'], worktree)).resolves.toBe(indexBefore);
    await expect(readFile(join(worktree, relativePath), 'utf8')).resolves.toBe(contentBefore);
  });

  it('preserves unrelated untracked files and reports that automatic sync is blocked', async () => {
    const {config, seed, worktree} = await makeShareRepo();
    const relativePath = 'durable/projects/threadnote/shared.md';
    await writeFile(join(worktree, 'local.txt'), 'local only\n', 'utf8');
    await mkdir(join(seed, 'durable', 'projects', 'threadnote'), {recursive: true});
    await writeFile(join(seed, relativePath), 'MEMORY\nkind: durable\nstatus: active\n\nremote body\n', 'utf8');
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'add shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);

    const result = await syncSharedReposBeforeAgentRead(config);

    expect(result.syncedTeams).toEqual([]);
    expect(result.warnings.some(warning => warning.includes('untracked or unmanaged changes'))).toBe(true);
    await expect(readFile(join(worktree, 'local.txt'), 'utf8')).resolves.toBe('local only\n');
    await expect(gitOutput(['rev-parse', 'HEAD'], worktree)).resolves.not.toBe(
      await gitOutput(['rev-parse', 'origin/main'], worktree),
    );
  });

  it('does not let one failed memory ingest block later remote memories', async () => {
    const {config, home, root, seed, worktree} = await makeShareRepo();
    const {ov, store} = await installFakeOv(root);
    process.env.THREADNOTE_OV = ov;
    process.env.THREADNOTE_FAKE_OV_STORE = store;
    const blockedPath = 'durable/projects/threadnote/blocked.md';
    const safePath = 'durable/projects/threadnote/safe.md';
    const safeUri = 'viking://user/denys/memories/shared/default/durable/projects/threadnote/safe.md';
    await mkdir(join(seed, 'durable', 'projects', 'threadnote'), {recursive: true});
    await writeFile(
      join(seed, blockedPath),
      [
        'MEMORY',
        'kind: durable',
        'status: active',
        '',
        ['aws_session_token=', 'abcdefghijklmnopqrstuvwxyz0123456789ABCD'].join(''),
      ].join('\n') + '\n',
      'utf8',
    );
    await git(['add', blockedPath], seed);
    await git(['commit', '-m', 'add blocked shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);

    const firstResult = await syncSharedReposBeforeAgentRead(config);

    expect(firstResult.syncedTeams).toEqual(['default']);
    expect(firstResult.warnings.some(warning => warning.includes('1 pending shared memory ingest failure'))).toBe(true);

    await writeFile(join(seed, safePath), 'MEMORY\nkind: durable\nstatus: active\n\nsafe body\n', 'utf8');
    await git(['add', safePath], seed);
    await git(['commit', '-m', 'add safe shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);
    await git(['-C', worktree, 'fetch', 'origin']);

    const secondResult = await syncSharedReposBeforeAgentRead(config);

    expect(secondResult.syncedTeams).toEqual(['default']);
    expect(secondResult.warnings.some(warning => warning.includes('1 pending shared memory ingest failure'))).toBe(
      true,
    );
    expect(
      secondResult.warnings.some(warning => warning.includes('Automatic sync continued for other remote changes')),
    ).toBe(true);
    await expect(readFile(fakeOvFile(store, safeUri), 'utf8')).resolves.toContain('safe body');
    await expect(gitOutput(['rev-parse', 'HEAD'], worktree)).resolves.toBe(
      await gitOutput(['rev-parse', 'origin/main'], worktree),
    );
    await expect(readFile(join(home, 'share', 'auto-sync-pending-reindexes.json'), 'utf8')).resolves.toContain(
      blockedPath,
    );
  });

  it('materializes previous content only for a failed remote update', async () => {
    const {config, home, root, seed} = await makeShareRepo();
    const {ov, store} = await installFakeOv(root);
    process.env.THREADNOTE_OV = ov;
    process.env.THREADNOTE_FAKE_OV_STORE = store;
    const relativePath = 'durable/projects/threadnote/shared.md';
    const oldContent = 'MEMORY\nkind: durable\nstatus: active\n\nold shared\n';
    await mkdir(dirname(join(seed, relativePath)), {recursive: true});
    await writeFile(join(seed, relativePath), oldContent, 'utf8');
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'add shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);
    await runShareSync(config, {push: true});
    await git(['pull', '--rebase', 'origin', 'main'], seed);

    await writeFile(
      join(seed, relativePath),
      [
        'MEMORY',
        'kind: durable',
        'status: active',
        '',
        ['aws_session_token=', 'abcdefghijklmnopqrstuvwxyz0123456789ABCD'].join(''),
      ].join('\n') + '\n',
      'utf8',
    );
    await git(['add', relativePath], seed);
    await git(['commit', '-m', 'update shared memory'], seed);
    await git(['push', 'origin', 'main'], seed);

    const result = await syncSharedReposBeforeAgentRead(config);

    expect(result.warnings.some(warning => warning.includes('1 pending shared memory ingest failure'))).toBe(true);
    const pending = JSON.parse(await readFile(join(home, 'share', 'auto-sync-pending-reindexes.json'), 'utf8')) as {
      teams: {default: Array<{previousContent?: string; previousRevision?: string}>};
    };
    expect(pending.teams.default[0]?.previousContent).toBe(oldContent);
    expect(pending.teams.default[0]?.previousRevision).toBeUndefined();
  });
});
