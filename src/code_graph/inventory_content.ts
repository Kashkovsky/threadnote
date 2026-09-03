import {Option, Predicate} from 'effect';
import {BUILTIN_LANGUAGE_PACK_REGISTRY, type CodeGraphLanguagePackRegistryShape} from './languages/registry.js';
import {CORPUS_EXTRACTION_SOURCE_BYTES_LIMIT} from './languages/corpus/policy.js';
import {isLowSignalStructuredPath} from './languages/schemas/policy.js';
import type {CodeGraphInventoryFile} from './types.js';

const COMPACT_RESOLUTION_CONTEXT_NAMES = new Set([
  'build.gradle',
  'build.gradle.kts',
  'go.mod',
  'gradle.properties',
  'package.json',
  'package.swift',
  'pom.xml',
  'project.pbxproj',
  'settings.gradle',
  'settings.gradle.kts',
  'tsconfig.json',
]);

export function retainResolutionContext(
  file: CodeGraphInventoryFile,
  languagePacks: CodeGraphLanguagePackRegistryShape,
): CodeGraphInventoryFile {
  const name = file.path.split('/').at(-1)?.toLowerCase() ?? '';
  const content =
    file.content === undefined
      ? undefined
      : (compactResolutionContext(name, file.content) ??
        (languagePacks.isResolutionContext(file.path) && !COMPACT_RESOLUTION_CONTEXT_NAMES.has(name)
          ? file.content
          : undefined));
  if (content !== undefined) {
    return {...file, content};
  }
  const {bytes: _bytes, content: _content, contentOmittedReason: _contentOmittedReason, ...metadata} = file;
  return metadata;
}

function isCorpusContent(path: string, languagePacks: CodeGraphLanguagePackRegistryShape): boolean {
  return Option.match(languagePacks.match(path), {
    onNone: () => false,
    onSome: value => value.role === 'corpus',
  });
}

export function shouldOmitRepositoryContent(
  path: string,
  size: number,
  languagePacks: CodeGraphLanguagePackRegistryShape = BUILTIN_LANGUAGE_PACK_REGISTRY,
): boolean {
  return repositoryContentOmissionReason(path, size, languagePacks) !== undefined;
}

export function repositoryContentOmissionReason(
  path: string,
  size: number,
  languagePacks: CodeGraphLanguagePackRegistryShape,
): CodeGraphInventoryFile['contentOmittedReason'] {
  const match = languagePacks.match(path);
  if (Option.isNone(match)) return undefined;
  if (
    (match.value.language === 'json' || match.value.language === 'jsonc' || match.value.language === 'yaml') &&
    isLowSignalStructuredPath(path)
  ) {
    return 'metadata-only';
  }
  if (match.value.role !== 'corpus') return undefined;
  if (size > CORPUS_EXTRACTION_SOURCE_BYTES_LIMIT) return 'size-budget';
  return match.value.language === 'image' || match.value.language === 'audio' || match.value.language === 'video'
    ? 'metadata-only'
    : undefined;
}

export function acceptsBinaryContent(path: string, languagePacks: CodeGraphLanguagePackRegistryShape): boolean {
  return isCorpusContent(path, languagePacks);
}

