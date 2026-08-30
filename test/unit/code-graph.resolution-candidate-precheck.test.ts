import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import {describe, expect} from 'vitest';
import {assessResolutionCandidateIncrementalClosure} from '../../src/code_graph/indexer_resolution_candidate_closure.js';
import {PROJECT_RESOLUTION_CANDIDATE_SCAN_MAX_FILES} from '../../src/code_graph/store_resolution_candidate_closure.js';
import type {CodeGraphInventoryFile} from '../../src/code_graph/types.js';

describe('resolution-candidate precheck', () => {
  effectIt.effect('rejects oversized inventories before requesting cache metadata', () =>
    Effect.gen(function* () {
      const files = Array.from({length: PROJECT_RESOLUTION_CANDIDATE_SCAN_MAX_FILES + 1}, (_, index) =>
        inventory(`src/oversized-${index}.ts`),
      );
      let storeAccesses = 0;
      const store = new Proxy(
        {},
        {
          get: () => {
            storeAccesses += 1;
            throw new Error('oversized precheck touched the graph store');
          },
        },
      );
      const result = yield* assessResolutionCandidateIncrementalClosure({
        baseFileSetFingerprint: 'base',
        baseFiles: files,
        candidateReexports: [],
        committedWorkspace: undefined as never,
        currentChangedFiles: [],
        currentFiles: files,
        currentWorkspace: undefined as never,
        initialLookupKeys: [{key: 'typescript:path:src%2Fvalue.ts:name:value', resolutionDomain: 'typescript'}],
        languagePacks: undefined as never,
        layout: undefined as never,
        projectCount: 1,
        store: store as never,
      });

      expect(result).toMatchObject({
        fallbackBoundary: {
          limit: PROJECT_RESOLUTION_CANDIDATE_SCAN_MAX_FILES,
          metric: 'candidate-scan-files',
          observedAtDecision: PROJECT_RESOLUTION_CANDIDATE_SCAN_MAX_FILES + 1,
        },
        mode: 'fallback',
        reason: 'project-closure-unbounded',
      });
      expect(storeAccesses).toBe(0);
    }),
  );
});

function inventory(path: string): CodeGraphInventoryFile {
  return {
    blobId: path,
    contentHash: path,
    language: 'typescript',
    mode: '100644',
    path,
    size: 1,
    source: 'worktree',
  };
}
