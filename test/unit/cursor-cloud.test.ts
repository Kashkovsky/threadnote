import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  buildCursorCloudMcpConfig,
  buildCursorCloudProfile,
  credentialFreeGitRemote,
  cursorCloudMemoryRoot,
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
        THREADNOTE_MCP_TOOLSET: 'cursor-cloud',
        THREADNOTE_USER: 'cloud-user',
      },
      type: 'stdio',
    });
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
