import {buildCandidateReview, saveCandidateReview, type SessionCloseoutInput} from '../../src/memory/candidate.js';
import {execFile} from '../helpers/node-child-process.js';
import {mkdtemp, readFile, rm} from '../helpers/node-fs-promises.js';
import {tmpdir} from '../helpers/node-os.js';
import {join} from '../helpers/node-path.js';
import {runEffect as run} from '../helpers/effect-runtime.js';
import {afterEach, describe, expect, it} from 'vitest';
import {promisify} from 'node:util';

const execFilePromise = promisify(execFile);
const homes: string[] = [];

const input: SessionCloseoutInput = {
  decisions: ['Keep closeout decisions explicit.'],
  evidence: ['test/integration/closeout-cli.test.ts'],
  outcome: 'Added closeout CLI coverage.',
  project: 'threadnote',
  sourceAgentClient: 'test',
  sourceSessionId: 'closeout-cli-test',
  task: 'Exercise candidate closeout commands',
  topic: 'closeout-cli',
};

afterEach(async () => {
  await Promise.all(homes.splice(0).map(home => rm(home, {force: true, recursive: true})));
});

describe('closeout CLI', () => {
  it('previews the bounded KnowledgeDeltaV1 without mutating its review', async () => {
    const {home, review, reviewId, reviewPath} = await storedReview();
    const before = await readFile(reviewPath, 'utf8');

    const result = await runCli(['closeout', 'preview', '--review-id', reviewId, '--json'], home);
    const human = await runCli(['closeout', 'preview', '--review-id', reviewId], home);

    expect(JSON.parse(result.stdout)).toMatchObject({reviewId, revision: 1, type: 'knowledge-delta', version: 1});
    expect(human.stdout).toContain(`Knowledge delta for ${reviewId} (revision 1)`);
    const edited = await runCli(
      [
        'closeout',
        'preview',
        '--review-id',
        reviewId,
        '--candidate-id',
        review.candidates[0]?.candidateId ?? '',
        '--revision',
        '1',
        '--edited-text',
        '## Decisions\n- Preview the reviewed edit.',
        '--json',
      ],
      home,
    );
    expect(JSON.parse(edited.stdout).items[0].mutationPreview.bodyText).toContain('reviewed edit');
    expect(await readFile(reviewPath, 'utf8')).toBe(before);
  });

  it('rejects stale revisions and approval without explicit confirmation', async () => {
    const {home, review, reviewId} = await storedReview();
    const candidateId = review.candidates[0]?.candidateId ?? '';

    const missingApproval = await runCli(
      [
        'closeout',
        'apply',
        '--action',
        'approve',
        '--review-id',
        reviewId,
        '--candidate-id',
        candidateId,
        '--revision',
        '1',
      ],
      home,
    ).catch(error => error as CliFailure);
    expect(missingApproval).toMatchObject({code: 1});
    expect(missingApproval.stderr).toContain('approve requires approved=true');

    const staleRevision = await runCli(
      [
        'closeout',
        'apply',
        '--action',
        'defer',
        '--review-id',
        reviewId,
        '--candidate-id',
        candidateId,
        '--revision',
        '2',
      ],
      home,
    ).catch(error => error as CliFailure);
    expect(staleRevision).toMatchObject({code: 1});
    expect(staleRevision.stderr).toContain('Candidate review revision changed: expected 2, current 1');

    const deferred = await runCli(
      [
        'closeout',
        'apply',
        '--action',
        'defer',
        '--review-id',
        reviewId,
        '--candidate-id',
        candidateId,
        '--revision',
        '1',
      ],
      home,
    );
    expect(deferred.stdout).toContain(`Deferred candidate ${candidateId}`);
  });

  it('persists and projects the exact approved edit', async () => {
    const {home, review, reviewId} = await storedReview();
    const candidateId = review.candidates[0]?.candidateId ?? '';
    const editedText = '## Decisions\n- Persist this exact reviewed edit.';

    const applied = await runCli(
      [
        'closeout',
        'apply',
        '--action',
        'approve',
        '--approved',
        '--review-id',
        reviewId,
        '--candidate-id',
        candidateId,
        '--revision',
        '1',
        '--edited-text',
        editedText,
      ],
      home,
    );
    expect(applied.stdout).toContain('Stored memory:');

    const preview = await runCli(['closeout', 'preview', '--review-id', reviewId, '--json'], home);
    expect(JSON.parse(preview.stdout).items[0]).toMatchObject({
      candidateId,
      mutationPreview: {bodyText: editedText},
      state: 'applied',
    });
    const stored = await readFile(
      join(home, 'data', 'local', 'user', 'local', 'memories', 'durable', 'projects', 'threadnote', 'closeout-cli.md'),
      'utf8',
    );
    expect(stored).toContain(editedText);
    expect(stored).not.toContain('Keep closeout decisions explicit.');
  });
});

interface CliFailure extends Error {
  readonly code?: number;
  readonly stderr: string;
}

async function storedReview() {
  const home = await mkdtemp(join(tmpdir(), 'threadnote-closeout-cli-'));
  homes.push(home);
  const review = await run(buildCandidateReview(input, [], new Date('2026-09-17T10:00:00.000Z')));
  await run(saveCandidateReview(home, review));
  return {
    home,
    review,
    reviewId: review.reviewId,
    reviewPath: join(home, 'threadnote', 'candidates', 'v1', 'reviews', `${review.reviewId}.json`),
  };
}

function runCli(args: readonly string[], home: string) {
  return execFilePromise(process.execPath, [join(process.cwd(), 'src', 'standalone.ts'), ...args], {
    env: {...process.env, NO_COLOR: '1', THREADNOTE_HOME: home, THREADNOTE_USER: 'local'},
  });
}
