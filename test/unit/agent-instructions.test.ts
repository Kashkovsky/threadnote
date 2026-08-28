import {readFile} from '../helpers/node-fs-promises.js';
import {join} from '../helpers/node-path.js';
import {describe, expect, it} from 'vitest';

async function agentInstructions(): Promise<string> {
  return readFile(join(process.cwd(), 'config', 'agent-instructions.md'), 'utf8');
}

describe('agent instructions', () => {
  it('keeps the packaged runtime template aligned with the contributor-facing copy', async () => {
    const [runtime, documentation] = await Promise.all([
      agentInstructions(),
      readFile(join(process.cwd(), 'docs', 'agent-instructions.md'), 'utf8'),
    ]);
    expect(runtime).toBe(documentation);
  });

  it('keeps the always-loaded guidance compact', async () => {
    const instructions = await agentInstructions();
    expect(Buffer.byteLength(instructions)).toBeLessThanOrEqual(3_000);
  });

  it('preserves the context lifecycle and safety invariants', async () => {
    const instructions = (await agentInstructions()).replace(/\s+/g, ' ');
    for (const requiredText of [
      'Repo files remain authoritative',
      'non-trivial task',
      'callerCwd',
      'nested package/app cwd',
      '`project` excludes projects',
      'omit it for global recall',
      '`callerCwd` prefers its package',
      'without excluding repo-wide or sibling evidence',
      '`threadnote://` results',
      'unread pointer queue, not evidence',
      'with `read_context`',
      'before relying on them or citing memory-backed claims',
      '`kind: durable`',
      '`kind: handoff`',
      '`project` and `topic`',
      '`replaceUri`',
      'secrets, credentials, customer data, or raw production logs',
      'never publish handoffs or preferences',
      'Confirm with the user',
      '`threadnote doctor --dry-run`',
      'explicit approval',
      'call `inspect_code_graph` before broad text search',
      'round-trip its stable ID through `node`, `neighbors`, or `path`',
      'Follow with exact text or path search for literals and verification',
      'If graph tooling is unavailable, say so',
      'Before pausing or ending meaningful work',
      '`threadnote` CLI',
      'graph-indexed repo paths',
    ]) {
      expect(instructions).toContain(requiredText);
    }
    expect(instructions).not.toContain('report-issue');
    expect(instructions).not.toContain('GitHub issue');
  });

  it('explains bounded Workset evidence and explicit preparation', async () => {
    const instructions = (await agentInstructions()).replace(/\s+/g, ' ');
    expect(instructions).toContain('use a named Workset when one is configured');
    expect(instructions).toContain('published ready generation');
    expect(instructions).toContain('never fan out cold graph builds');
    expect(instructions).toContain('`threadnote workset prepare <name>`');
    expect(instructions).toContain('bounded, per-repository evidence with provenance');
  });

  it('stores routine durable knowledge and handoffs without candidate approval', async () => {
    const instructions = (await agentInstructions()).replace(/\s+/g, ' ');
    expect(instructions).toContain('Store routine durable knowledge and handoffs directly');
    expect(instructions).toContain('only for additional session-extracted candidates');
    expect(instructions).not.toContain('include a concise handoff candidate');
    expect(instructions).not.toContain('Store it only after approval');
  });
});
