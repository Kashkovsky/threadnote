import {chmod, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {
  applyExactMatchBoost,
  buildRecallSections,
  categoryForUri,
  collectExactMatches,
  compareVersions,
  enrichRecallQueryWithWorkspaceContext,
  escapeRegExp,
  exactMemoryScopeUris,
  exactRecallScopeIntents,
  exactRecallTerms,
  findOpenVikingCli,
  formatExactMatchPointers,
  formatRecallHits,
  formatShellCommand,
  formatStaleVersionNotice,
  getGlobBase,
  globToRegExp,
  grepUrisFromJson,
  isAgentArtifactPackUri,
  memoryFrontmatterField,
  memoryUriProjectSegment,
  mergeRecallHits,
  parseRecallHits,
  RECALL_LOW_CONFIDENCE_NOTE,
  type RecallHit,
  hasGlob,
  isExecutable,
  isJsonObject,
  parseJsonConfigObject,
  recallQueryRequestsWorkspaceContext,
  redactText,
  reindexWaitTimeoutMs,
  runCommand,
  runInteractive,
  shellQuote,
  suggestedShellRc,
  uniqueUsefulWorkspaceTerms,
} from '../../src/utils.js';

describe('compareVersions', () => {
  it('returns 0 for equal versions', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
  });

  it('returns positive when left > right', () => {
    expect(compareVersions('1.2.4', '1.2.3')).toBeGreaterThan(0);
    expect(compareVersions('1.3.0', '1.2.99')).toBeGreaterThan(0);
    expect(compareVersions('2.0.0', '1.99.99')).toBeGreaterThan(0);
  });

  it('returns negative when left < right', () => {
    expect(compareVersions('0.3.23', '0.3.24')).toBeLessThan(0);
    expect(compareVersions('0.7.2', '0.7.4')).toBeLessThan(0);
  });

  it('treats a missing prerelease as newer than any prerelease', () => {
    expect(compareVersions('1.0.0', '1.0.0-rc1')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-rc1', '1.0.0')).toBeLessThan(0);
  });

  it('orders prereleases lexicographically', () => {
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBeLessThan(0);
    expect(compareVersions('1.0.0-rc2', '1.0.0-rc1')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-rc1', '1.0.0-rc1')).toBe(0);
  });

  it('orders numeric prerelease identifiers numerically', () => {
    expect(compareVersions('1.0.0-beta.10', '1.0.0-beta.2')).toBeGreaterThan(0);
  });

  it('coerces missing or non-numeric components to 0', () => {
    expect(compareVersions('1', '1.0.0')).toBe(0);
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('abc', '0.0.0')).toBe(0);
  });

  it('ignores build metadata so a local build is not misread as an older minor', () => {
    expect(compareVersions('0.4.4+local.1', '0.4.4')).toBe(0);
    expect(compareVersions('0.4.4+local', '0.4.3')).toBeGreaterThan(0);
  });

  it('treats PEP 440 post-releases as newer and pre-releases as older', () => {
    expect(compareVersions('0.4.4.post1', '0.4.4')).toBeGreaterThan(0);
    expect(compareVersions('0.4.4', '0.4.4.post1')).toBeLessThan(0);
    expect(compareVersions('0.4.4rc1', '0.4.4')).toBeLessThan(0);
    expect(compareVersions('0.4.4.dev0', '0.4.4')).toBeLessThan(0);
  });
});

describe('reindexWaitTimeoutMs', () => {
  const ENV = 'THREADNOTE_REINDEX_TIMEOUT_MS';
  const original = process.env[ENV];
  afterAll(() => {
    if (original === undefined) {
      delete process.env[ENV];
    } else {
      process.env[ENV] = original;
    }
  });

  it('defaults to a bounded 2-minute wait', () => {
    delete process.env[ENV];
    expect(reindexWaitTimeoutMs()).toBe(120_000);
  });

  it('honors a positive integer override', () => {
    process.env[ENV] = '30000';
    expect(reindexWaitTimeoutMs()).toBe(30_000);
  });

  it('falls back to the default for non-positive or invalid overrides', () => {
    process.env[ENV] = '0';
    expect(reindexWaitTimeoutMs()).toBe(120_000);
    process.env[ENV] = 'nope';
    expect(reindexWaitTimeoutMs()).toBe(120_000);
  });
});

describe('formatStaleVersionNotice', () => {
  it('returns a reconnect notice naming both versions when disk is newer', () => {
    const notice = formatStaleVersionNotice('1.4.0', '1.4.1');
    expect(notice).toContain('1.4.1');
    expect(notice).toContain('1.4.0');
    expect(notice).toMatch(/reconnect/i);
  });

  it('returns undefined when versions match or disk is older or equal', () => {
    expect(formatStaleVersionNotice('1.4.1', '1.4.1')).toBeUndefined();
    expect(formatStaleVersionNotice('1.4.1', '1.4.0')).toBeUndefined();
  });

  it('returns undefined when either version is unknown', () => {
    expect(formatStaleVersionNotice(undefined, '1.4.1')).toBeUndefined();
    expect(formatStaleVersionNotice('1.4.0', undefined)).toBeUndefined();
  });
});

describe('parseJsonConfigObject', () => {
  it('returns the parsed object for valid JSON objects', () => {
    expect(parseJsonConfigObject('{"a":1}')).toEqual({a: 1});
    expect(parseJsonConfigObject('  {"nested":{"b":2}}  ')).toEqual({nested: {b: 2}});
  });

  it('returns undefined for arrays', () => {
    expect(parseJsonConfigObject('[1,2,3]')).toBeUndefined();
  });

  it('returns undefined for null', () => {
    expect(parseJsonConfigObject('null')).toBeUndefined();
  });

  it('returns undefined for primitives', () => {
    expect(parseJsonConfigObject('"string"')).toBeUndefined();
    expect(parseJsonConfigObject('42')).toBeUndefined();
    expect(parseJsonConfigObject('true')).toBeUndefined();
  });

  it('returns undefined for malformed JSON', () => {
    expect(parseJsonConfigObject('{invalid')).toBeUndefined();
    expect(parseJsonConfigObject('')).toBeUndefined();
  });
});

describe('isJsonObject', () => {
  it('accepts plain objects', () => {
    expect(isJsonObject({})).toBe(true);
    expect(isJsonObject({a: 1})).toBe(true);
  });

  it('rejects arrays, null, and primitives', () => {
    expect(isJsonObject([])).toBe(false);
    expect(isJsonObject(null)).toBe(false);
    expect(isJsonObject('s')).toBe(false);
    expect(isJsonObject(1)).toBe(false);
    expect(isJsonObject(undefined)).toBe(false);
  });
});

describe('redactText', () => {
  it('redacts key=value pairs for secret-shaped keys', () => {
    expect(redactText('api_key=abc123def456')).toBe('api_key=[REDACTED]');
    expect(redactText('TOKEN=value123')).toBe('TOKEN=[REDACTED]');
    expect(redactText('authorization: "hunter2"')).toBe('authorization: [REDACTED]');
  });

  it('redacts bearer tokens', () => {
    expect(redactText('Bearer abcdefghijklmnopqrst')).toBe('<secret>');
  });

  it('redacts sk-* api keys', () => {
    expect(redactText('use sk-abcdefghijklmnopqrstuv now')).toBe('use <secret> now');
  });

  it('redacts github personal access tokens that appear outside key=value contexts', () => {
    expect(redactText('value: ghp_abcdefghijklmnopqrst')).toBe('value: <secret>');
  });

  it('redacts provider tokens and credential URLs that appear outside key=value contexts', () => {
    expect(redactText('dsn postgres://user:password@db.example.com/app')).toBe('dsn <secret>');
    expect(
      redactText(['webhook https://hooks.slack.com/services/T00000000/B00000000/', 'abcdefghijklmnop'].join('')),
    ).toBe('webhook <secret>');
  });

  it('leaves non-secret text untouched', () => {
    expect(redactText('hello world')).toBe('hello world');
  });
});

describe('runCommand guardrails', () => {
  it('rejects when a command exceeds the configured timeout', async () => {
    await expect(
      runCommand(process.execPath, ['-e', 'setTimeout(() => undefined, 5000)'], {timeoutMs: 50}),
    ).rejects.toThrow(/timed out after 50ms/);
  });

  it('returns a timeout result when allowFailure is set', async () => {
    const result = await runCommand(process.execPath, ['-e', 'setTimeout(() => undefined, 5000)'], {
      allowFailure: true,
      timeoutMs: 50,
    });
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain('timed out after 50ms');
  });

  it('caps accumulated output', async () => {
    const script = 'process.stdout.write("x".repeat(1024));';
    const result = await runCommand(process.execPath, ['-e', script], {allowFailure: true, maxOutputBytes: 16});
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain('exceeded output limit of 16 bytes');
  });

  it('escalates after timeout when the child ignores SIGTERM', async () => {
    const script = 'process.on("SIGTERM", () => undefined); setInterval(() => undefined, 1000);';
    const result = await runCommand(process.execPath, ['-e', script], {allowFailure: true, timeoutMs: 20});
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain('timed out after 20ms');
  });
});

describe('runInteractive', () => {
  it('returns the child exit code', async () => {
    expect(await runInteractive(process.execPath, ['-e', 'process.exit(0)'])).toBe(0);
    expect(await runInteractive(process.execPath, ['-e', 'process.exit(3)'])).toBe(3);
  });

  it('resolves non-zero instead of hanging when the binary cannot be spawned', async () => {
    expect(await runInteractive('threadnote-nonexistent-binary-xyz', ['--version'])).toBe(1);
  });
});

describe('findOpenVikingCli', () => {
  it('finds ov in UV_TOOL_BIN_DIR when it is outside PATH', async () => {
    const originalPath = process.env.PATH;
    const originalUvToolBinDir = process.env.UV_TOOL_BIN_DIR;
    const originalThreadnoteOv = process.env.THREADNOTE_OV;
    const dir = await mkdtemp(join(tmpdir(), 'threadnote-ov-bin-'));
    const ov = join(dir, 'ov');
    try {
      await writeFile(ov, '#!/bin/sh\nexit 0\n');
      await chmod(ov, 0o755);
      process.env.PATH = '/usr/bin:/bin';
      process.env.UV_TOOL_BIN_DIR = dir;
      delete process.env.THREADNOTE_OV;

      expect(await findOpenVikingCli()).toBe(ov);
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      if (originalUvToolBinDir === undefined) {
        delete process.env.UV_TOOL_BIN_DIR;
      } else {
        process.env.UV_TOOL_BIN_DIR = originalUvToolBinDir;
      }
      if (originalThreadnoteOv === undefined) {
        delete process.env.THREADNOTE_OV;
      } else {
        process.env.THREADNOTE_OV = originalThreadnoteOv;
      }
      await rm(dir, {force: true, recursive: true});
    }
  });
});

describe('globToRegExp', () => {
  it('matches a single path segment with *', () => {
    const re = globToRegExp('src/*.ts');
    expect(re.test('src/foo.ts')).toBe(true);
    expect(re.test('src/foo/bar.ts')).toBe(false);
  });

  it('matches across path segments with **', () => {
    const re = globToRegExp('src/**/*.ts');
    expect(re.test('src/foo.ts')).toBe(true);
    expect(re.test('src/foo/bar.ts')).toBe(true);
    expect(re.test('src/foo/bar/baz.ts')).toBe(true);
    expect(re.test('out/foo.ts')).toBe(false);
  });

  it('matches one char with ?', () => {
    const re = globToRegExp('a?.txt');
    expect(re.test('ab.txt')).toBe(true);
    expect(re.test('abc.txt')).toBe(false);
  });

  it('escapes regex metacharacters in literal text', () => {
    const re = globToRegExp('a.b');
    expect(re.test('a.b')).toBe(true);
    expect(re.test('axb')).toBe(false);
  });
});

describe('getGlobBase', () => {
  it('returns the path up to the first wildcard segment', () => {
    expect(getGlobBase('src/**/*.ts')).toBe('src');
    expect(getGlobBase('a/b/c/*.ts')).toBe('a/b/c');
    expect(getGlobBase('docs/index.md')).toBe('docs/index.md');
  });

  it('returns "." when the pattern starts with a wildcard', () => {
    expect(getGlobBase('*.ts')).toBe('.');
    expect(getGlobBase('**/*.ts')).toBe('.');
  });
});

describe('hasGlob', () => {
  it('detects * and ?', () => {
    expect(hasGlob('*.ts')).toBe(true);
    expect(hasGlob('a?b')).toBe(true);
  });

  it('returns false for plain paths', () => {
    expect(hasGlob('src/foo.ts')).toBe(false);
  });
});

describe('escapeRegExp', () => {
  it('escapes all regex metacharacters', () => {
    expect(escapeRegExp('a.b')).toBe('a\\.b');
    expect(escapeRegExp('(x)')).toBe('\\(x\\)');
    expect(escapeRegExp('a|b')).toBe('a\\|b');
    expect(escapeRegExp('a*b')).toBe('a\\*b');
  });
});

describe('exactRecallTerms', () => {
  it('keeps branch/topic-shaped terms and drops generic recall words', () => {
    expect(exactRecallTerms('coda latest handoff durable feature memory valencia-v1')).toEqual(['valencia-v1', 'coda']);
  });

  it('keeps stable issue topic slugs', () => {
    expect(exactRecallTerms('recall mobile-checkbox-clipped-table-cell handoff')).toEqual([
      'mobile-checkbox-clipped-table-cell',
    ]);
  });

  it('drops expanded generic function words so they cannot re-flood recall', () => {
    // A sentence built only from stop words yields no exact grep terms.
    expect(exactRecallTerms('what have they which does that when were')).toEqual([]);
    // A distinctive token still survives among the same filler.
    expect(exactRecallTerms('what does the sharding do')).toEqual(['sharding']);
  });
});

describe('recallQueryRequestsWorkspaceContext', () => {
  it('detects current branch and repo wording', () => {
    for (const phrase of [
      'this branch',
      'current branch',
      'this repo',
      'current repo',
      'this repository',
      'current repository',
      'this workspace',
      'current workspace',
      'this worktree',
      'current worktree',
    ]) {
      expect(recallQueryRequestsWorkspaceContext(`latest handoff for ${phrase}`)).toBe(true);
    }
  });

  it('leaves explicit recall queries alone', () => {
    expect(recallQueryRequestsWorkspaceContext('coda valencia-v1 latest handoff')).toBe(false);
  });
});

describe('enrichRecallQueryWithWorkspaceContext', () => {
  it('returns explicit queries unchanged', async () => {
    await expect(enrichRecallQueryWithWorkspaceContext('coda valencia-v1 latest handoff')).resolves.toBe(
      'coda valencia-v1 latest handoff',
    );
  });
});

describe('uniqueUsefulWorkspaceTerms', () => {
  it('keeps short branch names but drops short path terms', () => {
    expect(
      uniqueUsefulWorkspaceTerms([
        {source: 'branch', value: 'v1'},
        {source: 'path', value: 'v1'},
        {source: 'path', value: 'coda'},
      ]),
    ).toEqual(['v1', 'coda']);
  });

  it('drops ignored path terms and deduplicates case-insensitively', () => {
    expect(
      uniqueUsefulWorkspaceTerms([
        {source: 'path', value: 'repos'},
        {source: 'path', value: 'workspaces'},
        {source: 'branch', value: 'Fix'},
        {source: 'path', value: 'fix'},
      ]),
    ).toEqual(['Fix']);
  });
});

describe('shellQuote', () => {
  it('leaves safe identifiers unquoted', () => {
    expect(shellQuote('foo')).toBe('foo');
    expect(shellQuote('/usr/bin/env')).toBe('/usr/bin/env');
    expect(shellQuote('a-b_c.d')).toBe('a-b_c.d');
  });

  it('single-quotes anything with shell-significant characters', () => {
    expect(shellQuote('hello world')).toBe("'hello world'");
    expect(shellQuote('a;b')).toBe("'a;b'");
  });

  it('escapes embedded single quotes', () => {
    expect(shellQuote("it's")).toBe("'it'\"'\"'s'");
  });
});

describe('formatShellCommand', () => {
  it('quotes args containing spaces', () => {
    expect(formatShellCommand('echo', ['hello world'])).toBe("echo 'hello world'");
  });

  it('redacts secret-looking args', () => {
    const formatted = formatShellCommand('curl', ['-H', 'Authorization: Bearer abc123def456']);
    expect(formatted).toContain('[REDACTED]');
    expect(formatted).not.toContain('abc123def456');
  });
});

describe('isExecutable', () => {
  let tmpRoot: string;
  let executablePath: string;
  let plainPath: string;

  beforeAll(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'threadnote-isexec-'));
    executablePath = join(tmpRoot, 'runnable');
    plainPath = join(tmpRoot, 'plain');
    await writeFile(executablePath, '#!/bin/sh\nexit 0\n');
    await chmod(executablePath, 0o755);
    await writeFile(plainPath, 'not executable');
    await chmod(plainPath, 0o644);
  });

  afterAll(async () => {
    await rm(tmpRoot, {recursive: true, force: true});
  });

  it('returns true for files with the executable bit set', async () => {
    expect(await isExecutable(executablePath)).toBe(true);
  });

  it('returns false for files without the executable bit', async () => {
    expect(await isExecutable(plainPath)).toBe(false);
  });

  it('returns false for nonexistent paths', async () => {
    expect(await isExecutable(join(tmpRoot, 'does-not-exist'))).toBe(false);
  });
});

