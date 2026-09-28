import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import {Schema} from 'effect';
import {memoryReadRecoveryForError, memoryReadRecoveryText} from '@threadnote/memory/read/recovery';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {memoryIdentityAlias} from '@threadnote/memory/identity-alias';
import {MemoryIdentityResolutionError} from '@threadnote/recall/memory/identity';
import {mcpErrorResult} from './common.js';

export function memoryReadErrorResult(config: Pick<RuntimeConfig, 'user'>, error: unknown): CallToolResult {
  if (Schema.is(MemoryIdentityResolutionError)(error)) {
    const receipt = {
      alias: memoryIdentityAlias(error.memoryId),
      message: error.message,
      reason: error.reason,
      recovery: error.reason === 'not-found' ? 'Run recall_context again.' : 'Refresh recall and retry.',
      type: 'threadnote-memory-identity-error' as const,
      version: 1 as const,
    };
    return {
      content: [{type: 'text' as const, text: JSON.stringify(receipt)}],
      isError: true,
      structuredContent: receipt,
    };
  }
  const recovery = memoryReadRecoveryForError(config, error);
  if (recovery === undefined) return mcpErrorResult(error);
  const base = mcpErrorResult(error);
  return Object.assign(base, {
    content: [{type: 'text' as const, text: memoryReadRecoveryText(recovery)}],
    structuredContent: recovery,
  });
}
