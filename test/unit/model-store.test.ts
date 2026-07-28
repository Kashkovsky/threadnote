import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {createServer, type Server} from 'node:http';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {Effect, Result} from 'effect';
import {afterEach, describe, expect, it} from 'vitest';
import {assertSufficientModelDiskSpace, LocalModelStore} from '../../src/models/store.js';
import type {LocalModelManifest} from '../../src/models/catalog.js';
import {runEffect} from '../helpers/effect-runtime.js';

const homes: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  await Promise.all(homes.splice(0).map(home => rm(home, {force: true, recursive: true})));
});

describe('LocalModelStore', () => {
  it('fails disk-space preflight before a model download can start', async () => {
    const manifest = fixtureManifest(Buffer.from('fixture'));
    const result = await Effect.runPromise(
      assertSufficientModelDiskSpace(manifest, manifest.size, manifest.size).pipe(Effect.result),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure._tag).toBe('InsufficientDiskSpace');
      expect(result.failure.requiredBytes).toBe(manifest.size * 2);
    }
  });

  it('resumes a partial download, verifies SHA-256, and atomically promotes it', async () => {
    const bytes = Buffer.from('small deterministic GGUF fixture');
    const manifest = fixtureManifest(bytes);
    const ranges: Array<string | undefined> = [];
    const sourceUrl = await serve(bytes, ranges);
    const home = await mkdtemp(join(tmpdir(), 'threadnote-model-store-'));
    homes.push(home);

    const installedPath = await runEffect(
      Effect.gen(function* () {
        const store = yield* LocalModelStore;
        return store.path(home, manifest);
      }),
    );
    await mkdir(dirname(installedPath), {recursive: true});
    await writeFile(`${installedPath}.partial`, bytes.subarray(0, 6));

    const result = await runEffect(
      Effect.gen(function* () {
        const store = yield* LocalModelStore;
        return yield* store.install(home, manifest, {sourceUrl});
      }),
    );

    expect(result.resumed).toBe(true);
    expect(result.verified).toBe(true);
    expect(ranges).toEqual(['bytes=6-']);
    expect(await readFile(installedPath)).toEqual(bytes);
    await expect(readFile(`${installedPath}.partial`)).rejects.toThrow();
  });

  it('removes a checksum-invalid completed download instead of promoting it', async () => {
    const expected = Buffer.from('expected model bytes');
    const actual = Buffer.from('x'.repeat(expected.length));
    expect(actual.length).toBe(expected.length);
    const manifest = fixtureManifest(expected);
    const sourceUrl = await serve(actual, []);
    const home = await mkdtemp(join(tmpdir(), 'threadnote-model-store-checksum-'));
    homes.push(home);

    const result = await runEffect(
      Effect.gen(function* () {
        const store = yield* LocalModelStore;
        return yield* Effect.result(store.install(home, manifest, {sourceUrl}));
      }),
    );

    expect(result._tag).toBe('Failure');
    if (result._tag === 'Failure') {
      expect(result.failure._tag).toBe('ModelChecksumMismatch');
    }
    const installedPath = await runEffect(
      Effect.gen(function* () {
        const store = yield* LocalModelStore;
        return store.path(home, manifest);
      }),
    );
    await expect(readFile(installedPath)).rejects.toThrow();
    await expect(readFile(`${installedPath}.partial`)).rejects.toThrow();
  });

  it('repairs a corrupt installed model inside the installation lock', async () => {
    const bytes = Buffer.from('verified model replacement bytes');
    const manifest = fixtureManifest(bytes);
    const ranges: Array<string | undefined> = [];
    const sourceUrl = await serve(bytes, ranges);
    const home = await mkdtemp(join(tmpdir(), 'threadnote-model-store-repair-'));
    homes.push(home);
    const store = await runEffect(
      Effect.gen(function* () {
        return yield* LocalModelStore;
      }),
    );
    const installedPath = store.path(home, manifest);
    await runEffect(store.install(home, manifest, {sourceUrl}));
    await writeFile(installedPath, Buffer.from('x'.repeat(bytes.length)));

    const repaired = await runEffect(store.install(home, manifest, {sourceUrl}));

    expect(repaired.verified).toBe(true);
    expect(await readFile(installedPath)).toEqual(bytes);
    expect(ranges).toEqual([undefined, undefined]);
  });

  it('serializes removal behind an in-progress installation of the same model', async () => {
    const bytes = Buffer.from('barrier-controlled model bytes');
    const manifest = fixtureManifest(bytes);
    const controlled = await serveControlled(bytes);
    const home = await mkdtemp(join(tmpdir(), 'threadnote-model-store-lock-'));
    homes.push(home);
    const completionOrder: string[] = [];
    let signalRemoveContention = () => {};
    const removeContended = new Promise<void>(resolve => {
      signalRemoveContention = resolve;
    });
    const layer = LocalModelStore.layerWith({
      onModelLockCompleted: event =>
        Effect.sync(() => {
          completionOrder.push(event.operation);
        }),
      onModelLockContention: event =>
        Effect.sync(() => {
          if (event.operation === 'remove') signalRemoveContention();
        }),
    });
    const [installStore, removeStore] = await Promise.all([
      runEffect(LocalModelStore.pipe(Effect.provide(layer))),
      runEffect(LocalModelStore.pipe(Effect.provide(layer))),
    ]);
    const installedPath = installStore.path(home, manifest);

    const install = runEffect(installStore.install(home, manifest, {sourceUrl: controlled.sourceUrl}));
    await controlled.requestStarted;
    const remove = runEffect(removeStore.remove(home, manifest));
    await removeContended;
    controlled.release();

    await expect(install).resolves.toMatchObject({installed: true, verified: true});
    await expect(remove).resolves.toBe(true);
    expect(completionOrder).toEqual(['install', 'remove']);
    await expect(readFile(installedPath)).rejects.toThrow();
  });
});

