import {readFile} from '../helpers/node-fs-promises.js';
import {join} from '../helpers/node-path.js';
import {describe, expect, it} from 'vitest';

import {continueAdapter} from '../../src/agent_integration/adapters/continue.js';

const skillNames = ['threadnote-context', 'threadnote-code-graph', 'threadnote-memory'] as const;
const personalCursorCloudSkillNames = ['threadnote-context', 'threadnote-memory'] as const;

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
    ...personalCursorCloudSkillNames.map(skill => readFile(join(root, 'agent-skills', skill, 'SKILL.md'), 'utf8')),
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
      'Never store secrets, credentials, customer data, or raw production logs',
    ]) {
      expect(artifacts).toContain(requiredText);
    }
    expect(artifacts).not.toContain('Call `context_brief`');
    expect(artifacts).not.toContain('Git beta');
    expect(artifacts).not.toContain('`inspect_code_graph`');
    expect(artifacts).not.toContain('`analyze_code_graph`');
    expect(artifacts).not.toContain('local code graph');
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
      'required handoff; optional five-field Knowledge Delta needs approval',
      '`remember_context(kind=handoff)` is the required private direct write',
      'For repo work, call MCP `context_brief`',
      'optional proposals are never auto-applied/auto-shared',
      'secrets, credentials, customer data, or raw production logs',
      'Confirm before durable sharing',
      'MCP `context_brief` (task + absolute `callerCwd`)',
      '`threadnote context brief --cwd <cwd> --task <task>`',
    ]) {
      expect(normalized).toContain(requiredText);
    }
    expect(normalized).not.toContain('threadnote context brief --caller-cwd');
  });

  it('preserves detailed context, graph, memory, and code-brief contracts in progressive skills', async () => {
    const skillFiles = await agentSkills();
    const skills = skillFiles.join('\n').replace(/\s+/g, ' ');
    const [context, graph, memory] = skillFiles;
    const normalizedContext = context.replace(/\s+/g, ' ');
    expect(context.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(400);
    expect(graph.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(300);
    expect(memory.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(500);
    for (const requiredText of [
      '`context_brief`',
      '`codeRefs`',
      'Context Brief lifecycle',
      '`recall_context`',
      'absolute `callerCwd`',
      '`read_context`',
      'Recall output is pointers, not evidence',
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
      '`relations`',
      'replacement supplies the complete set',
      'carry forward every still-valid relation',
      'five-field Knowledge Delta',
      '`decisions` + `rationale`',
      '`constraints`',
      '`verificationPerformed`',
      '`knowledgeInvalidated`',
      '`unresolvedRisks`',
      '`review_session_context`',
      '`apply_memory_candidates`',
      '`approve` (optionally with `editedText`), `defer`, or `reject`',
      '`remember_context(kind=handoff)`',
      '`citationPolicy: "defer"`',
      '`--defer-code-refs`',
      '`citationPolicy: "require-current"`',
      '`finalize_code_refs`',
      'private pending anchor',
      '`share_publish`',
      '`share_propose`',
      '`context_health`',
      '`context_health_aggregate`',
      '`context_health_repair_preview`',
      '`context_health_repair_apply`',
      '`context_health_schedule`',
      '`context_metadata_preview`',
      '`context_metadata_apply`',
      '`recall_feedback`',
      '`threadnote value report`',
      '`procedure_publish_preview`',
      '`procedure_publish_apply`',
      '`threadnote procedure verify <manifest>`',
      '`threadnote guidance import`',
      '`threadnote guidance project`',
      '`complete_activation_retrieval_proof`',
      '`threadnote_guide`',
      'follow tool-returned actions for uncommon recovery',
      'Do not store secrets, credentials, customer data, or raw production logs',
    ]) {
      expect(skills).toContain(requiredText);
    }
    expect(context).not.toContain('unread pointers, not evidence');
    expect(normalizedContext).toContain('mode (`brief`, `locate`, `trace`, `impact`, or `explain`)');
    expect(normalizedContext).toContain('MCP `context_brief`');
    expect(normalizedContext).toContain('`threadnote context brief --cwd <cwd> --task <task>`');
    expect(normalizedContext).not.toContain('threadnote context brief --caller-cwd');
    for (const retiredDetail of [
      '`responseFormat`',
      '`offsetBytes`',
      '`sourceHash`',
      '`canonicalUri`',
      '`recoveryAction`',
      'identity-fenced relocation',
      '`--fixture',
      '`--available-manifest',
      '`validTo`',
      '`ttl`',
    ]) {
      expect(skills).not.toContain(retiredDetail);
    }
    expect(skills).not.toContain('4.6');
  });

  it('gives non-skill Continue sessions the exact normal lifecycle tools', () => {
    const instructions = continueAdapter.json?.instructionContent ?? '';
    for (const tool of [
      '`context_brief`',
      '`recall_context`',
      '`read_context`',
      '`inspect_code_graph`',
      '`analyze_code_graph`',
      '`remember_context(kind=handoff)`',
      '`review_session_context`',
      '`apply_memory_candidates`',
    ]) {
      expect(instructions).toContain(tool);
    }
    expect(instructions).toContain('`approve` (optional `editedText`), `defer`, or `reject`');
    expect(instructions).toContain('Never auto-apply or auto-share proposals');
    expect(instructions).toContain('`threadnote context brief --cwd <cwd> --task <task>`');
    expect(instructions).not.toContain('threadnote context brief --caller-cwd');
  });
});
