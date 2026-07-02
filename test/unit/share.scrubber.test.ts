import {describe, expect, it} from 'vitest';
import {applyScrubber, scrubberBlocker, stripPersonalProvenance} from '../../src/share.js';

describe('applyScrubber', () => {
  it('returns cleaned=content with no redactions when no patterns match', () => {
    const input = 'plain prose with no secrets';
    const result = applyScrubber(input, {redact: false});
    expect(result.blocker).toBeUndefined();
    expect(result.cleaned).toBe(input);
    expect(result.redactions).toEqual([]);
  });

  it('blocks PEM private keys regardless of redact mode', () => {
    const input = 'before\n-----BEGIN RSA PRIVATE KEY-----\npayload\n';
    expect(applyScrubber(input, {redact: false}).blocker).toBe('private key');
    expect(applyScrubber(input, {redact: true}).blocker).toBe('private key');
  });

  it('blocks sk-, gh_, GitLab, AWS, Slack, JWT, and Bearer tokens', () => {
    const samples: ReadonlyArray<{name: string; value: string}> = [
      {name: 'API key (sk-...)', value: 'sk-abcdefghijklmnopqr1234'},
      {name: 'GitHub token', value: 'ghp_abcdefghijklmnopqrst'},
      {name: 'GitHub fine-grained PAT', value: 'github_pat_abcdefghijklmnopqrstuv'},
      {name: 'GitLab PAT', value: 'glpat-abcdefghijklmnopqrst'},
      {name: 'AWS access key', value: 'AKIAABCDEFGHIJKLMNOP'},
      {name: 'Slack token', value: 'xoxb-12345-abcdefghijklmnopqr'},
      {name: 'bearer token', value: 'Bearer abcdefghijklmnopqrst'},
      {
        name: 'JWT',
        value: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abcdefghijklmnopqrst',
      },
    ];
    for (const sample of samples) {
      const result = applyScrubber(`prefix ${sample.value} suffix`, {redact: false});
      expect(result.blocker, `${sample.name} should block`).toBe(sample.name);
    }
  });

  it('redacts macOS home paths only when redact is true', () => {
    const input = 'see /Users/jane/secrets in the log';
    const blocked = applyScrubber(input, {redact: false});
    expect(blocked.blocker).toBe('macOS home path');
    expect(blocked.cleaned).toBe(input);

    const redacted = applyScrubber(input, {redact: true});
    expect(redacted.blocker).toBeUndefined();
    expect(redacted.cleaned).toBe('see <local-path> in the log');
    expect(redacted.redactions.find(r => r.name === 'macOS home path')?.count).toBe(1);
  });

  it('redacts linux home paths when preceded by a word boundary', () => {
    const input = 'cd/home/bob/work then done';
    const redacted = applyScrubber(input, {redact: true});
    expect(redacted.cleaned).toBe('cd<local-path> then done');
  });

  it('counts multiple matches per pattern when redacting', () => {
    const input = 'a /Users/a/x b /Users/b/y c /Users/c/z d';
    const result = applyScrubber(input, {redact: true});
    const macHits = result.redactions.find(r => r.name === 'macOS home path');
    expect(macHits?.count).toBe(3);
    expect(result.cleaned).toBe('a <local-path> b <local-path> c <local-path> d');
  });

  it('redacting soft-leaks does not silence a credential pattern in the same input', () => {
    const input = 'home /Users/jane/secrets and key sk-abcdefghijklmnopqr1234';
    const result = applyScrubber(input, {redact: true});
    expect(result.blocker).toBe('API key (sk-...)');
    expect(result.cleaned).toBe(input);
  });
});

describe('scrubberBlocker', () => {
  it('returns the first blocking pattern name', () => {
    expect(scrubberBlocker('sk-abcdefghijklmnopqr1234')).toBe('API key (sk-...)');
  });

  it('returns undefined when nothing blocks', () => {
    expect(scrubberBlocker('plain prose')).toBeUndefined();
  });
});

describe('stripPersonalProvenance', () => {
  it('removes supersedes and archived_from lines from the header block', () => {
    const input = [
      'MEMORY',
      'kind: durable',
      'project: foo',
      'supersedes: viking://user/me/memories/old.md',
      'archived_from: viking://user/me/memories/archive.md',
      '',
      'Body text mentioning supersedes: should NOT be stripped.',
      'archived_from: also kept here.',
    ].join('\n');
    const out = stripPersonalProvenance(input);
    expect(out).not.toMatch(/^supersedes:/m);
    expect(out).not.toMatch(/^archived_from: viking/m);
    expect(out).toContain('Body text mentioning supersedes:');
    expect(out).toContain('archived_from: also kept here.');
  });

  it('removes references lines from the header block but not the body', () => {
    const input = [
      'MEMORY',
      'kind: durable',
      'project: foo',
      'references: viking://user/me/memories/durable/projects/foo/a.md',
      'references: viking://user/me/memories/handoffs/active/foo/b.md',
      '',
      'Body mentioning references: should NOT be stripped.',
    ].join('\n');
    const out = stripPersonalProvenance(input);
    expect(out).not.toMatch(/^references:/m);
    expect(out).toContain('Body mentioning references:');
  });

  it('leaves content unchanged when there is no header to strip', () => {
    const input = 'just a body\nwith no provenance';
    expect(stripPersonalProvenance(input)).toBe(input);
  });

  it('handles input with no blank line (entire content is header)', () => {
    const input = ['MEMORY', 'supersedes: viking://x', 'project: y'].join('\n');
    const out = stripPersonalProvenance(input);
    expect(out).not.toMatch(/^supersedes:/m);
    expect(out).toContain('project: y');
  });
});
