import type {TraceScenario} from '../components/AgentTrace.js';

export const heroScenario: TraceScenario = {
  eyebrow: 'A real Threadnote workflow',
  title: 'Continue the rollout without re-discovering it',
  description: 'Historical context and current source stay separate, cited, and useful.',
  steps: [
    {
      kind: 'user',
      actor: 'You',
      text: 'Continue the mobile auth rollout. What did we decide, and what code is affected?',
    },
    {
      kind: 'tool',
      actor: 'recall_context',
      text: '{"project":"mobile","query":"auth rollout","callerCwd":"/repo/mobile"}',
      meta: 'scoped local memory recall',
    },
    {
      kind: 'result',
      actor: 'Threadnote',
      text: '2 durable memories and 1 active handoff',
      evidence: ['threadnote://…/mobile/auth-contract.md', 'threadnote://…/mobile/auth-rollout.md'],
    },
    {
      kind: 'tool',
      actor: 'read_context',
      text: '{"uri":"threadnote://user/me/memories/durable/projects/mobile/auth-contract.md"}',
      meta: 'canonical Markdown · local',
    },
    {
      kind: 'tool',
      actor: 'inspect_code_graph',
      text: '{"operation":"impact","query":"AuthSession","callerCwd":"/repo/mobile"}',
      meta: 'current worktree · polyglot graph',
    },
    {
      kind: 'result',
      actor: 'Threadnote',
      text: 'AuthSession reaches WebAuthGate, Android SessionStore, and iOS AuthCoordinator',
      evidence: [
        'apps/web/src/auth/AuthGate.tsx:48',
        'apps/android/SessionStore.kt:71',
        'apps/ios/AuthCoordinator.swift:34',
      ],
    },
    {
      kind: 'assistant',
      actor: 'Agent',
      text: 'We chose rotating refresh tokens and a staged Web → Android → iOS rollout. Web is complete; Android is next. I found three affected entry points and the handoff’s last passing command.',
    },
  ],
};
