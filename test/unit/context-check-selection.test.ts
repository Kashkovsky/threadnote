import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {selectAffectedMemories} from '../../src/context_check/commands.js';
import type {MemoryRecord} from '../../src/memory/document.js';

describe('context check citation selection', () => {
  it('respects repository identity and repository case mode', () => {
    const current = record('current', 'Source.ts');
    const other = record('other', 'Source.ts');
    expect(selectAffectedMemories([current, other], 'current', ['source.ts'])).toEqual([]);
    expect(selectAffectedMemories([current, other], 'current', ['source.ts'], 'insensitive')).toEqual([current]);
  });

  it('has set semantics for changed paths and cannot select another repository', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.stringMatching(/^[a-z]{1,8}$/u), {maxLength: 20}), names => {
        const paths = names.map(name => `${name}.ts`);
        const current = paths.map(path => record('current', path));
        const other = paths.map(path => record('other', path));
        expect(selectAffectedMemories([...other, ...current], 'current', [...paths, ...paths].reverse())).toEqual(
          current,
        );
        expect(selectAffectedMemories(current, 'current', [])).toEqual([]);
      }),
      {numRuns: 40},
    );
  });
});

function record(repositoryId: string, path: string): MemoryRecord {
  return {
    body: '',
    content: '',
    headerTitle: 'MEMORY',
    uri: `threadnote://memory/${repositoryId}/${path}`,
    metadata: {
      kind: 'durable',
      project: 'test',
      sourceAgentClient: 'test',
      status: 'active',
      timestamp: '2026-09-17T00:00:00.000Z',
      codeCitations: [
        {
          extractorSet: 'test',
          fileContentHash: {algorithm: 'sha256', value: 'a'.repeat(64)},
          id: 'citation',
          path,
          repositoryId,
          repositoryIdentityKind: 'local',
          sourceCommit: 'b'.repeat(40),
          sourceDirty: false,
          sourceSnapshotId: `cgsn_${'c'.repeat(40)}`,
          target: {kind: 'file'},
          version: 1,
        },
      ],
    },
  };
}
