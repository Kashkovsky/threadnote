import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {afterEach, describe, expect, it} from 'vitest';
import {captureConsole} from '../../src/effect/console.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {SystemInfo} from '../../src/effect/system.js';
import {memoryProjectConsistencyCheck, runDoctor} from '../../src/lifecycle.js';
import type {RuntimeConfig} from '../../src/types.js';
import {runEffect} from '../helpers/effect-runtime.js';

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map(home => rm(home, {force: true, recursive: true})));
});

async function makeConfig(): Promise<RuntimeConfig> {
  const home = await mkdtemp(join(tmpdir(), 'threadnote-doctor-'));
  homes.push(home);
  return {
    account: 'local',
    agentContextHome: home,
    agentId: 'threadnote',
    manifestPath: join(home, 'manifest.json'),
    user: 'test-user',
  };
}

function memoriesDir(config: RuntimeConfig): string {
  return join(config.agentContextHome, 'data', config.account, 'user', config.user, 'memories');
}

async function writeMemory(root: string, relPath: string, project: string | undefined): Promise<void> {
  const full = join(root, relPath);
  await mkdir(dirname(full), {recursive: true});
  const header = [
    'MEMORY',
    'kind: durable',
    'status: active',
    project ? `project: ${project}` : undefined,
    'topic: t',
    '',
    'Body.',
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n');
  await writeFile(full, header);
}

describe('memoryProjectConsistencyCheck', () => {
  it('is ok before any memories exist', async () => {
    const config = await makeConfig();
    const check = await runEffect(memoryProjectConsistencyCheck(config));
    expect(check.status).toBe('ok');
    expect(check.detail).toMatch(/no memories directory/);
  });

  it('flags a memory whose frontmatter project differs from its storage path', async () => {
    const config = await makeConfig();
    const root = memoriesDir(config);
    await writeMemory(root, 'durable/projects/mobile-native/consistent.md', 'mobile-native');
    await writeMemory(root, 'durable/projects/general/no-project.md', undefined); // absent project → not flagged
    await writeMemory(root, 'preferences/coding-style.md', 'whatever'); // project-less kind → skipped
    await writeMemory(root, 'shared/docs-desktop/durable/projects/coda/pagerduty.md', 'mobile-native'); // drift

    const check = await runEffect(memoryProjectConsistencyCheck(config));
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('shared/docs-desktop/durable/projects/coda/pagerduty.md');
    expect(check.detail).toContain('frontmatter "mobile-native" vs path "coda"');
    expect(check.detail).toMatch(/^1 memory/); // exactly one divergence
  });

  it('is ok when every project-scoped memory matches its path', async () => {
    const config = await makeConfig();
    const root = memoriesDir(config);
    await writeMemory(root, 'durable/projects/mobile-native/a.md', 'mobile-native');
    await writeMemory(root, 'handoffs/active/threadnote/b.md', 'threadnote');
    await writeMemory(root, 'incidents/active/coda/c.md', 'coda');
    const check = await runEffect(memoryProjectConsistencyCheck(config));
    expect(check.status).toBe('ok');
    expect(check.detail).toMatch(/3 project-scoped memories consistent/);
  });

  it('skips non-.md files, summary sidecars, and unreadable entries without flagging', async () => {
    const config = await makeConfig();
    const root = memoriesDir(config);
    await writeMemory(root, 'durable/projects/coda/real.md', 'coda'); // the only real memory
    await writeMemory(root, 'durable/projects/coda/notes.txt', 'mobile-native'); // not .md → skipped
    await writeMemory(root, 'durable/projects/coda/.overview.md', 'mobile-native'); // sidecar → skipped
    await mkdir(join(root, 'durable/projects/coda/isdir.md'), {recursive: true}); // dir → readFile throws, skipped
    const check = await runEffect(memoryProjectConsistencyCheck(config));
    expect(check.status).toBe('ok');
    expect(check.detail).toMatch(/1 project-scoped memories consistent/);
  });

  it('caps the reported sample and notes the remainder', async () => {
    const config = await makeConfig();
    const root = memoriesDir(config);
    for (const project of ['a', 'b', 'c', 'd']) {
      await writeMemory(root, `durable/projects/${project}/m.md`, 'wrong');
    }
    const check = await runEffect(memoryProjectConsistencyCheck(config));
    expect(check.status).toBe('warn');
    expect(check.detail).toMatch(/^4 memory/);
    expect(check.detail).toContain('+1 more');
  });
});

describe('doctor report resilience', () => {
  effectIt.effect('prints a complete fail-soft report when an individual check cannot read its state', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-doctor-resilience-'});
        const userHome = path.join(root, 'user');
        const threadnoteHome = path.join(userHome, '.threadnote');
        yield* fs.makeDirectory(path.join(threadnoteHome, 'layout.json'), {recursive: true});
        const config: RuntimeConfig = {
          account: 'local',
          agentContextHome: threadnoteHome,
          agentId: 'threadnote',
          manifestPath: path.join(threadnoteHome, 'manifest.yaml'),
          user: 'tester',
        };
        const testSystem = SystemInfo.of({
          ...system,
          environment: () => ({...system.environment(), PATH: ''}),
          homeDirectory: userHome,
        });

        const report = yield* captureConsole(runDoctor(config, {dryRun: true})).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );

        expect(report.output).toContain('Running Threadnote doctor checks.');
        expect(report.output).toContain('FAIL storage layout:');
        expect(report.output).toMatch(/WARN (?:MCP configuration|copilot MCP):/);
        expect(report.output).toContain('WARN codex user instructions:');
        expect(report.output).toContain('FAIL embedding model:');
        expect(report.output).toContain('FAIL vector recall index:');
        expect(report.output).toContain('FAIL lexical recall index:');
        expect(report.output).toContain('Summary: 4 failure(s)');
      }),
    ).pipe(Effect.provide(ApplicationLayer)),
  );
});
