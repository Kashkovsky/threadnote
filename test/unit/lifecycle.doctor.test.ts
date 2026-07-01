import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {memoryProjectConsistencyCheck} from '../../src/lifecycle.js';
import type {RuntimeConfig} from '../../src/types.js';

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
    host: '127.0.0.1',
    manifestPath: join(home, 'manifest.json'),
    openVikingVersion: '0.0.0',
    port: 1933,
    user: 'denyskashkovskyi',
  };
}

function memoriesDir(config: RuntimeConfig): string {
  return join(config.agentContextHome, 'data', 'viking', config.account, 'user', config.user, 'memories');
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
    const check = await memoryProjectConsistencyCheck(config);
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

    const check = await memoryProjectConsistencyCheck(config);
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
    const check = await memoryProjectConsistencyCheck(config);
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
    const check = await memoryProjectConsistencyCheck(config);
    expect(check.status).toBe('ok');
    expect(check.detail).toMatch(/1 project-scoped memories consistent/);
  });

  it('caps the reported sample and notes the remainder', async () => {
    const config = await makeConfig();
    const root = memoriesDir(config);
    for (const project of ['a', 'b', 'c', 'd']) {
      await writeMemory(root, `durable/projects/${project}/m.md`, 'wrong');
    }
    const check = await memoryProjectConsistencyCheck(config);
    expect(check.status).toBe('warn');
    expect(check.detail).toMatch(/^4 memory/);
    expect(check.detail).toContain('+1 more');
  });
});
