import {describe, expect, it} from 'vitest';
import {confirmationAnswer, selectionIndex} from '../../src/cli_ui.js';

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

describe('selectionIndex', () => {
  it('uses the highlighted default when Enter is pressed', () => {
    expect(selectionIndex('', 3, 1)).toBe(1);
  });

  it('maps one-based menu choices to zero-based indexes', () => {
    expect(selectionIndex(' 2 ', 3)).toBe(1);
  });

  it('rejects unavailable menu choices', () => {
    expect(selectionIndex('0', 3)).toBeUndefined();
    expect(selectionIndex('4', 3)).toBeUndefined();
    expect(selectionIndex('model', 3)).toBeUndefined();
  });
});
