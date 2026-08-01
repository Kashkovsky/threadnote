import {Context, Effect, Layer, Option} from 'effect';
import {sha256HexSync} from '../../crypto/sha256.js';
import {CODE_GRAPH_PARSER_FACTS_VERSION} from '../fact_budget.js';
import {BUILTIN_CODE_GRAPH_LANGUAGE_PACKS} from './catalog.generated.js';
import {
  CodeGraphLanguagePackError,
  type CodeGraphExtractionContext,
  type CodeGraphFileMatcher,
  type CodeGraphLanguageMatch,
  type CodeGraphLanguagePack,
  type CodeGraphWorkspace,
  type CodeGraphWorkspaceProject,
} from './types.js';
import type {CodeGraphFileFacts, CodeGraphInventoryFile} from '../types.js';
import {TREE_SITTER_RUNTIME_CACHE_IDENTITY, type TreeSitterRuntime} from '../tree_sitter/runtime.js';
import {mergeCodeGraphWorkspaces, projectForPath} from '../workspace.js';
import {
  augmentRationaleFacts,
  captureRationaleInputs,
  CODE_GRAPH_RATIONALE_EXTRACTOR_VERSION,
  CODE_GRAPH_RATIONALE_INPUT_VERSION,
} from '../rationale.js';

export {CODE_GRAPH_PARSER_FACTS_VERSION} from '../fact_budget.js';

export interface CodeGraphLanguagePackRegistryShape {
  readonly activeCacheIdentities: (paths: readonly string[]) => readonly string[];
  readonly activeDerivationIdentities: (paths: readonly string[]) => readonly string[];
  readonly cacheIdentities: readonly string[];
  readonly cacheIdentityForPath: (path: string) => Option.Option<string>;
  readonly discoverWorkspace: (
    files: readonly CodeGraphInventoryFile[],
  ) => Effect.Effect<CodeGraphWorkspace, CodeGraphLanguagePackError>;
  readonly extractFile: (
    file: CodeGraphInventoryFile,
    projects?: readonly CodeGraphWorkspaceProject[],
  ) => Effect.Effect<CodeGraphFileFacts, CodeGraphLanguagePackError, TreeSitterRuntime>;
  readonly extractRawFile: (
    file: CodeGraphInventoryFile,
    projects?: readonly CodeGraphWorkspaceProject[],
  ) => Effect.Effect<CodeGraphFileFacts, CodeGraphLanguagePackError, TreeSitterRuntime>;
  readonly isResolutionContext: (path: string) => boolean;
  readonly match: (path: string) => Option.Option<CodeGraphLanguageMatch>;
  readonly postprocessFile: (file: CodeGraphInventoryFile, facts: CodeGraphFileFacts) => CodeGraphFileFacts;
  readonly packs: readonly CodeGraphLanguagePack[];
}

export class CodeGraphLanguagePackRegistry extends Context.Service<
  CodeGraphLanguagePackRegistry,
  CodeGraphLanguagePackRegistryShape
>()('threadnote/codeGraph/CodeGraphLanguagePackRegistry') {
  static readonly layer = Layer.succeed(
    CodeGraphLanguagePackRegistry,
    createCodeGraphLanguagePackRegistry(BUILTIN_CODE_GRAPH_LANGUAGE_PACKS),
  );
}

export const BUILTIN_LANGUAGE_PACK_REGISTRY = createCodeGraphLanguagePackRegistry(BUILTIN_CODE_GRAPH_LANGUAGE_PACKS);

