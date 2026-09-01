import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  assertCodeMemoryLinkTurnProgress,
  CODE_MEMORY_LINK_NO_ACTION_BUDGET,
  summarizeCodeMemoryLinkCodexEvents,
} from '../../scripts/code-memory-link-app-server-client.js';
import {
  CODE_MEMORY_LINK_CODEX_TERMINAL_KINDS,
  CodeMemoryLinkCodexTerminalError,
  createCodeMemoryLinkCodexTerminalReceipt,
  formatCodeMemoryLinkCodexTerminalReceipt,
  parseCodeMemoryLinkCodexTerminalReceipt,
} from '../../scripts/code-memory-link-codex-terminal.js';

describe('Code Memory Link Codex terminal receipts', () => {
  it('round-trips every closed privacy-safe terminal class and rejects tampering', () => {
    fc.assert(
      fc.property(fc.constantFrom(...CODE_MEMORY_LINK_CODEX_TERMINAL_KINDS), kind => {
        const marker = formatCodeMemoryLinkCodexTerminalReceipt(
          new CodeMemoryLinkCodexTerminalError(kind, 'private diagnostic text must not be retained'),
        );
        expect(marker).not.toContain('private diagnostic text');
        expect(parseCodeMemoryLinkCodexTerminalReceipt(`${marker}\n`)).toEqual(
          createCodeMemoryLinkCodexTerminalReceipt(kind),
        );
        expect(
          parseCodeMemoryLinkCodexTerminalReceipt(marker.replace(/"diagnosticHash":"[0-9a-f]/u, '"diagnosticHash":"z')),
        ).toBeNull();
      }),
      {numRuns: 32},
    );
  });

  it('stops monotonically at either no-action boundary and disables the stop after a file change starts', () => {
    fc.assert(
      fc.property(
        fc.integer({min: 1, max: CODE_MEMORY_LINK_NO_ACTION_BUDGET.steps + 4}),
        fc.integer({min: 1, max: CODE_MEMORY_LINK_NO_ACTION_BUDGET.tokens + 4_000}),
        (steps, tokens) => {
          const events = usageEvents(steps, tokens);
          const shouldStop =
            steps >= CODE_MEMORY_LINK_NO_ACTION_BUDGET.steps || tokens >= CODE_MEMORY_LINK_NO_ACTION_BUDGET.tokens;
          if (shouldStop) {
            expect(() => assertCodeMemoryLinkTurnProgress(events, {steps: 100, tokens: 1_000_000})).toThrow(
              /no-action budget/u,
            );
          } else {
            expect(() => assertCodeMemoryLinkTurnProgress(events, {steps: 100, tokens: 1_000_000})).not.toThrow();
          }
          expect(() =>
            assertCodeMemoryLinkTurnProgress([...fileChangeStarted(), ...events], {
              steps: 100,
              tokens: 1_000_000,
            }),
          ).not.toThrow();
        },
      ),
      {numRuns: 64},
    );
  });

  it('summarizes only closed event classes and aggregate usage', () => {
    fc.assert(
      fc.property(
        fc.uuid().map(value => `private-${value}`),
        privateText => {
          const events = [
            {method: 'item/started', params: {item: {content: privateText, type: 'reasoning'}}},
            {method: 'item/completed', params: {item: {command: privateText, type: 'commandExecution'}}},
            {method: 'item/started', params: {item: {tool: 'context_brief', type: 'mcpToolCall'}}},
            ...usageEvents(2, 321),
          ];
          const summary = summarizeCodeMemoryLinkCodexEvents(events);
          expect(summary).toEqual({
            completedItems: {
              agentMessage: 0,
              commandExecution: 1,
              fileChange: 0,
              mcpToolCall: 0,
              other: 0,
              plan: 0,
              reasoning: 0,
              userMessage: 0,
            },
            contextBriefCallStarts: 1,
            startedItems: {
              agentMessage: 0,
              commandExecution: 0,
              fileChange: 0,
              mcpToolCall: 1,
              other: 0,
              plan: 0,
              reasoning: 1,
              userMessage: 0,
            },
            totalTaskUsage: {steps: 2, tokens: 321},
            version: 1,
          });
          expect(JSON.stringify(summary)).not.toContain(privateText);
        },
      ),
      {numRuns: 32},
    );
  });
});

function usageEvents(steps: number, totalTokens: number): readonly Record<string, unknown>[] {
  return Array.from({length: steps}, (_, index) => ({
    method: 'thread/tokenUsage/updated',
    params: {
      tokenUsage: {
        total: {totalTokens: Math.ceil((totalTokens * (index + 1)) / steps)},
      },
    },
  }));
}

function fileChangeStarted(): readonly Record<string, unknown>[] {
  return [{method: 'item/started', params: {item: {id: 'edit-1', type: 'fileChange'}}}];
}
