import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {hasAgentSkillCatalogIntent, runRecall, stripAdvancedSearchFlags} from '../../src/memory.js';
import type {RuntimeConfig} from '../../src/types.js';
import * as indexRepair from '../../src/index_repair.js';
import * as utils from '../../src/utils.js';

vi.mock('../../src/index_repair.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/index_repair.js')>();
  return {
    ...actual,
    repairStaleRecallIndex: vi.fn(),
  };
});

vi.mock('../../src/utils.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/utils.js')>();
  return {
    ...actual,
    openVikingCliForMode: vi.fn().mockResolvedValue('/ov'),
  };
});

const runtime: RuntimeConfig = {
  account: 'local',
  agentContextHome: '/tmp/threadnote-test',
  agentId: 'threadnote',
  host: '127.0.0.1',
  manifestPath: '/tmp/threadnote-test/seed-manifest.yaml',
  openVikingVersion: '0.0.0',
  port: 1933,
  user: 'denys',
};

beforeEach(() => {
  vi.mocked(indexRepair.repairStaleRecallIndex).mockReset();
  vi.mocked(indexRepair.repairStaleRecallIndex).mockResolvedValue({
    repairedUris: [],
    skippedRecentUris: [],
    warnings: [],
  });
  vi.mocked(utils.openVikingCliForMode).mockResolvedValue('/ov');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('recall skill catalog intent inference', () => {
  it('does not treat seed-skills maintenance queries as agent skill lookup', () => {
    expect(hasAgentSkillCatalogIntent('threadnote seed skills claude commands')).toBe(false);
    expect(hasAgentSkillCatalogIntent('fix seed-skills not recognizing claude commands')).toBe(false);
    expect(hasAgentSkillCatalogIntent('skill seeding should include repo commands')).toBe(false);
  });

  it('still recognizes explicit skill catalog lookup queries', () => {
    expect(hasAgentSkillCatalogIntent('skills')).toBe(true);
    expect(hasAgentSkillCatalogIntent('find skill for swiftui performance')).toBe(true);
    expect(hasAgentSkillCatalogIntent('show skills that help with release notes')).toBe(true);
    expect(hasAgentSkillCatalogIntent('skills for ios debugging')).toBe(true);
  });
});

describe('runRecall index repair fallback', () => {
  it('continues to search when automatic index repair fails', async () => {
    vi.mocked(indexRepair.repairStaleRecallIndex).mockRejectedValue(new Error('repair failed'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runRecall(runtime, {dryRun: true, query: 'availability check'});

    const output = log.mock.calls.map(call => call.join(' ')).join('\n');
    expect(output).toContain('Auto-index repair warning: repair failed');
    expect(output).toContain('Would run: /ov search');
    expect(output).toContain('availability check');
  });
});

describe('stripAdvancedSearchFlags', () => {
  it('removes --threshold and --level with their values, keeping the rest', () => {
    expect(
      stripAdvancedSearchFlags(['search', 'q', '--threshold', '0.45', '--level', '2', '--uri', 'viking://x']),
    ).toEqual(['search', 'q', '--uri', 'viking://x']);
  });

  it('is a no-op when no advanced flags are present', () => {
    expect(stripAdvancedSearchFlags(['search', 'q', '--node-limit', '5'])).toEqual([
      'search',
      'q',
      '--node-limit',
      '5',
    ]);
  });
});
