import {describe, expect, it} from 'vitest';
import {confirmationAnswer} from '../../src/cli_ui.js';

describe('confirmationAnswer', () => {
  it('accepts affirmative input', () => {
    expect(confirmationAnswer('yes')).toBe(true);
    expect(confirmationAnswer(' Y ')).toBe(true);
  });

  it('rejects negative input', () => {
    expect(confirmationAnswer('n')).toBe(false);
    expect(confirmationAnswer('no')).toBe(false);
  });

  it('honors the default for an empty answer', () => {
    expect(confirmationAnswer('', true)).toBe(true);
    expect(confirmationAnswer('  ', false)).toBe(false);
  });
});
