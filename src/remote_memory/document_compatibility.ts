import {assertMemoryDocumentSchemaWritable, formatMemoryDocument, parseMemoryDocument} from '../memory/document.js';
import {memoryCodeCitationSharingBlocker} from '../memory/code_citation_policy.js';
import {remoteMemoryError} from './errors.js';

export function assertRemoteBodyReplacementSupported(content: string): void {
  assertMemoryDocumentSchemaWritable(content);
  const normalized = content.trim().replace(/\r\n?/gu, '\n');
  if (/\n\n<!-- MEMORY_FIELDS\n[\s\S]*?\n-->\s*$/u.test(normalized)) unsupportedMetadata();
  const record = parseMemoryDocument('threadnote://share/compatibility/memories/durable/project/topic.md', content);
  if (!record) unsupportedMetadata();
  if (memoryCodeCitationSharingBlocker(record.metadata)) unsupportedMetadata();
  let formatted: string;
  try {
    formatted = formatMemoryDocument(record.headerTitle, record.metadata, '');
  } catch {
    unsupportedMetadata();
  }
  const remaining = new Map<string, number>();
  for (const line of formatted.split('\n\n', 1)[0].split('\n')) {
    remaining.set(line, (remaining.get(line) ?? 0) + 1);
  }
  // Tolerant readers may discard unknown or malformed fields; a rewrite must preserve every occurrence.
  for (const line of normalized.split('\n\n', 1)[0].split('\n')) {
    const count = remaining.get(line) ?? 0;
    if (count === 0) unsupportedMetadata();
    remaining.set(line, count - 1);
  }
}

function unsupportedMetadata(): never {
  throw remoteMemoryError(
    'invalid_request',
    'This document contains metadata the remote body editor cannot preserve. Repair it through the Git share before editing remotely.',
    {reason: 'unsupported_remote_metadata'},
  );
}
