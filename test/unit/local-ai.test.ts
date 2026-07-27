import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, truncate, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Effect} from 'effect';
import {afterEach, describe, expect, it} from 'vitest';
import {
  EFFECT_AI_API_URL_ENV,
  EFFECT_AI_ENABLED_ENV,
  EFFECT_AI_MODEL_ENV,
  resolveEffectAiConfiguration,
} from '../../src/effect/ai-consolidator.js';
import {
  LOCAL_AI_DEFAULT_PORT,
  LOCAL_AI_MODEL_ID,
  ensureLocalAiStarted,
  listInstalledLocalAiModels,
  localAiDoctorCheck,
  localAiHealthProof,
  localAiApiUrl,
  localAiProcessOwnershipMatches,
  localAiStartupOwnershipMatches,
  parseLocalAiSettings,
  resolveLocalAiServerPython,
  runLocalAiDisable,
  runLocalAiEnable,
  runLocalAiInstall,
  runLocalAiModelSwitch,
} from '../../src/effect/local-ai.js';
import {captureConsole} from '../../src/effect/console.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {findLocalAiModel} from '../../src/local_ai_models.js';
import type {RuntimeConfig} from '../../src/types.js';
import {runEffect} from '../helpers/effect-runtime.js';

const homes: string[] = [];
const ACCESS_TOKEN = 'a'.repeat(43);

afterEach(async () => {
  await Promise.all(homes.splice(0).map(home => rm(home, {force: true, recursive: true})));
});

