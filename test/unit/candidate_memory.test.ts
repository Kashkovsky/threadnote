import {NodeCrypto, NodePath} from '@effect/platform-node';
import {Effect, FileSystem, Layer, Option} from 'effect';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  appendCandidateAudit,
  buildCandidateReview,
  candidateReviewWithAuditEvent,
  candidateReviewWithState,
  loadCandidateReview,
  readActiveProjectMemories,
  saveCandidateReview,
  type SessionCloseoutInput,
  validateSessionCloseoutInput,
  withCandidateReviewLock,
} from '../../src/candidate_memory.js';
import type {MemoryRecord} from '../../src/memory_document.js';
import {join, mkdir, mkdtemp, readFile, rm, symlink, writeFile} from '../helpers/effect-filesystem.js';
import {runEffect as run} from '../helpers/effect-runtime.js';

const input: SessionCloseoutInput = {
  decisions: ['Keep application workflows Effect-native.'],
  evidence: ['docs/effect.md'],
  handoff: ['Candidate review MCP wiring remains.'],
  invariants: ['Only the executable runtime may run an Effect.'],
  outcome: 'Centralized memory documents.',
  preferences: ['Ask before creating durable memory.'],
  project: 'threadnote',
  sourceAgentClient: 'codex',
  sourceSessionId: 'session-1',
  task: 'Improve recall and memory formation',
  topic: 'recall-memory-formation',
};

function existing(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    body: '## Decisions\n- Use Promise-first workflows.',
    content: '',
    headerTitle: 'MEMORY',
    metadata: {
      kind: 'durable',
      project: 'threadnote',
      sourceAgentClient: 'codex',
      status: 'active',
      timestamp: '2026-07-22T00:00:00.000Z',
      topic: 'recall-memory-formation',
    },
    uri: 'threadnote://user/me/memories/durable/projects/threadnote/recall-memory-formation.md',
    ...overrides,
  };
}

