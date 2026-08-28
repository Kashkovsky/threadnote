import {BunFileSystem, BunPath} from '@effect/platform-bun';
import {it as effectIt} from '@effect/vitest';
import {Effect, Layer} from 'effect';
import {describe, expect} from 'vitest';
import {sha256HexSync} from '../../src/crypto/sha256.js';
import {withCodeGraphCheckpointAuthorityVerification} from '../../src/code_graph/checkpoint/authority.js';
import {codeGraphCheckpointFileFactCacheIdentity} from '../../src/code_graph/checkpoint/file_fact_identity.js';
import {encodeCodeGraphCheckpointPackV1} from '../../src/code_graph/checkpoint/pack.js';
import {
  CODE_GRAPH_CHECKPOINT_PATH_POLICY,
  CODE_GRAPH_CHECKPOINT_SEMANTIC_VERSION,
  type CodeGraphCheckpointFileFactRecordV1,
  type CodeGraphCheckpointFileRecordV1,
  type CodeGraphCheckpointMetadataV1,
} from '../../src/code_graph/checkpoint/schema.js';
import {
  codeGraphContentIdentity,
  codeGraphExtractorSetIdentityFromPackProvenance,
} from '../../src/code_graph/graph_identity.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const authorityLayer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

describe('code graph checkpoint authority', () => {
  effectIt.effect('orders the private SQLite spool canonically across its Unicode keyset boundary', () =>
    Effect.gen(function* () {
      const paths = [
        ...Array.from({length: 999}, (_, index) => `src/a${index.toString().padStart(4, '0')}.ts`),
        'src/\ue000.ts',
        'src/\u{10000}.ts',
      ];
      const files = paths.map(fileRecord);
      const records = files.flatMap(file => [file, factRecord(file.path)]);

      expect(
        yield* withCodeGraphCheckpointAuthorityVerification(headerFor(files), accept =>
          accept([...records].reverse()).pipe(Effect.as(records.length)),
        ),
      ).toBe(2_002);

      expect(
        yield* withCodeGraphCheckpointAuthorityVerification(headerFor([]), accept =>
          accept([]).pipe(Effect.as('empty')),
        ),
      ).toBe('empty');
    }).pipe(provideTestLayer(authorityLayer)),
  );
});

function headerFor(records: readonly CodeGraphCheckpointFileRecordV1[]) {
  const extractorSet = codeGraphExtractorSetIdentityFromPackProvenance([]);
  const metadata: CodeGraphCheckpointMetadataV1 = {
    abi: {
      checkpointSemanticVersion: CODE_GRAPH_CHECKPOINT_SEMANTIC_VERSION,
      graphSchemaVersion: 1,
      inventoryPolicyVersion: 1,
      languagePacks: [],
      lexicalLogicalFormatVersion: 1,
      pathPolicy: CODE_GRAPH_CHECKPOINT_PATH_POLICY,
      referenceResolutionVersion: 'resolution-v1',
      workspaceModelVersion: 'workspace-v1',
    },
    coverage: {eligibleFiles: records.length, excludedFiles: 0, reasons: [], state: 'complete'},
    repository: {
      caseMode: 'sensitive',
      displayName: 'authority-ordering-fixture',
      objectFormat: 'sha1',
      repositoryId: '0'.repeat(64),
    },
    source: {
      commit: '0'.repeat(40),
      extractorSet,
      graphContentId: codeGraphContentIdentity(extractorSet, records),
    },
  };
  return encodeCodeGraphCheckpointPackV1(
    metadata,
    records.flatMap(record => [record, factRecord(record.path)]),
  ).header;
}

function fileRecord(path: string): CodeGraphCheckpointFileRecordV1 {
  const contentHash = sha256HexSync(path);
  return {
    blobId: contentHash.slice(0, 40),
    contentHash,
    kind: 'file',
    language: 'typescript',
    mode: '100644',
    path,
    size: 0,
    source: 'commit',
  };
}

function factRecord(path: string): CodeGraphCheckpointFileFactRecordV1 {
  const facts = {diagnostics: [], edges: [], path, symbols: []};
  return {
    cacheIdentity: codeGraphCheckpointFileFactCacheIdentity(facts),
    factRole: 'materialized',
    facts,
    kind: 'file-fact',
    path,
  };
}
