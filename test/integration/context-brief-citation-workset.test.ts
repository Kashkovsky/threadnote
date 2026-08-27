import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {
  codeGraphWorksetRuntimeConfig,
  indexPreparedCodeGraphWorksetFixture,
  publishIndexedCodeGraphWorksetCatalog,
} from '../../scripts/support/code-graph-workset-harness.js';
import {
  prepareCodeGraphWorksetFixture,
  removePreparedCodeGraphWorksetFixture,
} from '../../scripts/support/code-graph-workset-fixture.js';
import {CodeGraphStore} from '../../src/code_graph/store.js';
import type {CodeGraphStoreShape} from '../../src/code_graph/store_shape.js';
import {validateContextBriefMemoryCitations} from '../../src/context_brief/citation_validation.js';
import {runCommandEffect} from '../../src/effect/command.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {captureMemoryCodeCitations} from '../../src/memory_code_citation_capture.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {TestError} from '../helpers/test-error.js';

describe('Context Brief published Workset citation validation', () => {
  effectIt.effect(
    'preserves policy-excluded changes and balances the lease when a HEAD race turns evidence stale',
    () =>
      Effect.acquireUseRelease(
        Effect.tryPromise({
          try: () => prepareCodeGraphWorksetFixture({size: 1, stateProfile: 'all-clean'}),
          catch: cause => new TestError('Could not prepare the citation Workset fixture.', {cause}),
        }),
        fixture =>
          Effect.gen(function* () {
            const repository = fixture.repositories[0];
            if (repository === undefined)
              return yield* Effect.fail(new TestError('Citation Workset fixture has no repository.'));
            const config = codeGraphWorksetRuntimeConfig(fixture);
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const excludedPath = path.join(repository.path, 'assets', 'logo.svg');
            yield* fs.makeDirectory(path.dirname(excludedPath), {recursive: true});
            yield* fs.writeFileString(excludedPath, '<svg/>\n');
            yield* git(repository.path, ['add', 'assets/logo.svg']);
            yield* git(repository.path, [
              '-c',
              'user.name=Threadnote Test',
              '-c',
              'user.email=test@threadnote.local',
              'commit',
              '-qm',
              'add excluded fixture',
            ]);
            yield* indexPreparedCodeGraphWorksetFixture(fixture);
            yield* publishIndexedCodeGraphWorksetCatalog(fixture, [fixture.identity.worksetName]);
            const citations = yield* captureMemoryCodeCitations(config, {
              callerCwd: repository.path,
              refs: ['src/session.ts'],
            });
            expect(citations).toHaveLength(1);
            expect(citations[0]?.target.kind).toBe('file');

            const candidate = {
              citationErrorCount: 0,
              codeCitations: citations,
              excerpt: 'The session resolver owns the published contract.',
              kind: 'durable' as const,
              project: repository.projectName,
              rank: 0,
              topic: 'session-resolver',
              uri: 'threadnote://user/test/memories/durable/projects/workset/session-resolver.md',
            };
            const baseStore = yield* CodeGraphStore;
            let acquired = 0;
            let evidenceReads = 0;
            let released = 0;
            let sessions = 0;
            const countedStore = CodeGraphStore.of({
              ...baseStore,
              acquireSnapshotLease: (...args: Parameters<CodeGraphStoreShape['acquireSnapshotLease']>) =>
                Effect.sync(() => void ++acquired).pipe(Effect.andThen(baseStore.acquireSnapshotLease(...args))),
              effectiveSnapshotCitationEvidence: (
                ...args: Parameters<CodeGraphStoreShape['effectiveSnapshotCitationEvidence']>
              ) =>
                Effect.sync(() => void ++evidenceReads).pipe(
                  Effect.andThen(baseStore.effectiveSnapshotCitationEvidence(...args)),
                ),
              releaseSnapshotLease: (...args: Parameters<CodeGraphStoreShape['releaseSnapshotLease']>) =>
                baseStore.releaseSnapshotLease(...args).pipe(Effect.tap(() => Effect.sync(() => void ++released))),
              withSession: (...args: Parameters<CodeGraphStoreShape['withSession']>) => {
                expect(args[2]).toMatchObject({existingOnly: true});
                return Effect.sync(() => void ++sessions).pipe(Effect.andThen(baseStore.withSession(...args)));
              },
            } as CodeGraphStoreShape);
            const validate = () =>
              validateContextBriefMemoryCitations(config, {kind: 'workset', name: fixture.identity.worksetName}, [
                candidate,
              ]).pipe(Effect.provideService(CodeGraphStore, countedStore));

            const exact = yield* validate();
            expect(exact[0]?.receipts).toMatchObject([{reason: 'exact', status: 'exact'}]);
            expect({acquired, evidenceReads, released, sessions}).toEqual({
              acquired: 1,
              evidenceReads: 1,
              released: 1,
              sessions: 1,
            });

            yield* fs.writeFileString(excludedPath, '<svg>excluded change</svg>\n');
            const policyClean = yield* validate();
            expect(policyClean[0]?.receipts).toMatchObject([{reason: 'exact', status: 'exact'}]);
            expect({acquired, evidenceReads, released, sessions}).toEqual({
              acquired: 2,
              evidenceReads: 1,
              released: 2,
              sessions: 2,
            });

            yield* fs.writeFileString(excludedPath, '<svg/>\n');
            yield* git(repository.path, [
              '-c',
              'user.name=Threadnote Test',
              '-c',
              'user.email=test@threadnote.local',
              'commit',
              '--allow-empty',
              '-qm',
              'move published head',
            ]);

            const stale = yield* validate();
            expect(stale[0]?.receipts).toMatchObject([{reason: 'graph-stale', status: 'unknown'}]);
            expect({acquired, evidenceReads, released, sessions}).toEqual({
              acquired: 3,
              evidenceReads: 1,
              released: 3,
              sessions: 3,
            });
          }),
        fixture =>
          Effect.tryPromise({
            try: () => removePreparedCodeGraphWorksetFixture(fixture),
            catch: cause => new TestError('Could not remove the citation Workset fixture.', {cause}),
          }),
      ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    {timeout: 120_000},
  );
});

const git = Effect.fn('contextBriefCitationWorksetTest.git')((cwd: string, args: readonly string[]) =>
  runCommandEffect('git', ['-C', cwd, ...args], {maxOutputBytes: 1_048_576, timeoutMs: 30_000}),
);
