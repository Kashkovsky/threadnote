import {chmod, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {runShareSync} from '../../src/share.js';
import type {ShareRuntime, ShareTeamsFile} from '../../src/types.js';
import {runCommand} from '../../src/utils.js';

interface TestShareRepo {
  readonly config: ShareRuntime;
  readonly home: string;
  readonly remote: string;
  readonly root: string;
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
