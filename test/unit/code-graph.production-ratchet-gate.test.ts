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
        '--expected-candidate-commit',
        'b'.repeat(40),
        '--expected-control-commit',
        'a'.repeat(40),
        '--initial-candidate',
        'initial-candidate.json',
      ]),
    ).toEqual({
      artifactPath: 'candidate.json',
      controlPath: 'control.json',
      expectedCandidateCommit: 'b'.repeat(40),
      expectedControlCommit: 'a'.repeat(40),
      initialCandidatePath: 'initial-candidate.json',
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
        '--control',
        'control.json',
        '--expected-candidate-commit',
        'b'.repeat(40),
        '--expected-control-commit',
        'a'.repeat(40),
      ]),
    ).toThrow(/must be provided together/u);
    expect(() =>
      parseCodeGraphProductionRatchetGateArguments([
        '--artifact',
        'candidate.json',
        '--ratchet',
        'ratchet.json',
        '--control',
        'control.json',
        '--expected-candidate-commit',
        'b'.repeat(40),
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
