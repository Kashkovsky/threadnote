import {describe, expect, it} from 'vitest';
import {localAiApiUrl, parseLocalAiSettings} from '../../src/effect/local-ai.js';

describe('deprecated local-ai compatibility surface', () => {
  it('accepts only in-process v2 settings', () => {
    expect(
      parseLocalAiSettings({
        enabled: true,
        host: 'in-process',
        model: 'fixture-generation',
        modelPath: '/models/fixture.gguf',
        port: 0,
        version: 2,
      }),
    ).toMatchObject({host: 'in-process', port: 0, version: 2});
    expect(() =>
      parseLocalAiSettings({
        enabled: true,
        host: '127.0.0.1',
        model: 'legacy',
        modelPath: '/models/legacy.gguf',
        port: 1934,
        version: 1,
      }),
    ).toThrow(/Legacy local-ai server settings/);
  });

  it('does not expose an HTTP endpoint', () => {
    expect(localAiApiUrl({host: 'in-process', port: 0})).toBe('threadnote+in-process://local-ai');
  });
});
