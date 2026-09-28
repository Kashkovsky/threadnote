import ts from 'typescript-compiler';
import {builtinModules} from 'node:module';
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Build declaration generation precedes the Effect dependency graph.
import {posix} from 'node:path';

const builtins = new Set(builtinModules);
const sourceExtensions = /\.(?:[cm]?[jt]sx?)$/u;

export function sourceImports(path, content) {
  if (!sourceExtensions.test(path)) return [];
  return [...new Set(ts.preProcessFile(content, true, true).importedFiles.map(item => item.fileName))].sort();
}

export function collectSourceClosure(
  entries,
  {read, exists, workspaces, virtualModules = [], imports = sourceImports},
) {
  const files = new Set();
  const npm = new Set();
  const pending = [...entries];
  const resolveFile = path => {
    const normalized = posix.normalize(path);
    if (normalized.startsWith('../') || posix.isAbsolute(normalized))
      throw new Error(`Import escapes repository: ${path}`);
    const candidates = [normalized];
    if (/\.[cm]?jsx?$/u.test(normalized))
      candidates.push(normalized.replace(/\.[cm]?jsx?$/u, '.ts'), normalized.replace(/\.jsx?$/u, '.tsx'));
    if (!posix.extname(normalized))
      candidates.push(
        ...['.ts', '.tsx', '.js', '/index.ts', '/index.tsx', '/index.js'].map(suffix => normalized + suffix),
      );
    const found = candidates.find(exists);
    if (!found) throw new Error(`Unresolved source input: ${path}`);
    return found;
  };
  while (pending.length) {
    const path = resolveFile(pending.pop());
    if (files.has(path)) continue;
    files.add(path);
    for (const specifier of sourceExtensions.test(path) ? imports(path, read(path)) : []) {
      if (
        specifier.startsWith('node:') ||
        specifier.startsWith('bun:') ||
        builtins.has(specifier) ||
        virtualModules.includes(specifier)
      )
        continue;
      const clean = specifier.split('?')[0];
      if (clean.startsWith('.')) {
        pending.push(posix.join(posix.dirname(path), clean));
        continue;
      }
      const name = clean.startsWith('@') ? clean.split('/').slice(0, 2).join('/') : clean.split('/')[0];
      const workspace = workspaces.get(name);
      if (!workspace) {
        npm.add(name);
        continue;
      }
      const subpath = clean === name ? '.' : `.${clean.slice(name.length)}`;
      const destination = workspace.manifest.exports?.[subpath];
      if (typeof destination !== 'string') throw new Error(`Unsupported or missing workspace export ${specifier}`);
      pending.push(posix.join(workspace.path, destination), `${workspace.path}/package.json`);
    }
  }
  return {files: [...files].sort(), npm: [...npm].sort()};
}
