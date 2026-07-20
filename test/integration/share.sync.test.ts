import {chmod, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {Effect} from 'effect';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {listShareConflicts, showShareConflict} from '../../src/share.js';
import {
  resolveShareConflict as resolveShareConflictEffect,
  runShareInit as runShareInitEffect,
  runShareSync as runShareSyncEffect,
} from '../../src/effect/share.js';
import type {ShareRuntime, ShareTeamsFile} from '../../src/types.js';
import {runCommand} from '../../src/utils.js';

const runShareInit = (...args: Parameters<typeof runShareInitEffect>) => Effect.runPromise(runShareInitEffect(...args));
const runShareSync = (...args: Parameters<typeof runShareSyncEffect>) => Effect.runPromise(runShareSyncEffect(...args));
const resolveShareConflict = (...args: Parameters<typeof resolveShareConflictEffect>) =>
  Effect.runPromise(resolveShareConflictEffect(...args));

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
  await runCommand('git', args, {cwd});
}

async function gitOutput(args: readonly string[], cwd?: string): Promise<string> {
  const result = await runCommand('git', args, {cwd});
  return result.stdout.trim();
}

function fakeOvFile(store: string, uri: string): string {
  return join(store, `${Buffer.from(uri).toString('base64url')}.txt`);
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
  process.exit(fs.existsSync(fileFor(uri)) || fs.existsSync(markerFor(uri)) ? 0 : 1);
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

  it('strips personal provenance before ingesting upstream shared memories', async () => {
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

  it('keeps a pending added reindex blocked when OpenViking has a real local edit', async () => {
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

    await expect(readFile(fakeOvFile(store, uri), 'utf8')).resolves.toContain('local edit');
    await expect(readFile(pendingPath, 'utf8')).resolves.toContain('"status": "added"');
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

    const conflicts = await listShareConflicts(config, {team: 'default'});
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      id,
      reason: 'local OpenViking content differs from the newly added shared file',
      status: 'added',
    });
    const detail = await showShareConflict(config, id);
    expect(detail.diff).toContain('local edit');
    expect(detail.diff).toContain('shared body');

    const result = await resolveShareConflict(config, id, {take: 'shared'});

    expect(result.backupPath).toContain('conflict-backups');
    await expect(readFile(fakeOvFile(store, uri), 'utf8')).resolves.toBe(
      'MEMORY\nkind: durable\nstatus: active\n\nshared body\n',
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

  it('preserves previousContent when replaying a pending modified reindex after restart', async () => {
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
    await writeFile(fakeOvFile(store, uri), `${oldContent}\n`, 'utf8');

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

  it('does not delete a local shared resource that diverged from the previous shared version', async () => {
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

    await expect(readFile(fakeOvFile(store, uri), 'utf8')).resolves.toContain('local edit');
  });
});
