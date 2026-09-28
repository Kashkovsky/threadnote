/** Remove a URI fragment without scanning the remainder with a regular expression. */
export function stripFragment(value: string): string {
  const fragment = value.indexOf('#');
  return fragment < 0 ? value : value.slice(0, fragment);
}

/** Trim only the listed ASCII boundary characters. */
export function trimLeadingCharacters(value: string, characters: string): string {
  let start = 0;
  while (start < value.length && characters.includes(value[start])) start += 1;
  return start === 0 ? value : value.slice(start);
}

/** Trim only the listed ASCII boundary characters. */
export function trimTrailingCharacters(value: string, characters: string): string {
  let end = value.length;
  while (end > 0 && characters.includes(value[end - 1])) end -= 1;
  return end === value.length ? value : value.slice(0, end);
}

/** Trim the listed ASCII characters from both boundaries. */
export function trimBoundaryCharacters(value: string, characters: string): string {
  return trimTrailingCharacters(trimLeadingCharacters(value, characters), characters);
}

export interface MarkdownHeadingLine {
  readonly level: number;
  readonly title: string;
}

export interface TextLineSpan {
  readonly end: number;
  readonly start: number;
  readonly text: string;
}

export function* textLines(value: string): IterableIterator<TextLineSpan> {
  let start = 0;
  while (start <= value.length) {
    const newline = value.indexOf('\n', start);
    const end = newline < 0 ? value.length : newline;
    yield {end, start, text: value.slice(start, end).replaceAll('\r', '')};
    if (newline < 0) return;
    start = newline + 1;
  }
}

/** Parse one ATX heading line with bounded, linear boundary scans. */
export function parseMarkdownHeadingLine(value: string, maximumLeadingSpaces = 0): MarkdownHeadingLine | undefined {
  let cursor = 0;
  while (cursor < value.length && cursor < maximumLeadingSpaces && value[cursor] === ' ') cursor += 1;
  if (value[cursor] !== '#') return undefined;
  const hashesStart = cursor;
  while (cursor < value.length && value[cursor] === '#' && cursor - hashesStart < 7) cursor += 1;
  const level = cursor - hashesStart;
  if (level < 1 || level > 6 || (value[cursor] !== ' ' && value[cursor] !== '\t')) return undefined;
  while (value[cursor] === ' ' || value[cursor] === '\t') cursor += 1;
  let title = value.slice(cursor).trim();
  if (!title) return undefined;
  let end = title.length;
  while (end > 0 && (title[end - 1] === ' ' || title[end - 1] === '\t')) end -= 1;
  let hashes = end;
  while (hashes > 0 && title[hashes - 1] === '#') hashes -= 1;
  if (hashes < end && hashes > 0 && (title[hashes - 1] === ' ' || title[hashes - 1] === '\t')) {
    let titleEnd = hashes;
    while (titleEnd > 0 && (title[titleEnd - 1] === ' ' || title[titleEnd - 1] === '\t')) titleEnd -= 1;
    title = title.slice(0, titleEnd);
  }
  return title ? {level, title} : undefined;
}
