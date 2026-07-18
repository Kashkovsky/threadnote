import {afterEach, describe, expect, it, vi} from 'vitest';
import {runMcpInstall} from '../../src/mcp.js';
import {parseMcpToolset} from '../../src/mcp_toolset.js';
import type {RuntimeConfig} from '../../src/types.js';

function runtime(): RuntimeConfig {
  return {
    account: 'local',
    agentContextHome: '/tmp/threadnote-test',
    agentId: 'threadnote',
    host: '127.0.0.1',
    manifestPath: '/tmp/threadnote-test/seed-manifest.yaml',
    openVikingVersion: '0.4.7',
    port: 1933,
    user: 'denys',
  };
}

async function dryRunOutput(toolset?: 'core' | 'full'): Promise<string> {
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation(value => lines.push(String(value)));
  await runMcpInstall(runtime(), 'codex', {toolset});
  return lines.join('\n');
}

afterEach(() => vi.restoreAllMocks());

describe('MCP toolsets', () => {
  it('installs the core stdio toolset by default', async () => {
    await expect(dryRunOutput()).resolves.toContain('THREADNOTE_MCP_TOOLSET=core');
  });

  it('installs the full stdio toolset when requested', async () => {
    await expect(dryRunOutput('full')).resolves.toContain('THREADNOTE_MCP_TOOLSET=full');
  });

  it('rejects unsupported toolsets', () => {
    expect(() => parseMcpToolset('minimal')).toThrow('Invalid MCP toolset: minimal. Expected core or full.');
  });
});
