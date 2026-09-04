import {execFile} from '../helpers/node-child-process.js';
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from '../helpers/node-fs-promises.js';
import {tmpdir} from '../helpers/node-os.js';
import {join} from '../helpers/node-path.js';
import {promisify} from '../helpers/node-util.js';
import {describe, expect, it} from 'vitest';

const execFilePromise = promisify(execFile);

describe('code graph sharing Phases 0–2', () => {
  it('imports a verified shared checkpoint on a second home and keeps local graphs without enrollment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-graph-share-'));
    const repository = join(root, 'repository');
    const cas = join(root, 'cas');
    const publisherHome = join(root, 'publisher-home');
    const clientHome = join(root, 'client-home');
    const localHome = join(root, 'local-home');
    try {
      await mkdir(join(repository, 'src'), {recursive: true});
      await writeFile(join(repository, 'package.json'), '{"name":"graph-share","private":true,"type":"module"}\n');
      await writeFile(join(repository, 'src', 'index.ts'), 'export const shared = 1;\n');
      await git(repository, ['init', '-q', '--initial-branch=main']);
      await git(repository, ['remote', 'add', 'origin', 'https://github.com/acme/graph-share.git']);
      await git(repository, ['add', '.']);
      await commit(repository, 'base');

      await runCli(['graph', 'index', '--home', publisherHome, '--cwd', repository, '--json']);
      const initialized = JSON.parse(
        (
          await runCli([
            'graph',
            'share',
            'init',
            '--home',
            publisherHome,
            '--cwd',
            repository,
            '--cas',
            cas,
            '--organization',
            'acme',
            '--write-config',
            '--json',
          ])
        ).stdout,
      ) as {readonly profileDigest: string; readonly written: boolean};
      expect(initialized.written).toBe(true);
      expect(initialized.profileDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
      await git(repository, ['add', '.threadnote/graph-share.json']);
      await commit(repository, 'enroll graph sharing');
      await runCli(['graph', 'index', '--full', '--home', publisherHome, '--cwd', repository, '--json']);
      const published = JSON.parse(
        (
          await runCli([
            'graph',
            'publisher',
            'bootstrap',
            '--home',
            publisherHome,
            '--cwd',
            repository,
            '--cas',
            cas,
            '--json',
          ])
        ).stdout,
      ) as {readonly checkpointDigest: string; readonly manifestDigest: string};
      expect(published.checkpointDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);

      const casBeforeJoin = await listFiles(cas);
      await runCli([
        'graph',
        'share',
        'join',
        '--home',
        clientHome,
        '--cwd',
        repository,
        '--cas',
        cas,
        '--read-only',
        '--json',
      ]);
      expect(await listFiles(cas)).toEqual(casBeforeJoin);

      const indexed = JSON.parse(
        (await runCli(['graph', 'index', '--home', clientHome, '--cwd', repository, '--json'])).stdout,
      ) as {
        readonly identity: {readonly checkoutId: string};
        readonly snapshot: {
          readonly commit: string;
          readonly fileCount: number;
          readonly graphContentId?: string;
          readonly id: string;
          readonly symbolCount: number;
        };
      };
      expect(indexed.snapshot.id).toMatch(/^cgsn_/);
      const provenance = JSON.parse(
        await readFile(join(clientHome, 'graph-sharing', 'provenance', `${indexed.identity.checkoutId}.json`), 'utf8'),
      ) as {readonly checkpointDigest: string; readonly snapshotId: string};
      expect(provenance.checkpointDigest).toBe(published.checkpointDigest);
      expect(provenance.snapshotId).toBe(indexed.snapshot.id);
      const queried = JSON.parse(
        (await runCli(['graph', 'query', '--home', clientHome, '--cwd', repository, '--query', 'shared', '--json']))
          .stdout,
      ) as {
        readonly nodes: ReadonlyArray<{readonly name: string}>;
        readonly source?: {
          readonly deltaCount: number;
          readonly frontierCommit: string;
          readonly kind: string;
          readonly localCommit: string;
          readonly profileDigest: string;
        };
      };
      expect(queried.source).toMatchObject({
        kind: 'shared-base-plus-local-overlay',
        profileDigest: initialized.profileDigest,
      });

      const parityHome = join(root, 'parity-home');
      const parityStatus = JSON.parse(
        (await runCli(['graph', 'share', 'status', '--home', parityHome, '--cwd', repository, '--json'])).stdout,
      ) as {readonly enrolled: boolean; readonly trusted: boolean};
      expect(parityStatus).toMatchObject({enrolled: true, trusted: false});
      const localIndexed = JSON.parse(
        (await runCli(['graph', 'index', '--home', parityHome, '--cwd', repository, '--json'])).stdout,
      ) as {
        readonly snapshot: {
          readonly commit: string;
          readonly fileCount: number;
          readonly graphContentId?: string;
          readonly id: string;
          readonly symbolCount: number;
        };
      };
      expect(localIndexed.snapshot.commit).toBe(indexed.snapshot.commit);
      expect(localIndexed.snapshot.fileCount).toBe(indexed.snapshot.fileCount);
      expect(localIndexed.snapshot.symbolCount).toBe(indexed.snapshot.symbolCount);
      expect(localIndexed.snapshot.graphContentId).toBe(indexed.snapshot.graphContentId);
      const localQueried = JSON.parse(
        (await runCli(['graph', 'query', '--home', parityHome, '--cwd', repository, '--query', 'shared', '--json']))
          .stdout,
      ) as {readonly nodes: ReadonlyArray<{readonly name: string}>; readonly source?: unknown};
      expect(localQueried.source).toBeUndefined();
      expect(localQueried.nodes.map(node => node.name).sort()).toEqual(queried.nodes.map(node => node.name).sort());

      await writeFile(join(repository, 'src', 'dirty.ts'), 'export const dirty = 2;\n');
      await runCli(['graph', 'index', '--home', clientHome, '--cwd', repository, '--json']);
      const overlay = JSON.parse(
        (await runCli(['graph', 'query', '--home', clientHome, '--cwd', repository, '--query', 'dirty', '--json']))
          .stdout,
      ) as {
        readonly nodes: ReadonlyArray<{readonly name: string}>;
        readonly snapshot: {readonly dirty: boolean; readonly id: string};
        readonly source?: {
          readonly deltaCount: number;
          readonly frontierCommit: string;
          readonly kind: string;
          readonly localCommit: string;
          readonly profileDigest: string;
        };
      };
      expect(overlay.snapshot.dirty).toBe(true);
      expect(overlay.nodes.some(node => node.name === 'dirty')).toBe(true);
      expect(overlay.source).toMatchObject({
        deltaCount: 0,
        kind: 'shared-base-plus-local-overlay',
        profileDigest: initialized.profileDigest,
      });
      const overlayProvenance = JSON.parse(
        await readFile(join(clientHome, 'graph-sharing', 'provenance', `${indexed.identity.checkoutId}.json`), 'utf8'),
      ) as {readonly snapshotId: string};
      expect(overlayProvenance.snapshotId).toBe(indexed.snapshot.id);

      await rm(join(repository, 'src', 'dirty.ts'));
      const contribution = JSON.parse(
        (await runCli(['graph', 'contribute', 'status', '--home', clientHome, '--cwd', repository, '--json'])).stdout,
      ) as {readonly mode: string; readonly queued: number};
      expect(contribution).toMatchObject({mode: 'off', queued: 0});
      const idleServe = JSON.parse(
        (
          await runCli([
            'graph',
            'publisher',
            'serve',
            '--home',
            publisherHome,
            '--cwd',
            repository,
            '--cas',
            cas,
            '--json',
          ])
        ).stdout,
      ) as {readonly generation: number; readonly sourceCommit: string};
      expect(idleServe.generation).toBe(1);
      await writeFile(join(repository, 'src', 'next.ts'), 'export const next = 3;\n');
      await git(repository, ['add', 'src/next.ts']);
      await commit(repository, 'advance frontier');
      await runCli(['graph', 'index', '--full', '--home', publisherHome, '--cwd', repository, '--json']);
      const served = JSON.parse(
        (
          await runCli([
            'graph',
            'publisher',
            'serve',
            '--home',
            publisherHome,
            '--cwd',
            repository,
            '--cas',
            cas,
            '--json',
          ])
        ).stdout,
      ) as {readonly generation: number; readonly sourceCommit: string};
      expect(served.generation).toBe(2);
      expect(served.sourceCommit).not.toBe(idleServe.sourceCommit);
      const advanced = JSON.parse(
        (await runCli(['graph', 'index', '--home', clientHome, '--cwd', repository, '--json'])).stdout,
      ) as {readonly snapshot: {readonly id: string}};
      expect(advanced.snapshot.id).toMatch(/^cgsn_/);
      const worker = JSON.parse(
        (await runCli(['graph', 'worker', '--json', '--home', clientHome, '--cwd', repository])).stdout,
      ) as {readonly eligible: number; readonly skippedMissingBlob: number};
      expect(worker).toMatchObject({eligible: 0, skippedMissingBlob: 0});

      const unenrolled = join(root, 'unenrolled');
      await mkdir(join(unenrolled, 'src'), {recursive: true});
      await writeFile(join(unenrolled, 'package.json'), '{"name":"local-only","private":true,"type":"module"}\n');
      await writeFile(join(unenrolled, 'src', 'index.ts'), 'export const localOnly = 1;\n');
      await git(unenrolled, ['init', '-q', '--initial-branch=main']);
      await git(unenrolled, ['remote', 'add', 'origin', 'https://github.com/acme/local-only.git']);
      await git(unenrolled, ['add', '.']);
      await commit(unenrolled, 'local');
      const localIndex = JSON.parse(
        (await runCli(['graph', 'index', '--home', localHome, '--cwd', unenrolled, '--json'])).stdout,
      ) as {readonly snapshot: {readonly id: string}};
      expect(localIndex.snapshot.id).toMatch(/^cgsn_/);
      const status = JSON.parse(
        (await runCli(['graph', 'share', 'status', '--home', localHome, '--cwd', unenrolled, '--json'])).stdout,
      ) as {readonly enrolled: boolean};
      expect(status.enrolled).toBe(false);
    } finally {
      await rm(root, {force: true, recursive: true});
    }
  }, 180_000);
});

async function listFiles(root: string): Promise<readonly string[]> {
  try {
    return (await readdir(root, {recursive: true})).slice().sort();
  } catch {
    return [];
  }
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFilePromise('git', ['-C', cwd, ...args]);
}

async function commit(cwd: string, message: string): Promise<void> {
  await git(cwd, [
    '-c',
    'user.name=Threadnote Test',
    '-c',
    'user.email=test@threadnote.local',
    'commit',
    '-qm',
    message,
  ]);
}

function runCli(args: readonly string[]) {
  return execFilePromise(process.execPath, ['src/standalone.ts', ...args], {
    cwd: process.cwd(),
    env: {...process.env, NO_COLOR: '1', THREADNOTE_TELEMETRY: '0'},
  });
}
