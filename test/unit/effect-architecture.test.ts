import {readFile, readdir} from '../helpers/node-fs-promises.js';
import {builtinModules} from '../helpers/node-module.js';
import {dirname, join, relative} from '../helpers/node-path.js';
import {fileURLToPath} from '../helpers/node-url.js';
import {describe, expect, it} from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sourceRoot = join(repoRoot, 'src');
const codeRoots = ['scripts', 'src', 'test'].map(path => join(repoRoot, path));

async function codeFiles(path: string): Promise<readonly string[]> {
  const files: string[] = [];
  for (const entry of await readdir(path, {withFileTypes: true})) {
    const entryPath = join(path, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await codeFiles(entryPath)));
    } else if (/\.(?:[cm]?js|tsx?)$/.test(entry.name)) {
      files.push(entryPath);
    }
  }
  return files;
}

const sourceFiles = () => codeFiles(sourceRoot);
const nodeBuiltinModules = new Set(
  builtinModules.filter(module => !module.startsWith('bun:')).map(module => module.replace(/^node:/, '')),
);
const moduleSpecifierScanners = {
  js: new Bun.Transpiler({loader: 'js', logLevel: 'error'}),
  jsx: new Bun.Transpiler({loader: 'jsx', logLevel: 'error', tsconfig: {compilerOptions: {jsx: 'react'}}}),
  ts: new Bun.Transpiler({loader: 'ts', logLevel: 'error'}),
  tsx: new Bun.Transpiler({loader: 'tsx', logLevel: 'error', tsconfig: {compilerOptions: {jsx: 'react'}}}),
};

function importedModuleSpecifiers(path: string, source: string): readonly string[] {
  const loader = path.endsWith('.tsx') ? 'tsx' : path.endsWith('.ts') ? 'ts' : path.endsWith('.jsx') ? 'jsx' : 'js';
  return moduleSpecifierScanners[loader].scanImports(source).map(imported => imported.path);
}

function isNodeBuiltinSpecifier(specifier: string): boolean {
  if (specifier.startsWith('node:')) return true;
  const root = specifier.split('/', 1)[0]!;
  return nodeBuiltinModules.has(specifier) || nodeBuiltinModules.has(root);
}

