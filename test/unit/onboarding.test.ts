import {describe, expect, it} from 'vitest';
import {buildOnboardingGuide} from '../../src/onboarding.js';

describe('buildOnboardingGuide', () => {
  it('lists the core capabilities with runnable calls', () => {
    const guide = buildOnboardingGuide({seededProjects: [], teams: []});
    expect(guide).toContain('# Threadnote — what you can do here');
    for (const call of ['recall_context(', 'remember_context(', 'compact_context(', 'share_publish(', 'share_skill(']) {
      expect(guide).toContain(call);
    }
    // It instructs the agent to present + offer, not to paste verbatim.
    expect(guide).toMatch(/OFFER to run it/);
    expect(guide).toMatch(/Do NOT paste this list verbatim/);
  });

  it('nudges first-time team setup when no team is configured', () => {
    const guide = buildOnboardingGuide({seededProjects: [], teams: []});
    expect(guide).toContain('No share team configured yet');
    expect(guide).toContain('threadnote share init');
  });

  it('names configured teams and offers direct publish', () => {
    const guide = buildOnboardingGuide({seededProjects: [], teams: ['default', 'friends']});
    expect(guide).toContain('Team sharing is configured: default, friends');
    expect(guide).toContain('share_publish({"uri":"viking://');
  });

  it('lists seeded projects when present', () => {
    const guide = buildOnboardingGuide({seededProjects: ['coda', 'mobile-native'], teams: []});
    expect(guide).toContain('Seeded project guidance is available for: coda, mobile-native');
  });

  it('leads with starting the server when it is down', () => {
    const guide = buildOnboardingGuide({seededProjects: [], serverUp: false, teams: []});
    expect(guide).toContain('OpenViking is NOT responding');
    expect(guide).toContain('threadnote start');
  });

  it('says the server is running when healthy', () => {
    const guide = buildOnboardingGuide({seededProjects: [], serverUp: true, teams: []});
    expect(guide).toContain('OpenViking is running.');
    expect(guide).toContain('threadnote doctor');
  });
});
