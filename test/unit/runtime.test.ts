import {describe, expect, it} from 'vitest';
import {renderJsonTemplate, withIdentity} from '../../src/runtime.js';
import type {RuntimeConfig} from '../../src/types.js';

const IDENTITY = {account: 'local', agentId: 'threadnote', user: 'denys'} as const;

describe('withIdentity', () => {
  it('appends only account and user (OpenViking 0.4.x removed the --agent-id flag)', () => {
    expect(withIdentity(IDENTITY, ['find', 'query'])).toEqual([
      'find',
      'query',
      '--account',
      'local',
      '--user',
      'denys',
    ]);
  });

  it('never passes --agent-id, which 0.4.x rejects with "Unexpected argument"', () => {
    expect(withIdentity(IDENTITY, ['search', 'q'])).not.toContain('--agent-id');
    expect(withIdentity(IDENTITY, ['search', 'q'])).not.toContain('threadnote');
  });
});

describe('renderJsonTemplate', () => {
  it('escapes Windows paths and identity values as JSON string content', () => {
    const config: RuntimeConfig = {
      account: 'local',
      agentContextHome: 'C:\\Users\\runner\\Threadnote Home',
      agentId: 'threadnote',
      host: '127.0.0.1',
      manifestPath: 'C:\\Users\\runner\\manifest.yaml',
      openVikingVersion: '0.4.10',
      port: 1933,
      user: 'windows-e2e',
    };

    expect(
      JSON.parse(renderJsonTemplate('{"workspace":"{{THREADNOTE_HOME}}/data","user":"{{OPENVIKING_USER}}"}', config)),
    ).toEqual({
      user: 'windows-e2e',
      workspace: 'C:\\Users\\runner\\Threadnote Home/data',
    });
  });
});
