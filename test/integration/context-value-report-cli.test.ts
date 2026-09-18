import {execFile} from '../helpers/node-child-process.js';
import {mkdir, mkdtemp, readFile, rm, writeFile} from '../helpers/node-fs-promises.js';
import {tmpdir} from '../helpers/node-os.js';
import {join} from '../helpers/node-path.js';
import {formatMemoryDocument, type MemoryMetadata} from '../../src/memory/document.js';
import {buildCandidateReview, saveCandidateReview, type SessionCloseoutInput} from '../../src/memory/candidate.js';
import {runEffect as run} from '../helpers/effect-runtime.js';
import {afterEach, describe, expect, it} from 'vitest';
import {promisify} from 'node:util';

const execFilePromise = promisify(execFile);
const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map(home => rm(home, {force: true, recursive: true})));
});

describe('context health and value report CLI', () => {
  it('returns a bounded empty health report as JSON without creating local state', async () => {
    const home = await makeHome();

    const result = await runCli(['context', 'health', '--project', 'project-a', '--json'], home);

    expect(JSON.parse(result.stdout)).toEqual({
      findings: [],
      limit: 100,
      omittedFindings: 0,
      project: 'project-a',
      recordsScanned: 0,
      semanticCompleteness: {
        analyzedRecords: 0,
        claimsAnalyzed: 0,
        contradictionCount: 0,
        eligibleRecords: 0,
        omittedContradictions: 0,
        pairsCompared: 0,
        state: 'complete',
        unknownReasons: [],
        unknownRecords: 0,
        version: 1,
      },
      status: 'clean',
      version: 1,
    });
    await expect(readFile(join(home, 'data'), 'utf8')).rejects.toThrow();
  });

  it('exposes aggregate and provider-neutral schedule subcommands without installing or syncing', async () => {
    const home = await makeHome();

    const aggregate = JSON.parse(
      (await runCli(['context', 'health', 'aggregate', '--project', 'project-a', '--json'], home)).stdout,
    );
    expect(aggregate).toMatchObject({
      completeSources: 1,
      exitCode: 0,
      sources: [expect.objectContaining({sourceKey: 'personal', state: 'complete'})],
      status: 'clean',
      unknownSources: 0,
    });

    const schedule = JSON.parse(
      (
        await runCli(
          ['context', 'health', 'schedule', '--project', 'project-a', '--cadence-minutes', '60', '--json'],
          home,
        )
      ).stdout,
    );
    expect(schedule).toMatchObject({
      argv: ['context', 'health', 'aggregate', '--project', 'project-a', '--json'],
      cadenceMinutes: 60,
      execution: {network: 'disabled', readOnly: true},
      teams: [],
    });
    await expect(readFile(join(home, 'share'), 'utf8')).rejects.toThrow();
  });

  it('reads only the requested project records and does not rewrite them', async () => {
    const home = await makeHome();
    const projectAPath = await storedMemory(home, 'project-a', 'expired.md', {validTo: '2026-09-16T00:00:00.000Z'});
    await storedMemory(home, 'project-b', 'other.md');
    const before = await readFile(projectAPath, 'utf8');

    const result = await runCli(['context', 'health', '--project', 'project-a', '--json'], home);
    const report = JSON.parse(result.stdout) as {
      readonly findings: readonly {readonly category: string}[];
      readonly recordsScanned: number;
    };

    expect(report).toMatchObject({recordsScanned: 1});
    expect(report.findings).toEqual([expect.objectContaining({category: 'validity-expired'})]);
    expect(await readFile(projectAPath, 'utf8')).toBe(before);
  });

  it('includes preference and smoke records in maintenance health', async () => {
    const home = await makeHome();
    await storedMemoryAt(home, 'preferences/preference.md', 'project-a', 'preference', {
      validTo: '2026-09-16T00:00:00.000Z',
    });
    await storedMemoryAt(home, 'smoke/projects/project-a/smoke.md', 'project-a', 'smoke', {
      reviewAfter: '2026-09-16',
    });

    const result = await runCli(['context', 'health', '--project', 'project-a', '--json'], home);
    const report = JSON.parse(result.stdout);

    expect(report.recordsScanned).toBe(2);
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({category: 'validity-expired'}),
        expect.objectContaining({category: 'review-overdue'}),
      ]),
    );
  });

  it('resolves stable relation aliases across active, inactive, and conflicted records', async () => {
    const home = await makeHome();
    await storedMemory(home, 'project-a', 'source.md', {
      memoryId: 'tn_source',
      relations: [
        {type: 'depends_on', uri: 'threadnote://memory/tn_active'},
        {type: 'depends_on', uri: 'threadnote://memory/tn_inactive'},
        {type: 'depends_on', uri: 'threadnote://memory/tn_conflict'},
      ],
    });
    await storedMemory(home, 'project-a', 'active.md', {memoryId: 'tn_active'}, 'active target');
    await storedMemory(
      home,
      'project-a',
      'inactive.md',
      {
        memoryId: 'tn_inactive',
        status: 'archived',
      },
      'inactive target',
    );
    await storedMemory(home, 'project-a', 'conflict-a.md', {memoryId: 'tn_conflict'}, 'conflict target a');
    await storedMemory(home, 'project-a', 'conflict-b.md', {memoryId: 'tn_conflict'}, 'conflict target b');

    const result = await runCli(['context', 'health', '--project', 'project-a', '--json'], home);
    const categories = JSON.parse(result.stdout).findings.map(
      (finding: {readonly category: string}) => finding.category,
    );

    expect(categories).toContain('relation-target-inactive');
    expect(categories).toContain('relation-target-conflicted');
    expect(categories).not.toContain('relation-target-missing');
  });

  it('surfaces pending candidate contradictions through the production health command', async () => {
    const home = await makeHome();
    const target = await storedMemory(home, 'project-a', 'target.md', {memoryId: 'tn_target'});
    const closeout: SessionCloseoutInput = {
      decisions: ['Replace contradictory guidance after review.'],
      evidence: ['test/integration/context-value-report-cli.test.ts'],
      outcome: 'Prepared a contradiction for review.',
      project: 'project-a',
      sourceAgentClient: 'test',
      task: 'Exercise candidate health evidence',
      topic: 'candidate-health',
    };
    const draft = await run(buildCandidateReview(closeout, [], new Date()));
    const candidate = draft.candidates[0];
    expect(candidate).toBeDefined();
    await run(
      saveCandidateReview(home, {
        ...draft,
        candidates: [
          {
            ...candidate,
            comparison: 'contradiction',
            reason: 'The reviewed candidate contradicts current guidance.',
            recommendation: 'manual_review',
            targetUri: memoryUriForPath(home, target),
          },
        ],
      }),
    );

    const result = await runCli(['context', 'health', '--project', 'project-a', '--json'], home);
    expect(JSON.parse(result.stdout).findings).toEqual(
      expect.arrayContaining([expect.objectContaining({category: 'candidate-contradiction'})]),
    );
  });

  it('requires a report-bound reviewer direction before proposing semantic supersession', async () => {
    const home = await makeHome();
    const stalePath = await storedMemory(
      home,
      'project-a',
      'stale-policy.md',
      {memoryId: 'tn_cli_stale_policy'},
      'Agents must never reuse verified context.',
    );
    const currentPath = await storedMemory(
      home,
      'project-a',
      'current-policy.md',
      {memoryId: 'tn_cli_current_policy'},
      'Agents must reuse verified context.',
    );
    const staleUri = memoryUriForPath(home, stalePath);
    const currentUri = memoryUriForPath(home, currentPath);
    const health = JSON.parse((await runCli(['context', 'health', '--project', 'project-a', '--json'], home)).stdout);
    const finding = health.findings.find(
      (item: {readonly category: string}) => item.category === 'semantic-contradiction',
    );
    expect(finding?.semanticEvidence?.contradictionId).toMatch(/^[0-9a-f]{64}$/u);

    const neutral = JSON.parse(
      (await runCli(['context', 'repair', 'preview', '--project', 'project-a', '--json'], home)).stdout,
    );
    const neutralProposal = neutral.proposals.find(
      (proposal: {readonly findingId: string}) => proposal.findingId === finding.id,
    );
    expect(neutralProposal.mutation.suggestedMutation).toBeUndefined();

    const directed = JSON.parse(
      (
        await runCli(
          [
            'context',
            'repair',
            'preview',
            '--project',
            'project-a',
            '--contradiction-id',
            finding.semanticEvidence.contradictionId,
            '--report-revision',
            neutral.reportRevision,
            '--stale-uri',
            staleUri,
            '--current-uri',
            currentUri,
            '--json',
          ],
          home,
        )
      ).stdout,
    );
    const directedProposal = directed.proposals.find(
      (proposal: {readonly findingId: string}) => proposal.findingId === finding.id,
    );
    expect(directedProposal.mutation.suggestedMutation).toMatchObject({
      designation: {
        contradictionId: finding.semanticEvidence.contradictionId,
        currentUri,
        reportRevision: neutral.reportRevision,
        staleUri,
        type: 'context-health-semantic-direction',
        version: 1,
      },
      kind: 'supersede-memory',
      subjectUri: staleUri,
      supersededByUri: currentUri,
    });
  });

  it('aggregates only selected-project local feedback and leaves it unchanged', async () => {
    const home = await makeHome();
    const feedbackPath = join(home, 'feedback', 'recall-events-v1.jsonl');
    const content = [
      feedback('applied', 'project-a'),
      feedback('useful', 'project-a'),
      feedback('wrong', 'project-b'),
      feedback('pin', 'project-a'),
    ].join('\n');
    await mkdir(join(home, 'feedback'), {recursive: true});
    await writeFile(feedbackPath, `${content}\n`, 'utf8');

    const result = await runCli(['value', 'report', '--project', 'project-a', '--period', '365', '--json'], home);
    const report = JSON.parse(result.stdout) as {
      readonly feedback: {
        readonly pin: number;
        readonly applied: number;
        readonly total: number;
        readonly useful: number;
        readonly wrong: number;
      };
      readonly scope: string;
      readonly type: string;
      readonly version: number;
    };

    expect(report).toMatchObject({
      feedback: {applied: 1, pin: 1, total: 3, useful: 1, wrong: 0},
      scope: 'local',
      type: 'value-report',
      version: 1,
    });
    expect(await readFile(feedbackPath, 'utf8')).toBe(`${content}\n`);
  });

  it('records applied feedback from the normal CLI without storing the query', async () => {
    const home = await makeHome();
    const query = 'Private applied context query';
    const uri = 'threadnote://user/local/memories/durable/projects/project-a/applied.md';

    const result = await runCli(
      ['recall-feedback', uri, '--action', 'applied', '--project', 'project-a', '--query', query],
      home,
    );

    expect(result.stdout).toContain(`Recorded applied feedback for ${uri}.`);
    const stored = await readFile(join(home, 'feedback', 'recall-events-v1.jsonl'), 'utf8');
    expect(stored).toContain('"action":"applied"');
    expect(stored).not.toContain(query);
  });

  it('reports locally observed health and Knowledge Delta activity while setup remains explicitly unavailable', async () => {
    const home = await makeHome();
    await storedMemory(home, 'project-a', 'expired.md', {validTo: '2026-09-16T00:00:00.000Z'});
    const closeout: SessionCloseoutInput = {
      decisions: ['Keep value reporting local and count-only.'],
      evidence: ['test/integration/context-value-report-cli.test.ts'],
      outcome: 'Recorded a reviewed delta.',
      project: 'project-a',
      sourceAgentClient: 'test',
      task: 'Exercise value event aggregation',
      topic: 'value-events',
    };
    const review = await run(buildCandidateReview(closeout, [], new Date()));
    await run(saveCandidateReview(home, review));

    await runCli(['context', 'health', '--project', 'project-a', '--json'], home);
    const result = await runCli(['value', 'report', '--project', 'project-a', '--period', '1', '--json'], home);
    const report = JSON.parse(result.stdout);

    expect(report.health.opened).toBeGreaterThan(0);
    expect(report.knowledgeDelta.proposed).toBe(review.candidates.length);
    expect(report.setup).toEqual({
      availability: 'unavailable',
      completed: 0,
      failed: 0,
      started: 0,
      supportedAgentReuse: 0,
    });
    expect(JSON.stringify(report)).not.toContain('value-events');
    expect(JSON.stringify(report)).not.toContain('context-value-report-cli.test.ts');
  });
});

