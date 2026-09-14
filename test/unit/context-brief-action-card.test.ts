import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {parseMemoryActionCard} from '../../src/context_brief/memory_evidence.js';
import {classifyCodeBriefEditDelivery, renderCodeBriefEditContext} from '../../src/context_brief/edit_hook.js';
import type {ContextBriefMemoryEvidenceV1, ContextBriefV1} from '../../src/context_brief/types.js';

const memory = {
  actionCard: {
    appliesTo: 'Catalog edits',
    invariant: 'Keep the stable key.',
    verify: 'Run the focused catalog test.',
  },
  codeRelations: [{anchorOrdinal: 0, citationId: 'tncc_test', kind: 'file', status: 'exact'}],
  excerpt: 'Catalog identity is stable.',
  freshness: 'fresh',
  freshnessBasis: 'code-citations',
  kind: 'durable',
  preciseStatus: 'exact',
  rank: 0,
  selectionBasis: 'code-citation',
  uri: 'threadnote://memory/tn_test',
} as ContextBriefMemoryEvidenceV1;

function briefWith(memoryEvidence: ContextBriefMemoryEvidenceV1): ContextBriefV1 {
  return {
    activeHandoffs: [],
    coverage: {memory: {codeAnchors: {complete: true, matchedMemories: 1, requested: 1, resolved: 1}}},
    durableDecisions: [memoryEvidence],
  } as unknown as ContextBriefV1;
}

describe('Context Brief action cards', () => {
  it('extracts only explicit bounded fields', () => {
    expect(
      parseMemoryActionCard(
        'A narrative line.\n## Applies to: Catalog edits\n## Invariant: Keep the stable key.\nAvoid: Resetting identity.\nVerify: Run focused tests.',
      ),
    ).toEqual({
      appliesTo: 'Catalog edits',
      invariant: 'Keep the stable key.',
      avoid: 'Resetting identity.',
      verify: 'Run focused tests.',
    });
    expect(parseMemoryActionCard('## Applies to: Catalog edits\nA vague story without an invariant.')).toBeUndefined();
    expect(
      parseMemoryActionCard('```text\nApplies to: sample\nInvariant: quoted code\n```\nA narrative line.'),
    ).toBeUndefined();
  });

  it('delivers only current direct evidence and includes a validation hint', () => {
    expect(renderCodeBriefEditContext(briefWith(memory))).toContain(
      'Verify after the edit: Run the focused catalog test.',
    );
    expect(renderCodeBriefEditContext(briefWith({...memory, freshness: 'stale'}))).toBeUndefined();
    expect(renderCodeBriefEditContext(briefWith({...memory, preciseStatus: 'relocated'}))).toBeUndefined();
    expect(renderCodeBriefEditContext(briefWith({...memory, preciseStatus: undefined}))).toContain(
      'Verify after the edit: Run the focused catalog test.',
    );
    expect(renderCodeBriefEditContext(briefWith({...memory, selectionBasis: undefined}))).toBeUndefined();
    expect(renderCodeBriefEditContext(briefWith({...memory, codeRelations: []}))).toBeUndefined();
    expect(classifyCodeBriefEditDelivery(briefWith(memory)).status).toBe('delivered');
    expect(classifyCodeBriefEditDelivery(briefWith({...memory, freshness: 'stale'})).status).toBe('unsafe-link');
    expect(classifyCodeBriefEditDelivery(briefWith({...memory, preciseStatus: undefined})).status).toBe('delivered');
    expect(classifyCodeBriefEditDelivery(briefWith({...memory, codeRelations: []})).status).toBe('unsafe-link');
    expect(classifyCodeBriefEditDelivery(briefWith({...memory, selectionBasis: undefined})).status).toBe(
      'evidence-omitted',
    );
  });

  it('keeps parsed fields bounded for arbitrary Unicode content', () => {
    fc.assert(
      fc.property(fc.string({minLength: 1, maxLength: 512}), value => {
        const card = parseMemoryActionCard(`Applies to: target\nInvariant: ${value}\nVerify: ${value}`);
        if (card === undefined) return;
        expect(new TextEncoder().encode(card.invariant).byteLength).toBeLessThanOrEqual(96);
        expect(new TextEncoder().encode(card.verify).byteLength).toBeLessThanOrEqual(96);
        expect(parseMemoryActionCard(`Applies to: target\nInvariant: ${value}\nVerify: ${value}`)).toEqual(card);
      }),
      {numRuns: 100},
    );
  });
});
