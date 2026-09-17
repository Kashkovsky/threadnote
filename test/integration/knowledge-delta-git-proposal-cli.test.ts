import {buildCandidateReview, saveCandidateReview, type SessionCloseoutInput} from '../../src/memory/candidate.js';
import {sha256HexSync} from '../../src/crypto/sha256.js';
import {canonicalMemoryDocumentContent, formatMemoryDocument} from '../../src/memory/document.js';
import {execFile} from '../helpers/node-child-process.js';
import {mkdir, mkdtemp, readFile, rm, writeFile} from '../helpers/node-fs-promises.js';
import {tmpdir} from '../helpers/node-os.js';
import {join} from '../helpers/node-path.js';
import {runEffect as run} from '../helpers/effect-runtime.js';
import {afterEach, describe, expect, it} from 'vitest';
import {promisify} from 'node:util';

const execFilePromise = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, {force: true, recursive: true})));
});

describe('Knowledge Delta Git proposal CLI', () => {
  it('exports exact approved replacement bytes without mutating Git or provider state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-git-proposal-cli-'));
    roots.push(root);
    const home = join(root, 'home');
    const worktree = join(root, 'shared');
    await mkdir(worktree, {recursive: true});
    await git(worktree, ['init']);
    await git(worktree, ['config', 'user.email', 'test@example.com']);
    await git(worktree, ['config', 'user.name', 'Threadnote Test']);

    const targetPath = join(worktree, 'durable', 'projects', 'threadnote', 'git-proposal.md');
    await mkdir(join(targetPath, '..'), {recursive: true});
    await writeFile(
      targetPath,
      formatMemoryDocument(
        'MEMORY',
        {
          authority: 'user_approved',
          kind: 'durable',
          memoryId: 'tn_existing_shared_identity',
          project: 'threadnote',
          sourceAgentClient: 'test',
          status: 'active',
          timestamp: '2026-09-16T00:00:00.000Z',
          topic: 'git-proposal',
          trust: 'approved',
          visibility: 'shared',
        },
        'Prior shared contract.',
      ),
      'utf8',
    );
    await git(worktree, ['add', '.']);
    await git(worktree, ['commit', '-m', 'seed shared memory']);
    const baseCommit = await git(worktree, ['rev-parse', 'HEAD']);
    await configureTeam(home, worktree);

    const input: SessionCloseoutInput = {
      decisions: ['Export an approved provider-neutral Git proposal.'],
      evidence: ['test/integration/knowledge-delta-git-proposal-cli.test.ts'],
      outcome: 'Prepared an applied candidate.',
      project: 'threadnote',
      sourceAgentClient: 'test',
      task: 'Exercise share propose',
      topic: 'git-proposal',
    };
    const draft = await run(buildCandidateReview(input, [], new Date('2026-09-17T00:00:00.000Z')));
    const candidate = draft.candidates[0];
    expect(candidate).toBeDefined();
    if (!candidate) throw new Error('Expected a durable candidate.');
    const sourceUri = 'threadnote://user/local/memories/durable/projects/threadnote/git-proposal.md';
    const sourcePath = join(
      home,
      'data',
      'local',
      'user',
      'local',
      'memories',
      'durable',
      'projects',
      'threadnote',
      'git-proposal.md',
    );
    await mkdir(join(sourcePath, '..'), {recursive: true});
    const sourceContent = formatMemoryDocument(
      'MEMORY',
      {
        authority: 'user_approved',
        candidateId: candidate.candidateId,
        kind: 'durable',
        memoryId: 'tn_personal_candidate_identity',
        project: 'threadnote',
        sourceAgentClient: 'test',
        status: 'active',
        timestamp: '2026-09-17T00:00:00.000Z',
        topic: 'git-proposal',
        trust: 'approved',
        visibility: 'personal',
      },
      'Updated shared contract.',
    );
    await writeFile(sourcePath, sourceContent, 'utf8');
    const review = {
      ...draft,
      candidates: [
        {
          ...candidate,
          applyContentHash: sha256HexSync(canonicalMemoryDocumentContent(sourceContent)),
          applyOperation: 'create' as const,
          applyTargetUri: sourceUri,
          state: 'applied' as const,
        },
      ],
    };
    await run(saveCandidateReview(home, review));

    const args = [
      'share',
      'propose',
      '--review-id',
      review.reviewId,
      '--revision',
      String(review.revision),
      '--candidate-id',
      candidate.candidateId,
    ] as const;
    const missingApproval = await runCli(args, home).catch(error => error as CliFailure);
    expect(missingApproval).toMatchObject({code: 1});
    expect(missingApproval.stderr).toContain('requires --approved');

    const artifact = JSON.parse((await runCli([...args, '--approved'], home)).stdout);
    expect(artifact).toMatchObject({
      base: {expectedCommit: baseCommit.trim()},
      files: [
        {
          memory: {id: 'tn_existing_shared_identity'},
          operation: 'replace',
          path: 'durable/projects/threadnote/git-proposal.md',
          targetPrecondition: {expectedMemoryId: 'tn_existing_shared_identity', state: 'present'},
        },
      ],
      knowledgeDelta: {reviewId: review.reviewId, expectedRevision: review.revision},
      type: 'knowledge-delta-git-proposal',
      version: 1,
    });
    expect(JSON.stringify(artifact)).not.toContain(sourceUri);
    expect(artifact.files[0].content).toContain('memory_id: tn_existing_shared_identity');
    expect(artifact.files[0].content).not.toContain('memory_id: tn_personal_candidate_identity');

    const output = join(root, 'exports', 'proposal.json');
    await runCli([...args, '--approved', '--output', output], home);
    expect(JSON.parse(await readFile(output, 'utf8'))).toEqual(artifact);
    expect((await git(worktree, ['rev-parse', 'HEAD'])).trim()).toBe(baseCommit.trim());
    expect((await git(worktree, ['status', '--short'])).trim()).toBe('');

    await writeFile(sourcePath, sourceContent.replace('Updated shared contract.', 'Changed after approval.'), 'utf8');
    const changedSource = await runCli([...args, '--approved'], home).catch(error => error as CliFailure);
    expect(changedSource).toMatchObject({code: 1});
    expect(changedSource.stderr).toContain('applied source changed after approval');

    await writeFile(sourcePath, sourceContent, 'utf8');
    const reviewWithoutApplyHash = {
      ...review,
      candidates: review.candidates.map(({applyContentHash: _applyContentHash, ...item}) => item),
    };
    await run(saveCandidateReview(home, reviewWithoutApplyHash));
    const missingApplyHash = await runCli([...args, '--approved'], home).catch(error => error as CliFailure);
    expect(missingApplyHash).toMatchObject({code: 1});
    expect(missingApplyHash.stderr).toContain('no approved apply content hash');
    await run(saveCandidateReview(home, review));

    const pendingDirectory = join(home, 'data', 'local', 'user', 'local', 'private', 'deferred-code-anchors', 'v1');
    await mkdir(pendingDirectory, {recursive: true, mode: 0o700});
    const pendingPath = join(pendingDirectory, `${sha256HexSync(sourceUri)}.json`);
    await writeFile(pendingPath, '{}\n', 'utf8');
    const pendingCitations = await runCli([...args, '--approved'], home).catch(error => error as CliFailure);
    expect(pendingCitations).toMatchObject({code: 1});
    expect(pendingCitations.stderr).toContain('code citations are still pending');
    expect(pendingCitations.stderr).toContain('finalize-code-refs');
    expect((await git(worktree, ['rev-parse', 'HEAD'])).trim()).toBe(baseCommit.trim());
    expect((await git(worktree, ['status', '--short'])).trim()).toBe('');
  });
});

interface CliFailure extends Error {
  readonly code?: number;
  readonly stderr: string;
}

async function configureTeam(home: string, worktree: string): Promise<void> {
  const share = join(home, 'share');
  await mkdir(share, {recursive: true});
  await writeFile(
    join(share, 'teams.json'),
    `${JSON.stringify(
      {
        defaultTeam: 'default',
        teams: {
          default: {
            addedAt: '2026-09-17T00:00:00.000Z',
            gitdir: join(worktree, '.git'),
            name: 'default',
            remote: 'local-test',
            worktree,
          },
        },
        version: 1,
      },
      undefined,
      2,
    )}\n`,
    'utf8',
  );
}

function runCli(args: readonly string[], home: string) {
  return execFilePromise(process.execPath, [join(process.cwd(), 'src', 'standalone.ts'), ...args], {
    env: {...process.env, NO_COLOR: '1', THREADNOTE_HOME: home, THREADNOTE_USER: 'local'},
  });
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  return (await execFilePromise('git', ['-C', cwd, ...args])).stdout;
}
