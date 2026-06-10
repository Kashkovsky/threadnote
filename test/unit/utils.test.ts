import {chmod, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {
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
  getGlobBase,
  globToRegExp,
  grepUrisFromJson,
  mergeRecallHits,
  parseRecallHits,
  hasGlob,
  isExecutable,
  isJsonObject,
  parseJsonConfigObject,
  recallQueryRequestsWorkspaceContext,
  redactText,
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

  it('coerces missing or non-numeric components to 0', () => {
    expect(compareVersions('1', '1.0.0')).toBe(0);
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('abc', '0.0.0')).toBe(0);
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
    expect(redactText('Bearer abc123xyz789')).toBe('Bearer [REDACTED]');
  });

  it('redacts sk-* api keys', () => {
    expect(redactText('use sk-abcdefghijklmnopqrstuv now')).toBe('use sk-[REDACTED] now');
  });

  it('redacts github personal access tokens that appear outside key=value contexts', () => {
    expect(redactText('value: ghp_abcdefghijklmnopqrst')).toBe('value: gh_[REDACTED]');
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
      {contextType: 'memory', uri: 'viking://m.md#chunk_0001', score: 0.7, snippet: 'a b c'},
      {contextType: 'resource', uri: 'viking://r.md', score: 0.6, snippet: 'doc'},
    ]);
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

  it('formats a capped numbered list with overflow note', () => {
    const hits = Array.from({length: 4}, (_unused, index) => ({
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
});
