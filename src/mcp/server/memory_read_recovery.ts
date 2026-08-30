import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import {memoryReadRecoveryForError, memoryReadRecoveryText} from '../memory_read_recovery.js';
import type {RuntimeConfig} from '../../types.js';
import {mcpErrorResult} from './common.js';

export function memoryReadErrorResult(config: Pick<RuntimeConfig, 'user'>, error: unknown): CallToolResult {
  const recovery = memoryReadRecoveryForError(config, error);
  if (recovery === undefined) return mcpErrorResult(error);
  const base = mcpErrorResult(error);
  return Object.assign(base, {
    content: [{type: 'text' as const, text: memoryReadRecoveryText(recovery)}],
    structuredContent: recovery,
  });
}
