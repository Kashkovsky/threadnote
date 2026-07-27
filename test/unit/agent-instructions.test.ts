import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';

async function agentInstructions(): Promise<string> {
  return readFile(join(process.cwd(), 'docs', 'agent-instructions.md'), 'utf8');
}

describe('agent instructions', () => {
  it('keeps the always-loaded guidance compact', async () => {
    const instructions = await agentInstructions();
    expect(Buffer.byteLength(instructions)).toBeLessThanOrEqual(5_000);
  });

  it('preserves the context lifecycle and safety invariants', async () => {
    const instructions = (await agentInstructions()).replace(/\s+/g, ' ');
    for (const requiredText of [
      'Repo files remain authoritative',
      'non-trivial task',
      'callerCwd',
      'viking://` URIs as pointers',
      '`kind: durable`',
      '`kind: handoff`',
      '`project` and `topic`',
      '`replaceUri`',
      'secrets, credentials, customer data, or raw production logs',
      'Never publish handoffs or preferences',
      'confirm with the user',
      '`threadnote doctor --dry-run`',
      'no daemon to start',
      'Before pausing, switching agents, or ending meaningful work',
      '`threadnote` CLI',
    ]) {
      expect(instructions).toContain(requiredText);
    }
  });

  it('stores routine durable knowledge and handoffs without candidate approval', async () => {
    const instructions = (await agentInstructions()).replace(/\s+/g, ' ');
    expect(instructions).toContain('store normal durable feature knowledge and handoffs directly without asking');
    expect(instructions).toContain('only for additional session-extracted candidates');
    expect(instructions).not.toContain('include a concise handoff candidate');
    expect(instructions).not.toContain('Store it only after approval');
  });
});