describe('local AI configuration', () => {
  it('accepts only a loopback, versioned configuration', () => {
    const settings = parseLocalAiSettings({
      enabled: true,
      host: '127.0.0.1',
      model: LOCAL_AI_MODEL_ID,
      modelPath: '/models/gemma.gguf',
      port: LOCAL_AI_DEFAULT_PORT,
      version: 1,
    });

    expect(localAiApiUrl(settings)).toBe('http://127.0.0.1:1934/v1');
    expect(() => parseLocalAiSettings({...settings, host: '0.0.0.0'})).toThrow(/unsupported shape/);
    expect(() => parseLocalAiSettings({...settings, version: 2})).toThrow(/unsupported shape/);
  });

  it('uses persisted local configuration without environment variables', async () => {
    const home = await makeHome();
    await writeSettings(home);

    const resolved = await runEffect(
      resolveEffectAiConfiguration({agentContextHome: home}, {}).pipe(Effect.provide(ApplicationLayer)),
    );

    expect(resolved).toEqual({
      configuration: {apiKey: ACCESS_TOKEN, apiUrl: 'http://127.0.0.1:1934/v1', model: LOCAL_AI_MODEL_ID},
      localAi: expect.objectContaining({model: LOCAL_AI_MODEL_ID}),
    });
  });

  it('proves health responses without sending the access token to an untrusted listener', async () => {
    const proof = await runEffect(
      localAiHealthProof({
        challenge: 'challenge',
        launchId: 'launch-id',
        model: LOCAL_AI_MODEL_ID,
        pid: 42,
        token: ACCESS_TOKEN,
      }).pipe(Effect.provide(ApplicationLayer)),
    );

    expect(proof).toHaveLength(64);
    expect(proof).not.toContain(ACCESS_TOKEN);
  });

  it('only stops a process whose authenticated launch identity matches the record', () => {
    const settings = {model: LOCAL_AI_MODEL_ID, modelPath: '/models/gemma.gguf'};
    const record = {launchId: 'launch-id', modelPath: settings.modelPath, pid: 42};
    const health = {launchId: 'launch-id', model: settings.model, pid: 42};

    expect(localAiProcessOwnershipMatches(record, health, settings)).toBe(true);
    expect(localAiProcessOwnershipMatches(record, undefined, settings)).toBe(false);
    expect(localAiProcessOwnershipMatches(record, {...health, launchId: 'reused-pid'}, settings)).toBe(false);
    expect(localAiProcessOwnershipMatches(record, {...health, pid: 43}, settings)).toBe(false);
  });

  it('accepts the authenticated PID handoff from a Windows virtual-environment redirector', () => {
    const settings = {model: LOCAL_AI_MODEL_ID};
    const launch = {launchId: 'launch-id', pid: 42};
    const redirected = {launchId: 'launch-id', model: LOCAL_AI_MODEL_ID, pid: 43};

    expect(localAiStartupOwnershipMatches(launch, redirected, settings, 'win32')).toBe(true);
    expect(localAiStartupOwnershipMatches(launch, redirected, settings, 'darwin')).toBe(false);
    expect(
      localAiStartupOwnershipMatches(launch, {...redirected, launchId: 'different-launch'}, settings, 'win32'),
    ).toBe(false);
    expect(localAiStartupOwnershipMatches(launch, {...redirected, model: 'different-model'}, settings, 'win32')).toBe(
      false,
    );
  });

  it('uses the windowless Python sibling for the Windows local AI server', async () => {
    const home = await makeHome();
    const scripts = join(home, 'Scripts');
    const python = join(scripts, 'python.exe');
    const windowlessPython = join(scripts, 'pythonw.exe');
    await mkdir(scripts, {recursive: true});
    await writeFile(python, '');
    await writeFile(windowlessPython, '');

    const resolved = await runEffect(resolveLocalAiServerPython(python).pipe(Effect.provide(ApplicationLayer)));

    expect(resolved).toBe(process.platform === 'win32' ? windowlessPython : python);
  });

  it('lets an explicit environment provider override or disable persisted local AI', async () => {
    const home = await makeHome();
    await writeSettings(home);

    const remote = await runEffect(
      resolveEffectAiConfiguration(
        {agentContextHome: home},
        {
          [EFFECT_AI_API_URL_ENV]: 'https://models.example.com/v1',
          [EFFECT_AI_ENABLED_ENV]: '1',
          [EFFECT_AI_MODEL_ENV]: 'remote-model',
        },
      ).pipe(Effect.provide(ApplicationLayer)),
    );
    const disabled = await runEffect(
      resolveEffectAiConfiguration({agentContextHome: home}, {[EFFECT_AI_ENABLED_ENV]: '0'}).pipe(
        Effect.provide(ApplicationLayer),
      ),
    );

    expect(remote).toEqual({
      configuration: {apiKey: undefined, apiUrl: 'https://models.example.com/v1', model: 'remote-model'},
    });
    expect(disabled).toBeUndefined();
  });

  it('prints a complete install plan without requiring OpenViking or a model download', async () => {
    const home = await makeHome();
    const result = await runEffect(
      captureConsole(runLocalAiInstall(runtime(home), {dryRun: true})).pipe(Effect.provide(ApplicationLayer)),
    );

    expect(result.output).toContain('Would download ggml-org/gemma-4-E4B-it-GGUF');
    expect(result.output).toContain('Would verify SHA-256');
    expect(result.output).toContain('Would start the loopback model service at http://127.0.0.1:1934/v1');
  });

  it('rejects unverified install model names with the verified choice', async () => {
    const home = await makeHome();

    expect(findLocalAiModel('LFM2.5-350M')).toBeUndefined();
    await expect(
      runEffect(
        runLocalAiInstall(runtime(home), {dryRun: true, model: 'LFM2.5-350M'}).pipe(Effect.provide(ApplicationLayer)),
      ),
    ).rejects.toThrow(/Available models: gemma-4-E4B-it-Q4_0/);
  });

  it('guides model installation instead of crashing when no models are available', async () => {
    const home = await makeHome();
    const result = await runEffect(
      captureConsole(runLocalAiModelSwitch(runtime(home), {})).pipe(Effect.provide(ApplicationLayer)),
    );

    expect(result.output).toContain('No installed local AI models are available.');
    expect(result.output).toContain('threadnote local-ai install');
    expect(result.output).not.toContain('LFM2.5-350M');
  });

  it('rejects an explicit unverified switch even when no verified model is installed', async () => {
    const home = await makeHome();

    await expect(
      runEffect(runLocalAiModelSwitch(runtime(home), {model: 'LFM2.5-350M'}).pipe(Effect.provide(ApplicationLayer))),
    ).rejects.toThrow(/Unknown local AI model "LFM2.5-350M"/);
  });

  it('refuses a healthy service when its configured model is no longer verified', async () => {
    const home = await makeHome();
    const model = 'LFM2.5-350M';
    const launchId = 'retired-model-test';
    const pid = 42;
    const server = createServer((request, response) => {
      const challenge = new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get('challenge') ?? '';
      const proof = createHash('sha256')
        .update([challenge, 'threadnote-local-ai', model, String(pid), launchId, ACCESS_TOKEN].join('\0'))
        .digest('hex');
      response.writeHead(200, {'content-type': 'application/json'});
      response.end(JSON.stringify({launchId, model, pid, proof, service: 'threadnote-local-ai', status: 'ok'}));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    await writeSettings(home, {model, modelPath: '/models/retired.gguf', port});

    try {
      await expect(
        runEffect(ensureLocalAiStarted(runtime(home)).pipe(Effect.provide(ApplicationLayer))),
      ).rejects.toThrow(`Configured local AI model is unsupported: ${model}`);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error === undefined ? resolve() : reject(error))),
      );
    }
  });

  it('records an authenticated healthy service that survived a failed launcher handoff', async () => {
    const home = await makeHome();
    const launchId = 'redirected-launch';
    const pid = 43;
    const server = createServer((request, response) => {
      const challenge = new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get('challenge') ?? '';
      const proof = createHash('sha256')
        .update([challenge, 'threadnote-local-ai', LOCAL_AI_MODEL_ID, String(pid), launchId, ACCESS_TOKEN].join('\0'))
        .digest('hex');
      response.writeHead(200, {'content-type': 'application/json'});
      response.end(
        JSON.stringify({
          launchId,
          model: LOCAL_AI_MODEL_ID,
          pid,
          proof,
          service: 'threadnote-local-ai',
          status: 'ok',
        }),
      );
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    await writeSettings(home, {port});

    try {
      await runEffect(ensureLocalAiStarted(runtime(home)).pipe(Effect.provide(ApplicationLayer)));
      const record = JSON.parse(await readFile(join(home, 'local-ai-server.json'), 'utf8')) as Record<string, unknown>;
      expect(record).toMatchObject({launchId, pid, version: 1});
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error === undefined ? resolve() : reject(error))),
      );
    }
  });

  it('rewrites a Windows redirector PID but rejects the same healthy mismatch elsewhere', async () => {
    const home = await makeHome();
    const launchId = 'redirected-launch';
    const recordedPid = 42;
    const servingPid = 43;
    const server = createServer((request, response) => {
      const challenge = new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get('challenge') ?? '';
      const proof = createHash('sha256')
        .update(
          [challenge, 'threadnote-local-ai', LOCAL_AI_MODEL_ID, String(servingPid), launchId, ACCESS_TOKEN].join('\0'),
        )
        .digest('hex');
      response.writeHead(200, {'content-type': 'application/json'});
      response.end(
        JSON.stringify({
          launchId,
          model: LOCAL_AI_MODEL_ID,
          pid: servingPid,
          proof,
          service: 'threadnote-local-ai',
          status: 'ok',
        }),
      );
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    await writeSettings(home, {port});
    await writeFile(
      join(home, 'local-ai-server.json'),
      `${JSON.stringify({
        launchId,
        modelPath: '/models/gemma.gguf',
        pid: recordedPid,
        startedAt: '2026-07-27T00:00:00.000Z',
        version: 1,
      })}\n`,
    );

    try {
      const started = runEffect(ensureLocalAiStarted(runtime(home)).pipe(Effect.provide(ApplicationLayer)));
      if (process.platform === 'win32') {
        await started;
      } else {
        await expect(started).rejects.toThrow(
          `Authenticated local AI endpoint pid ${servingPid} does not match recorded process ${recordedPid}`,
        );
      }
      const record = JSON.parse(await readFile(join(home, 'local-ai-server.json'), 'utf8')) as Record<string, unknown>;
      expect(record).toMatchObject({
        launchId,
        pid: process.platform === 'win32' ? servingPid : recordedPid,
        version: 1,
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error === undefined ? resolve() : reject(error))),
      );
    }
  });

  it('selects a verified installed model when no model is configured', async () => {
    const home = await makeHome();
    const gemma = findLocalAiModel(LOCAL_AI_MODEL_ID)!;
    const gemmaPath = join(home, 'threadnote', 'models', gemma.file);
    await mkdir(join(home, 'threadnote', 'models'), {recursive: true});
    await writeFile(gemmaPath, '');
    await truncate(gemmaPath, gemma.size);

    const installed = await runEffect(listInstalledLocalAiModels(runtime(home)).pipe(Effect.provide(ApplicationLayer)));
    const result = await runEffect(
      captureConsole(runLocalAiModelSwitch(runtime(home), {dryRun: true, model: gemma.id})).pipe(
        Effect.provide(ApplicationLayer),
      ),
    );

    expect(installed.map(item => item.definition.id)).toEqual([gemma.id]);
    expect(result.output).toContain(`Would switch local AI from no configured model to ${gemma.id}.`);
    expect(result.output).toContain('Would restart the loopback model service');
  });

  it('reports optional and broken configured local AI states to doctor', async () => {
    const emptyHome = await makeHome();
    const empty = await runEffect(localAiDoctorCheck(runtime(emptyHome)).pipe(Effect.provide(ApplicationLayer)));
    expect(empty).toEqual({
      detail: 'not installed (optional); run threadnote local-ai install',
      name: 'local AI',
      status: 'ok',
    });

    const brokenHome = await makeHome();
    await writeSettings(brokenHome, {
      model: 'LFM2.5-350M',
      modelPath: join(brokenHome, 'threadnote', 'models', 'missing.gguf'),
    });
    const broken = await runEffect(localAiDoctorCheck(runtime(brokenHome)).pipe(Effect.provide(ApplicationLayer)));
    expect(broken).toMatchObject({
      detail: 'configured model LFM2.5-350M is not in this Threadnote model catalog',
      name: 'local AI',
      status: 'warn',
    });
  });

  it('disables and re-enables an installed model without removing it', async () => {
    const home = await makeHome();
    await writeSettings(home);
    const config = runtime(home);

    const disabled = await runEffect(
      captureConsole(runLocalAiDisable(config, {})).pipe(Effect.provide(ApplicationLayer)),
    );
    expect(disabled.output).toContain('Disabled Threadnote local AI recall.');
    expect(await readSettings(home)).toMatchObject({enabled: false, model: LOCAL_AI_MODEL_ID});
    expect(
      await runEffect(
        resolveEffectAiConfiguration({agentContextHome: home}, {}).pipe(Effect.provide(ApplicationLayer)),
      ),
    ).toBeUndefined();
    expect(await readFile(join(home, 'threadnote', 'local-ai-token'), 'utf8')).toBe(`${ACCESS_TOKEN}\n`);

    const enabled = await runEffect(
      captureConsole(runLocalAiEnable(config, {})).pipe(Effect.provide(ApplicationLayer)),
    );
    expect(enabled.output).toContain('Enabled Threadnote local AI recall.');
    expect(await readSettings(home)).toMatchObject({enabled: true, model: LOCAL_AI_MODEL_ID});
    expect(
      await runEffect(
        resolveEffectAiConfiguration({agentContextHome: home}, {}).pipe(Effect.provide(ApplicationLayer)),
      ),
    ).toMatchObject({localAi: {enabled: true, model: LOCAL_AI_MODEL_ID}});
  });
});

