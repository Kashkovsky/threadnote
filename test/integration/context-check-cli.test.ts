import {execFile} from '../helpers/node-child-process.js';
import {mkdir, mkdtemp, readFile, rm, writeFile} from '../helpers/node-fs-promises.js';
import {tmpdir} from '../helpers/node-os.js';
import {join} from '../helpers/node-path.js';
import {promisify} from 'node:util';
import {afterEach, describe, expect, it} from 'vitest';
import {createMemoryCodeCitation} from '../../src/memory/code_citation.js';
import {sha256HexSync} from '../../src/crypto/sha256.js';
import {formatMemoryDocument} from '../../src/memory/document.js';

const execute = promisify(execFile);
const standalone = join(process.cwd(), 'src', 'standalone.ts');
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true})));
});

describe('context check CLI', () => {
  it('returns clean JSON for an empty diff and uncited changes without creating memory state', async () => {
    const {home, repository} = await fixture();
    for (const changed of [false, true]) {
      if (changed) await writeFile(join(repository, 'new-file.ts'), 'export const added = true;');
      const result = await runCli(['context', 'check', '--project', 'cli-test', '--json'], home, repository);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({exitCode: 0, evidenceStatus: 'complete', findings: []});
    }
    await expect(readFile(join(home, 'data'), 'utf8')).rejects.toThrow();
  });

  it('does not let unrelated project health truncation block an empty diff', async () => {
    const {home, repository} = await fixture();
    const directory = join(home, 'data', 'local', 'user', 'local', 'memories', 'durable', 'projects', 'cli-test');
    await mkdir(directory, {recursive: true});
    await Promise.all(
      Array.from({length: 101}, (_, index) =>
        writeFile(
          join(directory, `expired-${index}.md`),
          formatMemoryDocument(
            'MEMORY',
            {
              kind: 'durable',
              project: 'cli-test',
              sourceAgentClient: 'test',
              status: 'active',
              timestamp: '2026-09-01T00:00:00.000Z',
              topic: `expired-${index}`,
              validTo: '2026-09-16T00:00:00.000Z',
            },
            `Expired unrelated memory ${index}.`,
          ),
        ),
      ),
    );

    const health = await runCli(['context', 'health', '--project', 'cli-test', '--json'], home, repository);
    expect(JSON.parse(health.stdout).omittedFindings).toBe(1);
    const result = await runCli(['context', 'check', '--project', 'cli-test', '--format', 'json'], home, repository);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({evidenceStatus: 'complete', exitCode: 0, findings: []});
  });

  it('supports the provider-neutral --format selector and rejects conflicting selectors', async () => {
    const {home, repository} = await fixture();
    const json = await runCli(['context', 'check', '--project', 'cli-test', '--format', 'json'], home, repository);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({exitCode: 0, evidenceStatus: 'complete'});
    const conflicting = await runCli(
      ['context', 'check', '--project', 'cli-test', '--format', 'text', '--sarif'],
      home,
      repository,
    );
    expect(conflicting.code).toBe(2);
  });

  it('returns exit 2 and sanitized JSON/SARIF when Git evidence is unavailable', async () => {
    const {home, repository} = await fixture();
    for (const format of ['--json', '--sarif']) {
      const result = await runCli(
        ['context', 'check', '--project', 'cli-test', '--base', 'private-missing-ref', format],
        home,
        repository,
      );
      expect(result.code).toBe(2);
      expect(result.stdout).not.toContain('private-missing-ref');
      expect(result.stdout).not.toContain(repository);
      const report = JSON.parse(result.stdout);
      if (format === '--json')
        expect(report).toMatchObject({exitCode: 2, evidenceReason: 'changed-path-evidence-unavailable'});
      else expect(report.runs[0].results[0].ruleId).toBe('threadnote/context-check/evidence-unavailable');
    }
    const invalid = await runCli(['context', 'check', '--project', 'cli-test', '--json', '--sarif'], home, repository);
    expect(invalid.code).toBe(2);
    expect((await runCli(['context', 'check'], home, repository)).code).toBe(2);
    expect((await runCli(['context', 'check', '--project', 'cli-test', '--unknown-flag'], home, repository)).code).toBe(
      2,
    );
    expect((await runCli(['context', 'health'], home, repository)).code).toBe(1);
  });

  it('keeps cold-graph citations unknown and includes the deleted side of a rename', async () => {
    const {home, repository} = await fixture();
    const directory = join(home, 'data', 'local', 'user', 'local', 'memories', 'durable', 'projects', 'cli-test');
    await mkdir(directory, {recursive: true});
    const citation = createMemoryCodeCitation({
      extractorSet: 'test-extractor',
      fileContentHash: {algorithm: 'sha256', value: sha256HexSync('export const before = true;\n')},
      path: 'source.ts',
      repositoryId: sha256HexSync('repository-v1\ngithub.com/example/context-cli-test'),
      repositoryIdentityKind: 'remote',
      sourceCommit: (await execute('git', ['rev-parse', 'HEAD'], {cwd: repository})).stdout.trim(),
      sourceDirty: false,
      sourceSnapshotId: `cgsn_${'a'.repeat(40)}`,
      target: {kind: 'file'},
      version: 1,
    });
    const memoryPath = join(directory, 'example.md');
    await writeFile(
      memoryPath,
      formatMemoryDocument(
        'MEMORY',
        {
          codeCitations: [citation],
          kind: 'durable',
          project: 'cli-test',
          schemaVersion: 5,
          sourceAgentClient: 'test',
          status: 'active',
          timestamp: '2026-09-01T00:00:00.000Z',
          topic: 'example',
        },
        'Private content never emitted by CI.',
      ),
    );
    const before = await readFile(memoryPath, 'utf8');
    await execute('git', ['mv', 'source.ts', 'renamed.ts'], {cwd: repository});
    const result = await runCli(['context', 'check', '--project', 'cli-test', '--json'], home, repository);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout).findings).toEqual(
      expect.arrayContaining([expect.objectContaining({category: 'citation-unknown'})]),
    );
    expect(result.stdout).not.toContain('Private content');
    expect(result.stdout).not.toContain('source.ts');
    expect(result.stdout).not.toContain('threadnote://');
    expect(await readFile(memoryPath, 'utf8')).toBe(before);
  });

  it('returns actionable exit 1 for an affected citation with exact-current changed evidence', async () => {
    const {home, repository} = await fixture();
    expect((await runCli(['graph', 'index', '--cwd', repository, '--json'], home, repository)).code).toBe(0);
    const remember = await runCli(
      [
        'remember',
        '--project',
        'cli-test',
        '--topic',
        'verified',
        '--text',
        'An invariant.',
        '--code-ref',
        'source.ts',
        '--require-current-code-refs',
      ],
      home,
      repository,
    );
    expect(remember.code, remember.stderr).toBe(0);
    await writeFile(join(repository, 'source.ts'), 'export const after = false;\n');
    expect((await runCli(['graph', 'index', '--cwd', repository, '--json'], home, repository)).code).toBe(0);
    const result = await runCli(['context', 'check', '--project', 'cli-test', '--json'], home, repository);
    expect(result.code, result.stdout).toBe(1);
    expect(JSON.parse(result.stdout).findings).toEqual(
      expect.arrayContaining([expect.objectContaining({category: 'citation-changed'})]),
    );
  }, 60_000);
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'threadnote-context-check-'));
  roots.push(root);
  const home = join(root, 'home');
  const repository = join(root, 'repo');
  await mkdir(home);
  await mkdir(repository);
  await execute('git', ['init', '-q'], {cwd: repository});
  await execute('git', ['remote', 'add', 'origin', 'https://github.com/example/context-cli-test.git'], {
    cwd: repository,
  });
  await writeFile(join(repository, 'source.ts'), 'export const before = true;\n');
  await execute('git', ['add', 'source.ts'], {cwd: repository});
  await execute('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'], {
    cwd: repository,
  });
  return {home, repository};
}

async function runCli(args: readonly string[], home: string, cwd: string) {
  try {
    const output = await execute(process.execPath, [standalone, ...args], {
      cwd,
      env: {...process.env, NO_COLOR: '1', THREADNOTE_HOME: home, THREADNOTE_USER: 'local'},
      maxBuffer: 2_097_152,
    });
    return {...output, code: 0};
  } catch (error) {
    return error as {code: number; stdout: string; stderr: string};
  }
}
