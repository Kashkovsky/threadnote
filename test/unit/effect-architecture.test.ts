import {readFile, readdir} from 'node:fs/promises';
import {dirname, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
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

  it('does not depend on Node built-ins in production source', async () => {
    for (const path of await sourceFiles()) {
      const source = await readFile(path, 'utf8');
      expect(source, relative(repoRoot, path)).not.toMatch(
        /(?:from\s+['"]node:|import\s*\(\s*['"]node:|require\s*\(\s*['"]node:)/,
      );
    }
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
});
