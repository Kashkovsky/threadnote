import {mkdir, mkdtemp, readFile, rm, truncate, writeFile} from 'node:fs/promises';
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
  listInstalledLocalAiModels,
  localAiDoctorCheck,
  localAiHealthProof,
  localAiApiUrl,
  localAiProcessOwnershipMatches,
  parseLocalAiSettings,
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

  it('resolves the friendly LFM model name to the pinned official GGUF artifact', async () => {
    const home = await makeHome();
    const result = await runEffect(
      captureConsole(runLocalAiInstall(runtime(home), {dryRun: true, model: 'LFM2.5-350M'})).pipe(
        Effect.provide(ApplicationLayer),
      ),
    );

    expect(findLocalAiModel('LiquidAI/LFM2.5-350M')?.id).toBe('LFM2.5-350M');
    expect(result.output).toContain('LiquidAI/LFM2.5-350M-GGUF/LFM2.5-350M-Q4_K_M.gguf');
    expect(result.output).toContain('0.23 GB');
    expect(result.output).toContain('7e6f72643caafc9a68256686638c4d7916f2cec76d1df478d4c3ddcd95a6aed4');
  });

  it('rejects unknown install model names with the available choices', async () => {
    const home = await makeHome();

    await expect(
      runEffect(
        runLocalAiInstall(runtime(home), {dryRun: true, model: 'unknown'}).pipe(Effect.provide(ApplicationLayer)),
      ),
    ).rejects.toThrow(/Available models: gemma-4-E4B-it-Q4_0, LFM2.5-350M/);
  });

  it('guides model installation instead of crashing when no models are available', async () => {
    const home = await makeHome();
    const result = await runEffect(
      captureConsole(runLocalAiModelSwitch(runtime(home), {})).pipe(Effect.provide(ApplicationLayer)),
    );

    expect(result.output).toContain('No installed local AI models are available.');
    expect(result.output).toContain('threadnote local-ai install --model LFM2.5-350M');
  });

  it('switches directly between installed models while preserving disabled state', async () => {
    const home = await makeHome();
    const gemma = findLocalAiModel(LOCAL_AI_MODEL_ID)!;
    const lfm = findLocalAiModel('LFM2.5-350M')!;
    const gemmaPath = join(home, 'threadnote', 'models', gemma.file);
    const lfmPath = join(home, 'threadnote', 'models', lfm.file);
    await mkdir(join(home, 'threadnote', 'models'), {recursive: true});
    await Promise.all([writeFile(gemmaPath, ''), writeFile(lfmPath, '')]);
    await Promise.all([truncate(gemmaPath, gemma.size), truncate(lfmPath, lfm.size)]);
    await writeSettings(home, {enabled: false, model: gemma.id, modelPath: gemmaPath});

    const installed = await runEffect(listInstalledLocalAiModels(runtime(home)).pipe(Effect.provide(ApplicationLayer)));
    const result = await runEffect(
      captureConsole(runLocalAiModelSwitch(runtime(home), {dryRun: true, model: 'LiquidAI/LFM2.5-350M'})).pipe(
        Effect.provide(ApplicationLayer),
      ),
    );

    expect(installed.map(item => item.definition.id)).toEqual([gemma.id, lfm.id]);
    expect(result.output).toContain(`Would switch local AI from ${gemma.id} to ${lfm.id}.`);
    expect(result.output).toContain('Would preserve the disabled local AI state.');
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
      detail: expect.stringContaining(
        'LFM2.5-350M model file missing or wrong size; run threadnote local-ai install --model LFM2.5-350M',
      ),
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
      port: LOCAL_AI_DEFAULT_PORT,
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
