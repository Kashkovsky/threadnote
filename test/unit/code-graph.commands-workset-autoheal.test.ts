import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import {beforeEach, describe, expect, vi} from 'vitest';
import type {CodeGraphWorksetPrepareResultV1} from '../../src/code_graph/workset_catalog/workset.js';
import {runCodeGraphWorksetPrepare} from '../../src/code_graph/commands.js';
import {CliOutput} from '../../src/effect/cli_output.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import type {RuntimeConfig} from '../../src/types.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const mocks = vi.hoisted(() => ({
  healWorkset: vi.fn(),
  prepareWorkset: vi.fn(),
}));

vi.mock('../../src/code_graph/workset_catalog/workset.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/code_graph/workset_catalog/workset.js')>()),
  prepareCodeGraphWorkset: mocks.prepareWorkset,
}));

vi.mock('../../src/memory/deferred_code_anchor_recovery.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/memory/deferred_code_anchor_recovery.js')>()),
  healAnchorsAfterWorksetPrepare: mocks.healWorkset,
}));

const config: RuntimeConfig = {
  account: 'local',
  agentContextHome: '/threadnote-home',
  agentId: 'threadnote',
  manifestPath: '/threadnote-home/manifest.yaml',
  user: 'tester',
};

describe('Workset prepare deferred-anchor recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.healWorkset.mockReturnValue(Effect.void);
  });

  effectIt.effect('heals the canonical ready Workset when invocation casing differs', () => {
    const output: string[] = [];
    mocks.prepareWorkset.mockReturnValue(Effect.succeed(worksetResult('ready')));

    return Effect.gen(function* () {
      yield* runCodeGraphWorksetPrepare(config, {json: true, name: 'PLATFORM'});

      expect(mocks.prepareWorkset).toHaveBeenCalledWith(
        config,
        'PLATFORM',
        expect.objectContaining({isolateBuilds: false}),
      );
      expect(mocks.healWorkset).toHaveBeenCalledOnce();
      expect(mocks.healWorkset).toHaveBeenCalledWith(config, 'platform');
      expect(JSON.parse(output[0]!)).toMatchObject({state: 'ready', workset: 'platform'});
    }).pipe(Effect.provideService(CliOutput, collectingCliOutput(output)), provideTestLayer(ApplicationLayer));
  });

  effectIt.effect('does not heal when preparation did not publish a ready Workset', () => {
    const output: string[] = [];
    mocks.prepareWorkset.mockReturnValue(Effect.succeed(worksetResult('failed')));

    return Effect.gen(function* () {
      const failure = yield* runCodeGraphWorksetPrepare(config, {json: true, name: 'PLATFORM'}).pipe(Effect.flip);

      expect(failure.message).toContain('preparation was incomplete');
      expect(mocks.healWorkset).not.toHaveBeenCalled();
      expect(JSON.parse(output[0]!)).toMatchObject({state: 'failed', workset: 'platform'});
    }).pipe(Effect.provideService(CliOutput, collectingCliOutput(output)), provideTestLayer(ApplicationLayer));
  });
});

function collectingCliOutput(output: string[]) {
  return CliOutput.of({
    drain: Effect.void,
    enqueueError: () => undefined,
    enqueueOutput: () => undefined,
    flush: Effect.void,
    writeError: value => Effect.sync(() => output.push(value)),
    writeFinal: value => Effect.sync(() => output.push(value)),
  });
}

function worksetResult(state: 'failed' | 'ready'): CodeGraphWorksetPrepareResultV1 {
  return {
    coverage: {
      complete: state === 'ready',
      excluded: 0,
      failed: state === 'failed' ? 1 : 0,
      missing: 0,
      ready: state === 'ready' ? 1 : 0,
      requested: 1,
    },
    manifestDigest: 'a'.repeat(64),
    members: [],
    state,
    type: 'code-graph-workset-prepare',
    version: 1,
    workset: 'platform',
  };
}
