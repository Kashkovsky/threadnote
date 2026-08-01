import {Option} from 'effect';
import {describe, expect, it} from 'vitest';
import {extractFileFacts, TYPESCRIPT_DYNAMIC_RELATIONSHIP_LIMIT} from '../../src/code_graph/extractor.js';
import {extractStructuredSchemaFacts} from '../../src/code_graph/languages/schemas/extractor.js';
import type {CodeGraphInventoryFile} from '../../src/code_graph/types.js';

describe('code graph per-file extraction budgets', () => {
  it('bounds pathological TypeScript calls while preserving imports, reexports, and later declarations', () => {
    const calls = Array.from({length: TYPESCRIPT_DYNAMIC_RELATIONSHIP_LIMIT + 2_000}, () => 'dependency();');
    const content = [
      'import {dependency} from "./dependency.js";',
      'export function generated(): void {',
      ...calls,
      '}',
      'export {dependency as forwarded} from "./dependency.js";',
      'export interface PreservedAfterBudget { readonly value: string }',
    ].join('\n');
    const startedAt = performance.now();
    const facts = extractFileFacts(sourceFile('src/generated.ts', 'typescript', content));
    const duration = performance.now() - startedAt;

    expect(facts.edges.filter(edge => edge.relation === 'calls')).toHaveLength(1);
    expect(facts.references?.filter(reference => reference.relation === 'calls')).toHaveLength(1);
    expect(facts.edges.some(edge => edge.relation === 'imports' && edge.targetName === './dependency.js')).toBe(true);
    expect(facts.edges.some(edge => edge.relation === 'reexports' && edge.targetName === './dependency.js')).toBe(true);
    expect(facts.symbols.some(symbol => symbol.name === 'PreservedAfterBudget')).toBe(true);
    expect(facts.diagnostics.join('\n')).toContain('call and construct relationships were bounded');
    expect(extractFileFacts(sourceFile('src/generated.ts', 'typescript', content))).toEqual(facts);
    expect(duration).toBeLessThan(5_000);
  });

  it('uses declaration-surface extraction for multi-megabyte generated TypeScript', () => {
    const content = [
      `/* ${'generated '.repeat(240_000)} */`,
      'import {dependency} from "./dependency.js";',
      'export function preserved(): void { dependency(); }',
      'export {dependency as forwarded} from "./dependency.js";',
    ].join('\n');
    const facts = extractFileFacts(sourceFile('src/huge-generated.ts', 'typescript', content));

    expect(facts.symbols.some(symbol => symbol.name === 'preserved')).toBe(true);
    expect(facts.edges.some(edge => edge.relation === 'imports')).toBe(true);
    expect(facts.edges.some(edge => edge.relation === 'reexports')).toBe(true);
    expect(facts.edges.some(edge => edge.relation === 'calls')).toBe(false);
    expect(facts.diagnostics.join('\n')).toContain('declaration-surface extraction');
  });

  it.each([
    ['json', 'data/large.json', (padding: string) => `{"root":{"preserved":1},"payload":"${padding}"}`],
    [
      'jsonc',
      'data/large.jsonc',
      (padding: string) => `// retained comment\n{"root":{"preserved":1},"payload":"${padding}"}`,
    ],
    ['yaml', 'data/large.yaml', (padding: string) => `root:\n  preserved: value\npayload: ${padding}`],
  ] as const)('indexes large unknown generic %s as bounded metadata', (language, path, buildContent) => {
    const facts = extractStructuredSchemaFacts(
      sourceFile(path, language, buildContent('x'.repeat(5 * 1_024 * 1_024))),
      {
        packageName: Option.none(),
        project: Option.none(),
      },
    );

    expect(facts.symbols.map(symbol => symbol.name)).toEqual([path]);
    expect(facts.diagnostics.join('\n')).toContain('module metadata only');
  });

  it('keeps recognized multi-megabyte configs fully structured within their safety budget', () => {
    const content = `{"architecture":{"runtime":{"owner":"platform"}},"payload":"${'x'.repeat(5 * 1_024 * 1_024)}"}`;
    const facts = extractStructuredSchemaFacts(sourceFile('config/runtime-config.json', 'json', content), {
      packageName: Option.none(),
      project: Option.none(),
    });

    expect(facts.symbols.map(symbol => symbol.name)).toEqual(
      expect.arrayContaining(['architecture', 'runtime', 'owner', 'payload']),
    );
    expect(facts.diagnostics).toEqual([]);
  });

  it('locates quoted, escaped, and duplicate JSON keys in one linear source pass', () => {
    const content = [
      '{',
      '  "ordinary": 1,',
      '  "escaped\\u0020key": {',
      '    "duplicate": {"duplicate": 2}',
      '  }',
      '}',
    ].join('\n');
    const facts = extractStructuredSchemaFacts(sourceFile('config/locations.json', 'json', content), {
      packageName: Option.none(),
      project: Option.none(),
    });

    expect(facts.symbols.find(symbol => symbol.name === 'ordinary')?.span).toMatchObject({
      column: 4,
      endColumn: 12,
      line: 2,
    });
    expect(facts.symbols.find(symbol => symbol.name === 'escaped key')?.span).toMatchObject({
      column: 4,
      endColumn: 20,
      line: 3,
    });
    expect(facts.symbols.filter(symbol => symbol.name === 'duplicate').map(symbol => symbol.span.line)).toEqual([4, 4]);
    expect(facts.symbols.filter(symbol => symbol.name === 'duplicate').map(symbol => symbol.span.column)).toEqual([
      6, 20,
    ]);
  });

  it('shallow-extracts recognized configs above the full-structure safety budget', () => {
    const content = `{"architecture":{"owner":"runtime"},"payload":"${'x'.repeat(17 * 1_024 * 1_024)}"}`;
    const facts = extractStructuredSchemaFacts(sourceFile('config/architecture-schema.json', 'json', content), {
      packageName: Option.none(),
      project: Option.none(),
    });

    expect(facts.symbols.map(symbol => symbol.name)).toEqual(
      expect.arrayContaining(['architecture', 'owner', 'payload']),
    );
    expect(facts.symbols.length).toBeLessThanOrEqual(129);
    expect(facts.diagnostics.join('\n')).toContain('bounded shallow extraction');
  });

  it('keeps a 25 MiB generic JSON file searchable without materializing its object graph', () => {
    const content = `{"architecture":{"owner":"runtime"},"payload":"${'x'.repeat(25 * 1_024 * 1_024)}"}`;
    const startedAt = performance.now();
    const facts = extractStructuredSchemaFacts(sourceFile('data/large.json', 'json', content), {
      packageName: Option.none(),
      project: Option.none(),
    });
    const duration = performance.now() - startedAt;

    expect(facts.symbols.map(symbol => symbol.name)).toEqual(['data/large.json']);
    expect(facts.diagnostics.join('\n')).toContain('module metadata only');
    expect(duration).toBeLessThan(1_000);
  });

  it.each([
    'test/__snapshots__/api.json',
    'test/golden/render.json',
    'fixtures/events.json',
    'logs/oplog/session.json',
    'evaluation/results.json',
    'datasets/prompts.json',
    'assets/animations/loading.json',
  ])('keeps low-signal structured corpus metadata-only by default: %s', path => {
    const facts = extractStructuredSchemaFacts(sourceFile(path, 'json', '{"frames":[{"value":1}]}'), {
      packageName: Option.none(),
      project: Option.none(),
    });

    expect(facts.symbols.map(symbol => symbol.name)).toEqual([path]);
    expect(facts.diagnostics.join('\n')).toContain('module metadata only');
  });

  it('extracts low-signal structured metadata without receiving its payload', () => {
    const path = 'test/__snapshots__/large.json';
    const facts = extractStructuredSchemaFacts(
      {
        blobId: 'blob:snapshot',
        contentHash: 'snapshot-hash',
        contentOmittedReason: 'metadata-only',
        language: 'json',
        mode: '100644',
        path,
        size: 25 * 1_024 * 1_024,
        source: 'commit',
      },
      {packageName: Option.none(), project: Option.none()},
    );

    expect(facts.symbols.map(symbol => symbol.name)).toEqual([path]);
    expect(facts.diagnostics.join('\n')).toContain('module metadata only');
  });

  it('keeps dedicated package manifests fully functional above the generic config threshold', () => {
    const content = JSON.stringify({
      dependencies: {'@fixture/runtime': '1.0.0'},
      name: '@fixture/large-manifest',
      padding: 'x'.repeat(5 * 1_024 * 1_024),
    });
    const facts = extractFileFacts(sourceFile('package.json', 'npm-manifest', content));

    expect(facts.symbols).toEqual(expect.arrayContaining([expect.objectContaining({name: '@fixture/large-manifest'})]));
    expect(facts.edges).toEqual(
      expect.arrayContaining([expect.objectContaining({relation: 'depends_on', targetName: '@fixture/runtime'})]),
    );
  });
});

function sourceFile(path: string, language: string, content: string): CodeGraphInventoryFile {
  return {
    blobId: `blob:${path}`,
    content,
    contentHash: `hash:${path}`,
    language,
    mode: '100644',
    path,
    size: Buffer.byteLength(content),
    source: 'commit',
  };
}
