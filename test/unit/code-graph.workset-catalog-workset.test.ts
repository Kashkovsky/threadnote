import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  classifyCodeGraphWorksetStatusMember,
  classifyCodeGraphWorksetStatusFailure,
  codeGraphWorksetCatalogGenerationMatches,
  codeGraphWorksetManifestDigest,
} from '../../src/code_graph/workset_catalog/workset.js';
import type {CodeGraphWorksetCatalogPublishedMemberV1} from '../../src/code_graph/workset_catalog/types.js';
import {
  CodeGraphRepositoryError,
  CodeGraphStoreBusyError,
  CodeGraphStoreCorruptionError,
  type CodeGraphSnapshot,
  type RepositoryIdentity,
} from '../../src/code_graph/types.js';
import type {ResolvedWorkset} from '../../src/types.js';

describe('code graph workset preparation and status', () => {
  it('classifies exact publication, snapshot drift, identity drift, and missing catalog receipts', () => {
    const identity = repositoryIdentity('repository-a');
    const snapshot = readySnapshot(identity, 'snapshot-a');
    const published = publishedMember(identity, snapshot);

    expect(
      classifyCodeGraphWorksetStatusMember('api', {identity, readySnapshot: snapshot, stale: false}, published),
    ).toMatchObject({
      project: 'api',
      state: 'current',
    });
    expect(
      classifyCodeGraphWorksetStatusMember(
        'api',
        {identity, readySnapshot: {...snapshot, id: 'snapshot-b'}, stale: false},
        published,
      ),
    ).toMatchObject({reason: 'snapshot-drift', state: 'stale'});
    expect(
      classifyCodeGraphWorksetStatusMember(
        'api',
        {identity: repositoryIdentity('repository-b'), readySnapshot: snapshot, stale: false},
        published,
      ),
    ).toMatchObject({reason: 'identity-drift', state: 'stale'});
    expect(
      classifyCodeGraphWorksetStatusMember(
        'api',
        {identity: {...identity, checkoutId: 'b'.repeat(64)}, readySnapshot: snapshot, stale: false},
        published,
      ),
    ).toMatchObject({reason: 'checkout-drift', state: 'stale'});
    expect(
      classifyCodeGraphWorksetStatusMember(
        'api',
        {identity: {...identity, worktreeId: 'c'.repeat(64)}, readySnapshot: snapshot, stale: false},
        published,
      ),
    ).toMatchObject({reason: 'worktree-drift', state: 'stale'});
    expect(
      classifyCodeGraphWorksetStatusMember('api', {identity, readySnapshot: snapshot, stale: false}, undefined),
    ).toMatchObject({state: 'uncatalogued'});
    expect(
      classifyCodeGraphWorksetStatusMember('api', {identity, readySnapshot: undefined, stale: true}, published),
    ).toMatchObject({reason: 'no-ready-snapshot', state: 'deferred'});
  });

  it('keeps the manifest digest independent of project and unresolved-member iteration order', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.stringMatching(/^[a-z][a-z0-9-]{0,20}$/u), {maxLength: 24}),
        fc.uniqueArray(fc.stringMatching(/^[a-z][a-z0-9-]{0,20}$/u), {maxLength: 12}),
        (names, unresolved) => {
          const workset = resolvedWorkset(names, unresolved);
          const reversed: ResolvedWorkset = {
            ...workset,
            projects: [...workset.projects].reverse(),
            unresolvedProjects: [...workset.unresolvedProjects].reverse(),
          };
          expect(codeGraphWorksetManifestDigest(reversed)).toBe(codeGraphWorksetManifestDigest(workset));
        },
      ),
      {numRuns: 100},
    );
  });

  it('never classifies a different published snapshot as current', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z0-9-]{1,80}$/u), fc.stringMatching(/^[a-z0-9-]{1,80}$/u), (left, right) => {
        fc.pre(left !== right);
        const identity = repositoryIdentity('repository');
        const active = readySnapshot(identity, left);
        const published = publishedMember(identity, readySnapshot(identity, right));
        expect(
          classifyCodeGraphWorksetStatusMember('repository', {identity, readySnapshot: active, stale: false}, published)
            .state,
        ).toBe('stale');
      }),
      {numRuns: 100},
    );
  });

  it('accepts a non-empty ready subset while rejecting unknown, duplicate, or empty catalog membership', () => {
    const workset = resolvedWorkset(['api', 'web'], []);
    const manifestDigest = codeGraphWorksetManifestDigest(workset);
    const apiIdentity = repositoryIdentity('api');
    const api = {...publishedMember(apiIdentity, readySnapshot(apiIdentity, 'snapshot-api')), repositoryKey: 'api'};
    const webIdentity = repositoryIdentity('web');
    const web = {...publishedMember(webIdentity, readySnapshot(webIdentity, 'snapshot-web')), repositoryKey: 'web'};
    const generation = {
      digest: 'd'.repeat(64),
      id: `cgwg_${'e'.repeat(40)}`,
      manifestDigest,
      members: [api, web],
      worksetName: workset.name,
    } as const;

    expect(codeGraphWorksetCatalogGenerationMatches(workset, manifestDigest, generation)).toBe(true);
    expect(
      codeGraphWorksetCatalogGenerationMatches(workset, manifestDigest, {
        ...generation,
        members: [api, {...web, repositoryKey: 'unexpected'}],
      }),
    ).toBe(false);
    const readySubset = {...generation, members: [api]};
    expect(codeGraphWorksetCatalogGenerationMatches(workset, manifestDigest, readySubset)).toBe(true);
    expect(
      codeGraphWorksetCatalogGenerationMatches(workset, manifestDigest, {...generation, members: [api, api]}),
    ).toBe(false);
    expect(codeGraphWorksetCatalogGenerationMatches(workset, manifestDigest, {...generation, members: []})).toBe(false);

    expect(
      classifyCodeGraphWorksetStatusMember(
        'api',
        {identity: apiIdentity, readySnapshot: readySnapshot(apiIdentity, 'snapshot-api'), stale: false},
        api,
      ),
    ).toMatchObject({state: 'current'});
    expect(
      classifyCodeGraphWorksetStatusMember(
        'web',
        {identity: webIdentity, readySnapshot: undefined, stale: true},
        undefined,
      ),
    ).toMatchObject({reason: 'no-ready-snapshot', state: 'deferred'});
  });

  it('preserves typed pathless status failures instead of calling every failure an invalid repository', () => {
    expect(
      classifyCodeGraphWorksetStatusFailure('api', CodeGraphRepositoryError.make({message: '/secret/repo failed'})),
    ).toEqual({
      detail: {code: 'repository', retryable: false},
      project: 'api',
      reason: 'invalid-repository',
      state: 'failed',
    });
    expect(classifyCodeGraphWorksetStatusFailure('api', CodeGraphStoreBusyError.of('/secret/db busy'))).toEqual({
      detail: {code: 'busy', recovery: 'defer', retryable: true},
      project: 'api',
      reason: 'status-unavailable',
      state: 'failed',
    });
    expect(
      classifyCodeGraphWorksetStatusFailure('api', CodeGraphStoreCorruptionError.of('/secret/db corrupt')),
    ).toEqual({
      detail: {code: 'confirmed-corruption', recovery: 'manual-rebuild', retryable: false},
      project: 'api',
      reason: 'status-corrupt',
      state: 'failed',
    });
  });
});

