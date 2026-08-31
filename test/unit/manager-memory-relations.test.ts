import {describe, expect, it} from 'vitest';
import {assertManagerRawPersonalMemorySave, assertManagerRawSharedMemorySave} from '../../src/manager/memory_save.js';

const personalUri = 'threadnote://user/test/memories/durable/projects/threadnote/source.md';
const sharedUri = 'threadnote://user/test/memories/shared/default/durable/projects/threadnote/source.md';
const base = [
  'MEMORY',
  'kind: durable',
  'status: active',
  'project: threadnote',
  'topic: source',
  'memory_id: tn_manager_source',
  'relation: depends_on threadnote://memory/tn_manager_target',
  '',
  'Original body.',
].join('\n');

describe('Manager raw memory relation boundary', () => {
  it('allows body edits while preserving exact relation headers', () => {
    const updated = base.replace('Original body.', 'Updated body.');

    expect(() => assertManagerRawPersonalMemorySave(personalUri, base, base, updated)).not.toThrow();
    expect(() => assertManagerRawSharedMemorySave(config(), sharedUri, base, base, updated)).not.toThrow();
  });

  it('allows a browser-normalized LF body edit of an existing CRLF memory', () => {
    const existing = base.replaceAll('\n', '\r\n');
    const updated = base.replace('Original body.', 'Updated body.');

    expect(() => assertManagerRawPersonalMemorySave(personalUri, existing, existing, updated)).not.toThrow();
    expect(() => assertManagerRawSharedMemorySave(config(), sharedUri, existing, existing, updated)).not.toThrow();
  });

  it.each([
    ['add', base.replace('\n\nOriginal', '\nrelation: related_to threadnote://memory/tn_other\n\nOriginal')],
    ['change', base.replace('depends_on', 'related_to')],
    ['remove', base.replace('relation: depends_on threadnote://memory/tn_manager_target\n', '')],
  ])('rejects a raw %s relation edit until structured Manager authoring exists', (_operation, updated) => {
    expect(() => assertManagerRawPersonalMemorySave(personalUri, base, base, updated)).toThrow(
      'Raw Manager saves cannot change typed memory relations',
    );
    expect(() => assertManagerRawSharedMemorySave(config(), sharedUri, base, base, updated)).toThrow(
      'Raw Manager saves cannot change typed memory relations',
    );
  });

  it('rejects changing the source identity into a preserved self relation', () => {
    const updated = base.replace('memory_id: tn_manager_source', 'memory_id: tn_manager_target');

    expect(() => assertManagerRawPersonalMemorySave(personalUri, base, base, updated)).toThrow(
      'Raw Manager saves cannot change stable memory_id',
    );
    expect(() => assertManagerRawSharedMemorySave(config(), sharedUri, base, base, updated)).toThrow(
      'Raw Manager saves cannot change stable memory_id',
    );
  });
});

function config() {
  return {
    account: 'local',
    agentContextHome: '/tmp/threadnote-manager-memory-relations',
    agentId: 'threadnote',
    manifestPath: '/tmp/threadnote-manager-memory-relations/manifest.json',
    user: 'test',
  } as const;
}
