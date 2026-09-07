import {describe, expect, it} from 'vitest';
import * as FC from 'effect/testing/FastCheck';
import {formatMemoryDocument} from '../../src/memory/document.js';
import {classifyGitIngestDocument} from '../../src/remote_memory/git_ingest_document.js';

const path = {kind: 'durable' as const, project: 'threadnote', topic: 'contract'};
const header = 'MEMORY\nkind: durable\nproject: threadnote\ntopic: contract';

describe('Git ingestion metadata boundary', () => {
  it.each(['# MEMORY\nPlain Markdown.', 'A normal memory.', ''])('keeps plain Markdown active: %s', content => {
    expect(classifyGitIngestDocument(content, path)).toEqual({accepted: true, status: 'active'});
  });

  it.each([
    'status:',
    'status: invalid',
    'status: active\nstatus: active',
    'kind: durable',
    'project: other',
    'project:',
    'repo: threadnote',
    'topic: wrong',
    'topic:',
    'schema_version:',
    'schema_version: 0',
    'schema_version: 1.2',
    'schema_version: 999',
    'schema_version: 4\nschema_version: 4',
  ])('rejects ambiguous or unsupported critical metadata: %s', field => {
    expect(classifyGitIngestDocument(`${header}\n${field}\n\nSafe body.`, path)).toEqual({
      accepted: false,
      reason: 'metadata',
    });
  });

  it('supports omitted legacy status and the project alias', () => {
    expect(classifyGitIngestDocument(`${header.replace('project:', 'repo:')}\n\nSafe body.`, path)).toEqual({
      accepted: true,
      status: 'active',
    });
  });

  it('preserves lifecycle classification across supported kinds, statuses, and portable identities', () => {
    FC.assert(
      FC.property(
        FC.constantFrom('durable' as const, 'handoff' as const),
        FC.constantFrom('active' as const, 'archived' as const, 'expired' as const, 'superseded' as const),
        FC.stringMatching(/^[a-z][a-z0-9]{0,12}$/),
        FC.stringMatching(/^[a-z][a-z0-9]{0,12}$/),
        (kind, status, project, topic) => {
          const content = formatMemoryDocument(
            kind === 'durable' ? 'MEMORY' : 'HANDOFF',
            {
              kind,
              status,
              project,
              topic,
              schemaVersion: 4,
              sourceAgentClient: 'test',
              timestamp: '2026-09-07T00:00:00.000Z',
              keywords: ['preserved metadata'],
              references: ['https://example.com/contract'],
            },
            'Safe content.',
          );
          expect(classifyGitIngestDocument(content, {kind, project, topic})).toEqual({accepted: true, status});
        },
      ),
      {numRuns: 64},
    );
  });
});
