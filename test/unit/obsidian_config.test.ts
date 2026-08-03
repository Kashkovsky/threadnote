import {describe, expect, it} from 'vitest';
import {
  emptyObsidianConfiguration,
  parseObsidianConfiguration,
  renderObsidianConfiguration,
  upsertObsidianProjection,
  upsertObsidianSource,
} from '../../src/obsidian_config.js';

describe('Obsidian source configuration', () => {
  it('round-trips versioned sources and projections', () => {
    const configuration = upsertObsidianProjection(
      upsertObsidianSource(emptyObsidianConfiguration(), {
        enabled: true,
        exclude: ['.obsidian/**', 'Personal/**'],
        id: 'engineering',
        inbox: 'Threadnote Inbox',
        include: ['Engineering/**'],
        type: 'obsidian',
        vault: '/vault',
        watch: false,
      }),
      {
        enabled: true,
        folder: 'Threadnote',
        id: 'memory',
        includeShared: true,
        kinds: ['durable', 'handoff'],
        selectedUris: ['threadnote://user/tester/memories/durable/projects/threadnote/obsidian.md'],
        statuses: ['active'],
        type: 'obsidian',
        vault: '/vault',
      },
    );

    expect(parseObsidianConfiguration(renderObsidianConfiguration(configuration))).toEqual(configuration);
  });

  it('requires an explicit source allowlist', () => {
    expect(() =>
      parseObsidianConfiguration(
        [
          'version: 1',
          'sources:',
          '  - id: engineering',
          '    type: obsidian',
          '    vault: /vault',
          '    include: []',
          'projections: []',
        ].join('\n'),
      ),
    ).toThrow(/include must contain at least one allowlist pattern/i);
  });

  it('preserves configurations without selected_uris as legacy all-matching projections', () => {
    const configuration = parseObsidianConfiguration(
      [
        'version: 1',
        'sources: []',
        'projections:',
        '  - id: memory',
        '    type: obsidian',
        '    vault: /vault',
        '    folder: Threadnote',
      ].join('\n'),
    );

    expect(configuration.projections[0]?.selectedUris).toBeUndefined();
  });

  it('accepts only canonical memory resources in projection selections', () => {
    expect(() =>
      parseObsidianConfiguration(
        [
          'version: 1',
          'sources: []',
          'projections:',
          '  - id: memory',
          '    type: obsidian',
          '    vault: /vault',
          '    folder: Threadnote',
          '    selected_uris:',
          '      - threadnote://resources/external/obsidian/vault/Note.md',
        ].join('\n'),
      ),
    ).toThrow(/only canonical Threadnote memory URIs/i);
  });

  it('rejects unsafe projection folders and duplicate identifiers', () => {
    expect(() =>
      parseObsidianConfiguration(
        [
          'version: 1',
          'sources: []',
          'projections:',
          '  - id: memory',
          '    type: obsidian',
          '    vault: /vault',
          '    folder: ../outside',
        ].join('\n'),
      ),
    ).toThrow(/safe vault-relative folder/i);

    expect(() =>
      parseObsidianConfiguration(
        [
          'version: 1',
          'sources:',
          '  - id: engineering',
          '    type: obsidian',
          '    vault: /vault',
          '    include: ["Engineering/**"]',
          '  - id: engineering',
          '    type: obsidian',
          '    vault: /other',
          '    include: ["Docs/**"]',
          'projections: []',
        ].join('\n'),
      ),
    ).toThrow(/duplicate source id/i);
  });

  it('rejects source traversal patterns and unsafe Inbox folders', () => {
    expect(() =>
      parseObsidianConfiguration(
        [
          'version: 1',
          'sources:',
          '  - id: engineering',
          '    type: obsidian',
          '    vault: /vault',
          '    include: ["../Private/**"]',
          'projections: []',
        ].join('\n'),
      ),
    ).toThrow(/vault-relative patterns without parent traversal/i);

    expect(() =>
      parseObsidianConfiguration(
        [
          'version: 1',
          'sources:',
          '  - id: engineering',
          '    type: obsidian',
          '    vault: /vault',
          '    include: ["Engineering/**"]',
          '    inbox: ../Inbox',
          'projections: []',
        ].join('\n'),
      ),
    ).toThrow(/safe vault-relative folder/i);
  });

  it('requires absolute vault paths and accepts native Windows paths', () => {
    expect(() =>
      parseObsidianConfiguration(
        [
          'version: 1',
          'sources:',
          '  - id: engineering',
          '    type: obsidian',
          '    vault: relative/vault',
          '    include: ["Engineering/**"]',
          'projections: []',
        ].join('\n'),
      ),
    ).toThrow(/vault must be an absolute path/i);

    expect(
      parseObsidianConfiguration(
        [
          'version: 1',
          'sources:',
          '  - id: engineering',
          '    type: obsidian',
          '    vault: "C:\\\\Users\\\\example\\\\Vault"',
          '    include: ["Engineering/**"]',
          'projections: []',
        ].join('\n'),
      ).sources[0]?.vault,
    ).toBe('C:\\Users\\example\\Vault');
  });
});
