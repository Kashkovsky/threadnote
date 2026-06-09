import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  filterStaleRecallSummaryRows,
  findStaleRecallIndexTargets,
  repairStaleRecallIndex,
} from '../../src/index_repair.js';
import type {CommandResult, RuntimeConfig} from '../../src/types.js';
import * as utils from '../../src/utils.js';

vi.mock('../../src/utils.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/utils.js')>();
  return {
    ...actual,
    runCommand: vi.fn(),
  };
});

const ok = (stdout = ''): CommandResult => ({exitCode: 0, stdout, stderr: ''});

async function makeRuntime(): Promise<RuntimeConfig> {
  const home = await mkdtemp(join(tmpdir(), 'threadnote-index-repair-'));
  return {
    account: 'local',
    agentContextHome: home,
    agentId: 'threadnote',
    host: '127.0.0.1',
    manifestPath: join(home, 'seed-manifest.yaml'),
    openVikingVersion: '0.0.0',
    port: 1933,
    user: 'denys',
  };
}

describe('recall index auto repair', () => {
  const homes: string[] = [];

  beforeEach(() => {
    vi.mocked(utils.runCommand).mockReset();
    vi.mocked(utils.runCommand).mockResolvedValue(ok('reindexed'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(homes.splice(0).map(home => rm(home, {force: true, recursive: true})));
  });

  it('reindexes stale personal memory summary parents', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const summaryDir = join(
      config.agentContextHome,
      'data',
      'viking',
      'local',
      'user',
      'denys',
      'memories',
      'durable',
      'projects',
      'threadnote',
    );
    await mkdir(summaryDir, {recursive: true});
    await writeFile(join(summaryDir, '.overview.md'), '# threadnote\n\n[Directory overview is not ready]');

    const result = await repairStaleRecallIndex(config, '/ov', {query: 'threadnote latest handoff'});

    expect(result.repairedUris).toEqual(['viking://user/denys/memories/durable/projects/threadnote']);
    expect(vi.mocked(utils.runCommand)).toHaveBeenCalledWith(
      '/ov',
      expect.arrayContaining([
        'reindex',
        'viking://user/denys/memories/durable/projects/threadnote',
        '--mode',
        'semantic_and_vectors',
      ]),
      {allowFailure: true},
    );
  });

  it('skips a recently repaired unchanged stale signature', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const summaryDir = join(
      config.agentContextHome,
      'data',
      'viking',
      'local',
      'user',
      'denys',
      'memories',
      'durable',
      'projects',
      'threadnote',
    );
    await mkdir(summaryDir, {recursive: true});
    await writeFile(join(summaryDir, '.overview.md'), '# threadnote\n\n[Directory overview is not ready]');

    await repairStaleRecallIndex(config, '/ov', {query: 'threadnote latest handoff'});
    vi.mocked(utils.runCommand).mockClear();

    const result = await repairStaleRecallIndex(config, '/ov', {query: 'threadnote latest handoff'});

    expect(result.skippedRecentUris).toEqual(['viking://user/denys/memories/durable/projects/threadnote']);
    expect(vi.mocked(utils.runCommand)).not.toHaveBeenCalled();
  });

  it('ignores recent repair backoff when requested by maintenance repair', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const summaryDir = join(
      config.agentContextHome,
      'data',
      'viking',
      'local',
      'user',
      'denys',
      'memories',
      'durable',
      'projects',
      'threadnote',
    );
    await mkdir(summaryDir, {recursive: true});
    await writeFile(join(summaryDir, '.overview.md'), '# threadnote\n\n[Directory overview is not ready]');

    await repairStaleRecallIndex(config, '/ov', {query: 'threadnote latest handoff'});
    vi.mocked(utils.runCommand).mockClear();

    const result = await repairStaleRecallIndex(config, '/ov', {
      ignoreBackoff: true,
      query: 'threadnote latest handoff',
    });

    expect(result.repairedUris).toEqual(['viking://user/denys/memories/durable/projects/threadnote']);
    expect(result.skippedRecentUris).toEqual([]);
    expect(vi.mocked(utils.runCommand)).toHaveBeenCalledTimes(1);
  });

  it('repairs seeded project resources only when the query names that project', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    await writeFile(
      config.manifestPath,
      [
        'version: 1',
        'projects:',
        '  - name: coda',
        '    path: ~/src/coda',
        '    uri: viking://resources/repos/coda',
        '    seed: []',
        '',
      ].join('\n'),
    );
    const resourceDir = join(config.agentContextHome, 'data', 'viking', 'local', 'resources', 'repos', 'coda');
    await mkdir(resourceDir, {recursive: true});
    await writeFile(join(resourceDir, '.abstract.md'), '[Directory abstract is not ready]');

    await repairStaleRecallIndex(config, '/ov', {query: 'threadnote latest handoff'});
    expect(vi.mocked(utils.runCommand).mock.calls.map(call => call[1])).not.toContainEqual(
      expect.arrayContaining(['viking://resources/repos/coda']),
    );

    const result = await repairStaleRecallIndex(config, '/ov', {query: 'coda latest handoff'});

    expect(result.repairedUris).toContain('viking://resources/repos/coda');
  });

  it('can scan all manifest resources and agent skills as root targets for maintenance repair', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    await writeFile(
      config.manifestPath,
      [
        'version: 1',
        'projects:',
        '  - name: coda',
        '    path: ~/src/coda',
        '    uri: viking://resources/repos/coda',
        '    seed: []',
        '',
      ].join('\n'),
    );
    const resourceDir = join(config.agentContextHome, 'data', 'viking', 'local', 'resources', 'repos', 'coda');
    const skillDir = join(config.agentContextHome, 'data', 'viking', 'local', 'resources', 'agent-skills', 'codex');
    await mkdir(resourceDir, {recursive: true});
    await mkdir(skillDir, {recursive: true});
    await writeFile(join(resourceDir, '.abstract.md'), '[Directory abstract is not ready]');
    await writeFile(join(skillDir, '.overview.md'), '[Directory overview is not ready]');

    const targets = await findStaleRecallIndexTargets(config, {
      collapseToRoots: true,
      includeAgentSkills: true,
      includeManifestResources: true,
    });

    expect(targets.map(target => target.uri).sort()).toEqual([
      'viking://resources/agent-skills',
      'viking://resources/repos/coda',
    ]);
  });

  it('does not write repair state in dry-run mode', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const summaryDir = join(
      config.agentContextHome,
      'data',
      'viking',
      'local',
      'user',
      'denys',
      'memories',
      'durable',
      'projects',
      'threadnote',
    );
    await mkdir(summaryDir, {recursive: true});
    await writeFile(join(summaryDir, '.overview.md'), '# threadnote\n\n[Directory overview is not ready]');

    const result = await repairStaleRecallIndex(config, '/ov', {dryRun: true, query: 'threadnote latest handoff'});

    expect(result.repairedUris).toEqual(['viking://user/denys/memories/durable/projects/threadnote']);
    expect(vi.mocked(utils.runCommand)).not.toHaveBeenCalled();
    await expect(readFile(join(config.agentContextHome, 'index-auto-repair.json'), 'utf8')).rejects.toThrow();
  });

  it('reports scan and reindex progress for long maintenance repairs', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const summaryDir = join(
      config.agentContextHome,
      'data',
      'viking',
      'local',
      'user',
      'denys',
      'memories',
      'durable',
      'projects',
      'threadnote',
    );
    await mkdir(summaryDir, {recursive: true});
    await writeFile(join(summaryDir, '.overview.md'), '# threadnote\n\n[Directory overview is not ready]');
    const progressTypes: string[] = [];

    await repairStaleRecallIndex(config, '/ov', {
      collapseToRoots: true,
      onProgress: progress => {
        progressTypes.push(progress.type);
      },
      query: 'threadnote latest handoff',
    });

    expect(progressTypes).toEqual(['scan-start', 'scan-complete', 'repair-start']);
  });
});

describe('recall stale summary filtering', () => {
  it('removes stale generated summary rows without dropping useful rows', () => {
    const output = [
      'context_type  uri  level  score  abstract  type',
      'memory        viking://user/denys/memories/durable/projects/threadnote/.overview.md  1  0.6  [Directory overview is not ready]  memori',
      'memory        viking://user/denys/memories/durable/projects/threadnote/recall-index.md  0  0.9  Feature knowledge  memori',
      'resource      viking://resources/repos/threadnote/.abstract.md  1  0.4  [Directory abstract is not ready]  resourc',
    ].join('\n');

    const filtered = filterStaleRecallSummaryRows(output);

    expect(filtered).toContain('context_type');
    expect(filtered).toContain('recall-index.md');
    expect(filtered).not.toContain('[Directory overview is not ready]');
    expect(filtered).not.toContain('[Directory abstract is not ready]');
  });
});
