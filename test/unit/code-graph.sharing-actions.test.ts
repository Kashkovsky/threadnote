import {describe, expect, it} from 'vitest';
import * as FC from 'effect/testing/FastCheck';
import {
  graphShareLanguageAndRole,
  graphShareMaterializedActionKey,
  graphShareParseActionKey,
} from '../../src/code_graph/sharing/action.js';
import {
  GRAPH_SHARE_CAS_CANONICAL,
  GRAPH_SHARE_CAS_WORKER,
  graphShareActionDiscoveryTag,
  graphShareFrontierDiscoveryTag,
  isGraphShareCanonicalRegistry,
  isGraphShareWorkerRegistry,
} from '../../src/code_graph/sharing/namespace.js';

const HEX = '0123456789abcdef';

describe('graph share action keys and namespaces', () => {
  it('keeps worker and canonical CAS namespaces distinct', () => {
    expect(GRAPH_SHARE_CAS_CANONICAL).not.toBe(GRAPH_SHARE_CAS_WORKER);
    expect(isGraphShareCanonicalRegistry(GRAPH_SHARE_CAS_CANONICAL)).toBe(true);
    expect(isGraphShareWorkerRegistry(GRAPH_SHARE_CAS_WORKER)).toBe(true);
    expect(isGraphShareWorkerRegistry(GRAPH_SHARE_CAS_CANONICAL)).toBe(false);
    expect(graphShareActionDiscoveryTag('a'.repeat(64))).toBe(`tn-action-${'a'.repeat(64)}`);
    expect(graphShareFrontierDiscoveryTag('b'.repeat(64), 'refs/heads/main').startsWith('tn-frontier-')).toBe(true);
  });

  it('is deterministic and changes when any parse-action input changes', () => {
    FC.assert(
      FC.property(
        FC.tuple(
          hexString(64),
          hexString(64),
          FC.string({maxLength: 40, minLength: 1}),
          hexString(64),
          FC.constantFrom('typescript:source', 'json:manifest'),
        ),
        FC.integer({max: 4, min: 0}),
        (fields, index) => {
          const [repositoryId, extractorSet, normalizedPath, contentHash, languageAndRole] = fields;
          const input = {contentHash, extractorSet, languageAndRole, normalizedPath, repositoryId};
          expect(graphShareParseActionKey(input)).toBe(graphShareParseActionKey({...input}));
          const mutated = [...fields];
          mutated[index] = `${mutated[index]}x`;
          const [nextRepositoryId, nextExtractorSet, nextPath, nextHash, nextLanguage] = mutated;
          expect(
            graphShareParseActionKey({
              contentHash: nextHash,
              extractorSet: nextExtractorSet,
              languageAndRole: nextLanguage,
              normalizedPath: nextPath,
              repositoryId: nextRepositoryId,
            }),
          ).not.toBe(graphShareParseActionKey(input));
        },
      ),
      {numRuns: 40},
    );
  });

  it('separates parse keys from materialized keys', () => {
    const parseKey = graphShareParseActionKey({
      contentHash: 'c'.repeat(64),
      extractorSet: 'e'.repeat(64),
      languageAndRole: graphShareLanguageAndRole('typescript', 'source'),
      normalizedPath: 'src/index.ts',
      repositoryId: 'r'.repeat(64),
    });
    const materialized = graphShareMaterializedActionKey({
      contentHash: 'c'.repeat(64),
      graphAbi: 'a'.repeat(64),
      graphContentId: 'cgc_' + 'd'.repeat(40),
      normalizedPath: 'src/index.ts',
      parseResultDigest: 'p'.repeat(64),
      repositoryId: 'r'.repeat(64),
      workspaceFingerprint: 'w'.repeat(64),
    });
    expect(parseKey).toMatch(/^[0-9a-f]{64}$/u);
    expect(materialized).toMatch(/^[0-9a-f]{64}$/u);
    expect(parseKey).not.toBe(materialized);
  });
});

function hexString(length: number) {
  return FC.array(FC.constantFrom(...HEX), {maxLength: length, minLength: length}).map(characters =>
    characters.join(''),
  );
}
