import {describe, expect, it} from 'vitest';
import {memoryCodeCitationContentSharingBlocker} from '../../src/memory_code_citation_policy.js';

describe('memory code-citation sharing policy', () => {
  it('fails closed on a citation header even when the containing memory cannot be parsed', () => {
    const uri = 'threadnote://user/tester/memories/durable/projects/threadnote/unparseable.md';

    expect(memoryCodeCitationContentSharingBlocker(uri, 'MEMORY\ncode_citation: {not-json}\n\nBody')).toBe(
      'malformed-citation',
    );
    expect(memoryCodeCitationContentSharingBlocker(uri, 'not a memory\ncode_citation: {not-json}\n\nBody')).toBe(
      'malformed-citation',
    );
    expect(memoryCodeCitationContentSharingBlocker(uri, 'not a memory\n  code_citation: {not-json}\n\nBody')).toBe(
      'malformed-citation',
    );
    expect(memoryCodeCitationContentSharingBlocker(uri, 'not a memory\r  code_citation: {not-json}\r\rBody')).toBe(
      'malformed-citation',
    );
    expect(memoryCodeCitationContentSharingBlocker(uri, 'not a memory\n\ncode_citation: body text')).toBeUndefined();
  });

  it.each(['\n', '\r\n', '\r'])('fails closed on near-canonical citation keys with %j line endings', newline => {
    const uri = 'threadnote://user/tester/memories/durable/projects/threadnote/near-canonical.md';
    for (const citationLine of ['code_citation : {not-json}', 'code_citation\t: {not-json}']) {
      const parseable = [
        'MEMORY',
        'kind: durable',
        'project: threadnote',
        'topic: near-canonical',
        'schema_version: 4',
        citationLine,
        '',
        'Body',
      ].join(newline);
      const unparseable = ['not a memory', citationLine, '', 'Body'].join(newline);

      expect(memoryCodeCitationContentSharingBlocker(uri, parseable)).toBe('malformed-citation');
      expect(memoryCodeCitationContentSharingBlocker(uri, unparseable)).toBe('malformed-citation');
    }
  });
});
