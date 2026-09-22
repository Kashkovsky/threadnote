import {expect, it} from 'vitest';
import * as FC from 'fast-check';
import {extractFileFacts} from '../../src/code_graph/extractor.js';
import type {CodeGraphInventoryFile} from '../../src/code_graph/types.js';
import {mkdtempSync, rmSync} from '../helpers/node-fs.js';
import {tmpdir} from '../helpers/node-os.js';
import {join} from '../helpers/node-path.js';

it('loads the TypeScript compiler only for TypeScript extraction, preserving its identity and repeated facts', () => {
  // This contract is process-global module loading, so an isolated CLI boundary is intentional.
  const child = Bun.spawnSync(
    [
      process.execPath,
      '--eval',
      `
const compilerPath = require.resolve('typescript-compiler');
const loaded = () => Object.hasOwn(require.cache, compilerPath);
await import('./src/effect/runtime.ts');
const {extractFileFacts, createRepositoryFactAttributor} = await import('./src/code_graph/extractor.ts');
const {codeGraphLanguagePack} = await import('./src/code_graph/languages/typescript/pack.ts');
const states = [loaded()];
const file = (path, language, content) => ({
  blobId: 'b'.repeat(40), content, contentHash: 'a'.repeat(64), language,
  mode: '100644', path, size: Buffer.byteLength(content), source: 'commit',
});
const manifest = file('package.json', 'npm-manifest', '{"name":"@test/lazy"}');
const documentation = file('README.md', 'markdown', '# Lazy loading');
const nonTypeScriptFacts = [extractFileFacts(manifest), extractFileFacts(documentation)];
const attributed = createRepositoryFactAttributor([manifest, documentation])(nonTypeScriptFacts);
states.push(loaded());
const identityBefore = codeGraphLanguagePack.extractor.version;
const source = file('src/example.ts', 'typescript', 'export function example(value: number) { return value + 1; }');
const first = extractFileFacts(source);
states.push(loaded());
const second = extractFileFacts(source);
states.push(loaded());
const compiler = await import('typescript-compiler');
const compilerVersion = compiler.default.version;
const packageVersion = (await import('typescript-compiler/package.json')).default.version;
const expectedIdentity = new Bun.CryptoHasher('sha256')
  .update('typescript-compiler-v5-bounded-deduplicated-relationship-surface\\ntypescript:' + compilerVersion)
  .digest('hex');
console.log(JSON.stringify({
  states, compilerVersion, packageVersion, expectedIdentity, identityBefore,
  identityAfter: codeGraphLanguagePack.extractor.version,
  repeatedFactsEqual: JSON.stringify(first) === JSON.stringify(second),
  declarations: first.symbols.map(symbol => symbol.name),
  nonTypeScriptNames: attributed.flatMap(facts => facts.symbols.map(symbol => symbol.name)),
}));
`,
    ],
    {cwd: Bun.fileURLToPath(new URL('../..', import.meta.url)), stderr: 'pipe', stdout: 'pipe'},
  );
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  const observed = JSON.parse(child.stdout.toString());
  expect(observed.states).toEqual([false, false, true, true]);
  expect(observed.compilerVersion).toBe(observed.packageVersion);
  expect(observed.identityBefore).toBe(observed.expectedIdentity);
  expect(observed.identityAfter).toBe(observed.identityBefore);
  expect(observed.repeatedFactsEqual).toBe(true);
  expect(observed.declarations).toContain('example');
  expect(observed.nonTypeScriptNames).toEqual(expect.arrayContaining(['@test/lazy', 'Lazy loading']));
});

it('preserves facts and caller inputs across repeated cached-compiler extraction', () => {
  FC.assert(
    FC.property(FC.integer({min: 0, max: 1_000}), FC.integer({min: -100, max: 100}), (suffix, increment) => {
      const content = `export function example${suffix}(value: number) { return value + ${increment}; }`;
      const file: CodeGraphInventoryFile = {
        blobId: 'b'.repeat(40),
        content,
        contentHash: 'a'.repeat(64),
        language: 'typescript',
        mode: '100644',
        path: `src/example-${suffix}.ts`,
        size: Buffer.byteLength(content),
        source: 'commit',
      };
      const before = structuredClone(file);
      const first = extractFileFacts(file);
      extractFileFacts({...file, content: 'export const unrelated = 1;', path: 'src/unrelated.ts'});
      expect(extractFileFacts(file)).toEqual(first);
      expect(file).toEqual(before);
    }),
    {numRuns: 25},
  );
});

it('bundles the lazy compiler for extraction outside the dependency checkout', async () => {
  // The program under test is the Bun bundler and its child-process module boundary.
  const directory = mkdtempSync(join(tmpdir(), 'threadnote-lazy-extractor-'));
  try {
    const result = await Bun.build({
      entrypoints: [Bun.fileURLToPath(new URL('../../src/code_graph/extractor.ts', import.meta.url))],
      outdir: directory,
      target: 'bun',
    });
    expect(result.success, result.logs.map(log => log.message).join('\n')).toBe(true);
    const child = Bun.spawnSync(
      [
        process.execPath,
        '--eval',
        `
const {extractFileFacts} = await import('./extractor.js');
const content = 'export function bundledExample() { return 1; }';
const facts = extractFileFacts({
  blobId: 'b'.repeat(40), content, contentHash: 'a'.repeat(64), language: 'typescript',
  mode: '100644', path: 'src/example.ts', size: Buffer.byteLength(content), source: 'commit',
});
console.log(JSON.stringify(facts.symbols.map(symbol => symbol.name)));
`,
      ],
      {cwd: directory, stderr: 'pipe', stdout: 'pipe'},
    );
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    expect(JSON.parse(child.stdout.toString())).toContain('bundledExample');
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});
