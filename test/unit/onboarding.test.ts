import {describe, expect, it} from 'vitest';
import {buildOnboardingGuide} from '../../src/onboarding.js';

describe('buildOnboardingGuide', () => {
  it('lists core calls, including lifecycle MCP calls, and catalogs full-only capabilities', () => {
    const guide = buildOnboardingGuide({seededProjects: [], teams: []});
    expect(guide).toContain('# Threadnote — what you can do here');
    for (const call of [
      'recall_context(',
      'review_session_context(',
      'apply_memory_candidates',
      'remember_context(',
      'share_publish(',
      'context_health(',
      'context_health_aggregate(',
      'context_health_schedule(',
      'context_health_repair_preview(',
      'context_health_repair_apply(',
      'context_metadata_preview(',
      'context_metadata_apply(',
      'recall_feedback(',
      'procedure_publish_preview(',
      'procedure_publish_apply(',
    ]) {
      expect(guide).toContain(call);
    }
    expect(guide).not.toContain('compact_context(');
    expect(guide).not.toContain('share_skill(');
    expect(guide).toContain('Health and repair');
    expect(guide).toContain('verified procedures');
    expect(guide).toContain('activation proof');
    expect(guide).toContain('recall_feedback({"action":"useful","query":"<recall query>","uri":"threadnote://..."})');
    expect(guide).not.toContain('mcp-install <agent> --toolset full --apply');
    // It instructs the agent to present + offer, not to paste verbatim.
    expect(guide).toMatch(/OFFER to run it/);
    expect(guide).toMatch(/Do NOT paste this list verbatim/);
    expect(guide).toContain('Context Brief for non-trivial local repo work');
    expect(guide).toContain('bounded graph evidence with freshness');
    expect(guide).toContain('Recall is the memory-focused alternative.');
    expect(guide).toContain('required handoff');
    expect(guide).toContain('five-field Knowledge Delta');
    expect(guide).toContain('required handoff is a private direct write');
    expect(guide).toContain('optional Knowledge Delta proposals are never auto-applied or auto-shared');
    expect(guide).not.toContain('No durable write, apply, or share happens automatically');
    expect(guide).not.toContain('Codex/Claude/Cursor');
    expect(guide).toContain('Results are unread pointers, not evidence');
    expect(guide).not.toContain('unread pointer queue');
    expect(guide).toContain('read the most relevant');
    expect(guide).toContain('URI with read_context');
    expect(guide).toContain('context_brief({"task":"<task>","callerCwd":"<abs cwd>"');
    expect(guide).toContain('inspect_code_graph/analyze_code_graph');
    expect(guide).toContain('`threadnote context check`');
    expect(guide).toContain('`threadnote procedure status`');
    expect(guide).toContain('`threadnote guidance import`');
    expect(guide).toContain('`threadnote activate start`');
    expect(guide).toContain('`threadnote value report`');
    expect(guide).toContain('approve (optional editedText), defer, or reject');
    expect(guide).toContain('a Context Brief is the usual starting point');
    expect(guide).not.toContain('recall for the current repo is the usual starting point');
    expect(guide).toContain('context_health({');
    expect(guide).toContain('recall feedback');
    expect(guide).toContain('owner');
    expect(guide).toContain('review_after');
    expect(guide).toContain('validTo/valid_to');
    expect(guide).toContain('Use the CLI only for workflows that do not have an MCP call');
  });

  it('includes runnable advanced MCP calls for the full toolset', () => {
    const guide = buildOnboardingGuide({seededProjects: [], teams: [], toolset: 'full'});
    expect(guide).toContain('compact_context(');
    expect(guide).toContain('share_skill(');
    expect(guide).toContain('procedure_publish_preview');
    expect(guide).toContain('procedure_publish_apply');
    expect(guide).toContain('complete_activation_retrieval_proof');
    expect(guide).toContain('recall_feedback');
    expect(guide).toContain('<agent-skill-dir>/<name>/SKILL.md');
    expect(guide).not.toContain('~/.claude/skills/');
  });

  it('describes shared durable writes and transient local handoffs for Cursor Cloud', () => {
    const guide = buildOnboardingGuide({
      seededProjects: [],
      teams: ['engineering'],
      toolset: 'cursor-cloud-personal',
    });
    expect(guide).toContain('one MCP bounded to its configured Git memory shares');
    expect(guide).toContain('unread pointers, not evidence');
    expect(guide).toContain('use read_context before relying');
    expect(guide).toContain('remember_context');
    expect(guide).toContain('committed and pushed only to that share');
    expect(guide).toContain('kind=handoff write stays local');
    expect(guide).toContain('all other personal/local memory kinds stay inaccessible');
    expect(guide).not.toContain('share_publish(');
    expect(guide).not.toContain('inspect_code_graph');
    expect(guide).not.toContain('analyze_code_graph');
  });

  it('keeps the Cursor remote-hybrid local guide free of memory fallback', () => {
    const guide = buildOnboardingGuide({seededProjects: [], teams: [], toolset: 'cursor-cloud-local'});
    expect(guide).toContain('managed threadnote-memory HTTP server');
    expect(guide).toContain('threadnote-share-id');
    expect(guide).toContain('same share binding');
    expect(guide).toContain('complete_cursor_attestation');
    expect(guide).toContain('Never fall back');
    expect(guide).not.toContain('remember_context(');
    expect(guide).not.toContain('recall_context(');
    expect(guide).toContain('inspect_code_graph');
    expect(guide).toContain('analyze_code_graph');
  });

  it('nudges first-time team setup when no team is configured', () => {
    const guide = buildOnboardingGuide({seededProjects: [], teams: []});
    expect(guide).toContain('No share team configured yet');
    expect(guide).toContain('threadnote share init');
  });

  it('names configured teams and offers direct publish', () => {
    const guide = buildOnboardingGuide({seededProjects: [], teams: ['default', 'friends']});
    expect(guide).toContain('Team sharing is configured: default, friends');
    expect(guide).toContain('share_publish({"uri":"threadnote://');
  });

  it('lists seeded projects when present', () => {
    const guide = buildOnboardingGuide({seededProjects: ['coda', 'mobile-native'], teams: []});
    expect(guide).toContain('Seeded project guidance is available for: coda, mobile-native');
  });

  it('leads with initializing the owned home when the runtime is not ready', () => {
    const guide = buildOnboardingGuide({runtimeReady: false, seededProjects: [], teams: []});
    expect(guide).toContain('Threadnote home is not ready');
    expect(guide).toContain('threadnote install');
  });

  it('says the self-contained runtime is ready when healthy', () => {
    const guide = buildOnboardingGuide({runtimeReady: true, seededProjects: [], teams: []});
    expect(guide).toContain('self-contained Threadnote runtime is ready');
    expect(guide).toContain('threadnote doctor');
  });
});
