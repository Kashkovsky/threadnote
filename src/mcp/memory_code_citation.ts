import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import {Effect} from 'effect';
import {captureMemoryCodeCitations, MemoryCodeCitationCaptureError} from '../memory/code_citation_capture.js';
import {mcpErrorResult} from './server/common.js';
import type {RuntimeConfig} from '../types.js';

export function captureMemoryCodeCitationsForMcp(
  config: RuntimeConfig,
  input: {readonly callerCwd: string; readonly refs: readonly string[]},
  operation: string,
) {
  if (input.refs.length === 0) {
    return Effect.succeed({citations: [] as const, ok: true as const});
  }
  return captureMemoryCodeCitations(config, input).pipe(
    Effect.match({
      onFailure: error => ({
        error: memoryCodeCitationCaptureErrorResult(error, operation),
        failure: error,
        ok: false as const,
      }),
      onSuccess: citations => ({citations, ok: true as const}),
    }),
  );
}

function memoryCodeCitationCaptureErrorResult(error: unknown, operation: string): CallToolResult {
  const result = mcpErrorResult(error);
  if (!(error instanceof MemoryCodeCitationCaptureError) || error.recovery === undefined) return result;
  const recovery = error.recovery;
  const preparation = recovery.preparation;
  result.content = [
    {
      type: 'text',
      text: [
        error.message,
        'No memory was written.',
        `After preparation reports current ready evidence, retry the same ${operation} request unchanged.`,
      ].join(' '),
    },
  ];
  result.structuredContent = {
    code: recovery.code,
    graph: recovery.observedGraph,
    indexingStarted: recovery.indexingStarted,
    operation,
    recovery: {
      action: preparation.action,
      arguments: preparation.arguments,
      command: preparation.command,
      retry: 'same-request',
      runFrom: preparation.target === 'callerCwd' ? 'callerCwd' : 'any-directory',
      target: preparation.target,
    },
    retryCondition: recovery.retryCondition,
    retryable: recovery.retryable,
    state: 'blocked',
    type: 'memory-code-citation-write-recovery',
    version: 1,
    writeApplied: false,
  };
  return result;
}
