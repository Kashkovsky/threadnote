import {describe, expect, it} from 'vitest';
import {buildOnboardingGuide} from '../../src/onboarding.js';

describe('buildOnboardingGuide', () => {
  it('lists core calls and catalogs advanced capability categories', () => {
    const guide = buildOnboardingGuide({seededProjects: [], teams: []});
    expect(guide).toContain('# Threadnote — what you can do here');
    for (const call of [
      'recall_context(',
      'review_session_context(',
      'apply_memory_candidates',
      'remember_context(',
      'share_publish(',
    ]) {
      expect(guide).toContain(call);
    }
    expect(guide).not.toContain('compact_context(');
    expect(guide).not.toContain('share_skill(');
    expect(guide).toContain('Memory maintenance');
    expect(guide).toContain('Native resource utilities');
    expect(guide).toContain('Advanced sharing and artifacts');
    expect(guide).toContain('mcp-install <agent> --toolset full --apply');
    // It instructs the agent to present + offer, not to paste verbatim.
    expect(guide).toMatch(/OFFER to run it/);
    expect(guide).toMatch(/Do NOT paste this list verbatim/);
    expect(guide).toContain('Store routine durable feature knowledge and handoffs directly');
    expect(guide).toContain('Review only additional session-extracted candidates');
    expect(guide).toContain('"decisions":["Additional decision..."]');
    expect(guide).toContain('"sourceSessionId":"<session-id>"');
  });

  it('includes runnable advanced MCP calls for the full toolset', () => {
    const guide = buildOnboardingGuide({seededProjects: [], teams: [], toolset: 'full'});
    expect(guide).toContain('compact_context(');
    expect(guide).toContain('share_skill(');
  });

  it('describes shared durable writes and transient local handoffs for Cursor Cloud', () => {
    const guide = buildOnboardingGuide({seededProjects: [], teams: ['engineering'], toolset: 'cursor-cloud'});
    expect(guide).toContain('exclusive shared-memory scope');
    expect(guide).toContain('remember_context');
    expect(guide).toContain('committed and pushed');
    expect(guide).toContain('kind=handoff write stays local');
    expect(guide).toContain('all other personal/local memory kinds stay inaccessible');
    expect(guide).not.toContain('share_publish(');
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
