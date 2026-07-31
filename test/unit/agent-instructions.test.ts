import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
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
    expect(Buffer.byteLength(instructions)).toBeLessThanOrEqual(5_000);
  });

  it('preserves the context lifecycle and safety invariants', async () => {
    const instructions = (await agentInstructions()).replace(/\s+/g, ' ');
    for (const requiredText of [
      'Repo files remain authoritative',
      'non-trivial task',
      'callerCwd',
      'threadnote://` URIs as pointers',
      '`kind: durable`',
      '`kind: handoff`',
      '`project` and `topic`',
      '`replaceUri`',
      'secrets, credentials, customer data, or raw production logs',
      'Never publish handoffs or preferences',
      'confirm with the user',
      '`threadnote doctor --dry-run`',
      '`threadnote report-issue',
      '`--include-logs`',
      '`gh auth login`',
      'explicit user approval',
      'use `inspect_code_graph` before broad `rg` or grep searches',
      'Use text search afterward for exact literals, unsupported files, or verification',
      'do not silently skip graph search',
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
