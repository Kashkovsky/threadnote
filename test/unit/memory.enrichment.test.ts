import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Effect} from 'effect';
import {AiError} from 'effect/unstable/ai';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import * as aiEnrichment from '../../src/effect/ai-enrichment.js';
import * as localAi from '../../src/effect/local-ai.js';
import {captureConsole} from '../../src/effect/console.js';
import {runEnrichMemories} from '../../src/memory.js';
import * as share from '../../src/share.js';
import type {RuntimeConfig} from '../../src/types.js';
import * as utils from '../../src/utils.js';
import {runEffect} from '../helpers/effect-runtime.js';

vi.mock('../../src/effect/ai-enrichment.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/effect/ai-enrichment.js')>();
  return {
    ...actual,
    enrichMemoryWithInstalledLocalAi: vi.fn(() => Effect.succeed(['resume jobs after stalled heartbeat'])),
  };
});

vi.mock('../../src/effect/local-ai.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/effect/local-ai.js')>();
  return {
    ...actual,
    readLocalAiSettings: vi.fn(() =>
      Effect.succeed({
        enabled: true as const,
        host: '127.0.0.1' as const,
        model: 'test-model',
        modelPath: '/tmp/test-model.gguf',
        port: 1934,
        version: 1 as const,
      }),
    ),
    runLocalAiEnable: vi.fn(() => Effect.void),
  };
});

vi.mock('../../src/share.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/share.js')>();
  return {...actual, writeMemoryFile: vi.fn(() => Effect.void)};
});

vi.mock('../../src/utils.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/utils.js')>();
  return {...actual, openVikingCliForMode: vi.fn(() => Effect.succeed('/ov'))};
});

