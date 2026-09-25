import {describe, expect, it} from 'vitest';
import {resolveMemoryKeywordPlan, tryResolveMemoryKeywordPlan} from '../../src/memory/keywords.js';

describe('resolveMemoryKeywordPlan', () => {
  it('falls through to automatic on a fresh memory', () => {
    expect(resolveMemoryKeywordPlan({})).toEqual({mode: 'automatic'});
  });

  it('treats fresh-memory clear as a no-op automatic', () => {
    expect(resolveMemoryKeywordPlan({clearKeywords: true})).toEqual({mode: 'automatic'});
  });

  it('preserves prior keywords by default', () => {
    expect(resolveMemoryKeywordPlan({replacedKeywords: ['arc', 'karpenter']})).toEqual({
      mode: 'preserved',
      keywords: ['arc', 'karpenter'],
    });
  });

  it('normalizes preserved keywords and falls through when nothing usable remains', () => {
    expect(resolveMemoryKeywordPlan({replacedKeywords: ['  ARC  ', 'arc', 'x', '']})).toEqual({
      mode: 'preserved',
      keywords: ['ARC'],
    });
    expect(resolveMemoryKeywordPlan({replacedKeywords: ['x', '  ']})).toEqual({mode: 'automatic'});
  });

  it('clears only when prior keywords exist', () => {
    expect(resolveMemoryKeywordPlan({clearKeywords: true, replacedKeywords: ['arc']})).toEqual({
      mode: 'cleared',
    });
  });

  it('regenerates personal memories and rejects shared regeneration', () => {
    expect(resolveMemoryKeywordPlan({regenerateKeywords: true, replacedKeywords: ['arc']})).toEqual({
      mode: 'regenerate',
    });
    expect(() => resolveMemoryKeywordPlan({regenerateKeywords: true, replacedKeywords: ['arc'], shared: true})).toThrow(
      /shared/i,
    );
  });

  it('stores explicit keywords normalized', () => {
    expect(resolveMemoryKeywordPlan({keywords: [' jitconfig ', 'jitconfig', 'karpenter']})).toEqual({
      mode: 'explicit',
      keywords: ['jitconfig', 'karpenter'],
    });
  });

  it('rejects mutually exclusive options with CLI spellings by default', () => {
    for (const input of [
      {keywords: ['arc'], clearKeywords: true},
      {keywords: ['arc'], regenerateKeywords: true},
      {clearKeywords: true, regenerateKeywords: true},
    ] as const) {
      expect(() => resolveMemoryKeywordPlan(input)).toThrow(/--keyword.*--clear-keywords.*--regenerate-keywords/);
    }
    expect(() => resolveMemoryKeywordPlan({keywords: ['   ']})).toThrow(/non-empty/);
  });

  it('uses MCP field names on the MCP surface', () => {
    expect(() => resolveMemoryKeywordPlan({keywords: ['arc'], clearKeywords: true, surface: 'mcp'})).toThrow(
      /keywords, clearKeywords, or regenerateKeywords/,
    );
  });

  it('rejects authoring and regeneration for ineligible kinds', () => {
    expect(() => resolveMemoryKeywordPlan({keywords: ['arc'], kind: 'handoff', replacedKeywords: ['old']})).toThrow(
      /handoff/,
    );
    expect(() =>
      resolveMemoryKeywordPlan({regenerateKeywords: true, kind: 'smoke', replacedKeywords: ['old']}),
    ).toThrow(/smoke/);
    expect(resolveMemoryKeywordPlan({clearKeywords: true, kind: 'handoff', replacedKeywords: ['old']})).toEqual({
      mode: 'cleared',
    });
    expect(resolveMemoryKeywordPlan({kind: 'handoff', replacedKeywords: ['old']})).toEqual({
      mode: 'preserved',
      keywords: ['old'],
    });
  });

  it('caps explicit keywords at 32', () => {
    const keywords = Array.from({length: 40}, (_, index) => `keyword number ${index}`);
    const plan = resolveMemoryKeywordPlan({keywords});
    expect(plan.mode).toBe('explicit');
    if (plan.mode === 'explicit') {
      expect(plan.keywords).toHaveLength(32);
    }
  });
});

describe('tryResolveMemoryKeywordPlan', () => {
  it('returns the plan on success and the message on failure', () => {
    expect(tryResolveMemoryKeywordPlan({replacedKeywords: ['arc']})).toEqual({
      plan: {mode: 'preserved', keywords: ['arc']},
    });
    const outcome = tryResolveMemoryKeywordPlan({keywords: ['arc'], clearKeywords: true});
    expect('message' in outcome && outcome.message).toMatch(/Choose only one/);
  });
});