describe('Effect architecture boundaries', () => {
  it('keeps the CLI free of generic Promise workflow bridges', async () => {
    const cli = await readFile(join(sourceRoot, 'effect', 'cli.ts'), 'utf8');
    expect(cli).not.toContain('withRuntimePromise');
    expect(cli).not.toMatch(/\blegacy\s*\(/);
  });

  it('centralizes application Promise lifting in the Effect error adapter', async () => {
    const declarations: string[] = [];
    for (const path of await sourceFiles()) {
      const source = await readFile(path, 'utf8');
      if (/\b(?:const|function)\s+fromPromise\b/.test(source)) {
        declarations.push(relative(repoRoot, path));
      }
    }
    expect(declarations).toEqual(['src/effect/errors.ts']);
  });

  it('keeps raw Promise lifting primitives inside the shared adapters', async () => {
    const allowed = new Set([
      'src/effect/archive.ts',
      'src/effect/ai/isolated-local-model-runtime.ts',
      'src/effect/cli_output.ts',
      'src/effect/console.ts',
      'src/effect/errors.ts',
      'src/effect/system.ts',
      'src/mcp_server.ts',
    ]);
    for (const path of await sourceFiles()) {
      const source = await readFile(path, 'utf8');
      const relativePath = relative(repoRoot, path);
      if (allowed.has(relativePath)) {
        continue;
      }
      expect(source, relativePath).not.toContain('tryPromiseWithConsole');
      expect(source, relativePath).not.toMatch(/\bEffect\.(?:promise|tryPromise)\b/);
    }
  });

  it('does not create internal Effect runtimes in production source', async () => {
    for (const path of await sourceFiles()) {
      const source = await readFile(path, 'utf8');
      expect(source, relative(repoRoot, path)).not.toMatch(/Effect\.(?:runPromise|runFork)\s*\(/);
    }
  });

  it('does not import or require Node built-ins in production source', async () => {
    const importShapes = [
      "import '../helpers/node-fs.js';",
      "import {readFile} from 'fs/promises';",
      "export {join} from '../helpers/node-path.js';",
      "void import('../helpers/node-url.js');",
      "const os = require('os');",
      "import fs = require('fs');",
      "import external from 'external-package';",
      "const ignored = `require('fs') ${`nested ${value}`}`;",
      "import '../helpers/node-crypto.js';",
    ].join('\n');
    expect(importedModuleSpecifiers('builtin-shapes.ts', importShapes).filter(isNodeBuiltinSpecifier)).toEqual([
      'fs/promises',
      'os',
      'fs',
    ]);

    for (const path of await sourceFiles()) {
      const source = await readFile(path, 'utf8');
      expect(importedModuleSpecifiers(path, source).filter(isNodeBuiltinSpecifier), relative(repoRoot, path)).toEqual(
        [],
      );
    }
  });

  it('keeps Bun structural built-ins inside the exact SystemInfo adapters', async () => {
    const accesses: {module: string; path: string}[] = [];
    for (const path of await sourceFiles()) {
      const source = await readFile(path, 'utf8');
      const relativePath = relative(repoRoot, path);
      const mentions = source.match(/\bgetBuiltinModule\b/g)?.length ?? 0;
      expect(mentions, relativePath).toBe(relativePath === 'src/effect/system.ts' ? 3 : 0);
      const calls = [...source.matchAll(/process\.getBuiltinModule\(\s*['"]([^'"]+)['"]\s*\)/g)];
      accesses.push(...calls.map(match => ({module: match[1]!, path: relativePath})));
    }
    expect(accesses).toEqual([
      {module: 'os', path: 'src/effect/system.ts'},
      {module: 'fs', path: 'src/effect/system.ts'},
      {module: 'path', path: 'src/effect/system.ts'},
    ]);

    const system = await readFile(join(sourceRoot, 'effect', 'system.ts'), 'utf8');
    const nativeStatfsStart = system.indexOf('function nativeStatfs');
    const fallbackStart = system.indexOf('export function legacyAvailableDiskBytes');
    const defaultAdaptersStart = system.indexOf('const defaultDiskCapacityProbeAdapters');
    expect(nativeStatfsStart).toBeGreaterThanOrEqual(0);
    expect(fallbackStart).toBeGreaterThan(nativeStatfsStart);
    expect(defaultAdaptersStart).toBeGreaterThan(fallbackStart);
    const nativeStatfs = system.slice(nativeStatfsStart, fallbackStart);
    const fallback = system.slice(fallbackStart, defaultAdaptersStart);
    expect(nativeStatfs).toContain('Effect.tryPromise({');
    expect(nativeStatfs).toContain('nativeFileSystemPromises.statfs!(path, {bigint: true})');
    expect(nativeStatfs).not.toContain('Effect.try({');
    expect(fallback).toContain('Effect.acquireUseRelease(');
    expect(fallback).toContain('Bun.spawn({');
    expect(fallback).toContain('maxBuffer: DISK_QUERY_OUTPUT_LIMIT_BYTES');
    expect(fallback).toContain("child.kill('SIGKILL')");
    expect(fallback).not.toContain('Bun.spawnSync(');
  });

  it('uses only Bun Effect platform adapters in production source', async () => {
    for (const path of await sourceFiles()) {
      const source = await readFile(path, 'utf8');
      expect(source, relative(repoRoot, path)).not.toMatch(
        /@effect\/(?:platform-node|sql-sqlite-node)|\bNode(?:Runtime|Services|HttpClient|HttpServer|Socket|Stdio)\b/,
      );
    }
  });

  it('keeps runtime globals inside the SystemInfo, process-adapter, and executable boundaries', async () => {
    const allowed = new Set([
      'src/effect/ai/isolated-local-model-runtime.ts',
      'src/effect/system.ts',
      'src/standalone.ts',
    ]);
    for (const path of await sourceFiles()) {
      const relativePath = relative(repoRoot, path);
      if (allowed.has(relativePath)) {
        continue;
      }
      const source = await readFile(path, 'utf8');
      expect(source, relativePath).not.toMatch(
        /(?<![$\w])process\.(?:argv|cwd|env|execPath|exitCode|getuid|kill|pid|platform|stdin|stdout)/,
      );
    }
  });

  it('routes console output through the Effect Console service', async () => {
    for (const root of codeRoots) {
      for (const path of await codeFiles(root)) {
        const source = await readFile(path, 'utf8');
        expect(source, relative(repoRoot, path)).not.toMatch(/\bconsole\.(?:debug|error|info|log|warn)\s*\(/);
      }
    }
  });

  it('isolates unstable Effect AI imports inside the AI adapter directory', async () => {
    for (const path of await sourceFiles()) {
      const source = await readFile(path, 'utf8');
      if (!source.includes('effect/unstable/ai')) {
        continue;
      }
      expect(relative(repoRoot, path)).toMatch(/^src\/effect\/ai\//);
    }
  });

  it('isolates node-llama-cpp access inside its native adapter', async () => {
    const allowed = 'src/effect/ai/node-llama-cpp.ts';
    for (const path of await sourceFiles()) {
      const source = await readFile(path, 'utf8');
      if (!/(?:from\s+['"]node-llama-cpp['"]|import\s*\(\s*['"]node-llama-cpp['"]\s*\))/.test(source)) {
        continue;
      }
      expect(relative(repoRoot, path)).toBe(allowed);
    }
  });

  it('keeps application inference crash-isolated in source and release executions', async () => {
    const runtime = await readFile(join(sourceRoot, 'effect', 'runtime.ts'), 'utf8');
    expect(runtime).toContain('isolatedLocalModelRuntimeLayer()');
    expect(runtime).not.toContain('LocalModelRuntime.nativeLayer');
    expect(runtime).not.toContain('THREADNOTE_STANDALONE');
  });

  it('keeps standalone worker dispatch independent from application entry modules', async () => {
    const standalone = await readFile(join(sourceRoot, 'standalone.ts'), 'utf8');
    const workerProtocol = await readFile(join(sourceRoot, 'worker_protocol.ts'), 'utf8');
    const processLease = await readFile(join(sourceRoot, 'standalone_process_lease.ts'), 'utf8');

    expect(standalone).not.toMatch(
      /from ['"]\.\/(?:code_graph\/parser_worker|effect\/ai\/isolated-local-model-runtime|effect\/cli|effect\/runtime|installations|mcp_server|process_diagnostics|threadnote)\.js['"]/,
    );
    expect(standalone).toContain("import('./code_graph/parser_worker.js')");
    expect(standalone).toContain("import('./effect/ai/isolated-local-model-runtime.js')");
    expect(standalone).toContain("import('./effect/runtime.js')");
    expect(standalone).toContain("import('./mcp_server.js')");
    expect(workerProtocol).not.toMatch(/^import\s/m);
    expect(processLease).not.toContain("from './installations.js'");
    expect(processLease).not.toContain("from './utils.js'");
  });
});
