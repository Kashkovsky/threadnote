import {describe, expect, it} from '@effect/vitest';
import {Effect, Exit} from 'effect';
import * as FC from 'effect/testing/FastCheck';
import {serializeBoundedCodeGraphFact} from '../../src/code_graph/fact_budget.js';
import type {CodeGraphFileFacts, CodeGraphInventoryFile} from '../../src/code_graph/types.js';
import {graphShareParseActionKey} from '../../src/code_graph/sharing/action.js';
import {sha256Digest} from '../../src/code_graph/sharing/digest.js';
import {graphShareParseResultArtifact} from '../../src/code_graph/sharing/parse_result.js';
import {makeGraphShareSourceVerification} from '../../src/code_graph/sharing/source_verification.js';

const repositoryId = 'a'.repeat(64),
  sourceCommit = 'b'.repeat(40),
  extractorSet = 'c'.repeat(64);
function fixture(path: string, diagnostics: readonly string[] = []) {
  const file: CodeGraphInventoryFile = {
    path,
    blobId: 'd'.repeat(40),
    contentHash: 'e'.repeat(64),
    language: 'typescript',
    mode: '100644',
    source: 'commit',
    size: 20,
  };
  const facts: CodeGraphFileFacts = {path, symbols: [], edges: [], diagnostics};
  const parsed = graphShareParseResultArtifact({
    repositoryId,
    normalizedPath: path,
    gitBlobId: file.blobId,
    contentHash: file.contentHash,
    extractorSet,
    languageAndRole: 'typescript:source',
    facts,
    actionKey: graphShareParseActionKey({
      repositoryId,
      normalizedPath: path,
      contentHash: file.contentHash,
      extractorSet,
      languageAndRole: 'typescript:source',
    }),
  });
  const item = {
    parsed,
    announcement: {
      actionKey: parsed.actionKey,
      batchId: sourceCommit,
      semanticDigest: parsed.semanticDigest,
      resultManifestDigest: sha256Digest(JSON.stringify(parsed)),
      attestationDigest: sha256Digest('attestation'),
    },
  };
  return {
    file,
    facts,
    item,
    group: {cacheIdentity: extractorSet, facts: [serializeBoundedCodeGraphFact(facts)], files: [file]},
  };
}

describe('source-verified original contribution assembly', () => {
  it.effect.prop(
    'is order-independent and duplicate-idempotent without mutating source facts',
    {
      values: FC.array(FC.string({maxLength: 24}), {minLength: 1, maxLength: 12}),
    },
    ({values}) =>
      Effect.gen(function* () {
        const rows = values.map((value, i) => fixture(`src/file-${i}.ts`, [value]));
        const selected = rows.filter((_, i) => i % 2 === 0);
        const before = JSON.stringify(rows);
        const make = () =>
          makeGraphShareSourceVerification({repositoryId, sourceCommit, verified: selected.map(row => row.item)});
        const left = make(),
          right = make();
        for (const row of rows) yield* left.hooks.observeParserBatch(row.group);
        for (const row of [...rows].reverse()) yield* right.hooks.observeParserBatch(row.group);
        for (const proof of [left, right]) {
          for (const row of rows) {
            const batch = {facts: new Map([[row.file.path, row.facts]]), files: [row.file]};
            const first = yield* proof.hooks.materializeFacts(batch);
            yield* proof.hooks.materializeFacts(batch);
            expect(first.get(row.file.path)).toEqual(row.facts);
            if (selected.includes(row)) expect(first.get(row.file.path)).not.toBe(row.facts);
            else expect(first.get(row.file.path)).toBe(row.facts);
          }
        }
        const evidence = yield* left.complete();
        expect(evidence).toEqual(yield* right.complete());
        expect(evidence.consumedActions).toBe(selected.length);
        expect(evidence.sourceVerifiedFiles).toBe(rows.length);
        expect(evidence.consumedResultManifestDigests).toEqual(
          selected.map(row => row.item.announcement.resultManifestDigest).sort(),
        );
        expect(JSON.stringify(rows)).toBe(before);
      }),
    {fastCheck: {numRuns: 30}},
  );

  for (const changed of ['facts', 'blob', 'extractor', 'commit', 'path', 'language'] as const) {
    it.effect(`rejects mismatched ${changed} despite prior receipt integrity checks`, () =>
      Effect.gen(function* () {
        const row = fixture('src/a.ts');
        const item = {
          ...row.item,
          announcement: {...row.item.announcement, ...(changed === 'commit' ? {batchId: 'f'.repeat(40)} : {})},
          parsed: {
            ...row.item.parsed,
            ...(changed === 'facts' ? {facts: {...row.facts, diagnostics: ['forged']}} : {}),
            ...(changed === 'blob' ? {gitBlobId: 'f'.repeat(40)} : {}),
            ...(changed === 'extractor' ? {extractorSet: 'f'.repeat(64)} : {}),
            ...(changed === 'path' ? {normalizedPath: 'src/missing.ts'} : {}),
            ...(changed === 'language' ? {languageAndRole: 'javascript:source'} : {}),
          },
        };
        const proof = makeGraphShareSourceVerification({repositoryId, sourceCommit, verified: [item]});
        const result = yield* Effect.exit(
          Effect.gen(function* () {
            yield* proof.hooks.observeParserBatch(row.group);
            yield* proof.hooks.materializeFacts({facts: new Map([[row.file.path, row.facts]]), files: [row.file]});
            yield* proof.complete();
          }),
        );
        expect(Exit.isFailure(result)).toBe(true);
      }),
    );
  }

  it.effect('rejects stale, poisoned, or unobserved cache inputs and incomplete attempts', () =>
    Effect.gen(function* () {
      const row = fixture('src/a.ts');
      const proof = makeGraphShareSourceVerification({repositoryId, sourceCommit, verified: [row.item]});
      const batch = {facts: new Map([[row.file.path, row.facts]]), files: [row.file]};
      expect(Exit.isFailure(yield* Effect.exit(proof.hooks.materializeFacts(batch)))).toBe(true);
      yield* proof.hooks.observeParserBatch(row.group);
      expect(Exit.isFailure(yield* Effect.exit(proof.complete()))).toBe(true);
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            proof.hooks.materializeFacts({
              ...batch,
              facts: new Map([[row.file.path, {...row.facts, diagnostics: ['poison']}]]),
            }),
          ),
        ),
      ).toBe(true);
      const retry = makeGraphShareSourceVerification({repositoryId, sourceCommit, verified: [row.item]});
      expect(Exit.isFailure(yield* Effect.exit(retry.hooks.materializeFacts(batch)))).toBe(true);
      yield* proof.hooks.materializeFacts(batch);
      expect((yield* proof.complete()).consumedActions).toBe(1);
    }),
  );
});