function compactResolutionContext(name: string, content: string): string | undefined {
  if (name === 'go.mod') return compactGoModule(content);
  if (name === 'pom.xml') return compactMavenManifest(content);
  if (name === 'settings.gradle' || name === 'settings.gradle.kts') return compactGradleSettings(content);
  if (name === 'build.gradle' || name === 'build.gradle.kts') return compactGradleBuild(content);
  if (name === 'gradle.properties') return '';
  if (name === 'package.swift') return compactSwiftPackage(content);
  if (name === 'project.pbxproj') return compactXcodeProject(content);
  if (name !== 'package.json' && name !== 'tsconfig.json') return undefined;
  try {
    const parsed: unknown = JSON.parse(content);
    if (!Predicate.isObject(parsed)) return undefined;
    if (name === 'package.json') {
      const entry = packageEntryForResolution(parsed.exports, parsed.main);
      const dependencySections = Object.fromEntries(
        ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].flatMap(section => {
          const value = parsed[section];
          if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
          return [
            [
              section,
              Object.fromEntries(
                Object.entries(value).flatMap(([dependency, version]) =>
                  typeof version === 'string' ? [[dependency, version]] : [],
                ),
              ),
            ],
          ];
        }),
      );
      return JSON.stringify({
        ...dependencySections,
        ...(entry === undefined ? {} : {main: entry}),
        ...(typeof parsed.name === 'string' ? {name: parsed.name} : {}),
        ...(typeof parsed.packageManager === 'string' ? {packageManager: parsed.packageManager} : {}),
        ...(Array.isArray(parsed.workspaces)
          ? {workspaces: parsed.workspaces.filter((value): value is string => typeof value === 'string')}
          : Predicate.isObject(parsed.workspaces)
            ? {
                workspaces: {
                  packages: Array.isArray(parsed.workspaces.packages)
                    ? parsed.workspaces.packages.filter((value): value is string => typeof value === 'string')
                    : [],
                },
              }
            : {}),
      });
    }
    const compilerOptions = Predicate.isObject(parsed.compilerOptions) ? parsed.compilerOptions : {};
    const paths = Predicate.isObject(compilerOptions.paths)
      ? Object.fromEntries(
          Object.entries(compilerOptions.paths).flatMap(([alias, targets]) =>
            Array.isArray(targets)
              ? [[alias, targets.filter((target): target is string => typeof target === 'string')]]
              : [],
          ),
        )
      : undefined;
    const compact: Record<string, unknown> = {
      compilerOptions: {
        ...(typeof compilerOptions.baseUrl === 'string' ? {baseUrl: compilerOptions.baseUrl} : {}),
        ...(typeof compilerOptions.outDir === 'string' ? {outDir: compilerOptions.outDir} : {}),
        ...(paths === undefined ? {} : {paths}),
      },
    };
    for (const field of ['exclude', 'files', 'include'] as const) {
      if (Object.prototype.hasOwnProperty.call(parsed, field)) {
        compact[field] = Array.isArray(parsed[field])
          ? parsed[field].filter((value): value is string => typeof value === 'string')
          : parsed[field];
      }
    }
    if (Array.isArray(parsed.references)) {
      compact.references = parsed.references.flatMap(reference =>
        reference && Predicate.isObject(reference) && typeof reference.path === 'string'
          ? [{path: reference.path}]
          : [],
      );
    }
    return JSON.stringify(compact);
  } catch {
    return undefined;
  }
}

function compactGoModule(content: string): string {
  const output: string[] = [];
  let inRequireBlock = false;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    if (/^module\s+\S+/.test(line)) {
      output.push(line);
      continue;
    }
    if (/^require\s*\($/.test(line)) {
      inRequireBlock = true;
      continue;
    }
    if (inRequireBlock && line === ')') {
      inRequireBlock = false;
      continue;
    }
    if (inRequireBlock && /^\S+\s+v\S+/.test(line)) {
      output.push(line);
      continue;
    }
    if (/^require\s+\S+\s+v\S+/.test(line)) output.push(line);
  }
  return `${output.join('\n')}\n`;
}

function compactMavenManifest(content: string): string | undefined {
  const project = content.replace(/<parent\b[\s\S]*?<\/parent>/i, '');
  const group = compactXmlTag(project, 'groupId');
  const artifact = compactXmlTag(project, 'artifactId');
  if (!artifact) return undefined;
  const modules = compactXmlTags(content, 'module');
  const dependencies = [...content.matchAll(/<dependency\b[\s\S]*?<\/dependency>/gi)].flatMap(match => {
    const dependencyArtifact = compactXmlTag(match[0], 'artifactId');
    if (!dependencyArtifact) return [];
    const dependencyGroup = compactXmlTag(match[0], 'groupId');
    return [
      `<dependency>${dependencyGroup ? `<groupId>${dependencyGroup}</groupId>` : ''}<artifactId>${dependencyArtifact}</artifactId></dependency>`,
    ];
  });
  return [
    '<project>',
    group ? `<groupId>${group}</groupId>` : '',
    `<artifactId>${artifact}</artifactId>`,
    modules.length > 0 ? `<modules>${modules.map(module => `<module>${module}</module>`).join('')}</modules>` : '',
    dependencies.length > 0 ? `<dependencies>${dependencies.join('')}</dependencies>` : '',
    '</project>',
  ].join('');
}

