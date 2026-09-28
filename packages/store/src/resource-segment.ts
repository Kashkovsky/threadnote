export function uriSegment(value: string): string {
  const replaced = value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  let start = 0;
  while (replaced[start] === '-') start += 1;

  let end = replaced.length;
  while (end > start && replaced[end - 1] === '-') end -= 1;

  const normalized = replaced.slice(start, end);
  return normalized.length > 0 ? normalized : 'unknown';
}
