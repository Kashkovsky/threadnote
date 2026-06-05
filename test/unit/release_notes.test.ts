import {describe, expect, it} from 'vitest';
import {formatWhatsNew, releasesBetween, type ReleaseNote} from '../../src/release_notes.js';

const releases: readonly ReleaseNote[] = [
  {
    body: '## Changes\n- Newer than requested.',
    title: 'future',
    version: '0.7.10',
  },
  {
    body: '## Changes\n- Fixed shared replacements.\n- Added docs.',
    title: 'one-step shared memory updates',
    version: '0.7.8',
  },
  {
    body: '## Changes\nPlain paragraph.\n* Star bullet.',
    title: 'formatted version output',
    version: '0.7.9',
  },
  {
    body: '- Old release.',
    title: 'old',
    version: '0.7.7',
  },
];

describe('releasesBetween', () => {
  it('returns newer releases up to latest in ascending order', () => {
    expect(releasesBetween(releases, '0.7.7', '0.7.9').map(release => release.version)).toEqual(['0.7.8', '0.7.9']);
  });
});

describe('formatWhatsNew', () => {
  it('formats release titles and normalized body lines', () => {
    expect(formatWhatsNew(releasesBetween(releases, '0.7.7', '0.7.9'))).toEqual([
      "What's new:",
      '0.7.8: one-step shared memory updates',
      '  - Fixed shared replacements.',
      '  - Added docs.',
      '0.7.9: formatted version output',
      '  Plain paragraph.',
      '  - Star bullet.',
    ]);
  });

  it('returns no lines when there are no releases to show', () => {
    expect(formatWhatsNew([])).toEqual([]);
  });
});
