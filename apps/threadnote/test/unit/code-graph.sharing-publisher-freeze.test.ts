import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer} from 'effect';
import * as FC from 'fast-check';
import * as BunServices from '@effect/platform-bun/BunServices';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {graphShareLanguageAndRole, graphShareParseActionKey} from '@threadnote/graph/sharing/action';
import {putCasBytes} from '@threadnote/graph/sharing/cas';
import {sha256Digest} from '@threadnote/graph/sharing/digest';
import {
  graphShareParseResultArtifact,
  graphShareParseResultSemanticDigest,
} from '@threadnote/graph/sharing/parse/result';
import {verifyGraphShareParseReceipt} from '@threadnote/graph/sharing/parse/cache';

const sharingLayer = Layer.mergeAll(BunServices.layer, TestSystemInfoLayer);

describe('graph share publisher freeze verification', () => {
  effectIt.effect('accepts a matching receipt and rejects a semantic-digest mismatch', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const casRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-share-verify-'});
      const repositoryId = 'b'.repeat(64);
      const extractorSet = 'c'.repeat(64);
      const contentHash = 'd'.repeat(64);
      const normalizedPath = 'src/index.ts';
      const languageAndRole = graphShareLanguageAndRole('typescript', 'source');
      const actionKey = graphShareParseActionKey({
        contentHash,
        extractorSet,
        languageAndRole,
        normalizedPath,
        repositoryId,
      });
      const parsed = graphShareParseResultArtifact({
        actionKey,
        contentHash,
        extractorSet,
        facts: {diagnostics: [], edges: [], path: normalizedPath, symbols: []},
        gitBlobId: 'e'.repeat(40),
        languageAndRole,
        normalizedPath,
        repositoryId,
      });
      const resultManifestDigest = yield* putCasBytes(casRoot, new TextEncoder().encode(canonicalJson(parsed)));
      const attestationDigest = yield* putCasBytes(
        casRoot,
        new TextEncoder().encode(
          canonicalJson({kind: 'contributor-self', payloadDigest: resultManifestDigest, schemaVersion: 1}),
        ),
      );
      const announcement = {
        actionKey,
        attestationDigest,
        batchId: 'f'.repeat(40),
        resultManifestDigest,
        semanticDigest: parsed.semanticDigest,
      };
      const verified = yield* verifyGraphShareParseReceipt({
        announcement,
        casRoot,
        graphAbi: 'a'.repeat(64),
        repositoryId,
      });
      expect(verified.parsed.semanticDigest).toBe(parsed.semanticDigest);
      const mismatched = yield* verifyGraphShareParseReceipt({
        announcement: {...announcement, semanticDigest: sha256Digest('other')},
        casRoot,
        graphAbi: 'a'.repeat(64),
        repositoryId,
      }).pipe(Effect.option);
      expect(mismatched._tag).toBe('None');
    }).pipe(provideTestLayer(sharingLayer)),
  );

  fcEffectProp(
    effectIt,
    'hydrated parse semantic digest equals an independent local re-parse',
    {
      pathChars: FC.array(FC.constantFrom(...'abcdefghijklmnopqrstuvwxyz'), {maxLength: 8, minLength: 1}),
    },
    ({pathChars}) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const casRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-share-digest-'});
        const normalizedPath = `src/${pathChars.join('')}.ts`;
        const repositoryId = 'b'.repeat(64);
        const extractorSet = 'c'.repeat(64);
        const contentHash = 'd'.repeat(64);
        const languageAndRole = graphShareLanguageAndRole('typescript', 'source');
        const facts = {diagnostics: [], edges: [], path: normalizedPath, symbols: []};
        const actionKey = graphShareParseActionKey({
          contentHash,
          extractorSet,
          languageAndRole,
          normalizedPath,
          repositoryId,
        });
        const parsed = graphShareParseResultArtifact({
          actionKey,
          contentHash,
          extractorSet,
          facts,
          gitBlobId: 'e'.repeat(40),
          languageAndRole,
          normalizedPath,
          repositoryId,
        });
        const recomputed = graphShareParseResultArtifact({
          actionKey,
          contentHash,
          extractorSet,
          facts,
          gitBlobId: 'e'.repeat(40),
          languageAndRole,
          normalizedPath,
          repositoryId,
        });
        expect(parsed.semanticDigest).toBe(graphShareParseResultSemanticDigest(facts));
        expect(recomputed.semanticDigest).toBe(parsed.semanticDigest);
        const resultManifestDigest = yield* putCasBytes(casRoot, new TextEncoder().encode(canonicalJson(parsed)));
        const attestationDigest = yield* putCasBytes(
          casRoot,
          new TextEncoder().encode(
            canonicalJson({kind: 'contributor-self', payloadDigest: resultManifestDigest, schemaVersion: 1}),
          ),
        );
        const verified = yield* verifyGraphShareParseReceipt({
          announcement: {
            actionKey,
            attestationDigest,
            batchId: 'f'.repeat(40),
            resultManifestDigest,
            semanticDigest: parsed.semanticDigest,
          },
          casRoot,
          repositoryId,
        });
        expect(verified.parsed.semanticDigest).toBe(recomputed.semanticDigest);
      }).pipe(provideTestLayer(sharingLayer)),
    {fastCheck: {numRuns: 15}},
  );
});
