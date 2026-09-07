import {MEMORY_SCHEMA_VERSION} from '../memory/code_citation.js';
import {parseMemoryDocument} from '../memory/document.js';
import {inspectRemoteMemoryContent} from '../memory_domain/content.js';
import type {GitCanonicalListedPath} from './git_canonical_store.js';

export type GitIngestStatus = 'active' | 'archived' | 'expired' | 'superseded';
export type GitIngestRejection = 'content_policy' | 'metadata' | 'unsupported_entry';
export type GitIngestDocument =
  | {readonly accepted: true; readonly status: GitIngestStatus}
  | {readonly accepted: false; readonly reason: GitIngestRejection};

const statuses = new Set<GitIngestStatus>(['active', 'archived', 'expired', 'superseded']);
const criticalFields = new Set(['kind', 'status', 'project', 'repo', 'topic', 'schema_version']);

export function classifyGitIngestDocument(
  content: string,
  path: Pick<GitCanonicalListedPath, 'kind' | 'project' | 'topic'>,
): GitIngestDocument {
  if (!inspectRemoteMemoryContent(content).allowed) return {accepted: false, reason: 'content_policy'};
  const header = content.trim().replace(/\r\n?/gu, '\n').split('\n\n', 1)[0];
  const lines = header.split('\n');
  const marker = lines[0]?.trim();
  if (marker !== 'MEMORY' && marker !== 'HANDOFF') return {accepted: true, status: 'active'};
  const fields = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const match = /^([a-z_]+):\s*(.*)$/u.exec(line.trim());
    if (!match) return {accepted: false, reason: 'metadata'};
    const [, key, value] = match;
    if (!criticalFields.has(key)) continue;
    if (fields.has(key) || !value.trim()) return {accepted: false, reason: 'metadata'};
    fields.set(key, value.trim());
  }
  const schema = fields.get('schema_version');
  const status = fields.get('status');
  if (
    (schema !== undefined && (!/^[1-9][0-9]*$/u.test(schema) || Number(schema) > MEMORY_SCHEMA_VERSION)) ||
    (status !== undefined && !statuses.has(status as GitIngestStatus)) ||
    (fields.has('project') && fields.has('repo')) ||
    (fields.has('kind') && fields.get('kind') !== path.kind) ||
    (fields.has('project') && fields.get('project') !== path.project) ||
    (fields.has('repo') && fields.get('repo') !== path.project) ||
    (fields.has('topic') && fields.get('topic') !== path.topic) ||
    marker !== (path.kind === 'handoff' ? 'HANDOFF' : 'MEMORY')
  )
    return {accepted: false, reason: 'metadata'};
  const parsed = parseMemoryDocument('threadnote://share/ingest/memories/durable/project/topic.md', content);
  if (!parsed || parsed.metadata.kind !== path.kind) return {accepted: false, reason: 'metadata'};
  return {accepted: true, status: (status ?? 'active') as GitIngestStatus};
}
