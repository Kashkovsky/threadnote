import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from '../helpers/node-fs.js';
import {tmpdir} from '../helpers/node-os.js';
import {join, relative} from '../helpers/node-path.js';
import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  codeGraphGitWorktreeAdminNameKeys,
  scanCodeGraphGitWorktreeRegistry,
  scanCodeGraphGitWorktreeRegistryBatch,
  scanCodeGraphWorktreeAuthorityWorkerRequest,
  type CodeGraphGitWorktreeRegistryRequest,
} from '../../src/code_graph/git_worktree_registration.js';

const CHECKOUT_ID = 'a'.repeat(64);

describe('code graph common-gitdir authority properties', () => {
  it('is deterministic across insertion order and becomes present exactly when the target name is added', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._-]{0,23}$/), {
          maxLength: 12,
          selector: value => value.toLowerCase(),
        }),
        fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._-]{0,23}$/),
        async (generated, target) => {
          const entries = generated.filter(name => name.toLowerCase() !== target.toLowerCase());
          const first = registryFixture(entries);
          const second = registryFixture([...entries].reverse());
          try {
            const absentFirst = await scanCodeGraphGitWorktreeRegistry(request(first, target));
            const absentSecond = await scanCodeGraphGitWorktreeRegistry(request(second, target));
            expect(absentFirst).toMatchObject({state: 'absent'});
            expect(absentSecond).toMatchObject({state: 'absent'});
            if (absentFirst.state !== 'unknown' && absentSecond.state !== 'unknown') {
              expect(absentFirst.contentDigest).toBe(absentSecond.contentDigest);
            }

            mkdirSync(join(first, 'worktrees', target));
            const present = await scanCodeGraphGitWorktreeRegistry(request(first, target));
            expect(present).toMatchObject({state: 'present'});
          } finally {
            rmSync(first, {force: true, recursive: true});
            rmSync(second, {force: true, recursive: true});
          }
        },
      ),
      {numRuns: 100},
    );
  });

  effectIt.effect.prop(
    'keeps batch target states index-addressed across target and registry permutations',
    {
      entries: fc.uniqueArray(fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._-]{0,15}$/), {
        maxLength: 10,
        minLength: 1,
        selector: value => value.toLowerCase(),
      }),
      generatedTargets: fc.uniqueArray(fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._-]{0,15}$/), {
        maxLength: 16,
        minLength: 1,
        selector: value => value.toLowerCase(),
      }),
      reverseTargets: fc.boolean(),
    },
    ({entries, generatedTargets, reverseTargets}) => {
      const targets = (reverseTargets ? [...generatedTargets].reverse() : generatedTargets).slice(0, 16);
      return Effect.acquireUseRelease(
        Effect.sync(() => registryFixture(entries)),
        registry =>
          Effect.promise(() =>
            scanCodeGraphGitWorktreeRegistryBatch({
              adminNameKeySets: targets.map(target => codeGraphGitWorktreeAdminNameKeys(CHECKOUT_ID, target)),
              checkoutId: CHECKOUT_ID,
              gitCommonDirectory: registry,
              protocol: 2,
            }),
          ).pipe(
            Effect.tap(observation =>
              Effect.sync(() => {
                expect(observation.state).toBe('complete');
                if (observation.state === 'complete') {
                  const present = new Set(entries.map(entry => entry.toLowerCase()));
                  expect(observation.states).toEqual(
                    targets.map(target => (present.has(target.toLowerCase()) ? 'present' : 'absent')),
                  );
                }
              }),
            ),
            Effect.asVoid,
          ),
        registry => Effect.sync(() => rmSync(registry, {force: true, recursive: true})),
      );
    },
  );

  effectIt.effect.prop(
    'classifies a recycled admin name by its exact backlink target for either Git line ending',
    {
      lineEnding: fc.constantFrom('\n', '\r\n'),
      relativeBacklink: fc.boolean(),
      segments: fc.uniqueArray(fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._-]{0,15}$/), {
        maxLength: 2,
        minLength: 2,
      }),
      targetMatches: fc.boolean(),
    },
    ({lineEnding, relativeBacklink, segments, targetMatches}) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const common = registryFixture([]);
          const adminName = 'recycled-admin';
          const adminEntry = join(common, 'worktrees', adminName);
          mkdirSync(adminEntry);
          const target = join(common, 'removed', segments[0]);
          const replacement = join(common, 'replacement', segments[1]);
          const pointedAt = join(targetMatches ? target : replacement, '.git');
          writeFileSync(
            join(adminEntry, 'gitdir'),
            `${relativeBacklink ? relative(adminEntry, pointedAt) : pointedAt}${lineEnding}`,
          );
          return {adminName, common, target};
        }),
        ({adminName, common, target}) =>
          Effect.promise(() =>
            scanCodeGraphWorktreeAuthorityWorkerRequest({
              checkoutId: CHECKOUT_ID,
              gitCommonDirectory: common,
              kind: 'reconciliation-authority',
              protocol: 3,
              targets: [
                {
                  adminNameKeys: codeGraphGitWorktreeAdminNameKeys(CHECKOUT_ID, adminName),
                  canonicalWorktreePath: target,
                  evidenceToken: 'b'.repeat(64),
                },
              ],
            }),
          ).pipe(
            Effect.tap(observation =>
              Effect.sync(() => {
                expect(observation).toMatchObject({
                  pathStates: ['missing'],
                  registryStates: [targetMatches ? 'present' : 'absent'],
                  state: 'complete',
                });
              }),
            ),
            Effect.asVoid,
          ),
        ({common}) => Effect.sync(() => rmSync(common, {force: true, recursive: true})),
      ),
  );
});

function request(common: string, target: string): CodeGraphGitWorktreeRegistryRequest {
  return {
    adminNameKeys: codeGraphGitWorktreeAdminNameKeys(CHECKOUT_ID, target),
    checkoutId: CHECKOUT_ID,
    gitCommonDirectory: common,
    protocol: 1,
  };
}

function registryFixture(entries: readonly string[]): string {
  const common = mkdtempSync(join(tmpdir(), 'threadnote-registration-property-'));
  mkdirSync(join(common, 'worktrees'));
  for (const entry of entries) mkdirSync(join(common, 'worktrees', entry));
  return common;
}
