import {describe, expect, it} from 'vitest';
import type {TreeNode} from '../../src/manager/ui.js';
import {canPublishMemoryFromManager, canPublishSelectedMemoriesFromManager} from '../../src/manager/ui/support.js';

describe('Manager Publish availability', () => {
  const durable = 'threadnote://user/tester/memories/durable/projects/foo/bar.md';

  it('offers Publish for a loaded active durable memory', () => {
    expect(canPublishMemoryFromManager(durable, {kind: 'durable', status: 'active'})).toBe(true);
  });

  it('hides Publish for a handoff and inconsistent loaded metadata', () => {
    expect(canPublishMemoryFromManager('threadnote://user/tester/memories/handoffs/active/foo/bar.md', undefined)).toBe(
      false,
    );
    expect(canPublishMemoryFromManager(durable, undefined)).toBe(false);
    expect(canPublishMemoryFromManager(durable, {kind: 'handoff', status: 'active'})).toBe(false);
    expect(canPublishMemoryFromManager(durable, {kind: 'durable', status: 'archived'})).toBe(false);
  });

  it('enables bulk Publish only when every selected tree node is an active personal durable memory', () => {
    const handoff = 'threadnote://user/tester/memories/handoffs/active/foo/status.md';
    const node = (uri: string, kind: 'durable' | 'handoff'): TreeNode => ({
      isDir: false,
      isShared: false,
      isSystem: false,
      metadata: {
        kind,
        project: 'foo',
        sourceAgentClient: 'codex',
        status: 'active',
        timestamp: '2026-09-14T00:00:00.000Z',
      },
      name: 'bar.md',
      relativePath: uri,
      uri,
    });
    const tree: TreeNode = {
      children: [node(durable, 'durable'), node(handoff, 'handoff')],
      isDir: true,
      isShared: false,
      isSystem: false,
      name: 'memories',
      relativePath: '',
      uri: 'threadnote://user/tester/memories',
    };
    expect(canPublishSelectedMemoriesFromManager(tree, [durable])).toBe(true);
    expect(canPublishSelectedMemoriesFromManager(tree, [durable, handoff])).toBe(false);
    expect(canPublishSelectedMemoriesFromManager(tree, [durable, `${durable}/missing`])).toBe(false);
  });
});
