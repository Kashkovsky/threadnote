import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect, it} from 'vitest';
import {
  codeGraphStatusHasIndexingActivity,
  codeMemoryLinkDogfoodEnvironment,
  countDeferredAnchorIntentNames,
  projectAutomaticDeferredAnchorTransition,
  projectDeferredAnchorFinalization,
  projectCodeMemoryLinkDogfoodGraphStatusV1,
  verifyDogfoodRunnerCheckout,
} from '../../scripts/run-code-memory-link-dogfood.js';
import {runCommandEffect} from '../../src/effect/command.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

describe('Code Memory Link dogfood runner checkout binding', () => {
  effectIt.effect('seals candidate commands from ambient credentials and host configuration', () =>
    Effect.gen(function* () {
      const environment = codeMemoryLinkDogfoodEnvironment({
        home: '/isolated/process-home',
        temporaryDirectory: '/isolated/tmp',
        threadnoteHome: '/isolated/threadnote-home',
      });
      const child = yield* runCommandEffect(
        process.execPath,
        ['-e', 'process.stdout.write(process.env.THREADNOTE_SECRET_SENTINEL ?? "absent")'],
        {env: environment},
      );

      expect(child.stdout).toBe('absent');
      expect(environment).toMatchObject({
        HOME: '/isolated/process-home',
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        THREADNOTE_HOME: '/isolated/threadnote-home',
        TMPDIR: '/isolated/tmp',
      });
      expect(Object.keys(environment).sort()).toEqual([
        'CI',
        'HOME',
        'LANG',
        'LC_ALL',
        'NO_COLOR',
        'NO_UPDATE_NOTIFIER',
        'PATH',
        'THREADNOTE_ACCOUNT',
        'THREADNOTE_AGENT_ID',
        'THREADNOTE_HOME',
        'THREADNOTE_NO_SPINNER',
        'THREADNOTE_NO_UPDATE_CHECK',
        'THREADNOTE_USER',
        'TMPDIR',
      ]);
      expect(environment).not.toHaveProperty('THREADNOTE_SECRET_SENTINEL');
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  it('projects an observed graph-status receipt and rejects a caller-supplied stale assertion', () => {
    expect(
      projectCodeMemoryLinkDogfoodGraphStatusV1({
        readySnapshot: {commit: 'a'.repeat(40), dirty: false, id: `cgsn_${'b'.repeat(40)}`},
        stale: true,
        type: 'code-graph-status',
        version: 2,
      }),
    ).toEqual({
      readySnapshotCommit: 'a'.repeat(40),
      readySnapshotDirty: false,
      readySnapshotId: `cgsn_${'b'.repeat(40)}`,
      stale: true,
    });
    expect(
      projectCodeMemoryLinkDogfoodGraphStatusV1({
        readySnapshot: {commit: 'a'.repeat(40), dirty: false, id: `cgsn_${'b'.repeat(40)}`},
        stale: true,
        type: 'code-graph-status',
        version: 3,
      }),
    ).toMatchObject({stale: true});
    expect(() => projectCodeMemoryLinkDogfoodGraphStatusV1({stale: true})).toThrow(/supported status/);
  });

  it('derives indexing activity from the independent graph-status process receipt', () => {
    const idle = {
      build: null,
      builds: [],
      type: 'code-graph-status',
      version: 2,
      waiterCount: 0,
      waiters: [],
    };
    expect(codeGraphStatusHasIndexingActivity(idle)).toBe(false);
    expect(codeGraphStatusHasIndexingActivity({...idle, version: 3})).toBe(false);
    expect(codeGraphStatusHasIndexingActivity({...idle, build: {state: 'running'}, builds: [{state: 'running'}]})).toBe(
      true,
    );
    expect(() => codeGraphStatusHasIndexingActivity({build: null})).toThrow(/activity contract/);
  });

  it('projects finalization counts from matching per-item receipts', () => {
    expect(
      projectDeferredAnchorFinalization({
        conflictCount: 0,
        failedCount: 0,
        finalizedCount: 1,
        items: [{citationCount: 2, memoryUri: 'redacted', state: 'finalized'}],
        pendingCount: 0,
        scannedCount: 1,
        type: 'threadnote-deferred-code-anchor-finalization',
        version: 1,
      }),
    ).toEqual({
      citationCount: 2,
      conflictCount: 0,
      failedCount: 0,
      finalizedCount: 1,
      pendingCount: 0,
      scannedCount: 1,
    });
    expect(() =>
      projectDeferredAnchorFinalization({
        conflictCount: 0,
        failedCount: 0,
        finalizedCount: 0,
        items: [{citationCount: 1, state: 'finalized'}],
        pendingCount: 0,
        scannedCount: 1,
        type: 'threadnote-deferred-code-anchor-finalization',
        version: 1,
      }),
    ).toThrow(/aggregate counts/);
  });

  it('counts current routed and legacy deferred-anchor intent filenames through the production classifier', () => {
    const legacy = `${'a'.repeat(64)}-tnca_${'b'.repeat(32)}.json`;
    const routed =
      `${'c'.repeat(32)}-tnca_${'d'.repeat(32)}-r${'e'.repeat(32)}` + `-w${'f'.repeat(32)}-q-b${'0'.repeat(32)}.json`;

    for (const name of [legacy, routed]) {
      const pendingIntentCountBefore = countDeferredAnchorIntentNames([name]);
      const pendingIntentCountAfter = countDeferredAnchorIntentNames([]);
      expect(pendingIntentCountBefore).toBe(1);
      expect(pendingIntentCountAfter).toBe(0);
      expect(
        projectAutomaticDeferredAnchorTransition({
          citationCountAfter: 1,
          citationCountBefore: 0,
          pendingIntentCountAfter,
          pendingIntentCountBefore,
        }),
      ).toMatchObject({citationCount: 1, failedCount: 0, finalizedCount: 1, pendingCount: 0, scannedCount: 1});
    }
    expect(
      countDeferredAnchorIntentNames([
        legacy,
        routed,
        '.0123456789abcdef01234567.tmp',
        `${'a'.repeat(32)}-tnca_${'b'.repeat(32)}-rnot-a-route.json`,
        'unrelated.json',
      ]),
    ).toBe(2);
  });

  it.each([
    {
      expected: {
        citationCount: 1,
        conflictCount: 0,
        failedCount: 0,
        finalizedCount: 1,
        pendingCount: 0,
        scannedCount: 1,
      },
      input: {
        citationCountAfter: 1,
        citationCountBefore: 0,
        pendingIntentCountAfter: 0,
        pendingIntentCountBefore: 1,
      },
      label: 'one pending intent becomes one citation',
    },
    {
      expected: {
        citationCount: 0,
        conflictCount: 0,
        failedCount: 0,
        finalizedCount: 0,
        pendingCount: 1,
        scannedCount: 1,
      },
      input: {
        citationCountAfter: 0,
        citationCountBefore: 0,
        pendingIntentCountAfter: 1,
        pendingIntentCountBefore: 1,
      },
      label: 'a contended or unready intent remains pending',
    },
    {
      expected: {
        citationCount: 0,
        conflictCount: 0,
        failedCount: 1,
        finalizedCount: 0,
        pendingCount: 0,
        scannedCount: 1,
      },
      input: {
        citationCountAfter: 0,
        citationCountBefore: 0,
        pendingIntentCountAfter: 0,
        pendingIntentCountBefore: 1,
      },
      label: 'an intent disappears without adding a citation',
    },
    {
      expected: {
        citationCount: 1,
        conflictCount: 0,
        failedCount: 1,
        finalizedCount: 0,
        pendingCount: 1,
        scannedCount: 1,
      },
      input: {
        citationCountAfter: 1,
        citationCountBefore: 0,
        pendingIntentCountAfter: 1,
        pendingIntentCountBefore: 1,
      },
      label: 'a citation appears while its intent remains',
    },
    {
      expected: {
        citationCount: 0,
        conflictCount: 0,
        failedCount: 1,
        finalizedCount: 0,
        pendingCount: 0,
        scannedCount: 0,
      },
      input: {
        citationCountAfter: 0,
        citationCountBefore: 0,
        pendingIntentCountAfter: 0,
        pendingIntentCountBefore: 0,
      },
      label: 'the isolated staged intent was never observed',
    },
  ])('projects the automatic transition when $label', ({expected, input}) => {
    expect(projectAutomaticDeferredAnchorTransition(input)).toEqual(expected);
  });

  it('rejects invalid automatic transition counters', () => {
    expect(() =>
      projectAutomaticDeferredAnchorTransition({
        citationCountAfter: 1,
        citationCountBefore: 0,
        pendingIntentCountAfter: -1,
        pendingIntentCountBefore: 1,
      }),
    ).toThrow(/non-negative integers/);
  });

  effectIt.effect('accepts the exact clean checkout that supplied the reviewed runner', () =>
    fixtureRepository('trusted').pipe(
      Effect.flatMap(({approval, candidate, root}) =>
        verifyDogfoodRunnerCheckout({
          approvalCommit: approval,
          candidateCommit: candidate,
          executingSourceRoot: root,
          requestedSourceRoot: root,
        }).pipe(Effect.tap(result => Effect.sync(() => expect(result).toBe(root)))),
      ),
      provideTestLayer(ApplicationLayer),
      TestClock.withLive,
    ),
  );

  effectIt.effect('rejects a foreign runner checkout targeting a clean reviewed repository', () =>
    Effect.all([fixtureRepository('reviewed'), fixtureRepository('foreign')]).pipe(
      Effect.flatMap(([reviewed, foreign]) =>
        verifyDogfoodRunnerCheckout({
          approvalCommit: reviewed.approval,
          candidateCommit: reviewed.candidate,
          executingSourceRoot: foreign.root,
          requestedSourceRoot: reviewed.root,
        }).pipe(
          Effect.flip,
          Effect.tap(failure =>
            Effect.sync(() => {
              expect(String(failure)).toContain('canonical checkout that supplied and is executing');
            }),
          ),
        ),
      ),
      provideTestLayer(ApplicationLayer),
      TestClock.withLive,
    ),
  );
});

const fixtureRepository = Effect.fn('codeMemoryLinkDogfoodRunnerTest.fixtureRepository')(function* (name: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const temporaryRoot = yield* fs.makeTempDirectoryScoped({prefix: `threadnote-code-memory-dogfood-${name}-`});
  const root = yield* fs.realPath(temporaryRoot);
  const approvalsPath = path.join(root, 'src/evaluation/code-memory-link-approvals.json');
  const releasePath = path.join(root, 'docs/releasing.md');
  yield* fs.makeDirectory(path.dirname(approvalsPath), {recursive: true});
  yield* fs.makeDirectory(path.dirname(releasePath), {recursive: true});
  yield* fs.writeFileString(
    approvalsPath,
    `${JSON.stringify({
      agentAbEvidenceHashes: [],
      agentAbManifestHashes: [],
      dogfoodEvidenceHashes: [],
      version: 1,
    })}\n`,
  );
  yield* fs.writeFileString(releasePath, 'candidate\n');
  yield* git(root, ['init', '--quiet']);
  const candidate = yield* commit(root, 'candidate');
  yield* fs.writeFileString(
    approvalsPath,
    `${JSON.stringify({
      agentAbEvidenceHashes: [],
      agentAbManifestHashes: [],
      dogfoodEvidenceHashes: ['a'.repeat(64)],
      version: 1,
    })}\n`,
  );
  const approval = yield* commit(root, 'approval');
  return {approval, candidate, root};
});

const commit = Effect.fn('codeMemoryLinkDogfoodRunnerTest.commit')(function* (root: string, message: string) {
  yield* git(root, ['add', '.']);
  yield* git(root, [
    '-c',
    'user.name=Threadnote Test',
    '-c',
    'user.email=test@threadnote.local',
    'commit',
    '--quiet',
    '--message',
    message,
  ]);
  return (yield* git(root, ['rev-parse', 'HEAD'])).stdout.trim();
});

function git(cwd: string, args: readonly string[]) {
  return runCommandEffect('git', args, {cwd, maxOutputBytes: 64 * 1024, timeoutMs: 30_000});
}