describe('candidate-memory formation', () => {
  it('forms at most three reviewed candidates from a session closeout', async () => {
    const review = await run(buildCandidateReview(input, [], new Date('2026-07-23T10:00:00.000Z')));

    expect(review.candidates).toHaveLength(3);
    expect(review.candidates.map(candidate => candidate.kind)).toEqual(['durable', 'preference', 'handoff']);
    expect(review.candidates.every(candidate => candidate.recommendation === 'create')).toBe(true);
    expect(review.candidates[0]?.proposedText).toContain('## Decisions');
    expect(review.candidates[0]?.proposedText).toContain('## Invariants');
  });

  it('recommends no action for a duplicate stable memory', async () => {
    const draft = await run(
      buildCandidateReview(
        {...input, handoff: [], invariants: [], preferences: []},
        [
          existing({
            body: '## Decisions\n- Keep application workflows Effect-native.',
          }),
        ],
        new Date('2026-07-23T10:00:00.000Z'),
      ),
    );

    expect(draft.candidates[0]).toMatchObject({
      comparison: 'duplicate',
      recommendation: 'no_action',
      targetUri: existing().uri,
    });
  });

  it('flags a changed stable memory as a replacement instead of creating a duplicate', async () => {
    const review = await run(
      buildCandidateReview(
        {...input, handoff: [], invariants: [], preferences: []},
        [existing()],
        new Date('2026-07-23T10:00:00.000Z'),
      ),
    );

    expect(review.candidates[0]).toMatchObject({
      comparison: 'replacement',
      recommendation: 'replace',
      targetContentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      targetUri: existing().uri,
    });
  });

  it('does not form durable candidates without an evidence pointer', async () => {
    const review = await run(
      buildCandidateReview(
        {...input, evidence: [], sourceCommit: undefined, sourceSessionId: undefined},
        [],
        new Date('2026-07-23T10:00:00.000Z'),
      ),
    );

    expect(review.candidates).toEqual([]);
  });

  it('uses the global preference topic as its storage identity across projects', async () => {
    const preference = existing({
      body: '## Preferences\n- Ask before publishing.',
      metadata: {
        kind: 'preference',
        project: 'another-project',
        sourceAgentClient: 'codex',
        status: 'active',
        timestamp: '2026-07-22T00:00:00.000Z',
        topic: 'recall-memory-formation',
      },
      uri: 'threadnote://user/me/memories/preferences/recall-memory-formation.md',
    });
    const review = await run(
      buildCandidateReview(
        {...input, decisions: [], handoff: [], invariants: [], preferences: ['Ask before creating durable memory.']},
        [preference],
        new Date('2026-07-23T10:00:00.000Z'),
      ),
    );

    expect(review.candidates[0]).toMatchObject({
      recommendation: 'replace',
      targetUri: preference.uri,
    });
  });

  it('ignores symlinked memory escapes and cycles during candidate comparison', async () => {
    const scanDirectory = await mkdtemp('threadnote-candidate-scan-');
    try {
      const projectDirectory = join(
        scanDirectory,
        'data',
        'local',
        'user',
        'me',
        'memories',
        'durable',
        'projects',
        'threadnote',
      );
      const outsidePath = join(scanDirectory, 'outside.md');
      const memory = (body: string) =>
        [
          'MEMORY',
          'kind: durable',
          'status: active',
          'project: threadnote',
          'topic: safe-scan',
          'source_agent_client: test',
          'timestamp: 2026-07-23T00:00:00.000Z',
          '',
          body,
        ].join('\n');
      await mkdir(projectDirectory, {recursive: true});
      await writeFile(join(projectDirectory, 'safe.md'), memory('safe candidate comparison'), 'utf8');
      await writeFile(outsidePath, memory('escaped candidate comparison'), 'utf8');
      await symlink(outsidePath, join(projectDirectory, 'escaped.md'));
      await symlink(projectDirectory, join(projectDirectory, 'cycle'), 'dir');

      const records = await run(
        readActiveProjectMemories({account: 'local', agentContextHome: scanDirectory, user: 'me'}, 'threadnote'),
      );

      expect(records.map(record => record.body.trim())).toEqual(['safe candidate comparison']);
    } finally {
      await rm(scanDirectory, {force: true, recursive: true});
    }
  });

  it('normalizes Windows filesystem separators in comparison target URIs', async () => {
    const agentContextHome = 'C:\\context';
    const projectDirectory = 'C:\\context\\data\\local\\user\\me\\memories\\durable\\projects\\threadnote';
    const memoryPath = `${projectDirectory}\\recall.md`;
    const memoryContent = [
      'MEMORY',
      'kind: durable',
      'status: active',
      'project: threadnote',
      'topic: recall-memory-formation',
      'source_agent_client: test',
      'timestamp: 2026-07-23T00:00:00.000Z',
      '',
      '## Decisions',
      '- Keep application workflows Effect-native.',
    ].join('\n');
    const WindowsFileSystemLayer = FileSystem.layerNoop({
      readDirectory: path => Effect.succeed(path === projectDirectory ? ['recall.md'] : []),
      readFileString: () => Effect.succeed(memoryContent),
      realPath: path => Effect.succeed(path),
      stat: path =>
        Effect.succeed({
          atime: Option.none(),
          birthtime: Option.none(),
          blksize: Option.none(),
          blocks: Option.none(),
          dev: 0,
          gid: Option.none(),
          ino: Option.none(),
          mode: 0,
          mtime: Option.none(),
          nlink: Option.none(),
          rdev: Option.none(),
          size: FileSystem.Size(0),
          type: path === memoryPath ? 'File' : 'Directory',
          uid: Option.none(),
        } satisfies FileSystem.File.Info),
    });
    const WindowsTestLayer = Layer.mergeAll(NodeCrypto.layer, NodePath.layerWin32, WindowsFileSystemLayer);
    const records = await Effect.runPromise(
      readActiveProjectMemories({account: 'local', agentContextHome, user: 'me'}, 'threadnote').pipe(
        Effect.provide(WindowsTestLayer),
      ),
    );
    const review = await Effect.runPromise(
      buildCandidateReview(
        {...input, handoff: [], invariants: [], preferences: []},
        records,
        new Date('2026-07-23T10:00:00.000Z'),
      ).pipe(Effect.provide(WindowsTestLayer)),
    );

    expect(records[0]?.uri).toBe('threadnote://user/me/memories/durable/projects/threadnote/recall.md');
    expect(review.candidates[0]).toMatchObject({
      comparison: 'duplicate',
      recommendation: 'no_action',
      targetUri: 'threadnote://user/me/memories/durable/projects/threadnote/recall.md',
    });
  });

  it('rejects unbounded closeout arrays, items, and total payloads', () => {
    expect(validateSessionCloseoutInput({...input, evidence: Array.from({length: 33}, () => 'file.md')})).toContain(
      'evidence exceeds',
    );
    expect(validateSessionCloseoutInput({...input, decisions: ['x'.repeat(2_001)]})).toContain(
      'decisions contains an item',
    );
    expect(
      validateSessionCloseoutInput({
        ...input,
        decisions: Array.from({length: 32}, () => 'é'.repeat(1_100)),
        handoff: Array.from({length: 32}, () => 'é'.repeat(1_100)),
      }),
    ).toContain('UTF-8 bytes');
  });
});

