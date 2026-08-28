import type {TraceScenario} from '../components/AgentTrace.js';

export type ProTip = {
  id: string;
  number: string;
  category: 'team' | 'continuity' | 'operations' | 'graph';
  title: string;
  summary: string;
  why: string;
  practice: string[];
  scenario: TraceScenario;
};

export const proTips: ProTip[] = [
  {
    id: 'share-before-pr',
    number: '01',
    category: 'team',
    title: 'Share the feature memory before the PR.',
    summary: 'Give reviewers the design constraints and trade-offs that cannot fit cleanly in the diff.',
    why: 'A curated durable memory makes intent discoverable before review begins, while the PR remains the source of truth for code.',
    practice: [
      'Update one stable feature memory instead of creating a timeline of duplicates.',
      'Preview the exact shared bytes and resolve any reported leak before publishing.',
      'Reference the team, project, and topic in the PR; another user’s local threadnote:// URI is not portable.',
    ],
    scenario: {
      eyebrow: 'Review with context',
      title: 'The reviewer sees why—not only what',
      description: 'A durable feature record is curated, previewed, and shared before review.',
      steps: [
        {
          kind: 'user',
          actor: 'You',
          text: 'The auth refresh PR is ready. Give reviewers the design context.',
        },
        {
          kind: 'tool',
          actor: 'remember_context',
          text: '{"kind":"durable","project":"mobile","topic":"auth-refresh","replaceUri":"threadnote://user/alice/memories/durable/projects/mobile/auth-refresh.md","text":"Refresh tokens rotate inside one coordinator. Review callers against the rotation window and staged rollout constraints."}',
          meta: 'stable identity · updated in place',
        },
        {
          kind: 'result',
          actor: 'Threadnote',
          text: 'Updated durable feature memory',
          evidence: ['threadnote://…/mobile/auth-refresh.md'],
        },
        {
          kind: 'tool',
          actor: 'share_publish',
          text: '{"uri":"threadnote://user/alice/memories/durable/projects/mobile/auth-refresh.md","team":"mobile-team","preview":true}',
          meta: 'exact shared bytes · no write',
        },
        {
          kind: 'action',
          actor: 'You',
          text: 'Approve the exact preview for publication.',
        },
        {
          kind: 'tool',
          actor: 'share_publish',
          text: '{"uri":"threadnote://user/alice/memories/durable/projects/mobile/auth-refresh.md","team":"mobile-team","preview":false}',
          meta: 'approved publish · committed and pushed',
        },
        {
          kind: 'result',
          actor: 'Threadnote',
          text: 'Published mobile-team · mobile · auth-refresh',
          evidence: ['threadnote://user/alice/memories/shared/mobile-team/durable/projects/mobile/auth-refresh.md'],
        },
        {
          kind: 'tool',
          actor: 'recall_context',
          text: '{"project":"mobile","query":"auth-refresh rotation window rollout constraints","callerCwd":"/repo/mobile"}',
          meta: 'reviewer auto-syncs, then recalls',
        },
        {
          kind: 'assistant',
          actor: 'Reviewer agent',
          text: 'The PR names mobile-team · mobile · auth-refresh. I recalled the shared decision locally and will review the diff against its rotation-window and rollout invariants.',
        },
      ],
    },
  },
  {
    id: 'parallel-team',
    number: '02',
    category: 'team',
    title: 'Work in parallel without losing the shared edge.',
    summary: 'Publish reusable decisions while keeping branch-specific handoffs local to each teammate.',
    why: 'Shared durable memory synchronizes the contract; local handoffs preserve the mechanics of each worktree.',
    practice: [
      'Use the same project and topic identity for the shared contract.',
      'Never publish handoffs, private logs, or raw customer material.',
      'Recall at task start so auto-sync pulls the newest curated team memory.',
    ],
    scenario: {
      eyebrow: 'Parallel implementation',
      title: 'Web and mobile move on one contract',
      description: 'Two agents synchronize a decision while their branch state remains separate.',
      steps: [
        {
          kind: 'user',
          actor: 'Alice',
          text: 'Publish the finalized session envelope for the mobile team.',
        },
        {
          kind: 'tool',
          actor: 'share_publish',
          text: '{"uri":"threadnote://user/alice/memories/durable/projects/mobile/session-envelope.md","team":"mobile-team","preview":true}',
          meta: 'exact shared bytes · no write',
        },
        {
          kind: 'action',
          actor: 'Alice',
          text: 'Approve this preview for the mobile team.',
        },
        {
          kind: 'tool',
          actor: 'share_publish',
          text: '{"uri":"threadnote://user/alice/memories/durable/projects/mobile/session-envelope.md","team":"mobile-team","preview":false}',
          meta: 'approved publish · Git-backed',
        },
        {
          kind: 'result',
          actor: 'Threadnote',
          text: 'Published revision 8f2c1d',
          evidence: ['threadnote://user/alice/memories/shared/mobile-team/durable/projects/mobile/session-envelope.md'],
        },
        {
          kind: 'user',
          actor: 'Bob',
          text: 'Implement the Android consumer using our current contract.',
        },
        {
          kind: 'tool',
          actor: 'recall_context',
          text: '{"project":"mobile","query":"session envelope Android","callerCwd":"/repo/android"}',
          meta: 'auto-sync then recall',
        },
        {
          kind: 'assistant',
          actor: 'Bob’s agent',
          text: 'The shared contract now includes nonce rotation. I’ll keep Android branch status in a separate local handoff.',
        },
      ],
    },
  },
  {
    id: 'orchestrated-worktrees',
    number: '03',
    category: 'continuity',
    title: 'Give every parallel agent its own worktree.',
    summary: 'Share local memory while keeping each agent’s dirty source graph isolated to its checkout.',
    why: 'Conductor-style orchestrators can run several agents against linked worktrees without one branch’s uncommitted files becoming another branch’s current-code evidence.',
    practice: [
      'Pass each agent’s absolute worktree path as callerCwd on recall and graph calls.',
      'Let the first graph call start immediately: a graph-equivalent commit can reuse ready content, while a compatible clean commit builds a bounded delta.',
      'Manager-triggered indexing and Workset preparation run in isolated processes, with repository members prepared at bounded concurrency.',
      'Use a distinct handoff topic for each independent task; share a topic only when agents intentionally update one record.',
      'Let Threadnote coordinate graph publication and maintenance—do not copy or share derived index files between worktrees.',
    ],
    scenario: {
      eyebrow: 'Multi-agent orchestration',
      title: 'Two agents, one repository, isolated current code',
      description: 'Both agents recall the same decision while each graph call follows its own linked worktree.',
      steps: [
        {
          kind: 'user',
          actor: 'You',
          text: 'Implement the API and mobile parts of session refresh in parallel.',
        },
        {
          kind: 'tool',
          actor: 'recall_context · API agent',
          text: '{"project":"identity","query":"session refresh contract","callerCwd":"/repo/.worktrees/refresh-api"}',
          meta: 'shared canonical memory · API worktree scope',
        },
        {
          kind: 'tool',
          actor: 'inspect_code_graph · API agent',
          text: '{"operation":"query","query":"session refresh endpoint","callerCwd":"/repo/.worktrees/refresh-api"}',
          meta: 'API dirty overlay only',
        },
        {
          kind: 'tool',
          actor: 'recall_context · mobile agent',
          text: '{"project":"identity","query":"session refresh contract","callerCwd":"/repo/.worktrees/refresh-mobile"}',
          meta: 'same canonical memory · mobile worktree scope',
        },
        {
          kind: 'tool',
          actor: 'inspect_code_graph · mobile agent',
          text: '{"operation":"query","query":"session refresh coordinator","callerCwd":"/repo/.worktrees/refresh-mobile"}',
          meta: 'mobile dirty overlay only',
        },
        {
          kind: 'result',
          actor: 'Threadnote',
          text: 'Both agents recalled one contract; reusable committed graph work was shared, and each source result came from its own isolated worktree state.',
          evidence: ['apps/api/src/RefreshEndpoint.ts:38', 'apps/mobile/src/RefreshCoordinator.kt:52'],
        },
        {
          kind: 'assistant',
          actor: 'Orchestrator',
          text: 'The agents share the refresh contract, but their uncommitted code remains isolated. I’ll keep API and mobile status in separate handoff topics.',
        },
      ],
    },
  },
  {
    id: 'on-call',
    number: '04',
    category: 'operations',
    title: 'Turn an incident into the next on-caller’s head start.',
    summary: 'Preserve the privacy-safe diagnosis, signals, mitigations, and follow-up—not the production transcript.',
    why: 'The next incident starts with known failure modes and verified commands instead of institutional archaeology.',
    practice: [
      'Remove customer data, credentials, raw logs, and ephemeral identifiers.',
      'Publish only a sanitized durable pattern or runbook amendment; keep the incident record and handoff personal.',
      'Record what ruled hypotheses in or out, what mitigation worked, and which repository runbook remains authoritative.',
    ],
    scenario: {
      eyebrow: 'On-call continuity',
      title: 'A familiar symptom gets a faster answer',
      description: 'A sanitized durable pattern turns last month’s incident learning into shared evidence.',
      steps: [
        {
          kind: 'user',
          actor: 'Previous on-caller',
          text: 'Preserve the reusable retry-storm diagnosis for the next rotation.',
        },
        {
          kind: 'tool',
          actor: 'remember_context',
          text: '{"kind":"durable","project":"checkout","topic":"retry-storm-pattern","text":"A deploy-time latency spike plus a draining queue and doubled retries previously indicated retry amplification. Verify the three safe checks in the current repository runbook before mitigating."}',
          meta: 'sanitized learning · no raw incident log',
        },
        {
          kind: 'tool',
          actor: 'share_publish',
          text: '{"uri":"threadnote://user/alice/memories/durable/projects/checkout/retry-storm-pattern.md","team":"platform-on-call","preview":true}',
          meta: 'exact shared bytes · no write',
        },
        {
          kind: 'action',
          actor: 'Previous on-caller',
          text: 'Approve the sanitized durable pattern.',
        },
        {
          kind: 'tool',
          actor: 'share_publish',
          text: '{"uri":"threadnote://user/alice/memories/durable/projects/checkout/retry-storm-pattern.md","team":"platform-on-call","preview":false}',
          meta: 'approved durable publish',
        },
        {
          kind: 'user',
          actor: 'Next on-caller',
          text: 'Checkout latency jumped after a deploy. Have we seen this shape before?',
        },
        {
          kind: 'tool',
          actor: 'recall_context',
          text: '{"project":"checkout","query":"latency after deploy queue saturation","callerCwd":"/repo/checkout"}',
          meta: 'auto-sync · scope · lifecycle · authority',
        },
        {
          kind: 'result',
          actor: 'Threadnote',
          text: 'Found the shared durable retry-storm pattern',
          evidence: [
            'threadnote://user/on-caller/memories/shared/platform-on-call/durable/projects/checkout/retry-storm-pattern.md',
          ],
        },
        {
          kind: 'tool',
          actor: 'read_context',
          text: '{"uri":"threadnote://user/on-caller/memories/shared/platform-on-call/durable/projects/checkout/retry-storm-pattern.md"}',
        },
        {
          kind: 'assistant',
          actor: 'Agent',
          text: 'A similar deploy amplified retries while the queue drained. The durable pattern lists three safe checks; I’ll verify them against the current repository runbook before proposing a mitigation.',
        },
      ],
    },
  },
  {
    id: 'switch-agents',
    number: '05',
    category: 'continuity',
    title: 'Start in one agent. Continue in another.',
    summary: 'A concise handoff carries exact status, checks, blockers, and next steps across agent boundaries.',
    why: 'The handoff is tool-neutral and lives outside either chat, so changing interfaces does not reset the work.',
    practice: [
      'Store the handoff before switching agents or allowing a long session to compact.',
      'Include commands and outcomes, not raw terminal output.',
      'Keep durable design knowledge separate from temporary branch status.',
    ],
    scenario: {
      eyebrow: 'Agent portability',
      title: 'Codex hands a live branch to Claude',
      description: 'The next agent begins from a structured handoff rather than a copied transcript.',
      steps: [
        {
          kind: 'user',
          actor: 'You · Codex',
          text: 'Save the current state. I’m continuing in another agent.',
        },
        {
          kind: 'tool',
          actor: 'remember_context',
          text: '{"kind":"handoff","project":"billing","topic":"retry-policy","text":"Parser and unit tests pass. The jitter-boundary property test still fails; reproduce and fix that boundary next."}',
          meta: 'status · checks · blocker · next step',
        },
        {
          kind: 'result',
          actor: 'Threadnote',
          text: 'Stored active handoff',
          evidence: ['threadnote://…/handoffs/active/billing/retry-policy.md'],
        },
        {
          kind: 'user',
          actor: 'You · Claude',
          text: 'Continue the billing retry-policy work.',
        },
        {
          kind: 'tool',
          actor: 'recall_context',
          text: '{"project":"billing","query":"latest retry policy handoff","callerCwd":"/repo/billing"}',
        },
        {
          kind: 'assistant',
          actor: 'Claude',
          text: 'The parser and unit tests pass. One property test still exposes a jitter-boundary bug; I’ll start there.',
        },
      ],
    },
  },
  {
    id: 'resume-later',
    number: '06',
    category: 'continuity',
    title: 'Resume a feature a month later.',
    summary:
      'Stable durable memory preserves the decisions; archived handoffs preserve the historical trail without competing in active recall.',
    why: 'Time changes relevance, but it should not erase the reasoning that shaped the feature.',
    practice: [
      'Write durable records around contracts and non-obvious constraints.',
      'Archive completed handoffs so current work ranks above historical status.',
      'Update the same URI when a decision changes and record what superseded it.',
    ],
    scenario: {
      eyebrow: 'Long-running work',
      title: 'Thirty days later, the why is still intact',
      description: 'Lifecycle-aware recall separates lasting decisions from old branch status.',
      steps: [
        {
          kind: 'user',
          actor: 'You',
          text: 'Restart the offline sync feature. What still matters from last month?',
        },
        {
          kind: 'tool',
          actor: 'recall_context',
          text: '{"project":"mobile","query":"offline sync decisions handoff","callerCwd":"/repo/mobile"}',
          meta: 'durable boosted · archived handoff demoted',
        },
        {
          kind: 'result',
          actor: 'Threadnote',
          text: '2 durable decisions, 1 archived handoff',
          evidence: ['threadnote://…/offline-sync-contract.md', 'threadnote://…/offline-conflict-policy.md'],
        },
        {
          kind: 'assistant',
          actor: 'Agent',
          text: 'The durable constraints still apply: operations are idempotent and server order wins only after vector-clock comparison. The archived handoff is historical, so I’ll verify its file references against the graph.',
        },
      ],
    },
  },
  {
    id: 'graph-operations',
    number: '07',
    category: 'graph',
    title: 'Choose the graph operation that matches the question.',
    summary:
      'Query finds candidates, explain expands one symbol, path connects two endpoints, and impact shows downstream change risk.',
    why: 'A precise operation produces smaller, stronger evidence than broad repository search—especially in a monorepo.',
    practice: [
      'Start with query when you do not know the symbol name.',
      'Use explain for definitions plus immediate relationships.',
      'Use path for a concrete flow and impact before changing a symbol or comparing a Git base.',
    ],
    scenario: {
      eyebrow: 'Graph search',
      title: 'From product language to a verified change surface',
      description: 'The agent narrows a fuzzy request before touching the monorepo.',
      steps: [
        {
          kind: 'user',
          actor: 'You',
          text: 'Find the request retry flow and tell me what breaks if we change it.',
        },
        {
          kind: 'tool',
          actor: 'inspect_code_graph · query',
          text: '{"operation":"query","query":"request retry flow","callerCwd":"/monorepo/app"}',
          meta: 'lexical + symbol vectors',
        },
        {
          kind: 'result',
          actor: 'Threadnote',
          text: 'Top symbol: RequestRetryCoordinator',
          evidence: ['libs/networking/src/RequestRetryCoordinator.ts:41'],
        },
        {
          kind: 'tool',
          actor: 'inspect_code_graph · explain',
          text: '{"operation":"explain","symbol":"RequestRetryCoordinator","callerCwd":"/monorepo/app"}',
          meta: 'definition + typed relationships',
        },
        {
          kind: 'tool',
          actor: 'inspect_code_graph · impact',
          text: '{"operation":"impact","query":"RequestRetryCoordinator","callerCwd":"/monorepo/app"}',
          meta: 'downstream consumers',
        },
        {
          kind: 'assistant',
          actor: 'Agent',
          text: 'The coordinator is used by the web API client and background sync worker. I found five authoritative consumers; two heuristic edges are labeled separately.',
        },
      ],
    },
  },
  {
    id: 'memory-plus-graph',
    number: '08',
    category: 'graph',
    title: 'Cite the code behind consequential memory.',
    summary:
      'Give Context Brief enough evidence to distinguish a stale locator from memory backed by code that changed, disappeared, or cannot be verified.',
    why: 'A citation binds a claim to observed code without pretending that unchanged bytes automatically prove the prose.',
    practice: [
      'Add codeRefs only to consequential source-backed claims; uncited memory remains valid and recallable.',
      'For one repository, pass callerCwd. Use a prepared Workset only when the evidence really spans repositories.',
      'Treat relocated evidence as fresh: stale-link warns about the locator, not the memory. Changed or deleted evidence is stale, and unknown means Threadnote abstained.',
      'When replacing cited memory, pass codeRefs again to recapture it. Omitting them deliberately clears the old citations.',
    ],
    scenario: {
      eyebrow: 'Cited memory',
      title: 'The implementation moved; the evidence survived',
      description:
        'A durable claim captures one symbol, then Context Brief catches its uniquely relocated link without declaring the memory stale.',
      steps: [
        {
          kind: 'user',
          actor: 'You',
          text: 'Preserve why token refresh runs through one coordinator, with the code that supports the decision.',
        },
        {
          kind: 'tool',
          actor: 'inspect_code_graph · query',
          text: '{"operation":"query","query":"refresh token rotation coordinator","callerCwd":"/repo/identity"}',
          meta: 'exact-current source lookup',
        },
        {
          kind: 'result',
          actor: 'Threadnote',
          text: 'RefreshCoordinator · cgs_7b93…f281',
          evidence: ['packages/auth/src/RefreshCoordinator.ts:27'],
        },
        {
          kind: 'tool',
          actor: 'remember_context',
          text: '{"kind":"durable","project":"identity","topic":"refresh-isolation","callerCwd":"/repo/identity","codeRefs":["cgs_7b93d0c4b0a849a18ed8733c1402f281"],"text":"Refresh token rotation stays inside one coordinator to prevent concurrent rotation."}',
          meta: 'optional citation · stable topic',
        },
        {
          kind: 'result',
          actor: 'Threadnote',
          text: 'Stored durable memory with 1 code citation',
          evidence: ['threadnote://…/identity/refresh-isolation.md'],
        },
        {
          kind: 'user',
          actor: 'You · later',
          text: 'The coordinator moved packages. Continue the work and check whether the remembered decision is still grounded.',
        },
        {
          kind: 'tool',
          actor: 'context_brief',
          text: '{"task":"Continue token refresh isolation and check its source-backed memory.","callerCwd":"/repo/identity","project":"identity","mode":"brief"}',
          meta: 'single repository · no Workset required',
        },
        {
          kind: 'result',
          actor: 'Threadnote',
          text: 'Memory fresh · citation relocated · warning stale-link',
          evidence: ['packages/token/src/RefreshCoordinator.ts:27'],
        },
        {
          kind: 'assistant',
          actor: 'Agent',
          text: 'The cited source is byte-identical at one new locator. The stale-link warning is about that locator, not the memory, so I’ll review the claim and then recapture the current code reference.',
        },
      ],
    },
  },
  {
    id: 'portable-graph-checkpoints',
    number: '09',
    category: 'graph',
    title: 'Carry a verified graph across machines.',
    summary:
      'Move one deterministic clean graph between local installations when the receiver is offline or a rebuild would waste time.',
    why: 'The checkpoint carries disposable derived graph data—not raw source-file bytes or memory—and an independently obtained digest authenticates the exact artifact bytes.',
    practice: [
      'Export only after the current commit has an exact ready, clean root graph and a credential-free repository identity.',
      'Treat the artifact as potentially sensitive architecture data: derived names, signatures, and documentation can carry strings embedded in source.',
      'Transfer the checkpoint file and its expected SHA-256 digest through independent trusted paths.',
      'On the receiver, inspect with the expected digest, run the full verify, then import from a checkout of the same repository where the source commit already exists.',
      'No account, hosted service, or Workset is required. Existing schema-v1 and uncited legacy memories remain recallable.',
    ],
    scenario: {
      eyebrow: 'Offline graph portability',
      title: 'Verify before importing on the offline machine',
      description:
        'The sender exports one exact clean graph; the receiver authenticates the file, verifies every logical record, and imports it locally.',
      steps: [
        {
          kind: 'user',
          actor: 'You',
          text: 'Prepare this repository graph for an offline development machine without creating a Workset.',
        },
        {
          kind: 'action',
          actor: 'Source machine',
          text: 'Index the clean current commit.',
          meta: 'threadnote graph index',
        },
        {
          kind: 'action',
          actor: 'Source machine',
          text: 'Export the exact ready graph to a new local artifact.',
          meta: 'threadnote graph checkpoint export --output threadnote-graph.cgcp',
        },
        {
          kind: 'result',
          actor: 'Threadnote',
          text: 'Exported checkpoint · sha256:<digest>',
          evidence: ['threadnote-graph.cgcp', 'sha256:<digest>'],
        },
        {
          kind: 'action',
          actor: 'Transfer',
          text: 'Move the artifact and independently obtained digest to the offline machine.',
          meta: 'manual file transfer · no account or Workset',
        },
        {
          kind: 'action',
          actor: 'Offline machine',
          text: 'Authenticate the artifact framing before inflating graph records.',
          meta: 'threadnote graph checkpoint inspect --input threadnote-graph.cgcp --expected-digest sha256:<digest>',
        },
        {
          kind: 'action',
          actor: 'Offline machine',
          text: 'Fully verify chunks, schema, ordering, coverage, and the logical digest.',
          meta: 'threadnote graph checkpoint verify --input threadnote-graph.cgcp --expected-digest sha256:<digest>',
        },
        {
          kind: 'action',
          actor: 'Offline machine',
          text: 'Import from a checkout of the same repository with the source commit already available.',
          meta: 'threadnote graph checkpoint import --input threadnote-graph.cgcp --expected-digest sha256:<digest>',
        },
        {
          kind: 'assistant',
          actor: 'Agent',
          text: 'The verified graph is ready locally. No Workset was created, and existing v1 and uncited memories were not migrated or filtered.',
        },
      ],
    },
  },
];
