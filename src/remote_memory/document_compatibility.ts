import {assertMemoryDocumentSchemaWritable, parseMemoryDocument} from '../memory/document.js';
import {remoteMemoryError} from './errors.js';

const BODY_REPLACEMENT_FIELDS = new Set([
  'kind',
  'status',
  'project',
  'topic',
  'source_agent_client',
  'timestamp',
  'schema_version',
  'memory_id',
  'created_at',
  'updated_at',
  'visibility',
]);

export function assertRemoteBodyReplacementSupported(content: string): void {
  assertMemoryDocumentSchemaWritable(content);
  const normalized = content.trim().replace(/\r\n?/gu, '\n');
  const header = normalized.split('\n\n', 1)[0];
  const fields = header.split('\n').slice(1);
  const seen = new Set<string>();
  const unsupported = fields.some(line => {
    const key = /^([a-z_]+):/u.exec(line)?.[1];
    if (!key || !BODY_REPLACEMENT_FIELDS.has(key) || seen.has(key)) return true;
    seen.add(key);
    return false;
  });
  if (
    unsupported ||
    /\n\n<!-- MEMORY_FIELDS\n[\s\S]*?\n-->\s*$/u.test(normalized) ||
    !parseMemoryDocument('threadnote://share/compatibility/memories/durable/project/topic.md', content)
  ) {
    throw remoteMemoryError(
      'invalid_request',
      'This document contains metadata the remote body editor cannot preserve. Edit it through the Git share until rich metadata editing is supported.',
      {reason: 'unsupported_remote_metadata'},
    );
  }
}
