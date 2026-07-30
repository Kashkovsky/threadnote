import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Console, Effect, FileSystem, Path} from 'effect';
import {sha256FileHex} from '../src/effect/digest.js';

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
const EXPECTED_TYPESCRIPT_COMPILER_VERSION = 'npm:typescript@5.9.3';
const EXPECTED_WEB_TREE_SITTER_VERSION = '0.26.11';
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
  'src/migration/legacy-installations.ts',
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
  yield* validateCodeGraphAssets(fs, path, path.join(root, 'assets', 'code-graph'), failures);

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
  if (manifest.dependencies?.['typescript-compiler'] !== EXPECTED_TYPESCRIPT_COMPILER_VERSION) {
    failures.push(`typescript-compiler must be pinned to ${EXPECTED_TYPESCRIPT_COMPILER_VERSION}`);
  }
  if (manifest.dependencies?.['web-tree-sitter'] !== EXPECTED_WEB_TREE_SITTER_VERSION) {
    failures.push(`web-tree-sitter must be pinned to ${EXPECTED_WEB_TREE_SITTER_VERSION}`);
  }
  if (manifest.devDependencies?.['@effect/platform-bun'] !== EXPECTED_EFFECT_VERSION) {
    failures.push(`@effect/platform-bun must be pinned to ${EXPECTED_EFFECT_VERSION}`);
  }
  if (allDependencies['@effect/platform-node'] || allDependencies['@effect/sql-sqlite-node']) {
    failures.push('Node Effect runtime adapters must not be dependencies.');
  }
  if (allDependencies.graphify) {
    failures.push('Graphify must not be a runtime or development dependency.');
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
      path.join(root, 'dist', 'assets', 'code-graph', 'manifest.json'),
      path.join(root, 'dist', 'assets', 'code-graph', 'runtime', 'web-tree-sitter.wasm'),
      path.join(root, 'dist', 'assets', 'code-graph', 'grammars', 'java.wasm'),
      path.join(root, 'dist', 'assets', 'code-graph', 'grammars', 'kotlin.wasm'),
      path.join(root, 'dist', 'assets', 'code-graph', 'grammars', 'swift.wasm'),
      path.join(root, 'dist', 'assets', 'code-graph', 'licenses', 'tree-sitter-java.LICENSE'),
      path.join(root, 'dist', 'assets', 'code-graph', 'licenses', 'tree-sitter-kotlin.LICENSE'),
      path.join(root, 'dist', 'assets', 'code-graph', 'licenses', 'tree-sitter-swift.LICENSE'),
      path.join(root, 'dist', 'assets', 'code-graph', 'licenses', 'web-tree-sitter.LICENSE'),
    ]) {
      if (!(yield* fs.exists(required))) {
        failures.push(`standalone build output is missing: ${normalizePath(path.relative(root, required))}`);
      }
    }
    if (yield* fs.exists(path.join(root, 'dist', 'assets', 'code-graph', 'manifest.json'))) {
      yield* validateCodeGraphAssets(fs, path, path.join(root, 'dist', 'assets', 'code-graph'), failures);
    }
    if (yield* fs.exists(releaseMetadata)) {
      const metadata = yield* parseJsonFile(fs, releaseMetadata);
      if (
        !isRecord(metadata) ||
        !isRecord(metadata.codeGraphAssets) ||
        metadata.codeGraphAssets.manifest !== 'assets/code-graph/manifest.json' ||
        metadata.codeGraphAssets.version !== 1
      ) {
        failures.push('dist/release.json does not declare the verified code graph asset manifest');
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

const validateCodeGraphAssets = Effect.fn('checkSelfContained.validateCodeGraphAssets')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  failures: string[],
) {
  const manifestPath = path.join(root, 'manifest.json');
  if (!(yield* fs.exists(manifestPath))) {
    failures.push(`code graph asset manifest is missing: ${manifestPath}`);
    return;
  }
  const manifest = yield* parseJsonFile(fs, manifestPath);
  if (!isRecord(manifest) || manifest.version !== 1 || !isRecord(manifest.runtime) || !isRecord(manifest.grammars)) {
    failures.push(`code graph asset manifest is invalid: ${manifestPath}`);
    return;
  }
  const expected = [
    {id: 'web-tree-sitter', metadata: manifest.runtime, path: 'runtime/web-tree-sitter.wasm', runtime: true},
    {id: 'java', metadata: manifest.grammars.java, path: 'grammars/java.wasm', runtime: false},
    {id: 'kotlin', metadata: manifest.grammars.kotlin, path: 'grammars/kotlin.wasm', runtime: false},
    {id: 'swift', metadata: manifest.grammars.swift, path: 'grammars/swift.wasm', runtime: false},
  ] as const;
  for (const asset of expected) {
    if (
      !isRecord(asset.metadata) ||
      asset.metadata.path !== asset.path ||
      typeof asset.metadata.version !== 'string' ||
      typeof asset.metadata.source !== 'string' ||
      !asset.metadata.source.startsWith('https://github.com/') ||
      typeof asset.metadata.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(asset.metadata.sha256) ||
      (!asset.runtime && (!Number.isInteger(asset.metadata.abi) || Number(asset.metadata.abi) <= 0))
    ) {
      failures.push(`code graph asset metadata is invalid for ${asset.id}`);
      continue;
    }
    const assetPath = path.join(root, ...asset.path.split('/'));
    if (!(yield* fs.exists(assetPath))) {
      failures.push(`code graph asset is missing: ${asset.path}`);
      continue;
    }
    if ((yield* sha256FileHex(assetPath)) !== asset.metadata.sha256) {
      failures.push(`code graph asset checksum does not match: ${asset.path}`);
    }
  }
  for (const license of [
    'tree-sitter-java.LICENSE',
    'tree-sitter-kotlin.LICENSE',
    'tree-sitter-swift.LICENSE',
    'web-tree-sitter.LICENSE',
  ]) {
    if (!(yield* fs.exists(path.join(root, 'licenses', license)))) {
      failures.push(`code graph asset license is missing: ${license}`);
    }
  }
});

function parseJsonFile(fs: FileSystem.FileSystem, path: string): Effect.Effect<unknown> {
  return fs.readFileString(path).pipe(
    Effect.flatMap(content =>
      Effect.try({
        try: () => JSON.parse(content) as unknown,
        catch: cause => new Error(`Could not parse JSON file ${path}.`, {cause}),
      }),
    ),
    Effect.catch(() => Effect.succeed(undefined)),
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

BunRuntime.runMain(checkSelfContained.pipe(Effect.provide(BunServices.layer)));