describe('suggestedShellRc', () => {
  it('returns ~/.zshrc for zsh', () => {
    expect(suggestedShellRc('/bin/zsh', 'darwin')).toBe('~/.zshrc');
    expect(suggestedShellRc('/usr/local/bin/zsh', 'linux')).toBe('~/.zshrc');
  });

  it('returns ~/.bash_profile for bash on macOS', () => {
    expect(suggestedShellRc('/bin/bash', 'darwin')).toBe('~/.bash_profile');
  });

  it('returns ~/.bashrc for bash on Linux', () => {
    expect(suggestedShellRc('/bin/bash', 'linux')).toBe('~/.bashrc');
  });

  it('returns fish config path for fish', () => {
    expect(suggestedShellRc('/opt/homebrew/bin/fish', 'darwin')).toBe('~/.config/fish/config.fish');
  });

  it('falls back to a generic message for unknown or empty shells', () => {
    expect(suggestedShellRc(undefined, 'darwin')).toBe('your shell rc');
    expect(suggestedShellRc('', 'linux')).toBe('your shell rc');
    expect(suggestedShellRc('/usr/local/bin/something-else', 'darwin')).toBe('your shell rc');
  });
});

describe('exactRecallScopeIntents', () => {
  it('routes a writing-style query to preferences only', () => {
    expect([...exactRecallScopeIntents('Denys writing style tone for PR replies')]).toEqual(['preferences']);
  });

  it('routes handoff, durable, and incident intents', () => {
    expect([...exactRecallScopeIntents('latest handoff status and next step')]).toEqual(['handoffs']);
    expect([...exactRecallScopeIntents('durable feature design decision and invariants')]).toEqual(['durable']);
    expect([...exactRecallScopeIntents('incident outage postmortem on-call')]).toEqual(['incidents']);
  });

  it('accumulates multiple intents', () => {
    expect([...exactRecallScopeIntents('writing style preference for the latest handoff status')].sort()).toEqual([
      'handoffs',
      'preferences',
    ]);
  });

  it('does not classify incidental dev vocabulary as durable intent', () => {
    expect(exactRecallScopeIntents('refactor the auth design and interface').size).toBe(0);
  });

  it('returns an empty set when intent is unclear', () => {
    expect(exactRecallScopeIntents('threadnote release notes commit').size).toBe(0);
  });
});