export function createCodeGraphLanguagePackRegistry(
  packs: readonly CodeGraphLanguagePack[],
): CodeGraphLanguagePackRegistryShape {
  validatePacks(packs);
  const entries = packs
    .flatMap(pack =>
      pack.files.map(matcher => ({
        cacheIdentity: packCacheIdentity(pack),
        matcher,
        pack,
        priority: matcher.kind === 'extension' ? 1 : matcher.kind === 'basename' ? 2 : 3,
      })),
    )
    .sort((left, right) => right.priority - left.priority);
  const match = (path: string): Option.Option<CodeGraphLanguageMatch> => {
    const normalized = normalizeRepositoryPath(path);
    const basename = normalized.split('/').at(-1)?.toLowerCase() ?? '';
    const entry = entries.find(candidate => matches(candidate.matcher, normalized, basename));
    return entry
      ? Option.some({
          cacheIdentity: entry.cacheIdentity,
          language: entry.matcher.language,
          pack: entry.pack,
          role: entry.matcher.role,
        })
      : Option.none();
  };
  const workspaceDetectors = [...new Set(packs.flatMap(pack => Option.toArray(pack.workspaceDetector)))];
  return {
    activeCacheIdentities: paths =>
      [...new Set(paths.flatMap(path => Option.toArray(Option.map(match(path), value => value.cacheIdentity))))].sort(),
    activeDerivationIdentities: paths =>
      [
        ...new Set(
          paths.flatMap(path => Option.toArray(Option.map(match(path), value => packDerivationIdentity(value.pack)))),
        ),
      ].sort(),
    cacheIdentityForPath: path => Option.map(match(path), value => value.cacheIdentity),
    cacheIdentities: [...new Set(entries.map(entry => entry.cacheIdentity))].sort(),
    discoverWorkspace: files =>
      Effect.forEach(workspaceDetectors, detector => detector.detect(files), {
        concurrency: 1,
      }).pipe(Effect.map(mergeCodeGraphWorkspaces)),
    extractFile: (file, projects = []) =>
      extractRawFile(file, projects).pipe(Effect.map(facts => postprocessFile(file, facts))),
    extractRawFile,
    isResolutionContext: path =>
      Option.match(match(path), {
        onNone: () => false,
        onSome: value => value.role === 'manifest' || value.role === 'workspace',
      }),
    match,
    packs: [...packs],
    postprocessFile,
  };

  function postprocessFile(file: CodeGraphInventoryFile, facts: CodeGraphFileFacts): CodeGraphFileFacts {
    const matched = match(file.path);
    const attributed = Option.isSome(matched) ? {...file, language: matched.value.language} : file;
    return augmentRationaleFacts(attributed, facts);
  }

  function extractRawFile(file: CodeGraphInventoryFile, projects: readonly CodeGraphWorkspaceProject[] = []) {
    const matched = match(file.path);
    if (Option.isNone(matched)) {
      return Effect.fail(new CodeGraphLanguagePackError(`No code graph language pack accepts ${file.path}.`));
    }
    const project = projectForPath(projects, file.path, matched.value.pack.resolutionStrategy.domain);
    const context: CodeGraphExtractionContext = {
      packageName: Option.map(project, value => value.name),
      project,
    };
    const attributed = {...file, language: matched.value.language};
    return matched.value.pack.extractor
      .extract(attributed, context)
      .pipe(Effect.map(facts => captureRationaleInputs(attributed, facts)));
  }
}

export function packCacheIdentity(pack: CodeGraphLanguagePack): string {
  const matchers = pack.files
    .map(matcher => `${matcher.kind}:${matcher.value.toLowerCase()}:${matcher.language}`)
    .sort()
    .join('\n');
  const assets = pack.assets
    .map(asset => `${asset.relativePath}:${asset.sha256}:${asset.abi}:${asset.version}`)
    .sort()
    .join('\n');
  return sha256HexSync(
    [
      'code-graph-language-pack-v3',
      CODE_GRAPH_PARSER_FACTS_VERSION,
      `derivation-inputs:${CODE_GRAPH_RATIONALE_INPUT_VERSION}`,
      `id:${pack.id}`,
      `extractor:${pack.extractor.version}`,
      `parser-runtime:${pack.assets.length > 0 ? TREE_SITTER_RUNTIME_CACHE_IDENTITY : 'pack-owned'}`,
      `files:\n${matchers}`,
      `assets:\n${assets}`,
    ].join('\n'),
  );
}

export function packDerivationIdentity(pack: CodeGraphLanguagePack): string {
  const matchers = pack.files
    .map(matcher => `${matcher.kind}:${matcher.value.toLowerCase()}:${matcher.language}:${matcher.role}`)
    .sort()
    .join('\n');
  return sha256HexSync(
    [
      'code-graph-language-pack-derivation-v1',
      `postprocessors:${CODE_GRAPH_RATIONALE_EXTRACTOR_VERSION}`,
      `id:${pack.id}`,
      `version:${pack.version}`,
      `resolver:${pack.resolutionStrategy.domain}:${pack.resolutionStrategy.version}`,
      `capabilities:${[...pack.capabilities].sort().join(',')}`,
      `files:\n${matchers}`,
    ].join('\n'),
  );
}

function validatePacks(packs: readonly CodeGraphLanguagePack[]): void {
  const ids = new Set<string>();
  const matchers = new Set<string>();
  for (const pack of packs) {
    if (!/^[a-z][a-z0-9-]*$/.test(pack.id)) {
      throw new CodeGraphLanguagePackError(`Invalid code graph language pack id: ${pack.id}.`);
    }
    if (ids.has(pack.id)) throw new CodeGraphLanguagePackError(`Duplicate code graph language pack id: ${pack.id}.`);
    ids.add(pack.id);
    if (pack.files.length === 0) {
      throw new CodeGraphLanguagePackError(`Code graph language pack ${pack.id} does not declare any file matchers.`);
    }
    for (const matcher of pack.files) {
      const key = `${matcher.kind}:${matcher.value.toLowerCase()}`;
      if (matchers.has(key)) {
        throw new CodeGraphLanguagePackError(`Duplicate code graph file matcher: ${key}.`);
      }
      matchers.add(key);
    }
  }
}

function matches(matcher: CodeGraphFileMatcher, path: string, basename: string): boolean {
  const value = matcher.value.toLowerCase();
  if (matcher.kind === 'basename') return basename === value;
  if (matcher.kind === 'path-suffix') return path.toLowerCase().endsWith(value);
  return basename.endsWith(value);
}

function normalizeRepositoryPath(value: string): string {
  return value.replace(/^\.\/+/, '').replace(/\/+/g, '/');
}
