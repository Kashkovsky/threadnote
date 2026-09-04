import {readFile} from '../helpers/node-fs-promises.js';
import {join} from '../helpers/node-path.js';
import {describe, expect, it} from 'vitest';

const skillNames = ['threadnote-context', 'threadnote-code-graph', 'threadnote-memory'] as const;

async function agentInstructions(): Promise<string> {
  return readFile(join(process.cwd(), 'config', 'agent-instructions.md'), 'utf8');
}

async function agentSkills(): Promise<readonly string[]> {
  return Promise.all(
    skillNames.map(skill => readFile(join(process.cwd(), 'config', 'agent-skills', skill, 'SKILL.md'), 'utf8')),
  );
}

async function personalCursorCloudArtifacts(): Promise<readonly string[]> {
  const root = join(process.cwd(), 'config', 'agent-profiles', 'cursor-cloud-personal');
  return Promise.all([
    readFile(join(root, 'agent-instructions.md'), 'utf8'),
    ...skillNames.map(skill => readFile(join(root, 'agent-skills', skill, 'SKILL.md'), 'utf8')),
  ]);
}

describe('agent instructions', () => {
  it('keeps the packaged bootstrap aligned with the contributor-facing copy', async () => {
    const [runtime, documentation] = await Promise.all([
      agentInstructions(),
      readFile(join(process.cwd(), 'docs', 'agent-instructions.md'), 'utf8'),
    ]);
    expect(runtime).toBe(documentation);
  });

  it('ships Personal Cursor Cloud skills that match its one-MCP multi-share capabilities', async () => {
    const artifacts = (await personalCursorCloudArtifacts()).join('\n').replace(/\s+/g, ' ');
    for (const requiredText of [
      'one Threadnote MCP',
      'several configured Git memory shares',
      'pass `team`',
      '`recall_context`',
      '`read_context`',
      '`list_context`',
      '`remember_context`',
      'commits and pushes',
      'VM-local',
      '`inspect_code_graph`',
      '`analyze_code_graph`',
      'Named Worksets are unavailable',
      'Never store secrets, credentials, customer data, or raw production logs',
    ]) {
      expect(artifacts).toContain(requiredText);
    }
    expect(artifacts).not.toContain('Call `context_brief`');
    expect(artifacts).not.toContain('Git beta');
  });

  it('keeps the always-loaded bootstrap compact and routes detailed work to skills', async () => {
    const instructions = await agentInstructions();
    const normalized = instructions.replace(/\s+/g, ' ');
    expect(Buffer.byteLength(instructions)).toBeLessThanOrEqual(800);
    for (const requiredText of [
      ...skillNames,
      'non-trivial work',
      'Repository files',
      'authoritative',
      '`threadnote://` pointers',
      'code graph before broad source search',
      'leave a handoff and durable detailed feature memory (when applicable)',
      'Threadnote MCP tools',
      'CLI only as a fallback',
      'secrets, credentials, customer data, or raw production logs',
      'Confirm with the user before publishing durable memory',
    ]) {
      expect(normalized).toContain(requiredText);
    }
  });

  it('preserves detailed context, graph, memory, and code-brief contracts in progressive skills', async () => {
    const skills = (await agentSkills()).join('\n').replace(/\s+/g, ' ');
    for (const requiredText of [
      '`context_brief`',
      '`codeRefs`',
      'memory-to-code',
      'graph-to-memory',
      '`recall_context`',
      '`memoryRefs`',
      '`relationTypes`',
      'pure seed-only navigation',
      '`explicit-memory-connection`',
      'one-hop expansion',
      'not recursive graph discovery',
      'truncated connection coverage is not evidence',
      'absolute `callerCwd`',
      '`read_context`',
      'unread pointers, not evidence',
      '`inspect_code_graph` before broad text search',
      '`query`',
      '`node`',
      '`neighbors`',
      '`path`',
      '`impact`',
      '`analyze_code_graph`',
      '`threadnote workset prepare <name>`',
      '`kind: durable`',
      '`kind: handoff`',
      '`replaceUri`',
      'Author `relations` only when',
      '`depends_on`, `evidence_for`, `references`, `related_to`, and `supersedes`',
      'Never infer a durable edge from topical similarity alone',
      'complete intended relation set',
      'ready exact-current graph',
      '`citationPolicy: "require-current"`',
      '`finalize_code_refs`',
      'private pending anchor',
      'Shared and inactive writes remain strict',
      'identity-fenced relocation receipt',
      '`canonicalUri`',
      'Never store secrets, credentials, customer data, or raw production logs',
      'never publish handoffs or preferences',
    ]) {
      expect(skills).toContain(requiredText);
    }
    expect(skills).not.toContain('4.6');
  });
});