describe('exactMemoryScopeUris', () => {
  const base = {
    agentMemoriesUri: 'viking://agent/threadnote/memories',
    userBase: 'viking://user/denys/memories',
  };

  it('searches preferences and shared for a preferences intent', () => {
    expect(exactMemoryScopeUris({...base, includeArchived: false, intents: new Set(['preferences'] as const)})).toEqual(
      ['viking://user/denys/memories/preferences', 'viking://user/denys/memories/shared'],
    );
  });

  it('narrows project-specific scopes to the resolved project, leaving preferences and shared global', () => {
    expect(
      exactMemoryScopeUris({
        ...base,
        includeArchived: false,
        intents: new Set(['durable', 'handoffs', 'preferences'] as const),
        projectName: 'threadnote',
        projectResourceUri: 'viking://resources/repos/threadnote',
      }),
    ).toEqual([
      'viking://user/denys/memories/preferences',
      'viking://user/denys/memories/durable/projects/threadnote',
      'viking://user/denys/memories/handoffs/active/threadnote',
      'viking://user/denys/memories/shared',
    ]);
  });

  it('appends archived scopes for the present intents when includeArchived is set', () => {
    expect(exactMemoryScopeUris({...base, includeArchived: true, intents: new Set(['durable'] as const)})).toEqual([
      'viking://user/denys/memories/durable/projects',
      'viking://user/denys/memories/shared',
      'viking://user/denys/memories/durable/archived',
    ]);
  });

  it('falls back to the broad set when intent is unclear, narrowing project scopes', () => {
    expect(
      exactMemoryScopeUris({
        ...base,
        includeArchived: false,
        intents: new Set(),
        projectName: 'threadnote',
        projectResourceUri: 'viking://resources/repos/threadnote',
      }),
    ).toEqual([
      'viking://user/denys/memories/preferences',
      'viking://user/denys/memories/durable/projects/threadnote',
      'viking://user/denys/memories/handoffs/active/threadnote',
      'viking://user/denys/memories/incidents/active/threadnote',
      'viking://user/denys/memories/shared',
      'viking://agent/threadnote/memories',
      'viking://resources/repos/threadnote',
    ]);
  });
});

