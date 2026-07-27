import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Effect} from 'effect';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const inference = vi.hoisted(() => ({rerank: vi.fn()}));

vi.mock('../../src/models/inference.js', () => ({
  rerankWithSelectedLocalModel: inference.rerank,
}));

import {ApplicationLayer} from '../../src/effect/runtime.js';
import {createRecallRerankerCache, prepareRecallSections} from '../../src/recall/runtime.js';
import type {RuntimeConfig} from '../../src/types.js';

describe('recall runtime orchestration', () => {
  const homes: string[] = [];

  beforeEach(() => {
    inference.rerank.mockReset();
    inference.rerank.mockReturnValue(Effect.succeed([0.8]));
  });

  afterEach(async () => {
    await Promise.all(homes.splice(0).map(home => rm(home, {force: true, recursive: true})));
  });

  it('reuses reranker scores across repeated prepare passes in one top-level recall', async () => {
    const home = await mkdtemp(join(tmpdir(), 'threadnote-recall-runtime-'));
    homes.push(home);
    const resource = join(home, 'data', 'local', 'resources', 'repos', 'threadnote', 'runtime.md');
    await mkdir(join(resource, '..'), {recursive: true});
    await writeFile(resource, '# Runtime\n\nreranker cache anchor');
    const config: RuntimeConfig = {
      account: 'local',
      agentContextHome: home,
      agentId: 'threadnote',
      manifestPath: join(home, 'seed-manifest.yaml'),
      user: 'tester',
    };
    const rerankerCache = createRecallRerankerCache();
    const prepare = () =>
      prepareRecallSections(config, {
        allowExactRescue: false,
        exactMatches: [],
        feedbackQuery: 'reranker cache anchor',
        includeInactive: false,
        limit: 5,
        passes: [],
        query: 'reranker cache anchor',
        readRecords: () => Effect.succeed([]),
        rerankerCache,
        semanticScores: null,
      });

    await Effect.runPromise(
      Effect.all([prepare(), prepare()], {concurrency: 1}).pipe(Effect.provide(ApplicationLayer)),
    );

    expect(inference.rerank).toHaveBeenCalledTimes(1);
  });
});
