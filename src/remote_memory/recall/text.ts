import {parseMemoryDocument} from '../../memory/document.js';

export function remoteMemoryExcerpt(content: string, query: string): string {
  const record = parseMemoryDocument('threadnote://share/excerpt/memories/durable/project/topic.md', content);
  const body = (record?.body ?? content).replace(/\s+/g, ' ').trim();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const lower = body.toLowerCase();
  const first =
    terms
      .map(term => lower.indexOf(term))
      .filter(index => index >= 0)
      .sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, first - 120);
  const excerpt = body.slice(start, start + 600);
  return `${start > 0 ? '…' : ''}${excerpt}${start + 600 < body.length ? '…' : ''}`;
}

export function remoteRecallTextMatches(content: string, query: string): boolean {
  const haystack = content.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every(term => haystack.includes(term));
}