describe('grepUrisFromJson', () => {
  it('extracts match URIs past the cmd: banner', () => {
    const output =
      'cmd: ov grep --uri=x\n{"ok":true,"result":{"matches":[{"line":1,"uri":"viking://a.md","content":"x"},{"line":2,"uri":"viking://b.md","content":"y"}],"count":2}}';
    expect(grepUrisFromJson(output)).toEqual(['viking://a.md', 'viking://b.md']);
  });

  it('drops .overview/.abstract summary sidecars', () => {
    const output =
      '{"ok":true,"result":{"matches":[{"line":1,"uri":"viking://a/.overview.md","content":"x"},{"line":2,"uri":"viking://a/real.md","content":"y"},{"line":3,"uri":"viking://a/.abstract.md","content":"z"}]}}';
    expect(grepUrisFromJson(output)).toEqual(['viking://a/real.md']);
  });

  it('drops agent-artifact pack machinery so a review pack does not flood exact matches', () => {
    const output = JSON.stringify({
      ok: true,
      result: {
        matches: [
          {
            line: 1,
            uri: 'viking://user/me/memories/shared/default/agent-artifacts/packs/claude/r/r.pack.json',
            content: 'x',
          },
          {line: 2, uri: 'viking://user/me/memories/durable/projects/x/real.md', content: 'y'},
        ],
      },
    });
    expect(grepUrisFromJson(output)).toEqual(['viking://user/me/memories/durable/projects/x/real.md']);
  });

  it('returns [] on malformed output', () => {
    expect(grepUrisFromJson('cmd: ov grep\nnot json')).toEqual([]);
    expect(grepUrisFromJson('')).toEqual([]);
  });
});

describe('collectExactMatches + formatExactMatchPointers', () => {
  it('dedupes by URI, strips chunk anchors, and ranks by distinct-term count', async () => {
    const runGrep = async (term: string): Promise<string> => {
      const uris =
        term === 'style'
          ? ['viking://prefs.md#chunk_0001', 'viking://other.md']
          : term === 'tone'
            ? ['viking://prefs.md#chunk_0002']
            : [];
      return JSON.stringify({ok: true, result: {matches: uris.map((uri, line) => ({line, uri, content: ''}))}});
    };
    const matches = await collectExactMatches(['style', 'tone'], ['viking://scope'], runGrep);
    expect(matches).toEqual([
      {uri: 'viking://prefs.md', terms: ['style', 'tone']},
      {uri: 'viking://other.md', terms: ['style']},
    ]);
    const text = formatExactMatchPointers(matches);
    expect(text).toContain('Exact term matches (read the URI for full content):');
    expect(text).toContain('- viking://prefs.md (style, tone)');
  });

  it('does not double-count a term when the same URI matches it in two scopes', async () => {
    const runGrep = async (term: string, scope: string): Promise<string> => {
      const uris = scope === 'viking://a' ? ['viking://dup.md'] : scope === 'viking://b' ? ['viking://dup.md'] : [];
      return JSON.stringify({ok: true, result: {matches: uris.map((uri, line) => ({line, uri, content: ''}))}});
    };
    const matches = await collectExactMatches(['term'], ['viking://a', 'viking://b'], runGrep);
    expect(matches).toEqual([{uri: 'viking://dup.md', terms: ['term']}]);
  });

  it('caps the pointer list and notes the overflow', () => {
    const matches = Array.from({length: 10}, (_unused, index) => ({terms: ['t'], uri: `viking://m${index}.md`}));
    const text = formatExactMatchPointers(matches, 3) ?? '';
    expect(text.split('\n').filter(line => line.startsWith('- ')).length).toBe(3);
    expect(text).toContain('(+7 more exact matches');
  });

  it('returns undefined when there are no matches', () => {
    expect(formatExactMatchPointers([])).toBeUndefined();
  });
});