describe('candidate review persistence', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp('threadnote-candidates-');
  });

  afterEach(async () => {
    await rm(directory, {force: true, recursive: true});
  });

  it('persists revisions and appends audit events through Effect FileSystem', async () => {
    const review = await run(buildCandidateReview(input, [], new Date('2026-07-23T10:00:00.000Z')));
    await run(saveCandidateReview(directory, review));
    const loaded = await run(loadCandidateReview(directory, review.reviewId));
    const deferred = candidateReviewWithState(loaded, loaded.candidates[0]?.candidateId ?? '', 'deferred', {
      action: 'defer',
      at: '2026-07-23T10:01:00.000Z',
    });
    await run(saveCandidateReview(directory, deferred));
    const auditPath = join(directory, 'threadnote', 'candidates', 'v1', 'audit.jsonl');

    const persisted = await run(loadCandidateReview(directory, review.reviewId));
    expect(persisted.revision).toBe(2);
    expect(persisted.auditEvents).toEqual([
      {
        action: 'create_review',
        at: '2026-07-23T10:00:00.000Z',
        reviewId: review.reviewId,
        revision: 1,
      },
      {
        action: 'defer',
        at: '2026-07-23T10:01:00.000Z',
        candidateId: deferred.candidates[0]?.candidateId,
        reviewId: deferred.reviewId,
        revision: deferred.revision,
      },
    ]);
    expect(auditPath).toContain('/threadnote/candidates/v1/audit.jsonl');
  });

  it('serializes concurrent decisions for one review and deduplicates audit writes', async () => {
    const trace: string[] = [];
    const locked = (name: string) =>
      withCandidateReviewLock(
        directory,
        'review-lock-test',
        Effect.gen(function* () {
          yield* Effect.sync(() => trace.push(`${name}:start`));
          yield* Effect.sleep(75);
          yield* Effect.sync(() => trace.push(`${name}:end`));
        }),
      );

    await run(Effect.all([locked('first'), locked('second')], {concurrency: 2}));
    expect(trace[0]?.split(':')[0]).toBe(trace[1]?.split(':')[0]);
    expect(trace[2]?.split(':')[0]).toBe(trace[3]?.split(':')[0]);
    expect(trace[0]?.split(':')[0]).not.toBe(trace[2]?.split(':')[0]);

    const event = {
      action: 'apply' as const,
      at: '2026-07-23T10:01:00.000Z',
      candidateId: 'candidate-1',
      reviewId: 'review-lock-test',
      revision: 2,
    };
    const auditPath = await run(appendCandidateAudit(directory, event));
    await run(appendCandidateAudit(directory, event));
    expect((await readFile(auditPath, 'utf8')).trim().split('\n')).toHaveLength(1);
  });

  it('keeps no-op decisions and per-review audit history bounded', async () => {
    const review = await run(buildCandidateReview(input, [], new Date('2026-07-23T10:00:00.000Z')));
    const candidateId = review.candidates[0]?.candidateId ?? '';
    const deferred = candidateReviewWithState(review, candidateId, 'deferred', {
      action: 'defer',
      at: '2026-07-23T10:01:00.000Z',
    });
    expect(
      candidateReviewWithState(deferred, candidateId, 'deferred', {
        action: 'defer',
        at: '2026-07-23T10:02:00.000Z',
      }),
    ).toBe(deferred);

    let bounded = deferred;
    for (let revision = 3; revision <= 180; revision += 1) {
      bounded = candidateReviewWithAuditEvent(bounded, {
        action: 'begin_apply',
        at: `2026-07-23T10:${String(revision).padStart(2, '0')}:00.000Z`,
        candidateId,
        reviewId: review.reviewId,
        revision,
      });
    }
    await run(saveCandidateReview(directory, bounded));
    const persisted = await run(loadCandidateReview(directory, review.reviewId));

    expect(persisted.auditEvents).toHaveLength(100);
    expect(persisted.auditEvents[0]?.action).toBe('create_review');
  });

  it('reconciles a persisted review transition after aggregate audit synchronization fails', async () => {
    const review = await run(buildCandidateReview(input, [], new Date('2026-07-23T10:00:00.000Z')));
    const auditPath = join(directory, 'threadnote', 'candidates', 'v1', 'audit.jsonl');
    await mkdir(auditPath, {recursive: true});

    await expect(run(saveCandidateReview(directory, review))).rejects.toBeDefined();
    await rm(auditPath, {force: true, recursive: true});

    await expect(run(loadCandidateReview(directory, review.reviewId))).resolves.toMatchObject({
      reviewId: review.reviewId,
    });
    expect((await readFile(auditPath, 'utf8')).trim()).toContain('"action":"create_review"');
  });

  it('does not let an old review replay evict newer bounded audit events', async () => {
    const review = await run(buildCandidateReview(input, [], new Date('2020-01-01T00:00:00.000Z')));
    await run(saveCandidateReview(directory, review));
    const auditPath = join(directory, 'threadnote', 'candidates', 'v1', 'audit.jsonl');
    const newerEvents = Array.from({length: 5_000}, (_unused, index) => ({
      action: 'apply' as const,
      at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      candidateId: `candidate-${index}`,
      reviewId: `review-${index}`,
      revision: 2,
    }));
    const boundedAudit = `${newerEvents.map(event => JSON.stringify(event)).join('\n')}\n`;
    await writeFile(auditPath, boundedAudit, 'utf8');

    await run(loadCandidateReview(directory, review.reviewId));

    expect(await readFile(auditPath, 'utf8')).toBe(boundedAudit);
  });

  it('preserves workflow order when audit transitions share a timestamp', async () => {
    const at = '2026-07-23T10:00:00.000Z';
    const reviewId = 'same-timestamp-review';
    for (const [index, action] of ['create_review', 'begin_apply', 'apply', 'defer', 'reject'].entries()) {
      await run(
        appendCandidateAudit(directory, {
          action: action as 'apply' | 'begin_apply' | 'create_review' | 'defer' | 'reject',
          at,
          candidateId: index === 0 ? undefined : `candidate-${index}`,
          reviewId,
          revision: index + 1,
        }),
      );
    }
    const auditPath = join(directory, 'threadnote', 'candidates', 'v1', 'audit.jsonl');
    const actions = (await readFile(auditPath, 'utf8'))
      .trim()
      .split('\n')
      .map(line => (JSON.parse(line) as {readonly action: string}).action);

    expect(actions).toEqual(['create_review', 'begin_apply', 'apply', 'defer', 'reject']);
  });
});
