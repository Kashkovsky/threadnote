import {chmod, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {
  compareVersions,
  enrichRecallQueryWithWorkspaceContext,
  escapeRegExp,
  exactRecallTerms,
  formatShellCommand,
  getGlobBase,
  globToRegExp,
  hasGlob,
  isExecutable,
  isJsonObject,
  parseJsonConfigObject,
  recallQueryRequestsWorkspaceContext,
  redactText,
  runCommand,
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
    expect(compareVersions('0.3.12', '0.3.21')).toBeLessThan(0);
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
