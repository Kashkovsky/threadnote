import {describe, expect, it} from 'vitest';
import {withIdentity} from '../../src/runtime.js';

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
