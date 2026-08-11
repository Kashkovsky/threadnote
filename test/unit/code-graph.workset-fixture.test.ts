import {execFile} from 'node:child_process';
import {readFile, readdir, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {expect, it} from '@effect/vitest';
import * as FC from 'effect/testing/FastCheck';
import {afterEach, describe} from 'vitest';
import {
  CODE_GRAPH_WORKSET_FIXTURE_ARCHETYPES,
  CODE_GRAPH_WORKSET_FIXTURE_SIZES,
  CODE_GRAPH_WORKSET_FIXTURE_SUPPORTED_SIZES,
  codeGraphWorksetFixturePathExists,
  createCodeGraphWorksetFixturePlan,
  establishCodeGraphWorksetStaleReadySnapshot,
  prepareCodeGraphWorksetFixture,
  readCodeGraphWorksetFixtureFile,
  type CodeGraphWorksetFixtureState,
  type MaterializedCodeGraphWorksetFixtureRepository,
} from '../../scripts/support/code-graph-workset-fixture.js';
import {parseSeedManifest} from '../../src/manifest.js';

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, {force: true, recursive: true})));
});

describe('deterministic code graph workset fixtures', () => {
  it('plans every required workset size from bounded in-code archetypes', () => {
    for (const size of CODE_GRAPH_WORKSET_FIXTURE_SIZES) {
      const plan = createCodeGraphWorksetFixturePlan(size);

      expect(plan.repositories).toHaveLength(size);
      expect(plan.members).toHaveLength(size);
      expect(new Set(plan.repositories.map(repository => repository.repositoryKey)).size).toBe(size);
      expect(plan.identity.repositoryCount).toBe(size);
      expect(plan.identity.id).toMatch(/^cgwf_[a-f0-9]{32}$/u);
      expect(plan.worksets.map(workset => workset.size)).toEqual(
        CODE_GRAPH_WORKSET_FIXTURE_SUPPORTED_SIZES.filter(candidate => candidate <= size),
      );
      expect(plan.worksets.at(-1)?.repositoryKeys).toEqual(
        plan.repositories.map(repository => repository.repositoryKey),
      );
    }

    const full = createCodeGraphWorksetFixturePlan(128);
    const archetypeIds = new Set(full.repositories.map(repository => repository.archetype));
    expect(archetypeIds.size).toBeLessThanOrEqual(CODE_GRAPH_WORKSET_FIXTURE_ARCHETYPES.length);
    expect(CODE_GRAPH_WORKSET_FIXTURE_ARCHETYPES.every(archetype => /^[a-f0-9]{64}$/u.test(archetype.sha256))).toBe(
      true,
    );
    expect(createCodeGraphWorksetFixturePlan(50).workset.name).toBe('code-graph-workset-50');
    expect(full.worksets.map(workset => workset.size)).toContain(50);
    for (const size of [1, 8] as const) {
      expect(createCodeGraphWorksetFixturePlan(size).queries.map(query => query.id)).toEqual(
        full.queries.filter(query => query.sizes.includes(size)).map(query => query.id),
      );
    }
  });

  it('includes authoritative contracts, consumers, distractors, and an unanswerable query', () => {
    const plan = createCodeGraphWorksetFixturePlan(8);
    const content = plan.repositories.flatMap(repository => repository.files.map(file => file.content)).join('\n');

    expect(content).toContain('resolveTenantSession');
    expect(content).toContain('@threadnote-fixture/session-contract');
    expect(content).toContain('workspaces');
    expect(content).toContain('TenantSessionByTenant');
    expect(content).toContain('threadnote.session.v1.SessionDirectory');
    expect(content).toContain('/v1/tenant-sessions/{tenantId}');
    expect(content).toContain('tenant.session.changed');
    expect(plan.repositories.filter(repository => repository.archetype === 'same-name-distractor')).toHaveLength(1);
    expect(plan.queries.find(query => query.category === 'no-answer')).toMatchObject({
      relevantRepositoryKeys: [],
      text: 'quantumMarzipanLeaseCoordinator',
    });
  });

  it('keeps the 50-repository latency gate queryable without adding it to the default correctness matrix', () => {
    const plan = createCodeGraphWorksetFixturePlan(50);

    expect(CODE_GRAPH_WORKSET_FIXTURE_SIZES).not.toContain(50);
    expect(plan.worksets.at(-1)).toMatchObject({size: 50});
    expect(plan.queries.length).toBeGreaterThan(0);
    expect(plan.queries.every(query => query.sizes.includes(50))).toBe(true);
  });

  it('places relevant scale queries beyond the current manifest-prefix admission cap', () => {
    const plan = createCodeGraphWorksetFixturePlan(128);

    for (const size of [32, 50, 64, 128] as const) {
      const repositorySuffix = `Repo${String(size - 1).padStart(3, '0')}`;
      const query = plan.queries.find(candidate => candidate.id === `tail-repository-marker-${size}`);
      expect(query).toMatchObject({
        expectedRepositories: [`repo-${String(size - 1).padStart(3, '0')}`],
        expectedSymbols: [
          {
            repositoryId: `repo-${String(size - 1).padStart(3, '0')}`,
            symbol: `src/health.ts#repositoryHealthMarker${repositorySuffix}`,
          },
        ],
      });
      expect(query?.sizes).toContain(size);
      expect(Number(query?.expectedRepositories[0]?.slice('repo-'.length))).toBeGreaterThanOrEqual(8);
      expect(plan.repositories[size - 1]?.files.find(file => file.path === 'src/health.ts')?.content).toContain(
        `/** Deterministic repository marker repo-${String(size - 1).padStart(3, '0')}:ready. */`,
      );
    }
  });

  it.prop(
    'keeps identity and members stable when state override insertion order changes',
    {offset: FC.integer({max: 5, min: 0}), reverse: FC.boolean()},
    ({offset, reverse}) => {
      const entries = [
        ['repo-000', 'clean'],
        ['repo-001', 'dirty'],
        ['repo-002', 'stale'],
        ['repo-003', 'missing'],
        ['repo-004', 'failed'],
        ['repo-005', 'worktree'],
        ['repo-006', 'cold'],
      ] as const satisfies readonly (readonly [string, CodeGraphWorksetFixtureState])[];
      const reordered = [...entries.slice(offset), ...entries.slice(0, offset)];
      if (reverse) {
        reordered.reverse();
      }
      const baseline = createCodeGraphWorksetFixturePlan(8, {repositoryStates: Object.fromEntries(entries)});
      const candidate = createCodeGraphWorksetFixturePlan(8, {repositoryStates: Object.fromEntries(reordered)});

      expect(candidate.identity).toEqual(baseline.identity);
      expect(candidate.members).toEqual(baseline.members);
      expect(candidate.repositories).toEqual(baseline.repositories);
    },
    {fastCheck: {numRuns: 60}},
  );

  it('materializes clean Git repositories and a resolvable prefix-workset manifest', async () => {
    const fixture = await prepareCodeGraphWorksetFixture({concurrency: 4, size: 8});
    temporaryRoots.push(fixture.root);

    const repositoryDirectories = await readdir(fixture.repositoriesRoot);
    expect(repositoryDirectories.sort()).toEqual(
      Array.from({length: 8}, (_, index) => `repo-${String(index).padStart(3, '0')}`),
    );
    const manifest = parseSeedManifest(await readFile(fixture.manifestPath, 'utf8'), fixture.manifestPath);
    expect(manifest.projects).toHaveLength(8);
    expect(manifest.worksets?.map(workset => ({name: workset.name, size: workset.projects.length}))).toEqual([
      {name: 'code-graph-workset-1', size: 1},
      {name: 'code-graph-workset-8', size: 8},
    ]);
    expect(manifest.worksets?.[1]?.projects).toEqual(manifest.projects.map(project => project.name));
    expect(
      await readCodeGraphWorksetFixtureFile(fixture, 'repo-001', 'packages/session-client/package.json'),
    ).toContain('@threadnote-fixture/session-contract');
    for (const repository of fixture.repositories) {
      expect(repository.headCommit).toMatch(/^[a-f0-9]{40}$/u);
      expect(await git(repository.path, ['status', '--porcelain'])).toBe('');
    }
    const metadata = JSON.parse(await readFile(fixture.metadataPath, 'utf8')) as {
      readonly identity: {readonly id: string};
      readonly members: readonly unknown[];
    };
    expect(metadata.identity.id).toBe(fixture.identity.id);
    expect(metadata.members).toHaveLength(8);
  });

  it('produces path-independent fixture identities and deterministic Git commits', async () => {
    const first = await prepareCodeGraphWorksetFixture({size: 1});
    const second = await prepareCodeGraphWorksetFixture({size: 1});
    temporaryRoots.push(first.root, second.root);

    expect(first.identity).toEqual(second.identity);
    expect(first.repositories[0]?.contentDigest).toBe(second.repositories[0]?.contentDigest);
    expect(first.repositories[0]?.headCommit).toBe(second.repositories[0]?.headCommit);
    expect(await readFile(first.metadataPath, 'utf8')).toBe(await readFile(second.metadataPath, 'utf8'));
  });

  it('materializes clean, cold, dirty, stale, missing, failed, and sibling-worktree controls', async () => {
    const fixture = await prepareCodeGraphWorksetFixture({concurrency: 4, size: 8, stateProfile: 'mixed'});
    temporaryRoots.push(fixture.root);
    const byState = new Map(fixture.repositories.map(repository => [repository.state, repository]));

    expect(new Set(fixture.repositories.map(repository => repository.state))).toEqual(
      new Set(['clean', 'cold', 'dirty', 'stale', 'missing', 'failed', 'worktree']),
    );
    const clean = required(byState, 'clean');
    const cold = required(byState, 'cold');
    const dirty = required(byState, 'dirty');
    const stale = required(byState, 'stale');
    const missing = required(byState, 'missing');
    const failed = required(byState, 'failed');
    const worktree = required(byState, 'worktree');

    expect(await git(clean.path, ['status', '--porcelain'])).toBe('');
    expect(await git(cold.path, ['status', '--porcelain'])).toBe('');
    expect(await codeGraphWorksetFixturePathExists(join(cold.path, '.git'))).toBe(true);
    expect(await git(dirty.path, ['status', '--porcelain'])).toContain('README.md');
    expect(stale.readyCommit).toMatch(/^[a-f0-9]{40}$/u);
    expect(stale.headCommit).not.toBe(stale.readyCommit);
    await establishCodeGraphWorksetStaleReadySnapshot(stale, async repositoryPath => {
      expect(await git(repositoryPath, ['rev-parse', 'HEAD'])).toBe(stale.readyCommit);
    });
    expect(await git(stale.path, ['rev-parse', 'HEAD'])).toBe(stale.headCommit);
    expect(await codeGraphWorksetFixturePathExists(missing.path)).toBe(false);
    expect(await codeGraphWorksetFixturePathExists(failed.path)).toBe(true);
    expect(await codeGraphWorksetFixturePathExists(join(failed.path, '.git'))).toBe(false);
    expect(await git(worktree.path, ['status', '--porcelain'])).toBe('');
    expect(worktree.siblingWorktreePath).toBeDefined();
    expect(await git(worktree.siblingWorktreePath as string, ['status', '--porcelain'])).toContain(
      'src/worktree-only.ts',
    );
  });
});

function required(
  repositories: ReadonlyMap<CodeGraphWorksetFixtureState, MaterializedCodeGraphWorksetFixtureRepository>,
  state: CodeGraphWorksetFixtureState,
): MaterializedCodeGraphWorksetFixtureRepository {
  const repository = repositories.get(state);
  if (!repository) {
    throw new Error(`Missing ${state} fixture repository.`);
  }
  return repository;
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', cwd, ...args], {encoding: 'utf8'});
  return result.stdout.trim();
}
