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

export const graphInspectScenario: TraceScenario = {
  eyebrow: 'Scoped source inspection',
  title: 'Trace one change through the current worktree',
  description: 'Find the concept, verify its path, and measure downstream impact with source-level evidence.',
  steps: [
    {
      kind: 'user',
      actor: 'You',
      text: 'Where does the checkout retry policy enter the request flow, and what depends on it?',
    },
    {
      kind: 'tool',
      actor: 'inspect_code_graph · query',
      text: '{"operation":"query","query":"checkout retry policy","callerCwd":"/monorepo/apps/storefront"}',
      meta: 'current commit + isolated dirty overlay',
    },
    {
      kind: 'result',
      actor: 'Threadnote',
      text: 'Top current-source match: CheckoutRetryPolicy · stable node cgs_7b93…f281',
      evidence: ['libs/checkout/src/CheckoutRetryPolicy.ts:24'],
    },
    {
      kind: 'tool',
      actor: 'inspect_code_graph · neighbors',
      text: '{"operation":"neighbors","nodeId":"cgs_7b93d0c4b0a849a18ed8733c1402f281","direction":"incoming","depth":1,"callerCwd":"/monorepo/apps/storefront"}',
      meta: 'exact stable ID · bounded authoritative adjacency',
    },
    {
      kind: 'tool',
      actor: 'inspect_code_graph · path',
      text: '{"operation":"path","from":"CheckoutController","to":"CheckoutRetryPolicy","callerCwd":"/monorepo/apps/storefront"}',
      meta: 'declared + resolved + syntactic evidence',
    },
    {
      kind: 'result',
      actor: 'Threadnote',
      text: 'CheckoutController → OrderSubmitter → CheckoutRetryPolicy',
      evidence: ['apps/storefront/src/CheckoutController.ts:51', 'libs/orders/src/OrderSubmitter.ts:73'],
    },
    {
      kind: 'tool',
      actor: 'inspect_code_graph · impact',
      text: '{"operation":"impact","query":"CheckoutRetryPolicy","callerCwd":"/monorepo/apps/storefront"}',
      meta: 'reverse dependencies · authoritative by default',
    },
    {
      kind: 'assistant',
      actor: 'Agent',
      text: 'The retry policy enters through OrderSubmitter and reaches the storefront plus the background order worker. I found six authoritative consumers; lower-confidence associations remain labeled and opt-in.',
    },
  ],
};

export const graphAnalyzeScenario: TraceScenario = {
  eyebrow: 'Whole-repository analysis',
  title: 'See the architecture before changing the boundary',
  description: 'Summarize topology separately from a scoped source lookup, with deterministic and honest coverage.',
  steps: [
    {
      kind: 'user',
      actor: 'You',
      text: 'Before we split order processing, show me the architecture risks in this repository.',
    },
    {
      kind: 'tool',
      actor: 'analyze_code_graph · full',
      text: '{"operation":"full","callerCwd":"/monorepo/apps/storefront"}',
      meta: 'paged SQLite analysis · no repository admission cap',
    },
    {
      kind: 'result',
      actor: 'Threadnote',
      text: 'Complete coverage · 14 communities · 3 components · 2 god nodes · 4 structural groups',
      evidence: [
        'community: order-lifecycle · 96 nodes',
        'hub: PaymentGateway · degree 34',
        'group: checkout coordination · 5 participants',
      ],
    },
    {
      kind: 'tool',
      actor: 'analyze_code_graph · community',
      text: '{"operation":"community","communityId":"cgc_4f1a2b3c4d5e6f708192a3b4c5d6e7f8","memberLimit":40,"callerCwd":"/monorepo/apps/storefront"}',
      meta: 'stable drill-down · bounded members',
    },
    {
      kind: 'assistant',
      actor: 'Agent',
      text: 'PaymentGateway and OrderEventBus are the highest-blast-radius hubs. The order-lifecycle boundary and its five-participant checkout group deserve inspection before the split. Threadnote also suggested two focused follow-up questions for this snapshot.',
    },
  ],
};