function fixtureManifest(bytes: Uint8Array): LocalModelManifest {
  return {
    architecture: 'bert',
    contextLimit: 512,
    dimensions: 384,
    file: 'fixture.gguf',
    id: 'fixture-embedding',
    license: 'test-only',
    minimumRamBytes: 1,
    normalization: 'l2',
    promptPrefixes: {document: '', query: ''},
    quantization: 'F32',
    repository: 'threadnote/fixtures',
    revision: 'a'.repeat(40),
    role: 'embedding',
    runtime: {nodeLlamaCpp: '3.19.1'},
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
    task: 'retrieval',
    version: 1,
  };
}

async function serve(bytes: Buffer, ranges: Array<string | undefined>): Promise<string> {
  const server = createServer((request, response) => {
    const range = request.headers.range;
    ranges.push(range);
    const offset = range ? Number.parseInt(range.replace(/^bytes=(\d+)-.*$/, '$1'), 10) : 0;
    const body = bytes.subarray(Number.isFinite(offset) ? offset : 0);
    response.writeHead(range ? 206 : 200, {
      'Content-Length': body.length,
      'Content-Type': 'application/octet-stream',
      ...(range ? {'Content-Range': `bytes ${offset}-${bytes.length - 1}/${bytes.length}`} : {}),
    });
    response.end(body);
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not resolve test model server address.');
  return `http://127.0.0.1:${address.port}/model.gguf`;
}

async function serveControlled(bytes: Buffer): Promise<{
  readonly release: () => void;
  readonly requestStarted: Promise<void>;
  readonly sourceUrl: string;
}> {
  let release = () => {};
  let markStarted = () => {};
  const requestStarted = new Promise<void>(resolve => {
    markStarted = resolve;
  });
  const server = createServer((_request, response) => {
    markStarted();
    release = () => {
      response.writeHead(200, {
        'Content-Length': bytes.length,
        'Content-Type': 'application/octet-stream',
      });
      response.end(bytes);
    };
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not resolve test model server address.');
  return {
    release: () => release(),
    requestStarted,
    sourceUrl: `http://127.0.0.1:${address.port}/model.gguf`,
  };
}
