import {readSeedManifest} from './manifest.js';
import type {McpToolset} from './mcp_toolset.js';
import {readTeamsFile} from './share.js';

// Minimal config shape the onboarding probes need, structurally satisfied by
// both the CLI and the MCP-adapter RuntimeConfig variants.
interface OnboardingConfig {
  readonly account: string;
  readonly agentContextHome: string;
  readonly agentId: string;
  readonly manifestPath: string;
  readonly user: string;
}

// State the onboarding guide tailors itself to. All fields are best-effort: a
// probe that fails leaves its field empty/undefined so the guide still renders.
export interface OnboardingState {
  readonly seededProjects: readonly string[];
  // true = OpenViking responded healthy, false = it errored, undefined = unknown
  // (not probed / timed out). Only `false` shows the "start the server" nudge.
  readonly serverUp?: boolean;
  readonly teams: readonly string[];
  readonly toolset?: McpToolset;
}

// Reads the local, cheap pieces of onboarding state (configured share teams and
// seeded projects). Server health is probed separately by the caller, since that
// requires the OpenViking adapter the MCP server owns.
export async function gatherOnboardingContext(
  config: OnboardingConfig,
): Promise<Pick<OnboardingState, 'seededProjects' | 'teams'>> {
  return {seededProjects: await safeSeededProjects(config), teams: await safeTeams(config)};
}

async function safeTeams(config: OnboardingConfig): Promise<readonly string[]> {
  try {
    return Object.keys((await readTeamsFile(config)).teams ?? {}).sort();
  } catch (_err: unknown) {
    return [];
  }
}

async function safeSeededProjects(config: OnboardingConfig): Promise<readonly string[]> {
  try {
    return (await readSeedManifest(config.manifestPath)).projects.map(project => project.name);
  } catch (_err: unknown) {
    return [];
  }
}

// Builds the agent-facing onboarding walkthrough. Pure and deterministic so it is
// unit-testable without the MCP/OpenViking plumbing. The text is instructions FOR
// the agent (present conversationally, offer to run), not a message to paste.
export function buildOnboardingGuide(state: OnboardingState): string {
  const serverLine =
    state.serverUp === false
      ? 'OpenViking is NOT responding — recall/remember will fail until the user runs `threadnote start`. Offer to walk them through that first.'
      : state.serverUp === true
        ? 'OpenViking is running.'
        : 'OpenViking status unknown — if recall/remember return connection errors, the fix is `threadnote start`.';

  const teamLine =
    state.teams.length > 0
      ? `Team sharing is configured: ${state.teams.join(', ')}. They can publish memories and skills to teammates.`
      : 'No share team configured yet — team sharing is available but needs a one-time `threadnote share init <git-remote>`.';

  const seedLine =
    state.seededProjects.length > 0
      ? `Seeded project guidance is available for: ${state.seededProjects.join(', ')} (recall surfaces it when the query names the project).`
      : 'No seeded project guidance yet — recall draws on personal memories and shared team memories.';

  const hasTeam = state.teams.length > 0;
  const fullToolset = state.toolset === 'full';

  return [
    '# Threadnote — what you can do here',
    '',
    'You are onboarding the user to Threadnote. Do NOT paste this list verbatim. Read it,',
    'then guide the user conversationally: lead with what is most useful given the state',
    'below, explain one capability in a sentence, and OFFER to run it for them (with their',
    'go-ahead) instead of only describing it. Start small.',
    '',
    '## Current setup',
    `- ${serverLine}`,
    `- ${teamLine}`,
    `- ${seedLine}`,
    '',
    '## Capabilities to offer',
    '',
    'Recall context — pull back the last handoff and durable knowledge for the current',
    'repo+branch before starting work, so the session continues where the last one left off.',
    '  Run: recall_context({"query":"<repo> latest handoff","callerCwd":"<abs cwd>"}), then',
    '  read_context the most relevant viking:// URI it returns.',
    '',
    'Capture work — save a durable fact (a decision, interface, gotcha) or a handoff (current',
    'status + next step) so the next session or a teammate inherits it.',
    '  Run: remember_context({"text":"...","kind":"durable","project":"<repo>","topic":"<feature>"})',
    '  or a handoff with kind:"handoff". Reuse the same project/topic to keep one memory current.',
    '',
    'Share with your team — publish a durable memory teammates’ agents can recall. Secrets are',
    'scrubbed/blocked; handoffs/preferences/local-path notes are never shared.',
    hasTeam
      ? '  Run: share_publish({"uri":"viking://user/<you>/memories/durable/projects/<p>/<m>.md"}).'
      : '  First (one-time): `threadnote share init git@github.com:org/team-memories.git`, then share_publish({"uri":"..."}).',
    '',
    ...(fullToolset
      ? [
          'Tidy memory — when recall surfaces overlapping notes for one topic, preview a scoped merge.',
          '  Run: compact_context({"project":"<repo>","topic":"<topic>","dryRun":true}) and review before applying.',
          '',
          'Share skills & packs — publish a Codex/Claude skill, or a multi-skill pack (skills + shared',
          'scripts), into the team catalog; teammates install them on demand.',
          '  Run: share_skill({"path":"~/.claude/skills/<name>/SKILL.md"}) or',
          '  share_bundle({"path":"<repo>/threadnote-bundle.json"}). Teammates: list_shared_skills({})',
          '  then install_shared_skill({"name":"<name>"}).',
          '',
        ]
      : [
          '## Advanced capabilities',
          '',
          'Memory maintenance — archive and compact overlapping context.',
          'OpenViking utilities and raw parity — resource import, grep/glob, health, watches, and code navigation.',
          'Advanced sharing and artifacts — conflict resolution plus skill and bundle publishing or installation.',
          'Use the equivalent `threadnote` CLI command when one of these is needed now. To expose their',
          'MCP tools in future sessions, run `threadnote mcp-install <agent> --toolset full --apply` and',
          'start a fresh agent session.',
          '',
        ]),
    'Setup & health — verify the local install and server.',
    state.serverUp === false
      ? '  Run: `threadnote start` to bring OpenViking up.'
      : '  Run: `threadnote doctor` to check prerequisites.',
    '',
    '## How to proceed',
    'Pick the single most useful step for right now given the setup above (if the server is',
    'down, that first; otherwise a recall for the current repo is the usual starting point),',
    'describe it in one sentence, and ask whether to run it. Then chain into the others as the',
    'user shows interest. Keep it interactive — one offer at a time, not a wall of options.',
  ].join('\n');
}
