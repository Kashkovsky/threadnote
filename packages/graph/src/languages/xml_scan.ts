export interface XmlStartTag {
  readonly attributes: string;
  readonly end: number;
  readonly name: string;
  readonly offset: number;
}

export interface XmlAttribute {
  readonly name: string;
  readonly value: string;
}

export function* scanXmlStartTags(source: string): IterableIterator<XmlStartTag> {
  let cursor = 0;
  while (cursor < source.length) {
    const opening = source.indexOf('<', cursor);
    if (opening < 0) return;
    const closing = source.indexOf('>', opening + 1);
    if (closing < 0) return;
    const nestedOpening = source.indexOf('<', opening + 1);
    if (nestedOpening >= 0 && nestedOpening < closing) {
      cursor = nestedOpening;
      continue;
    }
    let nameEnd = opening + 1;
    if (!isXmlNameStart(source[nameEnd])) {
      cursor = closing + 1;
      continue;
    }
    nameEnd += 1;
    while (nameEnd < closing && isXmlNameCharacter(source[nameEnd])) nameEnd += 1;
    yield {
      attributes: source.slice(nameEnd, closing),
      end: closing + 1,
      name: source.slice(opening + 1, nameEnd),
      offset: opening,
    };
    cursor = closing + 1;
  }
}

export function* scanXmlAttributes(source: string): IterableIterator<XmlAttribute> {
  let cursor = 0;
  while (cursor < source.length) {
    while (cursor < source.length && isXmlWhitespace(source[cursor])) cursor += 1;
    if (source[cursor] === '/') return;
    if (!isXmlNameStart(source[cursor])) {
      cursor += 1;
      continue;
    }
    const nameStart = cursor;
    cursor += 1;
    while (cursor < source.length && isXmlNameCharacter(source[cursor])) cursor += 1;
    const name = source.slice(nameStart, cursor);
    while (cursor < source.length && isXmlWhitespace(source[cursor])) cursor += 1;
    if (source[cursor] !== '=') continue;
    cursor += 1;
    while (cursor < source.length && isXmlWhitespace(source[cursor])) cursor += 1;
    const quote = source[cursor];
    if (quote !== '"' && quote !== "'") continue;
    const valueStart = cursor + 1;
    const valueEnd = source.indexOf(quote, valueStart);
    if (valueEnd < 0) return;
    yield {name, value: source.slice(valueStart, valueEnd)};
    cursor = valueEnd + 1;
  }
}

function isXmlNameStart(value: string | undefined): boolean {
  if (!value) return false;
  const code = value.charCodeAt(0);
  return value === '_' || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isXmlNameCharacter(value: string | undefined): boolean {
  if (!value) return false;
  const code = value.charCodeAt(0);
  return isXmlNameStart(value) || value === '.' || value === ':' || value === '-' || (code >= 48 && code <= 57);
}

function isXmlWhitespace(value: string | undefined): boolean {
  return value === ' ' || value === '\t' || value === '\r' || value === '\n';
}