describe('personal memory enrichment migration', () => {
  const homes: string[] = [];

  beforeEach(() => {
    vi.mocked(aiEnrichment.enrichMemoryWithInstalledLocalAi).mockReset();
    vi.mocked(aiEnrichment.enrichMemoryWithInstalledLocalAi).mockReturnValue(
      Effect.succeed(['resume jobs after stalled heartbeat']),
    );
    vi.mocked(localAi.readLocalAiSettings).mockClear();
    vi.mocked(localAi.runLocalAiEnable).mockClear();
    vi.mocked(share.writeMemoryFile).mockClear();
    vi.mocked(utils.openVikingCliForMode).mockClear();
  });

  afterEach(async () => {
    await Promise.all(homes.splice(0).map(home => rm(home, {force: true, recursive: true})));
  });

  const makeEligibleMemory = async (suffix: string) => {
    const home = await mkdtemp(join(tmpdir(), `threadnote-memory-enrichment-${suffix}-`));
    homes.push(home);
    const config: RuntimeConfig = {
      account: 'local',
      agentContextHome: home,
      agentId: 'threadnote',
      host: '127.0.0.1',
      manifestPath: join(home, 'seed-manifest.yaml'),
      openVikingVersion: '0.4.7',
      port: 1933,
      user: 'me',
    };
    const memoryPath = join(
      home,
      'data',
      'viking',
      'local',
      'user',
      'me',
      'memories',
      'durable',
      'projects',
      'orion-worker',
      'lease-renewal.md',
    );
    const memory = [
      'MEMORY',
      'kind: durable',
      'status: active',
      'project: orion-worker',
      'topic: lease-renewal',
      'source_agent_client: codex',
      'timestamp: 2026-07-23T00:00:00.000Z',
      '',
      'The coordinator renews a worker lease.',
    ].join('\n');
    await mkdir(join(memoryPath, '..'), {recursive: true});
    await writeFile(memoryPath, memory, 'utf8');
    return {config, memory, memoryPath};
  };

  it('streams a dry-run plan, skips enriched records, and excludes shared memories', async () => {
    const home = await mkdtemp(join(tmpdir(), 'threadnote-memory-enrichment-'));
    homes.push(home);
    const config: RuntimeConfig = {
      account: 'local',
      agentContextHome: home,
      agentId: 'threadnote',
      host: '127.0.0.1',
      manifestPath: join(home, 'seed-manifest.yaml'),
      openVikingVersion: '0.4.7',
      port: 1933,
      user: 'me',
    };
    const root = join(home, 'data', 'viking', 'local', 'user', 'me', 'memories');
    const active = join(root, 'durable', 'projects', 'threadnote', 'recall.md');
    const enriched = join(root, 'handoffs', 'active', 'threadnote', 'current.md');
    const shared = join(root, 'shared', 'team', 'durable', 'projects', 'threadnote', 'shared.md');
    await Promise.all([active, enriched, shared].map(path => mkdir(join(path, '..'), {recursive: true})));
    const document = (extraHeader: readonly string[], body: string) =>
      [
        'MEMORY',
        'kind: durable',
        'status: active',
        'project: threadnote',
        'topic: recall',
        'source_agent_client: codex',
        'timestamp: 2026-07-23T00:00:00.000Z',
        ...extraHeader,
        '',
        body,
      ].join('\n');
    await writeFile(active, document([], 'Deterministic recall uses a local index.'), 'utf8');
    await writeFile(enriched, document(['keywords: paraphrase recall'], 'Already enriched.'), 'utf8');
    await writeFile(shared, document([], 'Shared memory must not be rewritten.'), 'utf8');

    const {output} = await runEffect(captureConsole(runEnrichMemories(config, {})));

    expect(output).toContain('1 would be processed');
    expect(output).toContain('1 already enriched');
    expect(output).toContain('shared team memories are excluded');
    expect(output).toContain('Would enrich viking://user/me/memories/durable/projects/threadnote/recall.md');
    expect(output).not.toContain('shared.md');
  });

  it('leaves a memory untouched when it changes during model generation', async () => {
    const home = await mkdtemp(join(tmpdir(), 'threadnote-memory-enrichment-race-'));
    homes.push(home);
    const config: RuntimeConfig = {
      account: 'local',
      agentContextHome: home,
      agentId: 'threadnote',
      host: '127.0.0.1',
      manifestPath: join(home, 'seed-manifest.yaml'),
      openVikingVersion: '0.4.7',
      port: 1933,
      user: 'me',
    };
    const memoryPath = join(
      home,
      'data',
      'viking',
      'local',
      'user',
      'me',
      'memories',
      'durable',
      'projects',
      'orion-worker',
      'lease-renewal.md',
    );
    await mkdir(join(memoryPath, '..'), {recursive: true});
    const memory = (body: string) =>
      [
        'MEMORY',
        'kind: durable',
        'status: active',
        'project: orion-worker',
        'topic: lease-renewal',
        'source_agent_client: codex',
        'timestamp: 2026-07-23T00:00:00.000Z',
        '',
        body,
      ].join('\n');
    await writeFile(memoryPath, memory('The coordinator renews a worker lease.'), 'utf8');
    vi.mocked(aiEnrichment.enrichMemoryWithInstalledLocalAi).mockImplementation(() =>
      Effect.promise(async () => {
        await writeFile(memoryPath, memory('A concurrent writer changed the lease policy.'), 'utf8');
        return ['resume jobs after stalled heartbeat'];
      }),
    );

    await expect(runEffect(runEnrichMemories(config, {apply: true}))).rejects.toThrow(
      '1 memory enrichment operation(s) failed',
    );

    expect(await readFile(memoryPath, 'utf8')).toContain('A concurrent writer changed the lease policy.');
    expect(share.writeMemoryFile).not.toHaveBeenCalled();
  });

  it('leaves a memory unchanged when local AI cannot generate useful keywords', async () => {
    const {config, memory, memoryPath} = await makeEligibleMemory('empty');
    vi.mocked(aiEnrichment.enrichMemoryWithInstalledLocalAi).mockReturnValue(
      Effect.fail(
        new aiEnrichment.AiMemoryEnrichmentFailed({
          cause: AiError.make({
            method: 'generateObject',
            module: 'LanguageModel',
            reason: new AiError.StructuredOutputError({
              description: 'The model returned no structured search phrases.',
              responseText: '',
            }),
          }),
          message: 'Effect AI memory enrichment failed.',
        }),
      ),
    );

    const {output} = await runEffect(captureConsole(runEnrichMemories(config, {apply: true})));

    expect(output).toContain('No useful keywords generated; left unchanged.');
    expect(output).toContain('Memory enrichment summary: 0 enriched; 1 unchanged; 0 failed; 1 attempted.');
    expect(await readFile(memoryPath, 'utf8')).toBe(memory);
    expect(share.writeMemoryFile).not.toHaveBeenCalled();

    vi.mocked(aiEnrichment.enrichMemoryWithInstalledLocalAi).mockReturnValue(
      Effect.fail(
        new aiEnrichment.AiMemoryEnrichmentFailed({
          cause: new Error('The local model connection failed.'),
          message: 'Effect AI memory enrichment failed.',
        }),
      ),
    );

    await expect(runEffect(runEnrichMemories(config, {apply: true}))).rejects.toThrow(
      '1 memory enrichment operation(s) failed',
    );
  });

  it('enables an existing disabled installation without reinstalling its model', async () => {
    const {config} = await makeEligibleMemory('disabled');
    vi.mocked(localAi.readLocalAiSettings).mockReturnValue(
      Effect.succeed({
        enabled: false,
        host: '127.0.0.1',
        model: 'test-model',
        modelPath: '/external/test-model.gguf',
        port: 1934,
        version: 1,
      }),
    );

    const {output} = await runEffect(captureConsole(runEnrichMemories(config, {apply: true, installLocalAi: true})));

    expect(output).toContain('Enabling the existing installation before enrichment.');
    expect(localAi.runLocalAiEnable).toHaveBeenCalledWith(config, {});
    expect(output).toContain('Memory enrichment summary: 1 enriched; 0 unchanged; 0 failed; 1 attempted.');
  });
});
