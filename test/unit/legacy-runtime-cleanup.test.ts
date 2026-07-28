import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Effect} from 'effect';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {captureConsole} from '../../src/effect/console.js';
import {HttpService, type HttpServiceShape} from '../../src/effect/http.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {SystemInfo} from '../../src/effect/system.js';
import {stopVerifiedLegacyLocalAi} from '../../src/migration/legacy-runtime.js';

const homes: string[] = [];
const launchId = '2025ed4f-fdfa-4467-949a-fecd0411fccb';
const model = 'legacy-model';
const pid = 30_356;
const port = 19_340;
const token = 'a'.repeat(43);

afterEach(async () => {
  await Promise.all(homes.splice(0).map(home => rm(home, {force: true, recursive: true})));
});

describe('legacy local AI cleanup', () => {
  it('stops only a process with a matching receipt and token-derived loopback proof', async () => {
    const legacyHome = await makeLegacyHome();
    let running = true;
    const signalProcess = vi.fn((_pid: number, _signal: NodeJS.Signals) => {
      running = false;
    });
    const services = await testServices(legacyHome, {
      isProcessRunning: () => running,
      signalProcess,
    });

    const result = await Effect.runPromise(
      captureConsole(stopVerifiedLegacyLocalAi({dryRun: false, legacyHome})).pipe(
        Effect.provideService(HttpService, services.http),
        Effect.provideService(SystemInfo, services.system),
        Effect.provide(ApplicationLayer),
      ),
    );

    expect(signalProcess).toHaveBeenCalledWith(pid, 'SIGTERM');
    expect(result.output).toContain(`Stopped verified legacy local AI process ${pid}.`);
    await expect(readFile(join(legacyHome, 'local-ai-server.json'), 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
    await expect(readFile(join(legacyHome, 'threadnote', 'local-ai-token'), 'utf8')).resolves.toBe(token);
  });

  it('leaves a live process untouched when its health proof does not match', async () => {
    const legacyHome = await makeLegacyHome();
    const signalProcess = vi.fn();
    const services = await testServices(
      legacyHome,
      {isProcessRunning: () => true, signalProcess},
      {invalidProof: true},
    );

    const result = await Effect.runPromise(
      captureConsole(stopVerifiedLegacyLocalAi({dryRun: false, legacyHome})).pipe(
        Effect.provideService(HttpService, services.http),
        Effect.provideService(SystemInfo, services.system),
        Effect.provide(ApplicationLayer),
      ),
    );

    expect(signalProcess).not.toHaveBeenCalled();
    expect(result.output).toContain(`WARN legacy local AI process ${pid} could not be verified`);
    await expect(readFile(join(legacyHome, 'local-ai-server.json'), 'utf8')).resolves.toContain(launchId);
  });

  it('reports a verified dry run without signaling the process', async () => {
    const legacyHome = await makeLegacyHome();
    const signalProcess = vi.fn();
    const services = await testServices(legacyHome, {
      isProcessRunning: () => true,
      signalProcess,
    });

    const result = await Effect.runPromise(
      captureConsole(stopVerifiedLegacyLocalAi({dryRun: true, legacyHome})).pipe(
        Effect.provideService(HttpService, services.http),
        Effect.provideService(SystemInfo, services.system),
        Effect.provide(ApplicationLayer),
      ),
    );

    expect(signalProcess).not.toHaveBeenCalled();
    expect(result.output).toContain(`Would stop verified legacy local AI process ${pid}.`);
    await expect(readFile(join(legacyHome, 'local-ai-server.json'), 'utf8')).resolves.toContain(launchId);
  });
});

async function makeLegacyHome(): Promise<string> {
  const legacyHome = await mkdtemp(join(tmpdir(), 'threadnote-legacy-runtime-'));
  homes.push(legacyHome);
  await mkdir(join(legacyHome, 'threadnote'), {recursive: true});
  await writeFile(
    join(legacyHome, 'local-ai-server.json'),
    `${JSON.stringify({launchId, pid, startedAt: '2026-07-27T00:00:00.000Z', version: 1})}\n`,
  );
  await writeFile(
    join(legacyHome, 'threadnote', 'local-ai.json'),
    `${JSON.stringify({enabled: true, host: '127.0.0.1', model, port, version: 1})}\n`,
  );
  await writeFile(join(legacyHome, 'threadnote', 'local-ai-token'), token);
  return legacyHome;
}

async function testServices(
  legacyHome: string,
  processOverrides: {
    readonly isProcessRunning: (pid: number) => boolean;
    readonly signalProcess: (pid: number, signal: NodeJS.Signals) => void;
  },
  options: {readonly invalidProof?: boolean} = {},
) {
  const system = await Effect.runPromise(SystemInfo.pipe(Effect.provide(ApplicationLayer)));
  const testSystem = SystemInfo.of({
    ...system,
    homeDirectory: join(legacyHome, '..'),
    isProcessRunning: processOverrides.isProcessRunning,
    signalProcess: processOverrides.signalProcess,
  });
  const http = HttpService.of({
    downloadToFile: () => Effect.die(new Error('Unexpected download')),
    getJson: url =>
      Effect.sync(() => {
        const challenge = new URL(url).searchParams.get('challenge') ?? '';
        const proof = options.invalidProof
          ? '0'.repeat(64)
          : createHash('sha256')
              .update([challenge, 'threadnote-local-ai', model, String(pid), launchId, token].join('\0'))
              .digest('hex');
        return {
          body: {launchId, model, pid, proof, service: 'threadnote-local-ai', status: 'ok'},
          status: 200,
        };
      }),
    getStatus: () => Effect.die(new Error('Unexpected status request')),
    getText: () => Effect.die(new Error('Unexpected text request')),
  } satisfies HttpServiceShape);
  return {http, system: testSystem};
}
