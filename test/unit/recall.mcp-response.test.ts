import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {projectRecallMcpResponse} from '../../src/recall/mcp_response.js';
import {lexicalIndexUnavailableWarning} from '../../src/recall/warning.js';
import type {RecallHit} from '../../src/utils.js';

function hit(index: number, options: Partial<RecallHit> = {}): RecallHit {
  return {
    category: 'memories',
    contextType: 'memory',
    finalScore: 0.73456,
    rankReasons: [{code: 'exact_term_match', contribution: 0.18, detail: 'Exact terms matched the memory.'}],
    rankSignals: {
      authority: 0.6,
      bm25: 0.4,
      exact: 0.8,
      feedback: 0,
      field: 0.5,
      freshness: 1,
      graph: 0,
      kindIntent: 0,
      lifecycle: 1,
      reranker: 0,
      scope: 1,
      semantic: 0,
      temporal: 1,
      workspace: 0,
    },
    rankWarnings: ['lexical-only result'],
    score: 0,
    snippet: `memory ${index}`,
    uri: `threadnote://user/test/memories/durable/projects/threadnote/memory-${index}.md`,
    ...options,
  };
}

function logical(results: readonly RecallHit[], notices: readonly string[] = []) {
  return {
    confidence: {level: 'medium' as const, margin: 0.2, reason: 'Useful match.', score: 0.73},
    notices,
    queryExpansions: ['expanded query'],
    rankerVersion: 'hybrid-v5',
    results,
  };
}

describe('recall MCP response projection', () => {
  it('keeps degraded lexical state typed and visible when no pointer is available', () => {
    const warning = lexicalIndexUnavailableWarning();
    const projected = projectRecallMcpResponse({...logical([]), warnings: [warning, warning]});

    expect(projected.structuredContent.results).toEqual([]);
    expect(projected.structuredContent.warnings).toEqual([warning]);
    expect(projected.text).toContain('Recall returned 0/0 unread pointer(s)');
    expect(projected.text).toContain('Recall index warning:');
    expect(projected.text).toContain(warning.remediation);
  });

  it('returns a compact unread queue by default and restores ranking detail only with explain', () => {
    const compact = projectRecallMcpResponse(logical([hit(1)]), {budgetTokens: 1_500});

    expect(compact.structuredContent).toMatchObject({
      nextAction: {
        tool: 'read_context',
        uris: ['threadnote://user/test/memories/durable/projects/threadnote/memory-1.md'],
      },
      output: {explain: false, omittedResults: 0, returnedResults: 1, truncated: false},
      rankerVersion: 'hybrid-v5',
      results: [
        {
          category: 'memories',
          confidence: 0.735,
          readState: 'unread',
          reason: 'Exact terms matched the memory.',
        },
      ],
    });
    expect(compact.structuredContent).not.toHaveProperty('queryExpansions');
    expect(compact.structuredContent.results[0]).not.toHaveProperty('reasons');
    expect(compact.structuredContent.results[0]).not.toHaveProperty('signals');
    expect(compact.text).toContain('Ranked pointers are not evidence');

    const explained = projectRecallMcpResponse(logical([hit(1)]), {budgetTokens: 1_500, explain: true});
    expect(explained.structuredContent.queryExpansions).toEqual(['expanded query']);
    expect(explained.structuredContent.results[0]).toMatchObject({
      finalScore: 0.73456,
      rankWarnings: ['lexical-only result'],
      reasons: expect.any(Array),
      signals: expect.any(Object),
    });
  });

  it('surfaces a typed identity-conflict warning without enabling diagnostic explanations', () => {
    const compact = projectRecallMcpResponse(logical([hit(1, {identityConflict: true})]));

    expect(compact.structuredContent.output.explain).toBe(false);
    expect(compact.structuredContent.results[0]).toMatchObject({
      warnings: [
        {
          code: 'memory_identity_conflict',
          message: expect.stringContaining('divergent bodies'),
          remediation: expect.stringContaining('verify'),
        },
      ],
    });
    expect(compact.structuredContent.results[0]).not.toHaveProperty('rankWarnings');
  });

  it('keeps the canonical top pointer when one logical memory has hundreds of aliases', () => {
    const aliases = Array.from(
      {length: 500},
      (_, index) => `threadnote://user/test/memories/shared/team-${index}/memory.md`,
    );
    const projected = projectRecallMcpResponse(logical([hit(1, {equivalentUris: aliases})]));

    expect(projected.measurement.totalBytes).toBeLessThanOrEqual(1_500 * 3);
    expect(projected.structuredContent.results).toHaveLength(1);
    expect(projected.structuredContent.results[0]).toMatchObject({
      aliasCount: 500,
      aliases: aliases.slice(0, 3),
      omittedAliases: 497,
      uri: 'threadnote://user/test/memories/durable/projects/threadnote/memory-1.md',
    });
  });

  it('prioritizes bounded warnings and hygiene hints in compact text', () => {
    const projected = projectRecallMcpResponse(
      logical(
        [hit(1)],
        [
          'Workset scope: product',
          'Recall query expansion: evaluated one rewrite.',
          'Memory hygiene hints:\n- Review an older handoff.',
          'Local AI recall unavailable: worker failed. Deterministic recall continued.',
          'Auto-synced Obsidian sources: notes',
        ],
      ),
    );

    expect(projected.text).toContain('Local AI recall unavailable');
    expect(projected.text).toContain('Memory hygiene hints: - Review an older handoff.');
    expect(projected.text).toContain('Auto-synced Obsidian sources: notes');
    expect(projected.text).not.toContain('Recall query expansion');
  });

  it('selects a deterministic ranked prefix within the declared budget', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.stringMatching(/^[a-z0-9-]{1,32}$/), {maxLength: 30, selector: value => value}),
        fc.integer({min: 300, max: 1_500}),
        (segments, budgetTokens) => {
          const results = segments.map((segment, index) =>
            hit(index, {
              uri: `threadnote://user/test/memories/durable/projects/threadnote/${segment}.md`,
            }),
          );
          const first = projectRecallMcpResponse(logical(results), {budgetTokens});
          const second = projectRecallMcpResponse(logical(results), {budgetTokens});

          expect(first).toEqual(second);
          expect(first.measurement.totalBytes).toBeLessThanOrEqual(budgetTokens * 3);
          expect(first.structuredContent.results.map(result => result.uri)).toEqual(
            results.slice(0, first.structuredContent.output.returnedResults).map(result => result.uri),
          );
          expect(first.structuredContent.results.every(result => result.readState === 'unread')).toBe(true);
          expect(first.structuredContent.nextAction.uris).toEqual(
            first.structuredContent.results.slice(0, 3).map(result => result.uri),
          );
        },
      ),
      {numRuns: 100},
    );
  });
});