describe('parseRecallHits / mergeRecallHits / formatRecallHits', () => {
  const json = (obj: unknown): string => `cmd: ov search ...\n${JSON.stringify(obj)}`;

  it('parses memories + resources, drops sidecars, and trims snippets', () => {
    const hits = parseRecallHits(
      json({
        ok: true,
        result: {
          memories: [{context_type: 'memory', uri: 'viking://m.md#chunk_0001', score: 0.7, abstract: 'a  b\n c'}],
          resources: [
            {context_type: 'resource', uri: 'viking://r.md', score: 0.6, abstract: 'doc'},
            {context_type: 'resource', uri: 'viking://r/.overview.md', score: 0.9, abstract: 'sidecar'},
          ],
          skills: [],
        },
      }),
    );
    expect(hits).toEqual([
      {category: 'memories', contextType: 'memory', uri: 'viking://m.md#chunk_0001', score: 0.7, snippet: 'a b c'},
      {category: 'resources', contextType: 'resource', uri: 'viking://r.md', score: 0.6, snippet: 'doc'},
    ]);
  });

  it('drops agent-artifact pack machinery from semantic hits', () => {
    const hits = parseRecallHits(
      json({
        ok: true,
        result: {
          memories: [
            {
              context_type: 'memory',
              uri: 'viking://user/me/memories/shared/default/agent-artifacts/packs/claude/r/r.pack.json',
              score: 0.7,
              abstract: 'pack',
            },
            {
              context_type: 'memory',
              uri: 'viking://user/me/memories/durable/projects/x/real.md',
              score: 0.6,
              abstract: 'real',
            },
          ],
        },
      }),
    );
    expect(hits.map(hit => hit.uri)).toEqual(['viking://user/me/memories/durable/projects/x/real.md']);
  });

  it('leads with a low-confidence note when the window is entirely keyword-only', () => {
    // No semantic pass matched; every shown hit is a promoted exact-only doc.
    const {semanticSection} = buildRecallSections(
      [],
      [{terms: ['kubernetes'], uri: 'viking://user/me/memories/durable/projects/x/unrelated.md'}],
      12,
    );
    expect(semanticSection?.split('\n')[0]).toBe(RECALL_LOW_CONFIDENCE_NOTE);
    expect(semanticSection).toContain('keyword-only: kubernetes');
  });

  it('omits the low-confidence note when a semantic hit is present', () => {
    const {semanticSection} = buildRecallSections(
      [parseRecallHits(json({ok: true, result: {memories: [{uri: 'viking://real.md', score: 0.7, abstract: 'x'}]}}))],
      [{terms: ['kubernetes'], uri: 'viking://user/me/memories/durable/projects/x/unrelated.md'}],
      12,
    );
    expect(semanticSection).not.toContain(RECALL_LOW_CONFIDENCE_NOTE);
    // Positively assert the mixed state so the test cannot pass by dropping the
    // semantic hit or rendering an empty section.
    expect(semanticSection).toContain('viking://real.md');
    expect(semanticSection).toContain('keyword-only: kubernetes');
  });

  it('emits no note and no section for an empty result', () => {
    const {semanticSection} = buildRecallSections([], [], 12);
    expect(semanticSection).toBeUndefined();
  });

  it('omits archived lifecycle memories by default', () => {
    const hits = parseRecallHits(
      json({
        ok: true,
        result: {
          memories: [
            {
              context_type: 'memory',
              uri: 'viking://user/denys/memories/handoffs/archived/threadnote/old.md#chunk_0000',
              score: 0.8,
              abstract: 'old',
            },
            {
              context_type: 'memory',
              uri: 'viking://user/denys/memories/durable/projects/threadnote/current.md',
              score: 0.7,
              abstract: 'current',
            },
          ],
        },
      }),
    );

    expect(hits.map(hit => hit.uri)).toEqual(['viking://user/denys/memories/durable/projects/threadnote/current.md']);
  });

  it('keeps archived lifecycle memories when includeArchived is set', () => {
    const hits = parseRecallHits(
      json({
        ok: true,
        result: {
          memories: [
            {
              context_type: 'memory',
              uri: 'viking://user/denys/memories/durable/archived/threadnote/old.md',
              score: 0.8,
              abstract: 'old',
            },
          ],
        },
      }),
      {includeArchived: true},
    );

    expect(hits.map(hit => hit.uri)).toEqual(['viking://user/denys/memories/durable/archived/threadnote/old.md']);
  });

  it('merges passes, collapses chunks to one document, keeps the best score, ranks desc', () => {
    const base = parseRecallHits(
      json({ok: true, result: {memories: [{uri: 'viking://doc.md#chunk_0000', score: 0.5, abstract: 'x'}]}}),
    );
    const scoped = parseRecallHits(
      json({
        ok: true,
        result: {
          memories: [
            {uri: 'viking://doc.md#chunk_0009', score: 0.8, abstract: 'y'},
            {uri: 'viking://other.md', score: 0.6, abstract: 'z'},
          ],
        },
      }),
    );
    const merged = mergeRecallHits([base, scoped]);
    expect(merged.map(hit => ({score: hit.score, uri: hit.uri}))).toEqual([
      {score: 0.8, uri: 'viking://doc.md'},
      {score: 0.6, uri: 'viking://other.md'},
    ]);
  });

  it('ranks memories above resources and skills regardless of score', () => {
    const merged = mergeRecallHits([
      parseRecallHits(
        json({
          ok: true,
          result: {
            memories: [{context_type: 'memory', uri: 'viking://mem.md', score: 0.5, abstract: 'm'}],
            resources: [{context_type: 'resource', uri: 'viking://res.md', score: 0.9, abstract: 'r'}],
            skills: [{context_type: 'skill', uri: 'viking://skill.md', score: 0.8, abstract: 's'}],
          },
        }),
      ),
    ]);
    expect(merged.map(hit => hit.uri)).toEqual(['viking://mem.md', 'viking://res.md', 'viking://skill.md']);
  });

  it('formats a capped numbered list with overflow note', () => {
    const hits = Array.from({length: 4}, (_unused, index) => ({
      category: 'memories' as const,
      contextType: 'memory',
      score: 0.5,
      snippet: '',
      uri: `viking://m${index}.md`,
    }));
    const text = formatRecallHits(hits, 2) ?? '';
    expect(text).toContain('1. memory · score 0.50 · viking://m0.md');
    expect(text).toContain('(+2 more');
    expect(formatRecallHits([], 5)).toBeUndefined();
  });

  it('collapses resource hits with identical snippets but keeps distinct memories', () => {
    const {ranked} = buildRecallSections(
      [
        parseRecallHits(
          json({
            ok: true,
            result: {
              resources: [
                {context_type: 'resource', uri: 'viking://r/.agents/skills/x/SKILL.md', score: 0.7, abstract: 'same'},
                {context_type: 'resource', uri: 'viking://r/.claude/skills/x/SKILL.md', score: 0.6, abstract: 'same'},
              ],
              memories: [
                {context_type: 'memory', uri: 'viking://m1.md', score: 0.8, abstract: 'dup'},
                {context_type: 'memory', uri: 'viking://m2.md', score: 0.75, abstract: 'dup'},
              ],
            },
          }),
        ),
      ],
      [],
      12,
    );
    // One resource kept (highest score), both memories kept despite identical snippet.
    expect(ranked.map(hit => hit.uri)).toEqual([
      'viking://m1.md',
      'viking://m2.md',
      'viking://r/.agents/skills/x/SKILL.md',
    ]);
  });

  it('does not collapse resource hits with empty snippets', () => {
    const {ranked} = buildRecallSections(
      [
        parseRecallHits(
          json({
            ok: true,
            result: {
              resources: [
                {context_type: 'resource', uri: 'viking://r/a.md', score: 0.7, abstract: ''},
                {context_type: 'resource', uri: 'viking://r/b.md', score: 0.6, abstract: ''},
              ],
            },
          }),
        ),
      ],
      [],
      12,
    );
    expect(ranked.map(hit => hit.uri)).toEqual(['viking://r/a.md', 'viking://r/b.md']);
  });

  it('keeps the exact-matched twin when a content-duplicate would otherwise be dropped', () => {
    // Lower-scored .claude copy is the exact match; it must survive dedup and lead.
    const {ranked} = buildRecallSections(
      [
        parseRecallHits(
          json({
            ok: true,
            result: {
              resources: [
                {context_type: 'resource', uri: 'viking://r/.agents/skills/x/SKILL.md', score: 0.7, abstract: 'same'},
                {context_type: 'resource', uri: 'viking://r/.claude/skills/x/SKILL.md', score: 0.6, abstract: 'same'},
              ],
            },
          }),
        ),
      ],
      [{terms: ['chaos'], uri: 'viking://r/.claude/skills/x/SKILL.md'}],
      12,
    );
    expect(ranked.map(hit => hit.uri)).toEqual(['viking://r/.claude/skills/x/SKILL.md']);
  });

  it('builds an exact tail that excludes matches already shown in the ranked window', () => {
    const sections = buildRecallSections(
      [parseRecallHits(json({ok: true, result: {memories: [{uri: 'viking://shown.md', score: 0.8, abstract: 'x'}]}}))],
      [
        {terms: ['a'], uri: 'viking://shown.md'},
        {terms: ['a'], uri: 'viking://resources/repos/coda/only-exact.md'},
      ],
      12,
    );
    // shown.md is in the ranked window, so it is filtered out of the tail; the
    // exact-only doc was promoted into the window too, so the tail is empty.
    expect(sections.exactTail).toBeUndefined();
    expect(sections.ranked.map(hit => hit.uri)).toContain('viking://resources/repos/coda/only-exact.md');
  });
});

