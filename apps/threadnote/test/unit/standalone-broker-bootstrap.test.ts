import {readFileSync} from '@threadnote/testing/node-fs';
import {dirname, join, relative, resolve} from '@threadnote/testing/node-path';
import {describe, expect, it} from 'vitest';

const repositoryRoot = process.cwd();

describe('standalone broker bootstrap', () => {
  it('selects the broker runtime before importing the application runtime', () => {
    const standaloneSource = readSource('apps/threadnote/src/standalone.ts');
    const applicationProgramStart = standaloneSource.indexOf('async function applicationProgram');
    const brokerBranch = standaloneSource.indexOf('if (isMcpBroker)', applicationProgramStart);
    const brokerRuntimeImport = standaloneSource.indexOf("import('./effect/runtime-bootstrap.js')", brokerBranch);
    const applicationRuntimeImport = standaloneSource.indexOf("import('./effect/runtime.js')", applicationProgramStart);

    expect(applicationProgramStart).toBeGreaterThanOrEqual(0);
    expect(brokerBranch).toBeGreaterThan(applicationProgramStart);
    expect(brokerRuntimeImport).toBeGreaterThan(brokerBranch);
    expect(applicationRuntimeImport).toBeGreaterThan(brokerRuntimeImport);
  });

  it('keeps the broker runtime bootstrap outside heavyweight application domains', () => {
    const bootstrapSource = readSource('apps/threadnote/src/effect/runtime-bootstrap.ts');
    const importSpecifiers = [...bootstrapSource.matchAll(/(?:from\s+|import\()(['"])([^'"]+)\1/gu)].map(
      match => match[2],
    );
    const heavyweightPrefixes = [
      '@threadnote/context',
      '@threadnote/graph',
      '@threadnote/inference',
      '@threadnote/memory',
      '@threadnote/recall',
      '@threadnote/store',
      '../code_graph/',
      '../memory/',
    ];

    expect(importSpecifiers).not.toEqual([]);
    expect(
      importSpecifiers.filter(Boolean).filter(specifier => heavyweightPrefixes.some(p => specifier.startsWith(p))),
    ).toEqual([]);
  });

  it('keeps broker release checks on narrow leaf imports', () => {
    const installationsSource = readSource('apps/threadnote/src/installations.ts');
    const autoUpdateSource = readSource('apps/threadnote/src/release/auto_update.ts');

    expect(installationsSource).toContain("from './release/version/compare.js'");
    expect(installationsSource).not.toContain("from './utils.js'");
    expect(autoUpdateSource).toContain("from '@threadnote/platform/json'");
    expect(autoUpdateSource).not.toContain("from '../utils.js'");
    expect(autoUpdateSource).not.toContain("from './index.js'");
    expect(autoUpdateSource).toContain("import('./index.js')");

    const closure = staticRelativeImportClosure([
      'apps/threadnote/src/effect/runtime-bootstrap.ts',
      'apps/threadnote/src/effect/mcp_broker_process.ts',
      'apps/threadnote/src/process/diagnostics.ts',
      'apps/threadnote/src/process/standalone_lease.ts',
    ]);
    const forbidden = [...closure].filter(
      path =>
        path === 'apps/threadnote/src/effect/runtime.ts' ||
        path === 'apps/threadnote/src/release/index.ts' ||
        path === 'apps/threadnote/src/release/update.ts' ||
        path === 'apps/threadnote/src/utils.ts' ||
        path.startsWith('apps/threadnote/src/code_graph/') ||
        path.startsWith('apps/threadnote/src/memory/'),
    );
    expect(forbidden).toEqual([]);
  });
});

function readSource(path: string): string {
  return readFileSync(join(repositoryRoot, path), 'utf8');
}

function staticRelativeImportClosure(entryPaths: readonly string[]): ReadonlySet<string> {
  const appSourceRoot = resolve(repositoryRoot, 'apps/threadnote/src');
  const queued = entryPaths.map(path => resolve(repositoryRoot, path));
  const visited = new Set<string>();
  while (queued.length > 0) {
    const current = queued.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    const imports = new Bun.Transpiler({loader: 'ts'}).scanImports(readFileSync(current, 'utf8'));
    for (const imported of imports) {
      if (imported.kind !== 'import-statement' || !imported.path.startsWith('.')) continue;
      const candidate = resolve(dirname(current), imported.path.replace(/\.js$/u, '.ts'));
      if (relative(appSourceRoot, candidate).startsWith('..')) continue;
      queued.push(candidate);
    }
  }
  return new Set([...visited].map(path => relative(repositoryRoot, path).replaceAll('\\', '/')));
}
