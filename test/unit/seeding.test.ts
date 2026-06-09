import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {runSeedSkills} from '../../src/seeding.js';
import type {RuntimeConfig} from '../../src/types.js';

async function captureConsole(action: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  console.log = (...args: readonly unknown[]) => lines.push(args.map(String).join(' '));
  console.warn = (...args: readonly unknown[]) => lines.push(args.map(String).join(' '));
  console.error = (...args: readonly unknown[]) => lines.push(args.map(String).join(' '));
  try {
    await action();
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
  return lines.join('\n');
}

describe('seed-skills', () => {
  const homes: string[] = [];
  const originalHome = process.env.HOME;

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await Promise.all(homes.splice(0).map(home => rm(home, {force: true, recursive: true})));
  });

  it('discovers global and repo-local Claude command markdown files', async () => {
    const home = await mkdtemp(join(tmpdir(), 'threadnote-seed-skills-home-'));
    const contextHome = await mkdtemp(join(tmpdir(), 'threadnote-seed-skills-context-'));
    const repo = await mkdtemp(join(tmpdir(), 'threadnote-seed-skills-repo-'));
    homes.push(home, contextHome, repo);
    process.env.HOME = home;

    await mkdir(join(home, '.claude', 'commands'), {recursive: true});
    await writeFile(join(home, '.claude', 'commands', 'weekly.md'), '# Weekly\n\nSummarize the week.\n');
    await mkdir(join(repo, '.claude', 'commands'), {recursive: true});
    await writeFile(join(repo, '.claude', 'commands', 'review-pr.md'), '# Review PR\n\nReview the current PR.\n');
    const manifestPath = join(contextHome, 'seed-manifest.yaml');
    await writeFile(
      manifestPath,
      [
        'version: 1',
        'projects:',
        '  - name: sample-repo',
        `    path: ${repo}`,
        '    uri: viking://resources/repos/sample-repo',
        '    seed: []',
        '',
      ].join('\n'),
    );

    const config: RuntimeConfig = {
      account: 'local',
      agentContextHome: contextHome,
      agentId: 'threadnote',
      host: '127.0.0.1',
      manifestPath,
      openVikingVersion: '0.0.0',
      port: 1933,
      user: 'denys',
    };

    const output = await captureConsole(() => runSeedSkills(config, {dryRun: true}));

    expect(output).toContain(`Command claude-commands-global: ${join(home, '.claude', 'commands', 'weekly.md')}`);
    expect(output).toContain(
      `Command repo-local:sample-repo:claude-commands: ${join(repo, '.claude', 'commands', 'review-pr.md')}`,
    );
    expect(output).toMatch(/viking:\/\/resources\/agent-skills\/claude-commands-global\/weekly-[a-f0-9]{12}\.md/);
    expect(output).toMatch(
      /viking:\/\/resources\/agent-skills\/repo-local-sample-repo-claude-commands\/review-pr-[a-f0-9]{12}\.md/,
    );
    expect(output).toContain('--reason');
    expect(output).toContain('Agent command catalog item from claude-commands-global: weekly.md');
    expect(output).toContain('Skill seed complete: 2 unique catalog item(s).');
  });
});
