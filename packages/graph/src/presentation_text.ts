/** Replace terminal controls and bidi overrides while preserving code-point length. */
export function sanitizeCodeGraphPresentationText(value: string, maximumCharacters = Number.MAX_SAFE_INTEGER): string {
  const limit = Number.isFinite(maximumCharacters)
    ? Math.max(0, Math.floor(maximumCharacters))
    : Number.MAX_SAFE_INTEGER;
  let output = '';
  let length = 0;
  for (const character of value) {
    if (length >= limit) break;
    const codePoint = character.codePointAt(0) ?? 0;
    output +=
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
        ? ' '
        : character;
    length += 1;
  }
  return output;
}

/** Defensive projection for bounded public result objects assembled outside the analysis service. */
export function sanitizeCodeGraphPresentationValue<Value>(value: Value): Value {
  if (typeof value === 'string') return sanitizeCodeGraphPresentationText(value) as Value;
  if (Array.isArray(value)) return value.map(item => sanitizeCodeGraphPresentationValue(item)) as Value;
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, sanitizeCodeGraphPresentationValue(item)]),
  ) as Value;
}