async function makeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'threadnote-local-ai-'));
  homes.push(home);
  return home;
}

async function writeSettings(
  home: string,
  options: {
    readonly enabled?: boolean;
    readonly model?: string;
    readonly modelPath?: string;
    readonly port?: number;
  } = {},
): Promise<void> {
  const directory = join(home, 'threadnote');
  await mkdir(directory, {recursive: true});
  await writeFile(
    join(directory, 'local-ai.json'),
    `${JSON.stringify({
      enabled: options.enabled ?? true,
      host: '127.0.0.1',
      model: options.model ?? LOCAL_AI_MODEL_ID,
      modelPath: options.modelPath ?? '/models/gemma.gguf',
      port: options.port ?? LOCAL_AI_DEFAULT_PORT,
      version: 1,
    })}\n`,
  );
  await writeFile(join(directory, 'local-ai-token'), `${ACCESS_TOKEN}\n`, {mode: 0o600});
}

async function readSettings(home: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(home, 'threadnote', 'local-ai.json'), 'utf8')) as Record<string, unknown>;
}

function runtime(agentContextHome: string): RuntimeConfig {
  return {
    account: 'local',
    agentContextHome,
    agentId: 'threadnote',
    host: '127.0.0.1',
    manifestPath: join(agentContextHome, 'seed-manifest.yaml'),
    openVikingVersion: '0.4.7',
    port: 1933,
    user: 'test',
  };
}
