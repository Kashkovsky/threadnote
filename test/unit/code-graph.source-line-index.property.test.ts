import {describe, expect, it} from '@effect/vitest';
import * as FC from 'effect/testing/FastCheck';
import {createSourceLineIndex, sourcePositionAt} from '../../src/code_graph/languages/source_line_index.js';

const sourceArbitrary = FC.array(
  FC.oneof(FC.string({maxLength: 12}), FC.constantFrom('\n', '\r', '\r\n', '\u2028', '\u2029', '🙂', '\u0000')),
  {maxLength: 48},
).map(parts => parts.join(''));

describe('code graph source line index properties', () => {
  it.prop(
    'matches the linear UTF-16 position reference for every newline form',
    {source: sourceArbitrary},
    ({source}) => {
      const index = createSourceLineIndex(source);
      for (let offset = 0; offset <= source.length; offset += 1) {
        expect(sourcePositionAt(index, offset)).toEqual(referencePosition(source, offset));
      }
    },
    {fastCheck: {numRuns: 500}},
  );
});

function referencePosition(content: string, offset: number): {readonly column: number; readonly line: number} {
  let column = 1;
  let cursor = 0;
  let line = 1;
  while (cursor < offset) {
    const width = lineTerminatorWidth(content, cursor);
    if (width > 0) {
      cursor += width;
      column = 1;
      line += 1;
    } else {
      cursor += 1;
      column += 1;
    }
  }
  return {column, line};
}

function lineTerminatorWidth(content: string, offset: number): number {
  const character = content[offset];
  if (character === '\r') return content[offset + 1] === '\n' ? 2 : 1;
  return character === '\n' || character === '\u2028' || character === '\u2029' ? 1 : 0;
}
