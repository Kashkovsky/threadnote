import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Console, Effect, FileSystem, Path} from 'effect';

interface PackageManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly packageManager?: string;
  readonly scripts?: Readonly<Record<string, string>>;
}

const ROOT_URL = new URL('..', import.meta.url);
const EXPECTED_BUN_VERSION = '1.3.14';
const EXPECTED_EFFECT_VERSION = '4.0.0-beta.99';
const EXPECTED_NODE_LLAMA_CPP_VERSION = '3.19.1';
const FORBIDDEN_LEGACY_FILES = [
  '.nvmrc',
  'bin/node-warning-filter.cjs',
  'bin/threadnote.cjs',
  'bin/threadnote-mcp-server.cjs',
  'config/ov.conf.template.json',
  'config/ovcli.conf.template.json',
  'scripts/check-node-version.cjs',
  'scripts/local-ai-server.py',
] as const;
const ALLOWED_LEGACY_RUNTIME_SOURCES = new Set([
  'src/effect/cli.ts',
  'src/lifecycle.ts',
  'src/migration/home.ts',
  'src/migration/legacy-runtime.ts',
  'src/storage/layout.ts',
]);
const ALLOWED_LEGACY_IDENTIFIER_SOURCES = new Set([
  'src/evaluation/recall-fixture.ts',
  'src/memory_hygiene.ts',
  'src/migration/home.ts',
  'src/migration/layout.ts',
  'src/storage/resource-id.ts',
]);

const checkSelfContained = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* path.fromFileUrl(ROOT_URL);
  const failures: string[] = [];

  for (const file of FORBIDDEN_LEGACY_FILES) {
    if (yield* fs.exists(path.join(root, file))) {
      failures.push(`legacy runtime file remains: ${file}`);
    }
  }

  for (const file of yield* sourceFiles(fs, path, path.join(root, 'src'))) {
    const relativePath = normalizePath(path.relative(root, file));
    const content = yield* fs.readFileString(file);
    if (/\b(?:openviking|python|pipx)\b/i.test(content) && !ALLOWED_LEGACY_RUNTIME_SOURCES.has(relativePath)) {
      failures.push(`legacy runtime token outside migration boundary: ${relativePath}`);
    }
    if (/(?:viking:\/\/|data\/viking)/i.test(content) && !ALLOWED_LEGACY_IDENTIFIER_SOURCES.has(relativePath)) {
      failures.push(`legacy identifier or storage path outside compatibility boundary: ${relativePath}`);
    }
    if (/(?:from\s+['"]node:|import\s*\(\s*['"]node:|require\s*\(\s*['"]node:)/.test(content)) {
      failures.push(`Node built-in import in production source: ${relativePath}`);
    }
    if (/from\s+['"](?:@effect\/platform-node|@effect\/sql-sqlite-node)['"]/.test(content)) {
      failures.push(`Node Effect adapter in production source: ${relativePath}`);
    }
    if (/from\s+['"]node-llama-cpp['"]/.test(content) && relativePath !== 'src/effect/ai/node-llama-cpp.ts') {
      failures.push(`raw node-llama-cpp import outside adapter: ${relativePath}`);
    }
  }

  const manifest = yield* fs.readFileString(path.join(root, 'package.json')).pipe(
    Effect.flatMap(content =>
      Effect.try({
        try: () => JSON.parse(content) as PackageManifest,
        catch: cause => new Error('Could not parse package.json.', {cause}),
      }),
    ),
  );
  const allDependencies = {...manifest.dependencies, ...manifest.devDependencies};
  if (manifest.packageManager !== `bun@${EXPECTED_BUN_VERSION}`) {
    failures.push(`packageManager must pin bun@${EXPECTED_BUN_VERSION}`);
  }
  if (manifest.dependencies?.['node-llama-cpp'] !== EXPECTED_NODE_LLAMA_CPP_VERSION) {
    failures.push(`node-llama-cpp must be pinned to ${EXPECTED_NODE_LLAMA_CPP_VERSION}`);
  }
  if (manifest.dependencies?.['@effect/sql-sqlite-bun'] !== EXPECTED_EFFECT_VERSION) {
    failures.push(`@effect/sql-sqlite-bun must be pinned to ${EXPECTED_EFFECT_VERSION}`);
  }
  if (manifest.devDependencies?.['@effect/platform-bun'] !== EXPECTED_EFFECT_VERSION) {
    failures.push(`@effect/platform-bun must be pinned to ${EXPECTED_EFFECT_VERSION}`);
  }
  if (allDependencies['@effect/platform-node'] || allDependencies['@effect/sql-sqlite-node']) {
    failures.push('Node Effect runtime adapters must not be dependencies.');
  }
  const scriptCommands = Object.values(manifest.scripts ?? {}).join('\n');
  if (/\b(?:node|npm|npx)\b/.test(scriptCommands)) {
    failures.push('package scripts must run through Bun only.');
  }

  for (const installer of ['scripts/install.sh', 'scripts/install.ps1'] as const) {
    const content = yield* fs.readFileString(path.join(root, installer));
    if (!content.includes('/releases/download/')) {
      failures.push(`${installer} must install standalone GitHub release artifacts.`);
    }
    if (/\b(?:npm|npx|node_modules)\b/i.test(content)) {
      failures.push(`${installer} still depends on the Node package workflow.`);
    }
  }

  const releaseMetadata = path.join(root, 'dist', 'release.json');
  if (yield* fs.exists(path.join(root, 'dist'))) {
    for (const required of [
      releaseMetadata,
      path.join(root, 'dist', process.platform === 'win32' ? 'threadnote.exe' : 'threadnote'),
      path.join(root, 'dist', 'runtime', 'node-llama-cpp.js'),
      path.join(root, 'dist', 'runtime', 'native'),
    ]) {
      if (!(yield* fs.exists(required))) {
        failures.push(`standalone build output is missing: ${normalizePath(path.relative(root, required))}`);
      }
    }
  }

  if (failures.length > 0) {
    return yield* Effect.fail(new Error(failures.map(failure => `- ${failure}`).join('\n')));
  }
  yield* Console.log('Self-contained Bun source and release checks passed.');
});

const sourceFiles = Effect.fn('checkSelfContained.sourceFiles')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  directory: string,
): Effect.fn.Return<readonly string[]> {
  const output: string[] = [];
  for (const name of yield* fs.readDirectory(directory)) {
    const file = path.join(directory, name);
    const info = yield* fs.stat(file);
    if (info.type === 'Directory') {
      output.push(...(yield* sourceFiles(fs, path, file)));
    } else if (info.type === 'File' && /\.(?:[cm]?js|tsx?)$/.test(name)) {
      output.push(file);
    }
  }
  return output;
});

function normalizePath(value: string): string {
  return value.replaceAll('\\', '/');
}

BunRuntime.runMain(checkSelfContained.pipe(Effect.provide(BunServices.layer)));
