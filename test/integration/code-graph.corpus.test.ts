import {execFileSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {strToU8, zipSync} from 'fflate';
import {Effect} from 'effect';
import {afterEach, describe, expect, test} from 'vitest';
import {CodeGraphIndexer} from '../../src/code_graph/indexer.js';
import {CodeGraphQueryService} from '../../src/code_graph/query.js';
import {runEffect} from '../helpers/effect-runtime.js';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0).reverse()) rmSync(root, {force: true, recursive: true});
});

describe('code graph mixed corpus lifecycle', () => {
  test('indexes tracked text, OpenXML, media metadata, and rationale in one transactional snapshot', async () => {
    const root = temporaryDirectory();
    mkdirSync(join(root, 'docs'), {recursive: true});
    mkdirSync(join(root, 'diagrams'), {recursive: true});
    mkdirSync(join(root, 'src'), {recursive: true});
    writeFileSync(
      join(root, 'docs', 'operations.rst'),
      'Operations\n==========\n\nRetry queues use decorrelated jitter.\n',
    );
    writeFileSync(
      join(root, 'docs', 'handoff.docx'),
      zipSync({
        '[Content_Types].xml': strToU8('<Types/>'),
        'word/document.xml': strToU8(
          '<w:document><w:body><w:p><w:r><w:t>Portable incident handoff checklist</w:t></w:r></w:p></w:body></w:document>',
        ),
      }),
    );
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47], 0);
    writeFileSync(join(root, 'diagrams', 'retry-flow.png'), png);
    writeFileSync(
      join(root, 'src', 'retry.ts'),
      'export function retry() {\n  // WHY: Backoff prevents coordinated retries.\n}\n',
    );
    git(root, ['init']);
    git(root, ['config', 'user.email', 'threadnote@example.test']);
    git(root, ['config', 'user.name', 'Threadnote Test']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'fixture']);
    const home = join(root, '.threadnote-test-home');

    const results = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        const query = yield* CodeGraphQueryService;
        const indexed = yield* indexer.index({cwd: root, threadnoteHome: home});
        const [office, image, rationale] = yield* Effect.all(
          [
            query.inspect({
              cwd: root,
              operation: 'query',
              query: 'portable incident handoff',
              refresh: false,
              threadnoteHome: home,
            }),
            query.inspect({
              cwd: root,
              operation: 'query',
              query: 'retry flow',
              refresh: false,
              threadnoteHome: home,
            }),
            query.inspect({
              cwd: root,
              operation: 'query',
              query: 'coordinated retries backoff why',
              refresh: false,
              threadnoteHome: home,
            }),
          ],
          {concurrency: 1},
        );
        return {image, indexed, office, rationale};
      }),
    );

    expect(results.indexed.snapshot.fileCount).toBe(4);
    expect(results.office.nodes.some(node => node.path === 'docs/handoff.docx')).toBe(true);
    expect(results.image.nodes).toEqual(expect.arrayContaining([expect.objectContaining({kind: 'asset'})]));
    expect(results.rationale.nodes).toEqual(
      expect.arrayContaining([expect.objectContaining({kind: 'rationale', path: 'src/retry.ts'})]),
    );
  });
});

function temporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'threadnote-code-graph-corpus-'));
  temporaryRoots.push(root);
  return root;
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', ['-C', cwd, ...args], {stdio: 'pipe'});
}
