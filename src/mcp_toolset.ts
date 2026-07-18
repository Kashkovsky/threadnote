export const DEFAULT_MCP_TOOLSET = 'core';
export const MCP_TOOLSET_ENV = 'THREADNOTE_MCP_TOOLSET';

export type McpToolset = 'core' | 'full';

export function parseMcpToolset(value: string): McpToolset {
  if (value === 'core' || value === 'full') {
    return value;
  }
  throw new Error(`Invalid MCP toolset: ${value}. Expected core or full.`);
}