function feedback(action: 'applied' | 'pin' | 'useful' | 'wrong', project: string): string {
  return JSON.stringify({
    action,
    project,
    queryFingerprint: 'a'.repeat(64),
    rankerVersion: 'test',
    timestamp: '2026-09-16T12:00:00.000Z',
    uri: 'threadnote://user/local/memories/durable/projects/project-a/example.md',
    version: 1,
  });
}

async function makeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'threadnote-context-value-cli-'));
  homes.push(home);
  return home;
}

async function storedMemory(
  home: string,
  project: string,
  name: string,
  overrides: Partial<MemoryMetadata> = {},
  body = 'Stored integration-test memory.',
): Promise<string> {
  return storedMemoryAt(home, `durable/projects/${project}/${name}`, project, 'durable', overrides, body);
}

async function storedMemoryAt(
  home: string,
  relativePath: string,
  project: string,
  kind: MemoryMetadata['kind'],
  overrides: Partial<MemoryMetadata> = {},
  body = 'Stored integration-test memory.',
): Promise<string> {
  const path = join(home, 'data', 'local', 'user', 'local', 'memories', relativePath);
  const metadata: MemoryMetadata = {
    kind,
    project,
    sourceAgentClient: 'test',
    status: 'active',
    timestamp: '2026-09-01T00:00:00.000Z',
    topic: 'context-value-cli',
    ...overrides,
  };
  await mkdir(join(path, '..'), {recursive: true});
  await writeFile(path, formatMemoryDocument(kind === 'handoff' ? 'HANDOFF' : 'MEMORY', metadata, body), 'utf8');
  return path;
}

function memoryUriForPath(home: string, path: string): string {
  const root = join(home, 'data', 'local', 'user', 'local', 'memories');
  return `threadnote://user/local/memories/${path.slice(root.length + 1)}`;
}

function runCli(args: readonly string[], home: string) {
  return execFilePromise(process.execPath, [join(process.cwd(), 'src', 'standalone.ts'), ...args], {
    env: {...process.env, NO_COLOR: '1', THREADNOTE_HOME: home, THREADNOTE_USER: 'local'},
  });
}
