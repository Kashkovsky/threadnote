import {provideTestLayer} from '../helpers/effect-layer.js';
import {join} from '../helpers/node-path.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {expect, it} from '@effect/vitest';
import {Effect, FileSystem} from 'effect';
import {describe} from 'vitest';
import {SystemInfo} from '../../src/effect/system.js';
import {handleManagerProcessRequest} from '../../src/manager_processes.js';
import type {RuntimeConfig} from '../../src/types.js';

describe('Manager process API', () => {
  it.effect('requires explicit confirmation before process termination', () =>
    Effect.gen(function* () {
      const response = yield* handleManagerProcessRequest({
        body: Effect.succeed({processId: 123, processRef: `tnp_${'a'.repeat(64)}`}),
        config: testConfig('/unused'),
        method: 'POST',
        url: new URL('http://localhost/api/processes/terminate'),
      });
      expect(response).toEqual({
        body: {
          code: 'confirmation-required',
          error: 'Confirm termination of the selected Threadnote process.',
          retryAfterMilliseconds: 0,
        },
        status: 400,
      });
    }).pipe(provideTestLayer(SystemInfo.layer), provideTestLayer(BunServices.layer)),
  );

  it.effect('maps a stale opaque process target to a typed conflict without signaling', () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const nativeSystem = yield* SystemInfo;
      const home = yield* fileSystem.makeTempDirectoryScoped({prefix: 'threadnote-manager-process-stale-'});
      const processId = 1_234_601;
      yield* writeRegistration(fileSystem, home, processId, 'private-registration-token');
      let signals = 0;
      const testSystem = SystemInfo.of({
        ...nativeSystem,
        isProcessRunning: id => id === processId,
        processStartIdentity: () => Effect.succeed('identity-a'),
        signalProcess: () => {
          signals += 1;
        },
      });
      const response = yield* handleManagerProcessRequest({
        body: Effect.succeed({confirm: true, processId, processRef: `tnp_${'a'.repeat(64)}`}),
        config: testConfig(home),
        method: 'POST',
        url: new URL('http://localhost/api/processes/terminate'),
      }).pipe(Effect.provideService(SystemInfo, testSystem));
      expect(response).toMatchObject({body: {code: 'process-stale'}, status: 409});
      expect(signals).toBe(0);
    }).pipe(provideTestLayer(SystemInfo.layer), provideTestLayer(BunServices.layer), Effect.scoped),
  );

  it.effect('returns a privacy-safe inventory and a successful exact-instance termination response', () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const nativeSystem = yield* SystemInfo;
      const home = yield* fileSystem.makeTempDirectoryScoped({prefix: 'threadnote-manager-process-success-'});
      const processId = 1_234_602;
      const token = 'private-success-registration-token';
      yield* writeRegistration(fileSystem, home, processId, token);
      let running = true;
      const signals: NodeJS.Signals[] = [];
      const testSystem = SystemInfo.of({
        ...nativeSystem,
        isProcessRunning: id => id === processId && running,
        processStartIdentity: () => Effect.succeed('identity-a'),
        signalProcess: (_id, signal) => {
          signals.push(signal);
          running = false;
        },
      });
      const config = testConfig(home);
      const listed = yield* handleManagerProcessRequest({
        body: Effect.succeed({}),
        config,
        method: 'GET',
        url: new URL('http://localhost/api/processes'),
      }).pipe(Effect.provideService(SystemInfo, testSystem));
      expect(listed).toBeDefined();
      expect(listed!.status).toBe(200);
      const serialized = JSON.stringify(listed!.body);
      expect(serialized).not.toContain(token);
      expect(serialized).not.toContain(home);
      const process = (listed!.body as {processes: readonly {processId: number; processRef?: string}[]}).processes[0]!;
      expect(process).toMatchObject({processId, processRef: expect.stringMatching(/^tnp_[0-9a-f]{64}$/u)});

      const terminated = yield* handleManagerProcessRequest({
        body: Effect.succeed({confirm: true, processId, processRef: process.processRef}),
        config,
        method: 'POST',
        url: new URL('http://localhost/api/processes/terminate'),
      }).pipe(Effect.provideService(SystemInfo, testSystem));
      expect(terminated).toEqual({body: {processId, state: 'terminated'}, status: 200});
      expect(signals).toEqual(['SIGTERM']);
    }).pipe(provideTestLayer(SystemInfo.layer), provideTestLayer(BunServices.layer), Effect.scoped),
  );
});

function writeRegistration(fileSystem: FileSystem.FileSystem, home: string, processId: number, token: string) {
  return Effect.gen(function* () {
    const directory = join(home, 'runtime', 'processes');
    yield* fileSystem.makeDirectory(directory, {recursive: true});
    yield* fileSystem.writeFileString(
      join(directory, `${processId}.json`),
      `${JSON.stringify({
        baseRole: 'mcp',
        currentOperation: 'mcp-server',
        parentProcessId: 42,
        processId,
        processStartIdentity: 'identity-a',
        role: 'mcp',
        schemaVersion: 1,
        startedAt: '2026-08-12T00:00:00.000Z',
        token,
        updatedAt: '2026-08-12T00:00:00.000Z',
      })}\n`,
    );
  });
}

function testConfig(agentContextHome: string): RuntimeConfig {
  return {
    account: 'local',
    agentContextHome,
    agentId: 'threadnote',
    manifestPath: join(agentContextHome, 'manifest.yaml'),
    user: 'test',
  };
}
