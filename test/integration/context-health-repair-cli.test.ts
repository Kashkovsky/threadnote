import {execFile} from '../helpers/node-child-process.js';
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from '../helpers/node-fs-promises.js';
import {tmpdir} from '../helpers/node-os.js';
import {join} from '../helpers/node-path.js';
import {formatMemoryDocument, parseMemoryDocument, type MemoryMetadata} from '../../src/memory/document.js';
import {afterEach, describe, expect, it} from 'vitest';
import {promisify} from 'node:util';

const execFilePromise = promisify(execFile);
const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map(home => rm(home, {force: true, recursive: true})));
});

describe('context health repair CLI', () => {
  it('keeps preview read-only and applies an approved archive idempotently', async () => {
    const home = await makeHome();
    const sourcePath = await storedMemory(home, 'expired', {validTo: '2000-01-01T00:00:00.000Z'});
    const before = await readFile(sourcePath, 'utf8');

    const preview = await runCli(['context', 'repair', 'preview', '--project', 'project-a', '--json'], home);
    const plan = JSON.parse(preview.stdout) as RepairPlan;
    const proposal = plan.proposals.find(item => item.mutation.kind === 'archive-memory');

    expect(proposal).toBeDefined();
    expect(await readFile(sourcePath, 'utf8')).toBe(before);
    await expect(readFile(join(home, 'threadnote', 'context-health-repairs'), 'utf8')).rejects.toThrow();

    const withoutApproval = await runCli(
      [
        'context',
        'repair',
        'apply',
        '--project',
        'project-a',
        '--proposal-id',
        proposal?.proposalId ?? '',
        '--revision',
        proposal?.revision ?? '',
        '--json',
      ],
      home,
    ).catch(error => error as CliFailure);
    expect(withoutApproval).toMatchObject({code: 1});
    expect(withoutApproval.stderr).toContain('requires --approved');

    const args = [
      'context',
      'repair',
      'apply',
      '--project',
      'project-a',
      '--proposal-id',
      proposal?.proposalId ?? '',
      '--revision',
      proposal?.revision ?? '',
      '--approved',
      '--json',
    ] as const;
    const applied = JSON.parse((await runCli(args, home)).stdout);
    const retried = JSON.parse((await runCli(args, home)).stdout);

    expect(applied).toMatchObject({proposalId: proposal?.proposalId, status: 'applied', version: 1});
    expect(retried).toMatchObject({proposalId: proposal?.proposalId, status: 'already-applied', version: 1});
    await expect(readFile(sourcePath, 'utf8')).rejects.toThrow();
    const memoryRoot = join(home, 'data', 'local', 'user', 'local', 'memories');
    const archived = (await readdir(memoryRoot, {recursive: true})).filter(name => name.endsWith('.md'));
    expect(archived.some(name => name.includes('archived'))).toBe(true);
  });

  it('removes only the reviewed missing relation and preserves stable identity', async () => {
    const home = await makeHome();
    const sourcePath = await storedMemory(home, 'source', {
      memoryId: 'tn_source',
      relations: [
        {type: 'depends_on', uri: 'threadnote://memory/tn_missing'},
        {type: 'references', uri: 'threadnote://memory/tn_active'},
      ],
    });
    await storedMemory(home, 'active', {memoryId: 'tn_active'});

    const preview = JSON.parse(
      (await runCli(['context', 'repair', 'preview', '--project', 'project-a', '--json'], home)).stdout,
    ) as RepairPlan;
    const proposal = preview.proposals.find(item => item.mutation.kind === 'remove-relations');
    expect(proposal).toBeDefined();

    const result = JSON.parse(
      (
        await runCli(
          [
            'context',
            'repair',
            'apply',
            '--project',
            'project-a',
            '--proposal-id',
            proposal?.proposalId ?? '',
            '--revision',
            proposal?.revision ?? '',
            '--approved',
            '--json',
          ],
          home,
        )
      ).stdout,
    );
    const updated = parseMemoryDocument('threadnote://memory/source', await readFile(sourcePath, 'utf8'));

    expect(result).toMatchObject({status: 'applied', version: 1});
    expect(updated?.metadata.memoryId).toBe('tn_source');
    expect(updated?.metadata.relations).toEqual([{type: 'references', uri: 'threadnote://memory/tn_active'}]);
  });

  it('reports a stable conflict for a stale proposal revision without writing a journal', async () => {
    const home = await makeHome();
    await storedMemory(home, 'expired', {validTo: '2000-01-01T00:00:00.000Z'});
    const preview = JSON.parse(
      (await runCli(['context', 'repair', 'preview', '--project', 'project-a', '--json'], home)).stdout,
    ) as RepairPlan;
    const proposal = preview.proposals[0];
    expect(proposal).toBeDefined();

    const result = JSON.parse(
      (
        await runCli(
          [
            'context',
            'repair',
            'apply',
            '--project',
            'project-a',
            '--proposal-id',
            proposal?.proposalId ?? '',
            '--revision',
            'f'.repeat(64),
            '--approved',
            '--json',
          ],
          home,
        )
      ).stdout,
    );

    expect(result).toMatchObject({conflict: {code: 'revision-mismatch'}, status: 'conflict', version: 1});
    await expect(readFile(join(home, 'threadnote', 'context-health-repairs'), 'utf8')).rejects.toThrow();
  });
});

interface RepairPlan {
  readonly proposals: readonly {
    readonly mutation: {readonly kind: string};
    readonly proposalId: string;
    readonly revision: string;
  }[];
}

interface CliFailure extends Error {
  readonly code?: number;
  readonly stderr: string;
}

async function makeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'threadnote-context-repair-'));
  homes.push(home);
  return home;
}

async function storedMemory(home: string, topic: string, metadata: Partial<MemoryMetadata> = {}): Promise<string> {
  const directory = join(home, 'data', 'local', 'user', 'local', 'memories', 'durable', 'projects', 'project-a');
  const path = join(directory, `${topic}.md`);
  await mkdir(directory, {recursive: true});
  await writeFile(
    path,
    formatMemoryDocument(
      'MEMORY',
      {
        kind: 'durable',
        memoryId: `tn_${topic}`,
        project: 'project-a',
        sourceAgentClient: 'test',
        status: 'active',
        timestamp: '2026-09-17T00:00:00.000Z',
        topic,
        ...metadata,
      },
      `Body for ${topic}.`,
    ),
    'utf8',
  );
  return path;
}

function runCli(args: readonly string[], home: string) {
  return execFilePromise(process.execPath, [join(process.cwd(), 'src', 'standalone.ts'), ...args], {
    env: {...process.env, NO_COLOR: '1', THREADNOTE_HOME: home, THREADNOTE_USER: 'local'},
  });
}