function compactGradleSettings(content: string): string {
  return `${content
    .split(/\r?\n/)
    .filter(line => /\brootProject\.name\b|^\s*include\b|\.projectDir\s*=/.test(line))
    .join('\n')}\n`;
}

function compactGradleBuild(content: string): string {
  return `${content
    .split(/\r?\n/)
    .filter(line => /\bproject\s*\(/.test(line))
    .join('\n')}\n`;
}

function compactSwiftPackage(content: string): string | undefined {
  const packageName = /\bPackage\s*\(\s*name\s*:\s*"([^"]+)"/m.exec(content)?.[1];
  const starts = [...content.matchAll(/\.(target|executableTarget|testTarget)\s*\(\s*name\s*:\s*"([^"]+)"/g)];
  if (!packageName && starts.length === 0) return undefined;
  const targets = starts.map((match, index) => {
    const body = content.slice(match.index, starts[index + 1]?.index ?? content.length);
    const path = /\bpath\s*:\s*"([^"]+)"/.exec(body)?.[1];
    const dependencies = /\bdependencies\s*:\s*\[([\s\S]*?)\]/.exec(body)?.[1] ?? '';
    const names = [...dependencies.matchAll(/"([^"]+)"/g)].map(value => value[1]);
    return `.${match[1]}(name: ${JSON.stringify(match[2])}, dependencies: [${names
      .map(name => JSON.stringify(name))
      .join(', ')}]${path ? `, path: ${JSON.stringify(path)}` : ''})`;
  });
  return `let package = Package(name: ${JSON.stringify(packageName ?? 'Package')}, targets: [${targets.join(', ')}])\n`;
}

function compactXcodeProject(content: string): string {
  const targets = [...content.matchAll(/isa\s*=\s*PBXNativeTarget;[\s\S]*?\bname\s*=\s*"?([^";\n]+)"?;/g)].map(match =>
    match[1].trim(),
  );
  return `${targets.map(target => `isa = PBXNativeTarget; name = ${JSON.stringify(target)};`).join('\n')}\n`;
}

function compactXmlTag(content: string, tag: string): string | undefined {
  return new RegExp(`<${tag}(?:\\s[^>]*)?>\\s*([^<]+?)\\s*</${tag}>`, 'i').exec(content)?.[1]?.trim();
}

function compactXmlTags(content: string, tag: string): readonly string[] {
  return [...content.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>\\s*([^<]+?)\\s*</${tag}>`, 'gi'))].map(match =>
    match[1].trim(),
  );
}

function packageEntryForResolution(exportsValue: unknown, mainValue: unknown): string | undefined {
  if (exportsValue === undefined) return typeof mainValue === 'string' ? mainValue : undefined;
  let root: unknown = exportsValue;
  if (Predicate.isObject(exportsValue) && Object.keys(exportsValue).some(key => key.startsWith('.'))) {
    root = exportsValue['.'];
  }
  const targets = new Set(collectResolutionExportTargets(root));
  return targets.size === 1 ? [...targets][0] : undefined;
}

function collectResolutionExportTargets(value: unknown): readonly string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(collectResolutionExportTargets);
  if (typeof value !== 'object' || value === null) return [];
  return Object.values(value).flatMap(collectResolutionExportTargets);
}

export function appearsBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, Math.min(bytes.byteLength, 8192)).includes(0);
}

export function appearsGitLfsPointer(bytes: Uint8Array): boolean {
  if (bytes.byteLength > 1024) return false;
  return new TextDecoder().decode(bytes).startsWith('version https://git-lfs.github.com/spec/v1\n');
}

export function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  } catch {
    return undefined;
  }
}
