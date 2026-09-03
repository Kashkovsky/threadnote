import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import {Schema} from 'effect';
import {memoryReadRecoveryForError, memoryReadRecoveryText} from '../../memory/read_recovery.js';
import type {RuntimeConfig} from '../../types.js';
import {memoryIdentityAlias} from '../../memory/identity_alias.js';
import {MemoryIdentityResolutionError} from '../../recall/memory_identity.js';
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
