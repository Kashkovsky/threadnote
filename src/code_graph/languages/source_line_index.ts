import type {CodeGraphSpan} from '../types.js';

export interface SourceLineIndex {
  readonly contentLength: number;
  readonly crlfMidpoints: ReadonlySet<number>;
  readonly lineStarts: readonly number[];
}

/**
 * Builds a compact, reusable offset index once per source file. Positions use
 * JavaScript UTF-16 code units, matching TypeScript and the graph span schema.
 */
export function createSourceLineIndex(content: string): SourceLineIndex {
  const crlfMidpoints = new Set<number>();
  const lineStarts = [0];
  let cursor = 0;
  while (cursor < content.length) {
    const character = content[cursor];
    if (character === '\r') {
      if (content[cursor + 1] === '\n') {
        crlfMidpoints.add(cursor + 1);
        cursor += 2;
      } else {
        cursor += 1;
      }
      lineStarts.push(cursor);
      continue;
    }
    if (character === '\n' || character === '\u2028' || character === '\u2029') {
      cursor += 1;
      lineStarts.push(cursor);
      continue;
    }
    cursor += 1;
  }
  return {contentLength: content.length, crlfMidpoints, lineStarts};
}

export function sourcePositionAt(
  index: SourceLineIndex,
  offset: number,
): {readonly column: number; readonly line: number} {
  const boundedOffset = Math.max(0, Math.min(index.contentLength, offset));
  let lower = 0;
  let upper = index.lineStarts.length;
  while (lower < upper) {
    const middle = lower + ((upper - lower) >> 1);
    if (index.lineStarts[middle] <= boundedOffset) lower = middle + 1;
    else upper = middle;
  }
  const lineIndex = Math.max(0, lower - 1);
  if (index.crlfMidpoints.has(boundedOffset)) return {column: 1, line: lineIndex + 2};
  return {column: boundedOffset - index.lineStarts[lineIndex] + 1, line: lineIndex + 1};
}

export function sourceSpan(index: SourceLineIndex, start: number, end: number): CodeGraphSpan {
  const boundedStart = Math.max(0, Math.min(index.contentLength, start));
  const boundedEnd = Math.max(boundedStart, Math.min(index.contentLength, end));
  const from = sourcePositionAt(index, boundedStart);
  const to = sourcePositionAt(index, boundedEnd);
  return {
    column: from.column,
    endColumn: to.column,
    endLine: to.line,
    line: from.line,
  };
}
