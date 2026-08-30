import {Effect} from 'effect';
import {readSeedManifest} from './manifest.js';
import type {McpToolset} from './mcp/toolset.js';
import {readTeamsFile} from './share/index.js';

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
  readonly runtimeReady?: boolean;
  readonly teams: readonly string[];
  readonly toolset?: McpToolset;
}

// Reads the local, cheap pieces of onboarding state (configured share teams and
// seeded projects). Runtime readiness is probed separately by the caller.
export const gatherOnboardingContext = Effect.fn('onboarding.gatherContext')(function* (config: OnboardingConfig) {
  const [seededProjects, teams] = yield* Effect.all([safeSeededProjects(config), safeTeams(config)]);
  return {seededProjects, teams};
});

const safeTeams = Effect.fn('onboarding.safeTeams')((config: OnboardingConfig) =>
  readTeamsFile(config).pipe(Effect.map(file => Object.keys(file.teams ?? {}).sort())),
);

const safeSeededProjects = Effect.fn('onboarding.safeSeededProjects')((config: OnboardingConfig) =>
  readSeedManifest(config.manifestPath).pipe(Effect.map(manifest => manifest.projects.map(project => project.name))),
);

// Builds the agent-facing onboarding walkthrough. Pure and deterministic so it is
// unit-testable without MCP plumbing. The text is instructions FOR
// the agent (present conversationally, offer to run), not a message to paste.
export function buildOnboardingGuide(state: OnboardingState): string {
  if (state.toolset === 'cursor-cloud-local') {
    return [
      '# Threadnote remote-hybrid mode for Cursor Cloud Agents',
      '',
      'Use the managed threadnote-memory HTTP server for every historical memory read and write.',
      'It is bound to exactly one remote memory share by the threadnote-share-id Dashboard header.',
      'Do not remove, replace, or infer that share binding from a memory URI.',
      'This local server deliberately has no recall, read, list, remember, resource, or Git-share tools.',
      'Never fall back to personal or VM-local memory when the managed service is unavailable.',
      '',
      'Use inspect_code_graph before broad text search and analyze_code_graph for repository-wide',
      'structure in the current checkout. Named worksets are unavailable in this cloud-local profile.',
      'Use cursor_cloud_status to check the two planes and confirm the same share binding independently.',
      '',
      'When the managed server returns an attestation challenge, pass its exact metadata to',
      'complete_cursor_attestation. The helper sends the Cursor OIDC token directly to Threadnote',
      'and returns only the opaque attestation ID.',
    ].join('\n');
  }
  if (state.toolset === 'cursor-cloud' || state.toolset === 'cursor-cloud-git-beta') {
    return [
      '# Threadnote Cursor Cloud Git beta',
      '',
      'This session has one exclusive shared-memory scope. Start with recall_context.',
      'Its results are unread pointers, not evidence; use read_context before relying on relevant URIs.',
      'Read only the threadnote:// URIs it returns. list_context can browse within that same scope.',
      '',
      'The code graph is local to the current cloud checkout. Use inspect_code_graph before broad text',
      'search and analyze_code_graph for repository-wide structure. Named worksets are unavailable.',
      '',
      'Store durable knowledge with remember_context. Each write is committed and pushed to the configured',
      'share so it survives the ephemeral cloud session. A kind=handoff write stays local and may not survive',
      'a new cloud session; all other personal/local memory kinds stay inaccessible.',
      'Review/apply actions, separate publishing, Obsidian operations, and maintenance tools are unavailable.',
      'Use the remote-hybrid profile instead when managed Threadnote memory is enabled for the environment.',
    ].join('\n');
  }
  const runtimeLine =
    state.runtimeReady === false
      ? 'The Threadnote home is not ready — run `threadnote install`, then `threadnote doctor`. Offer to walk the user through that first.'
      : state.runtimeReady === true
        ? 'The self-contained Threadnote runtime is ready.'
        : 'Runtime status is unknown — run `threadnote doctor` if a native storage or model operation fails.';

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
    `- ${runtimeLine}`,
    `- ${teamLine}`,
    `- ${seedLine}`,
    '',
    '## Capabilities to offer',
    '',
    'Recall context — pull back the last handoff and durable knowledge for the current',
    'repo+branch before starting work, so the session continues where the last one left off.',
    '  Run: recall_context({"query":"<repo> latest handoff","callerCwd":"<abs cwd>"}).',
    '  Treat the result as an unread pointer queue, not evidence; read_context the most relevant',
    '  threadnote:// URI before relying on it.',
    '',
    'Capture work — Store routine durable feature knowledge and handoffs directly at meaningful',
    'task closeout; these writes do not need user approval.',
    '  Run: remember_context({"kind":"durable","project":"<repo>","topic":"<feature>","text":"..."}),',
    '  then remember_context({"kind":"handoff","project":"<repo>","topic":"<feature>","text":"..."}).',
    'Review only additional session-extracted candidates against current memory and show at most three.',
    '  Run: review_session_context({"task":"...","outcome":"...","project":"<repo>","topic":"<feature>",',
    '  "decisions":["Additional decision..."],"sourceSessionId":"<session-id>"}),',
    '  then apply_memory_candidates only after the user approves, edits, defers, or rejects each candidate.',
    '',
    'Share with your team — publish a durable memory teammates’ agents can recall. Secrets are',
    'scrubbed/blocked; handoffs/preferences/local-path notes are never shared.',
    hasTeam
      ? '  Run: share_publish({"uri":"threadnote://user/<you>/memories/durable/projects/<p>/<m>.md"}).'
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
          'Native resource utilities — resource import, grep/glob, health, and recall-index operations.',
          'Advanced sharing and artifacts — conflict resolution plus skill and bundle publishing or installation.',
          'Use the equivalent `threadnote` CLI command when one of these is needed now. To expose their',
          'MCP tools in future sessions, run `threadnote mcp-install <agent> --toolset full --apply` and',
          'start a fresh agent session.',
          '',
        ]),
    'Setup & health — verify the local home, indexes, and optional model files.',
    state.runtimeReady === false
      ? '  Run: `threadnote install`, then `threadnote doctor`.'
      : '  Run: `threadnote doctor` to check prerequisites.',
    '',
    '## How to proceed',
    'Pick the single most useful step for right now given the setup above (if the runtime is',
    'not ready, fix that first; otherwise recall for the current repo is the usual starting point),',
    'describe it in one sentence, and ask whether to run it. Then chain into the others as the',
    'user shows interest. Keep it interactive — one offer at a time, not a wall of options.',
  ].join('\n');
}
