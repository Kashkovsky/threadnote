export function normalizeSchemaDefinition(value: string): string {
  const quoted: string[] = [];
  let unquoted = '';
  for (let index = 0; index < value.length; index += 1) {
    const opener = value[index]!;
    const closer = opener === '[' ? ']' : opener;
    if (opener !== "'" && opener !== '"' && opener !== '`' && opener !== '[') {
      unquoted += opener;
      continue;
    }
    const start = index;
    for (index += 1; index < value.length; index += 1) {
      if (value[index] !== closer) continue;
      if (closer !== ']' && value[index + 1] === closer) {
        index += 1;
        continue;
      }
      break;
    }
    quoted.push(value.slice(start, Math.min(index + 1, value.length)));
    unquoted += `\u0000${quoted.length - 1}\u0000`;
  }
  return unquoted
    .toLowerCase()
    .replace(/\bif not exists\b/gu, '')
    .replace(/\s+/gu, ' ')
    .replace(/\s*([(),])\s*/gu, '$1')
    .trim()
    .split('\u0000')
    .map((segment, index) => (index % 2 === 1 ? (quoted[Number(segment)] ?? '') : segment))
    .join('');
}