describe('buildRecallSections per-category reserve', () => {
  const mk = (category: 'memories' | 'resources' | 'skills', index: number, score: number): RecallHit => ({
    category,
    contextType: category === 'memories' ? 'memory' : category === 'skills' ? 'skill' : 'resource',
    score,
    snippet: '',
    uri: `viking://${category}/${index}`,
  });
  const numberedLines = (section: string | undefined): number =>
    (section ?? '').split('\n').filter(line => /^\d+\. /.test(line)).length;

  it('reserves window slots for resources and skills in a memory-heavy result', () => {
    const hits = [
      ...Array.from({length: 12}, (_unused, i) => mk('memories', i, 0.9 - i * 0.01)),
      ...Array.from({length: 3}, (_unused, i) => mk('resources', i, 0.5 - i * 0.01)),
      ...Array.from({length: 2}, (_unused, i) => mk('skills', i, 0.4 - i * 0.01)),
    ];
    const {semanticSection} = buildRecallSections([hits], [], 12);
    const text = semanticSection ?? '';
    // RECALL_CATEGORY_RESERVE = 2 → two resources and two skills are guaranteed visibility.
    expect(text).toContain('viking://resources/0');
    expect(text).toContain('viking://resources/1');
    expect(text).not.toContain('viking://resources/2');
    expect(text).toContain('viking://skills/0');
    expect(text).toContain('viking://skills/1');
    // Memories still take every remaining slot: 12 - 2 - 2 = 8.
    expect((text.match(/viking:\/\/memories\//g) ?? []).length).toBe(8);
    // Display stays fully category-first: every memory precedes every resource,
    // which precedes every skill.
    const lines = text.split('\n').filter(line => /^\d+\. /.test(line));
    const lastMemory = lines.map(l => l.includes('memories/')).lastIndexOf(true);
    const firstResource = lines.findIndex(l => l.includes('resources/'));
    const lastResource = lines.map(l => l.includes('resources/')).lastIndexOf(true);
    const firstSkill = lines.findIndex(l => l.includes('skills/'));
    expect(firstResource).toBeGreaterThan(lastMemory);
    expect(firstSkill).toBeGreaterThan(lastResource);
    expect(numberedLines(semanticSection)).toBe(12);
  });

  it('shows every hit in category-first order when the result fits the window', () => {
    const hits = [mk('skills', 0, 0.4), mk('memories', 0, 0.9), mk('resources', 0, 0.5)];
    const {semanticSection} = buildRecallSections([hits], [], 12);
    const lines = (semanticSection ?? '').split('\n').filter(line => /^\d+\. /.test(line));
    expect(lines.map(l => l.replace(/^\d+\. .* · /, ''))).toEqual([
      'viking://memories/0',
      'viking://resources/0',
      'viking://skills/0',
    ]);
  });

  it('applies the reserve best-effort by priority when the window is smaller than reserve x categories', () => {
    // limit 4 < RECALL_CATEGORY_RESERVE (2) * 3 categories: the two higher-priority
    // categories claim their reserve first, and the lowest (skills) is squeezed out.
    const hits = [
      ...Array.from({length: 2}, (_unused, i) => mk('memories', i, 0.9 - i * 0.01)),
      ...Array.from({length: 2}, (_unused, i) => mk('resources', i, 0.5 - i * 0.01)),
      ...Array.from({length: 2}, (_unused, i) => mk('skills', i, 0.4 - i * 0.01)),
    ];
    const text = buildRecallSections([hits], [], 4).semanticSection ?? '';
    expect(numberedLines(text)).toBe(4);
    expect(text).toContain('viking://memories/0');
    expect(text).toContain('viking://memories/1');
    expect(text).toContain('viking://resources/0');
    expect(text).toContain('viking://resources/1');
    expect(text).not.toContain('viking://skills/');
  });

  it('does not starve a memory-only result of slots', () => {
    const hits = Array.from({length: 15}, (_unused, i) => mk('memories', i, 0.9 - i * 0.01));
    const {semanticSection} = buildRecallSections([hits], [], 12);
    expect(numberedLines(semanticSection)).toBe(12);
    expect((semanticSection ?? '').match(/viking:\/\/memories\//g)?.length).toBe(12);
  });
});

describe('categoryForUri', () => {
  it('classifies memories, skill catalog, and resources', () => {
    expect(categoryForUri('viking://user/me/memories/durable/projects/x/y.md')).toBe('memories');
    expect(categoryForUri('viking://user/me/memories/shared/default/durable/x.md')).toBe('memories');
    expect(categoryForUri('viking://resources/agent-skills/codex-global/foo/SKILL.md')).toBe('skills');
    expect(categoryForUri('viking://resources/repos/coda/CLAUDE.md')).toBe('resources');
    expect(categoryForUri('viking://resources/repos/coda/.claude/skills/x/SKILL.md')).toBe('resources');
  });

  it('keeps shared agent artifacts out of the memory band (routes them to skills)', () => {
    expect(
      categoryForUri('viking://user/me/memories/shared/default/agent-artifacts/skills/claude/reviewer/SKILL.md'),
    ).toBe('skills');
  });
});

describe('memoryUriProjectSegment', () => {
  const u = (path: string): string => `viking://user/me/memories/${path}`;
  it('extracts the project for personal durable/handoff/incident memories', () => {
    expect(memoryUriProjectSegment(u('durable/projects/mobile-native/auth.md'))).toBe('mobile-native');
    expect(memoryUriProjectSegment(u('durable/archived/mobile-native/auth.md'))).toBe('mobile-native');
    expect(memoryUriProjectSegment(u('handoffs/active/threadnote/foo.md'))).toBe('threadnote');
    expect(memoryUriProjectSegment(u('incidents/active/coda/bar.md'))).toBe('coda');
  });

  it('de-scopes shared team memories to the underlying project', () => {
    expect(memoryUriProjectSegment(u('shared/docs-desktop/durable/projects/coda/pagerduty.md'))).toBe('coda');
  });

  it('returns undefined for project-less kinds, directory nodes, and non-memory URIs', () => {
    expect(memoryUriProjectSegment(u('preferences/coding-style.md'))).toBeUndefined();
    expect(memoryUriProjectSegment(u('preferences/archived/old.md'))).toBeUndefined();
    expect(memoryUriProjectSegment(u('smoke/active/probe.md'))).toBeUndefined();
    expect(memoryUriProjectSegment(u('durable/projects/mobile-native'))).toBeUndefined(); // dir node, no file
    expect(memoryUriProjectSegment('viking://resources/repos/coda/README.md')).toBeUndefined();
  });

  it('ignores a chunk anchor', () => {
    expect(memoryUriProjectSegment(u('durable/projects/coda/x.md#chunk_0001'))).toBe('coda');
  });
});

describe('memoryFrontmatterField', () => {
  const doc = ['MEMORY', 'kind: durable', 'status: active', 'project: mobile-native', 'topic: auth', '', 'Body.'].join(
    '\n',
  );
  it('reads a header field from the leading block', () => {
    expect(memoryFrontmatterField(doc, 'project')).toBe('mobile-native');
    expect(memoryFrontmatterField(doc, 'topic')).toBe('auth');
  });
  it('returns undefined for an absent field and does not read the body', () => {
    expect(memoryFrontmatterField(doc, 'repo')).toBeUndefined();
    expect(memoryFrontmatterField('MEMORY\nkind: durable\n\nproject: not-a-header', 'project')).toBeUndefined();
  });

  it('treats a bare (empty-value) field as absent', () => {
    expect(memoryFrontmatterField('MEMORY\nkind: durable\nproject:\ntopic: t\n\nb', 'project')).toBeUndefined();
    expect(memoryFrontmatterField('MEMORY\nproject:   \n\nb', 'project')).toBeUndefined();
  });

  it('does not match a field that is only a prefix of another key', () => {
    expect(memoryFrontmatterField('MEMORY\nproject_id: coda\n\nb', 'project')).toBeUndefined();
  });

  it('trims a trailing-whitespace value (memories round-trip through git)', () => {
    expect(memoryFrontmatterField('MEMORY\nproject: coda   \n\nb', 'project')).toBe('coda');
  });
});

describe('isAgentArtifactPackUri', () => {
  it('flags pack machinery but not shared skills or plain memories', () => {
    expect(
      isAgentArtifactPackUri(
        'viking://user/me/memories/shared/default/agent-artifacts/packs/claude/reviewer/reviewer.pack.json',
      ),
    ).toBe(true);
    expect(
      isAgentArtifactPackUri(
        'viking://user/me/memories/shared/default/agent-artifacts/packs/claude/reviewer/files/prompts/f.md',
      ),
    ).toBe(true);
    expect(
      isAgentArtifactPackUri(
        'viking://user/me/memories/shared/default/agent-artifacts/skills/claude/reviewer/SKILL.md',
      ),
    ).toBe(false);
    expect(isAgentArtifactPackUri('viking://user/me/memories/durable/projects/x/y.md')).toBe(false);
  });
});

describe('applyExactMatchBoost', () => {
  const hit = (over: Partial<RecallHit> = {}): RecallHit => ({
    category: 'resources',
    contextType: 'resource',
    score: 0.6,
    snippet: 's',
    uri: 'viking://x',
    ...over,
  });

  it('returns hits unchanged when there are no exact matches', () => {
    const hits = [hit()];
    expect(applyExactMatchBoost(hits, [])).toBe(hits);
  });

  it('annotates a semantic hit that an exact term also matched', () => {
    const ranked = applyExactMatchBoost(
      [hit({uri: 'viking://a', score: 0.6}), hit({uri: 'viking://b', score: 0.9})],
      [{terms: ['release', 'test'], uri: 'viking://a'}],
    );
    const a = ranked.find(entry => entry.uri === 'viking://a');
    expect(a?.exactTerms).toEqual(['release', 'test']);
    // Exact match leads its category despite lower semantic score.
    expect(ranked[0]?.uri).toBe('viking://a');
  });

  it('promotes an exact-only document into the ranked list with score 0', () => {
    const ranked = applyExactMatchBoost(
      [hit({uri: 'viking://sem', score: 0.9})],
      [{terms: ['conventions'], uri: 'viking://resources/repos/coda/CLAUDE.md'}],
    );
    const promoted = ranked.find(entry => entry.uri === 'viking://resources/repos/coda/CLAUDE.md');
    expect(promoted).toMatchObject({
      category: 'resources',
      contextType: 'resource',
      score: 0,
      exactTerms: ['conventions'],
    });
    // Promoted exact match outranks the unmatched higher-scoring semantic hit in the same category.
    expect(ranked[0]?.uri).toBe('viking://resources/repos/coda/CLAUDE.md');
  });

  it('orders by category, then blended exact strength + score', () => {
    const ranked = applyExactMatchBoost(
      [
        hit({category: 'memories', contextType: 'memory', uri: 'viking://user/me/memories/m.md', score: 0.5}),
        hit({uri: 'viking://r-one-term', score: 0.6}),
        hit({uri: 'viking://r-two-terms', score: 0.55}),
      ],
      [
        {terms: ['a'], uri: 'viking://r-one-term'},
        {terms: ['a', 'b'], uri: 'viking://r-two-terms'},
      ],
    );
    expect(ranked.map(entry => entry.uri)).toEqual([
      'viking://user/me/memories/m.md',
      'viking://r-two-terms',
      'viking://r-one-term',
    ]);
  });

  it('breaks ties by score when exact strength is equal', () => {
    const ranked = applyExactMatchBoost(
      [hit({uri: 'viking://lo', score: 0.5}), hit({uri: 'viking://hi', score: 0.8})],
      [
        {terms: ['a'], uri: 'viking://lo'},
        {terms: ['a'], uri: 'viking://hi'},
      ],
    );
    // Same single-term match → higher semantic score wins.
    expect(ranked.map(entry => entry.uri)).toEqual(['viking://hi', 'viking://lo']);
  });

  it('renders promoted exact-only hits without a score and annotates boosted hits', () => {
    const ranked = applyExactMatchBoost(
      [hit({uri: 'viking://sem', score: 0.62})],
      [
        {terms: ['x'], uri: 'viking://sem'},
        {terms: ['y', 'z'], uri: 'viking://resources/repos/coda/CLAUDE.md'},
      ],
    );
    const lines = (formatRecallHits(ranked, 5) ?? '').split('\n');
    const promotedIndex = lines.findIndex(line => line.includes('CLAUDE.md'));
    // Promoted exact-only line is labelled keyword-only (no semantic match),
    // carries no "score" token, and is not followed by a wrapped (3-space
    // indented) snippet line, since its snippet is empty.
    expect(lines[promotedIndex]).toContain('resource · keyword-only: y, z · viking://resources/repos/coda/CLAUDE.md');
    expect(lines[promotedIndex]).not.toContain('score');
    expect(lines[promotedIndex + 1] ?? '').not.toMatch(/^ {3}/);
    // A semantic hit that a term also matched keeps the "exact:" label.
    expect(lines.join('\n')).toContain('resource · score 0.62 · exact: x · viking://sem');
  });

  it('weights a rare exact term above a common one (inverse document frequency)', () => {
    // "common" matches three documents, "rare" matches one. The rare-term
    // document leads even though "common" appears in more of the result set.
    const ranked = applyExactMatchBoost(
      [],
      [
        {terms: ['common'], uri: 'viking://user/me/memories/durable/projects/x/c1.md'},
        {terms: ['common'], uri: 'viking://user/me/memories/durable/projects/x/c2.md'},
        {terms: ['common'], uri: 'viking://user/me/memories/durable/projects/x/c3.md'},
        {terms: ['rare'], uri: 'viking://user/me/memories/durable/projects/x/r.md'},
      ],
    );
    expect(ranked[0]?.uri).toBe('viking://user/me/memories/durable/projects/x/r.md');
  });

  it('boosts an exact term that names the document slug over a body-only match', () => {
    // Same term, same document frequency — the memory whose topic slug names the
    // term wins over one that only mentions it in the body (an incidental match).
    const ranked = applyExactMatchBoost(
      [],
      [
        {terms: ['observability'], uri: 'viking://user/me/memories/durable/projects/x/mobile-observability-spec.md'},
        {terms: ['observability'], uri: 'viking://user/me/memories/durable/projects/x/desktop-layout-review.md'},
      ],
    );
    expect(ranked[0]?.uri).toContain('mobile-observability-spec');
  });

  it('gives the slug bonus only on a token boundary, not an incidental substring', () => {
    // "spec" names the slug token in one doc but is only a substring of "respec"
    // in the other; same term and df, so the whole-token match must win.
    const ranked = applyExactMatchBoost(
      [],
      [
        {terms: ['spec'], uri: 'viking://user/me/memories/durable/projects/x/mobile-alerting-spec.md'},
        {terms: ['spec'], uri: 'viking://user/me/memories/durable/projects/x/design-respec-notes.md'},
      ],
    );
    expect(ranked[0]?.uri).toContain('mobile-alerting-spec');
    expect(ranked[1]?.uri).toContain('design-respec-notes');
  });

  it('keeps a common-word-only promotion below a genuine semantic hit', () => {
    // The semantic hit carries no exact term but scores 0.6; the promoted docs
    // match only a corpus-common term (df 5 → strength 0.2), so they no longer
    // outrank the real semantic hit — this is the anti-flooding guarantee.
    const ranked = applyExactMatchBoost(
      [hit({category: 'memories', contextType: 'memory', uri: 'viking://user/me/memories/semantic.md', score: 0.6})],
      [
        {terms: ['common'], uri: 'viking://user/me/memories/durable/projects/x/p1.md'},
        {terms: ['common'], uri: 'viking://user/me/memories/durable/projects/x/p2.md'},
        {terms: ['common'], uri: 'viking://user/me/memories/durable/projects/x/p3.md'},
        {terms: ['common'], uri: 'viking://user/me/memories/durable/projects/x/p4.md'},
        {terms: ['common'], uri: 'viking://user/me/memories/durable/projects/x/p5.md'},
      ],
    );
    expect(ranked[0]?.uri).toBe('viking://user/me/memories/semantic.md');
  });
});
