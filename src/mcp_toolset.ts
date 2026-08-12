export const DEFAULT_MCP_TOOLSET = 'core';
export const MCP_TOOLSET_ENV = 'THREADNOTE_MCP_TOOLSET';

export type McpToolset = 'core' | 'cursor-cloud' | 'full';

export interface McpToolCapabilities {
  readonly contextBrief: boolean;
  readonly graphLocal: boolean;
  readonly graphWorkset: boolean;
  readonly maintenance: boolean;
  readonly memoryPublish: boolean;
  readonly memoryRead: boolean;
  readonly memoryReview: boolean;
  readonly memoryWrite: boolean;
}

const TOOLSET_CAPABILITIES = {
  core: {
    contextBrief: true,
    graphLocal: true,
    graphWorkset: true,
    maintenance: false,
    memoryPublish: true,
    memoryRead: true,
    memoryReview: true,
    memoryWrite: true,
  },
  'cursor-cloud': {
    contextBrief: false,
    graphLocal: true,
    graphWorkset: false,
    maintenance: false,
    memoryPublish: false,
    memoryRead: true,
    memoryReview: false,
    memoryWrite: true,
  },
  full: {
    contextBrief: true,
    graphLocal: true,
    graphWorkset: true,
    maintenance: true,
    memoryPublish: true,
    memoryRead: true,
    memoryReview: true,
    memoryWrite: true,
  },
} as const satisfies Record<McpToolset, McpToolCapabilities>;

export function parseMcpToolset(value: string): McpToolset {
  if (value === 'core' || value === 'cursor-cloud' || value === 'full') {
    return value;
  }
  throw new Error(`Invalid MCP toolset: ${value}. Expected core, cursor-cloud, or full.`);
}

export function mcpToolCapabilities(toolset: McpToolset): McpToolCapabilities {
  return TOOLSET_CAPABILITIES[toolset];
}
