import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  compileThreadnoteIgnore,
  isIgnoredByThreadnote,
  isOverlayAdmissionControlPath,
  THREADNOTE_IGNORE_FILE,
  THREADNOTE_IGNORE_LOCAL_FILE,
} from '../../src/code_graph/threadnote_ignore.js';

describe('threadnote ignore union', () => {
  it('ignores A-only, B-only, both, and neither independently', () => {
    const committed = 'src/a.ts\n';
    const local = 'src/b.ts\n';
    expect(isIgnoredByThreadnote('src/a.ts', compileThreadnoteIgnore(committed, ''))).toBe(true);
    expect(isIgnoredByThreadnote('src/b.ts', compileThreadnoteIgnore(committed, ''))).toBe(false);
    expect(isIgnoredByThreadnote('src/a.ts', compileThreadnoteIgnore('', local))).toBe(false);
    expect(isIgnoredByThreadnote('src/b.ts', compileThreadnoteIgnore('', local))).toBe(true);
    expect(isIgnoredByThreadnote('src/a.ts', compileThreadnoteIgnore(committed, local))).toBe(true);
    expect(isIgnoredByThreadnote('src/b.ts', compileThreadnoteIgnore(committed, local))).toBe(true);
    expect(isIgnoredByThreadnote('src/c.ts', compileThreadnoteIgnore(committed, local))).toBe(false);
  });

  it('does not let a local negation un-ignore a committed ignore', () => {
    expect(isIgnoredByThreadnote('src/a.ts', compileThreadnoteIgnore('src/a.ts\n', '!src/a.ts\n'))).toBe(true);
  });

  it('treats both ignore files as overlay admission controls', () => {
    expect(isOverlayAdmissionControlPath(THREADNOTE_IGNORE_FILE)).toBe(true);
    expect(isOverlayAdmissionControlPath(THREADNOTE_IGNORE_LOCAL_FILE)).toBe(true);
    expect(isOverlayAdmissionControlPath('.gitignore')).toBe(true);
  });

  effectIt.effect.prop(
    'union ignore matches committed or local independently',
    {
      committed: fc.constantFrom('', 'src/a.ts', 'tmp/', 'vendor/**', '!src/c.ts'),
      local: fc.constantFrom('', 'src/b.ts', 'tmp/', 'scratch.ts', '!src/a.ts'),
      path: fc.constantFrom('src/a.ts', 'src/b.ts', 'src/c.ts', 'tmp/x.ts', 'vendor/lib.ts', 'scratch.ts'),
    },
    ({committed, local, path}) =>
      Effect.sync(() => {
        expect(isIgnoredByThreadnote(path, compileThreadnoteIgnore(committed, local))).toBe(
          isIgnoredByThreadnote(path, compileThreadnoteIgnore(committed, '')) ||
            isIgnoredByThreadnote(path, compileThreadnoteIgnore('', local)),
        );
      }),
    {fastCheck: {numRuns: 40}},
  );
});
