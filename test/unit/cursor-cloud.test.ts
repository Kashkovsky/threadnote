import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  buildCursorCloudMcpConfig,
  buildCursorCloudProfile,
  buildCursorCloudRemoteHybridMcpConfig,
  credentialFreeGitRemote,
  cursorCloudMemoryEndpoint,
  cursorCloudMemoryRoot,
  cursorCloudRemoteShareId,
  planCursorCloudBootstrap,
} from '../../src/cursor_cloud.js';
import type {RuntimeConfig, ShareTeamConfig, ShareTeamsFile} from '../../src/types.js';

const runtime: RuntimeConfig = {
  account: 'local',
  agentContextHome: '/tmp/threadnote-cloud-test',
  agentId: 'threadnote',
  manifestPath: '/tmp/threadnote-cloud-test/seed-manifest.yaml',
  user: 'local-user',
};

describe('Cursor Cloud profile', () => {
  it('renders a deterministic writable shared-memory MCP configuration', () => {
    const profile = buildCursorCloudProfile(runtime, {
      agentId: 'cursor-agent',
      team: 'engineering',
      user: 'cloud-user',
    });

    expect(profile).toMatchObject({
      agentId: 'cursor-agent',
      memoryRoot: 'threadnote://user/cloud-user/memories/shared/engineering',
      profile: 'shared-read-write',
      team: 'engineering',
      user: 'cloud-user',
    });
    const mcpConfig = buildCursorCloudMcpConfig(profile);
    expect(mcpConfig).toEqual(buildCursorCloudMcpConfig(profile));
    expect(mcpConfig).toEqual({
      args: ['-lc', 'exec "$HOME/.local/bin/threadnote-mcp-server"'],
      command: '/bin/sh',
      env: {
        THREADNOTE_ACCOUNT: 'local',
        THREADNOTE_AGENT_ID: 'cursor-agent',
        THREADNOTE_CURSOR_CLOUD_TEAM: 'engineering',
        THREADNOTE_MCP_TOOLSET: 'cursor-cloud-git-beta',
        THREADNOTE_USER: 'cloud-user',
      },
      type: 'stdio',
    });
  });

  it('renders two credential-free Dashboard entries for remote-hybrid mode', () => {
    const profile = buildCursorCloudProfile(runtime, {agentId: 'cloud-agent', user: 'cloud-user'});
    const config = buildCursorCloudRemoteHybridMcpConfig(
      profile,
      'https://memory.threadnote.io/mcp',
      'share-engineering',
    );

    expect(config).toEqual({
      mcpServers: {
        'threadnote-local': {
          args: ['-lc', 'exec "$HOME/.local/bin/threadnote-mcp-server"'],
          command: '/bin/sh',
          env: {
            THREADNOTE_ACCOUNT: 'local',
            THREADNOTE_AGENT_ID: 'cloud-agent',
            THREADNOTE_CURSOR_MEMORY_ENDPOINT: 'https://memory.threadnote.io/mcp',
            THREADNOTE_CURSOR_MEMORY_SHARE_ID: 'share-engineering',
            THREADNOTE_MCP_TOOLSET: 'cursor-cloud-local',
            THREADNOTE_USER: 'cloud-user',
          },
          type: 'stdio',
        },
        'threadnote-memory': {
          headers: {'threadnote-share-id': 'share-engineering'},
          url: 'https://memory.threadnote.io/mcp',
        },
      },
    });
    expect(Object.keys(config.mcpServers['threadnote-memory'].headers)).toEqual(['threadnote-share-id']);
    expect(new URL(config.mcpServers['threadnote-memory'].url).search).toBe('');
    expect(JSON.stringify(config)).not.toMatch(/authorization|bearer|token|secret/i);
  });

  it('accepts only the server-supported opaque remote share ID grammar without reflecting rejected values', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/u), shareId => {
        expect(cursorCloudRemoteShareId(shareId)).toBe(shareId);
      }),
      {numRuns: 100},
    );

    for (const shareId of ['share:other', '-leading-hyphen', `${'a'.repeat(128)}b`]) {
      let message = '';
      try {
        cursorCloudRemoteShareId(shareId);
      } catch (cause) {
        message = cause instanceof Error ? cause.message : String(cause);
      }
      expect(message).toContain('opaque identifier');
      expect(message).not.toContain(shareId);
    }
  });

  it('rejects credential-bearing or ambiguous managed endpoints without reflecting them', () => {
    const endpoint = 'https://owner:credential@memory.threadnote.io/mcp';
    expect(() => cursorCloudMemoryEndpoint(endpoint)).toThrow('credential-free HTTPS');
    try {
      cursorCloudMemoryEndpoint(endpoint);
    } catch (cause) {
      expect(String(cause)).not.toContain(endpoint);
      expect(String(cause)).not.toContain('credential@');
    }
    expect(() => cursorCloudMemoryEndpoint('http://memory.threadnote.io/mcp')).toThrow('credential-free HTTPS');
    expect(() => cursorCloudMemoryEndpoint('https://memory.threadnote.io/mcp?token=value')).toThrow(
      'credential-free HTTPS',
    );
    expect(() => cursorCloudMemoryEndpoint('https://memory.threadnote.io/not-mcp')).toThrow('HTTPS /mcp URL');
  });

  it('plans initialization once and reuses only the equivalent writable share', () => {
    const remote = 'git@example.com:team/memories.git';
    expect(planCursorCloudBootstrap(emptyTeams(), remote, 'engineering')).toEqual({
      action: 'initialize',
      remote,
      team: 'engineering',
    });
    expect(planCursorCloudBootstrap(teamsWith(teamConfig(remote)), remote, 'engineering')).toEqual({
      action: 'reuse',
      remote,
      team: 'engineering',
    });
    expect(() => planCursorCloudBootstrap(teamsWith(teamConfig(remote, 'read-only')), remote, 'engineering')).toThrow(
      'not read-write',
    );
    expect(() =>
      planCursorCloudBootstrap(teamsWith(teamConfig('git@example.com:other/memories.git')), remote, 'engineering'),
    ).toThrow('different remote');
  });

  it('constructs the canonical exclusive memory root', () => {
    expect(cursorCloudMemoryRoot('Cloud User', 'product-team')).toBe(
      'threadnote://user/cloud-user/memories/shared/product-team',
    );
  });

  it('never reflects embedded HTTP credentials in rejection messages', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z0-9]{1,16}$/),
        fc.stringMatching(/^[A-Za-z0-9]{1,16}$/),
        (username, password) => {
          const remote = `https://${username}:${password}@example.com/team/memories.git`;
          let message = '';
          try {
            credentialFreeGitRemote(remote);
          } catch (cause) {
            message = cause instanceof Error ? cause.message : String(cause);
          }
          expect(message).toContain('must not contain embedded credentials');
          expect(message).not.toContain(remote);
        },
      ),
      {numRuns: 100},
    );
  });
});

function emptyTeams(): ShareTeamsFile {
  return {teams: {}, version: 1};
}

function teamsWith(team: ShareTeamConfig): ShareTeamsFile {
  return {defaultTeam: 'engineering', teams: {engineering: team}, version: 1};
}

function teamConfig(remote: string, access?: 'read-only'): ShareTeamConfig {
  return {
    ...(access ? {access} : {}),
    addedAt: '2026-08-12T00:00:00.000Z',
    gitdir: '/tmp/threadnote-cloud-test/share/teams/engineering.gitdir',
    name: 'engineering',
    remote,
    worktree: '/tmp/threadnote-cloud-test/share/worktrees/engineering',
  };
}