function resolvedWorkset(names: readonly string[], unresolvedProjects: readonly string[]): ResolvedWorkset {
  return {
    name: 'engineering',
    projects: names.map(name => ({
      name,
      path: `~/src/${name}`,
      seed: [],
      uri: `threadnote://resources/repos/${name}`,
    })),
    unresolvedProjects,
  };
}

function repositoryIdentity(seed: string): RepositoryIdentity {
  const digest = seed
    .padEnd(64, '0')
    .slice(0, 64)
    .replace(/[^a-f0-9]/gu, 'a');
  return {
    caseMode: 'sensitive',
    checkoutId: digest,
    displayName: seed,
    gitCommonDirectory: '.git',
    headCommit: 'a'.repeat(40),
    objectFormat: 'sha1',
    repoRoot: '/repository',
    repositoryId: digest,
    worktreeId: digest,
  };
}

function readySnapshot(identity: RepositoryIdentity, id: string): CodeGraphSnapshot {
  return {
    commit: identity.headCommit,
    dirty: false,
    edgeCount: 0,
    extractorSet: 'test',
    fileCount: 1,
    id,
    repositoryId: identity.repositoryId,
    state: 'ready',
    symbolCount: 1,
    worktreeId: identity.worktreeId,
  };
}

function publishedMember(
  identity: RepositoryIdentity,
  snapshot: CodeGraphSnapshot,
): CodeGraphWorksetCatalogPublishedMemberV1 {
  return {
    checkoutId: identity.checkoutId,
    commitId: snapshot.commit,
    ordinal: 0,
    projectionDigest: 'b'.repeat(64),
    repositoryId: identity.repositoryId,
    repositoryKey: 'api',
    snapshotDigest: 'c'.repeat(64),
    snapshotId: snapshot.id,
    symbolCount: snapshot.symbolCount,
    worktreeId: identity.worktreeId,
  };
}
