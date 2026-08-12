import {readdirSync, readFileSync} from '../helpers/node-fs.js';
import {join} from '../helpers/node-path.js';
import {describe, expect, it} from 'vitest';

const STORE_DIRECTORY = join(process.cwd(), 'src/code_graph');
const STORE_MODULE_PATTERN = /^store(?:_.*)?\.ts$/u;
const STORE_IMPORT_PATTERN = /\b(?:from|import)\s+['"]\.\/(store(?:_[^'"]*)?)\.js['"]/gu;

function storeModules(): ReadonlyMap<string, string> {
  return new Map(
    readdirSync(STORE_DIRECTORY)
      .filter(name => STORE_MODULE_PATTERN.test(name))
      .sort()
      .map(name => [name, readFileSync(join(STORE_DIRECTORY, name), 'utf8')]),
  );
}

function storeModuleDependencies(modules: ReadonlyMap<string, string>): ReadonlyMap<string, readonly string[]> {
  return new Map(
    [...modules].map(([name, source]) => [
      name,
      [...source.matchAll(STORE_IMPORT_PATTERN)]
        .map(match => `${match[1]}.ts`)
        .filter(dependency => modules.has(dependency)),
    ]),
  );
}

describe('code graph Store module boundaries', () => {
  it('keeps every Store implementation module below 1,000 lines', () => {
    const oversized = [...storeModules()]
      .map(([name, source]) => ({name, lines: source.split('\n').length - (source.endsWith('\n') ? 1 : 0)}))
      .filter(module => module.lines >= 1_000);

    expect(oversized).toEqual([]);
  });

  it('keeps the Store module graph acyclic', () => {
    const modules = storeModules();
    const dependencies = storeModuleDependencies(modules);
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const path: string[] = [];
    const cycles: string[][] = [];

    const visit = (module: string): void => {
      if (visiting.has(module)) {
        const cycleStart = path.indexOf(module);
        cycles.push([...path.slice(cycleStart), module]);
        return;
      }
      if (visited.has(module)) return;
      visiting.add(module);
      path.push(module);
      for (const dependency of dependencies.get(module) ?? []) visit(dependency);
      path.pop();
      visiting.delete(module);
      visited.add(module);
    };

    for (const module of modules.keys()) visit(module);
    expect(cycles).toEqual([]);
  });
});
