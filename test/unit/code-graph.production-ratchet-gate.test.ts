import {describe, expect, it} from 'vitest';
import {parseCodeGraphProductionRatchetGateArguments} from '../ci/code-graph-production-ratchet-gate.js';

describe('code graph production ratchet gate', () => {
  it('requires an explicit paired control contract', () => {
    expect(
      parseCodeGraphProductionRatchetGateArguments([
        '--artifact',
        'candidate.json',
        '--ratchet',
        'ratchet.json',
        '--control',
        'control.json',
        '--expected-control-commit',
        'a'.repeat(40),
      ]),
    ).toEqual({
      artifactPath: 'candidate.json',
      controlPath: 'control.json',
      expectedControlCommit: 'a'.repeat(40),
      ratchetPath: 'ratchet.json',
    });
    expect(() =>
      parseCodeGraphProductionRatchetGateArguments([
        '--artifact',
        'candidate.json',
        '--ratchet',
        'ratchet.json',
        '--control',
        'control.json',
      ]),
    ).toThrow(/must be provided together/u);
    expect(() =>
      parseCodeGraphProductionRatchetGateArguments([
        '--artifact',
        'candidate.json',
        '--ratchet',
        'ratchet.json',
        '--unexpected',
        'value',
      ]),
    ).toThrow(/Unknown or incomplete/u);
  });
});
