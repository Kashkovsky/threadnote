import {describe, expect, it} from 'vitest';
import {applyScrubber, scrubberBlocker, setMemoryVisibility, stripPersonalProvenance} from '../../src/share.js';

function fixture(...parts: readonly string[]): string {
  return parts.join('');
}

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

  it('blocks common API tokens, cloud tokens, webhooks, auth headers, and credential URIs', () => {
    const samples: ReadonlyArray<{name: string; value: string}> = [
      {name: 'API key (sk-...)', value: fixture('sk-', 'abcdefghijklmnopqr1234')},
      {name: 'GitHub token', value: fixture('ghp_', 'abcdefghijklmnopqrst')},
      {name: 'GitHub fine-grained PAT', value: fixture('github_pat_', 'abcdefghijklmnopqrstuv')},
      {name: 'GitLab PAT', value: fixture('glpat-', 'abcdefghijklmnopqrst')},
      {name: 'AWS access key', value: fixture('AKIA', 'ABCDEFGHIJKLMNOP')},
      {name: 'AWS access key', value: fixture('ASIA', 'ABCDEFGHIJKLMNOP')},
      {
        name: 'AWS secret access key',
        value: fixture('aws_secret_access_key=', 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN'),
      },
      {name: 'AWS session token', value: fixture('aws_session_token=', 'abcdefghijklmnopqrstuvwxyz0123456789ABCD')},
      {name: 'Google API key', value: fixture('AIza', 'abcdefghijklmnopqrstuvwxyz123456789')},
      {name: 'Google OAuth token', value: fixture('ya29.', 'abcdefghijklmnopqrstuvwxyz123456789')},
      {name: 'Stripe key', value: fixture('sk_', 'live_', 'abcdefghijklmnopqrstuvwxyz')},
      {name: 'Stripe webhook secret', value: fixture('whsec_', 'abcdefghijklmnopqrstuvwxyz')},
      {name: 'Discord token', value: fixture('mfa.', 'abcdefghijklmnopqrstuvwxyz123456789')},
      {
        name: 'Discord webhook',
        value: fixture('https://discord.com/api/webhooks/123456789/', 'abcdefghijklmnopqrstuvwxyz'),
      },
      {name: 'Slack token', value: fixture('xoxb-', '12345-', 'abcdefghijklmnopqr')},
      {name: 'Slack token', value: fixture('xapp-', '1-ABCDEF-2-', 'abcdef123456')},
      {
        name: 'Slack webhook',
        value: fixture('https://hooks.slack.com/services/T00000000/B00000000/', 'abcdefghijklmnop'),
      },
      {name: 'bearer token', value: fixture('Bearer ', 'abcdefghijklmnopqrst')},
      {name: 'basic auth header', value: fixture('Basic ', 'QWxhZGRpbjpvcGVuIHNlc2FtZQ==')},
      {name: 'database URI', value: fixture('postgres://user:', 'password@db.example.com:5432/app')},
      {name: 'URL basic auth', value: fixture('https://user:', 'password@example.com/path')},
      {
        name: 'JWT',
        value: fixture('eyJhbGciOiJIUzI1NiJ9.', 'eyJzdWIiOiIxMjMifQ.', 'abcdefghijklmnopqrst'),
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

  it.each([
    ['Cursor workspace path', '/workspace/threadnote/src/main.ts'],
    ['Cursor workspace path', '/workspaces/threadnote/src/main.ts'],
    ['temporary path', '/tmp/cursor-agent/output.json'],
    ['temporary path', '/private/tmp/cursor-agent/output.json'],
    ['Windows absolute path', 'C:\\Users\\jane\\work\\secret.txt'],
    ['Windows absolute path', 'D:/agent/work/output.txt'],
    ['Windows absolute path', '/c/Users/jane/work/secret.txt'],
    ['Windows absolute path', '\\\\wsl.localhost\\Ubuntu\\home\\jane\\work.txt'],
    ['WSL mounted drive path', '/mnt/c/Users/jane/work/secret.txt'],
  ])('blocks %s without returning the matched path', (name, path) => {
    const result = applyScrubber(`Local evidence: ${path}`, {redact: false});
    expect(result.blocker).toBe(name);
    expect(result.cleaned).toContain(path);
    const redacted = applyScrubber(`Local evidence: ${path}`, {redact: true});
    expect(redacted.blocker).toBeUndefined();
    expect(redacted.cleaned).not.toContain(path);
  });

  it('does not confuse an ordinary one-letter POSIX directory with a Git-Bash drive', () => {
    expect(applyScrubber('module /a/project/readme.md', {redact: false}).blocker).toBeUndefined();
  });

  it('supports deployment policy hooks without mutating the baseline pattern catalog', () => {
    const result = applyScrubber('Customer marker CUST-123456', {
      additionalPatterns: [{name: 'customer marker', regex: /\bCUST-\d{6}\b/u}],
      redact: false,
    });
    expect(result.blocker).toBe('customer marker');
    expect(applyScrubber('Customer marker CUST-123456', {redact: false}).blocker).toBeUndefined();
  });

  it('evaluates stateful deployment regexes deterministically across calls', () => {
    const policy = [{name: 'customer marker', regex: /\bCUST-\d{6}\b/gu}];
    expect(applyScrubber('CUST-123456', {additionalPatterns: policy, redact: false}).blocker).toBe('customer marker');
    expect(applyScrubber('CUST-123456', {additionalPatterns: policy, redact: false}).blocker).toBe('customer marker');
  });

  it('still redacts a macOS home embedded in a file URL', () => {
    expect(applyScrubber('open file:///Users/jane/work', {redact: true}).cleaned).toBe('open file://<local-path>');
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
    const input = fixture('home /Users/jane/secrets and key sk-', 'abcdefghijklmnopqr1234');
    const result = applyScrubber(input, {redact: true});
    expect(result.blocker).toBe('API key (sk-...)');
    expect(result.cleaned).toBe(input);
  });
});

describe('scrubberBlocker', () => {
  it('returns the first blocking pattern name', () => {
    expect(scrubberBlocker(fixture('sk-', 'abcdefghijklmnopqr1234'))).toBe('API key (sk-...)');
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
      'supersedes: threadnote://user/me/memories/old.md',
      'archived_from: threadnote://user/me/memories/archive.md',
      '',
      'Body text mentioning supersedes: should NOT be stripped.',
      'archived_from: also kept here.',
    ].join('\n');
    const out = stripPersonalProvenance(input);
    expect(out).not.toMatch(/^supersedes:/m);
    expect(out).not.toMatch(/^archived_from: threadnote/m);
    expect(out).toContain('Body text mentioning supersedes:');
    expect(out).toContain('archived_from: also kept here.');
  });

  it('removes references lines from the header block but not the body', () => {
    const input = [
      'MEMORY',
      'kind: durable',
      'project: foo',
      'references: threadnote://user/me/memories/durable/projects/foo/a.md',
      'references: threadnote://user/me/memories/handoffs/active/foo/b.md',
      '',
      'Body mentioning references: should NOT be stripped.',
    ].join('\n');
    const out = stripPersonalProvenance(input);
    expect(out).not.toMatch(/^references:/m);
    expect(out).toContain('Body mentioning references:');
  });

  it('removes local candidate, session, evidence, and relation provenance', () => {
    const input = [
      'MEMORY',
      'schema_version: 2',
      'kind: durable',
      'candidate_id: review-abc-1',
      'source_session_id: local-session',
      'evidence: /Users/me/repo/file.ts',
      'relation: evidence_for threadnote://user/me/memories/private.md',
      'authority: user_approved',
      'trust: approved',
      '',
      'Reviewed body.',
    ].join('\n');

    const out = stripPersonalProvenance(input);

    expect(out).not.toMatch(/^(?:candidate_id|source_session_id|evidence|relation):/m);
    expect(out).toContain('authority: user_approved');
    expect(out).toContain('trust: approved');
    expect(out).toContain('Reviewed body.');
  });

  it('leaves content unchanged when there is no header to strip', () => {
    const input = 'just a body\nwith no provenance';
    expect(stripPersonalProvenance(input)).toBe(input);
  });

  it('handles input with no blank line (entire content is header)', () => {
    const input = ['MEMORY', 'supersedes: threadnote://x', 'project: y'].join('\n');
    const out = stripPersonalProvenance(input);
    expect(out).not.toMatch(/^supersedes:/m);
    expect(out).toContain('project: y');
  });

  it('strips generated hygiene trailers before sharing without removing authored prose', () => {
    const personalUri = 'threadnote://user/me/memories/handoffs/archived/threadnote/private-task.md';
    const generated = [
      'MEMORY',
      'kind: durable',
      'project: threadnote',
      '',
      'Public durable contract.',
      '',
      '<!-- threadnote:hygiene-sources:v1 -->',
      '## Threadnote Hygiene Sources',
      '',
      `- ${personalUri}`,
    ].join('\n');
    const authored = [
      'MEMORY',
      'kind: durable',
      'project: threadnote',
      '',
      'Public durable contract.',
      '',
      '## Threadnote Hygiene Sources',
      '',
      'This heading is ordinary user-authored prose.',
    ].join('\n');
    const legacyGenerated = generated.replace('<!-- threadnote:hygiene-sources:v1 -->\n', '');

    const scrubbed = stripPersonalProvenance(generated);

    expect(scrubbed).toContain('Public durable contract.');
    expect(scrubbed).not.toContain('threadnote:hygiene-sources');
    expect(scrubbed).not.toContain(personalUri);
    expect(stripPersonalProvenance(legacyGenerated)).not.toContain(personalUri);
    expect(stripPersonalProvenance(authored)).toBe(authored);
  });
});

describe('setMemoryVisibility', () => {
  it('changes visibility without changing stable identity or unknown headers', () => {
    const personal = [
      'MEMORY',
      'schema_version: 3',
      'memory_id: tn_stable',
      'kind: durable',
      'timestamp: 2026-07-27T00:00:00.000Z',
      'visibility: personal',
      'future_field: preserved',
      '',
      'Body.',
    ].join('\n');

    const shared = setMemoryVisibility(personal, 'shared');

    expect(shared).toContain('memory_id: tn_stable');
    expect(shared).toContain('visibility: shared');
    expect(shared).toContain('future_field: preserved');
    expect(shared).not.toContain('visibility: personal');
  });

  it('adds missing visibility to legacy memory headers and ignores non-memory documents', () => {
    const legacy = ['HANDOFF', 'kind: handoff', 'timestamp: 2026-07-27T00:00:00.000Z', '', 'Body.'].join('\n');
    expect(setMemoryVisibility(legacy, 'shared')).toContain(
      'timestamp: 2026-07-27T00:00:00.000Z\nvisibility: shared\n\nBody.',
    );
    expect(setMemoryVisibility('plain Markdown', 'shared')).toBe('plain Markdown');
  });
});
