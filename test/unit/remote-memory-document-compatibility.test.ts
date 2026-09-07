import {describe, expect, it} from 'vitest';
import * as FC from 'effect/testing/FastCheck';
import {assertRemoteBodyReplacementSupported} from '../../src/remote_memory/document_compatibility.js';

describe('remote body replacement compatibility', () => {
  it('rejects unknown header fields without consuming or rewriting them', () => {
    FC.assert(
      FC.property(
        FC.stringMatching(/^[a-z]{1,24}$/u),
        FC.string({maxLength: 40}).filter(value => !/[\r\n]/u.test(value)),
        (key, value) => {
          const document = `MEMORY\nkind: durable\nx_${key}: ${value}\n\nOriginal body`;
          expect(() => assertRemoteBodyReplacementSupported(document)).toThrow('metadata');
        },
      ),
      {numRuns: 100},
    );
  });

  it('supports basic remote documents and rejects rich or malformed local ones', () => {
    expect(() =>
      assertRemoteBodyReplacementSupported('MEMORY\nkind: durable\n\nThe documentation mentions `<!-- MEMORY_FIELDS`.'),
    ).not.toThrow();
    expect(() =>
      assertRemoteBodyReplacementSupported('MEMORY\nkind: durable\nstatus: active\nmemory_id: tn_123\n\nBody'),
    ).not.toThrow();
    for (const field of [
      'code_citation: invalid',
      'relation: references threadnote://memory/tn_123',
      'keywords: important',
      'trust: approved',
      'workspace_scope: src',
      'this header is malformed',
    ]) {
      expect(() => assertRemoteBodyReplacementSupported(`MEMORY\nkind: durable\n${field}\n\nBody`)).toThrow();
    }
    expect(() => assertRemoteBodyReplacementSupported('Plain Git document')).toThrow();
    expect(() =>
      assertRemoteBodyReplacementSupported(
        'MEMORY\nkind: durable\n\nBody\n\n<!-- MEMORY_FIELDS\nreferences: legacy\n-->',
      ),
    ).toThrow();
  });
});
