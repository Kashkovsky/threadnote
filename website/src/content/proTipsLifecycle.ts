import type {ProTip} from './proTips.js';

export const lifecycleProTips: ProTip[] = [
  {
    id: 'start-with-context-brief',
    number: '01',
    category: 'continuity',
    title: 'Start with a Context Brief, not a history dump.',
    summary: 'Compile only the reviewed decisions, current evidence, handoff, and procedures relevant to this task.',
    why: 'A bounded brief reduces rediscovery without asking the agent to treat every old note—or every graph result—as equally authoritative.',
    practice: [
      'Name the engineering task and stable project; pass the absolute worktree path.',
      'Add a small set of current-code anchors when you already know the likely surface.',
      'Read selected memory pointers and verify consequential claims in exact local files.',
      'Treat incomplete coverage as unknown, never as proof that no dependency or conflict exists.',
    ],
    scenario: {
      eyebrow: 'Task-first context',
      title: 'A new agent starts with the contract and the live change surface',
      description: 'The brief stays bounded while current source remains authoritative.',
      steps: [
        {
          kind: 'user',
          actor: 'You',
          text: 'Change checkout retries without breaking order submission.',
        },
        {
          kind: 'tool',
          actor: 'context_brief',
          text: '{"mode":"impact","project":"commerce","task":"Change checkout retries without breaking order submission","callerCwd":"/repo/commerce","codeRefs":["apps/checkout/src/retry.ts"],"budgetTokens":1250}',
          meta: 'bounded decisions + handoff + current evidence',
        },
        {
          kind: 'result',
          actor: 'Threadnote',
          text: 'One reviewed retry contract, one active rollout handoff, three current source cards, one verification gap',
          evidence: ['threadnote://…/commerce/retry-contract.md', 'apps/orders/src/submit.ts:64'],
        },
        {
          kind: 'assistant',
          actor: 'Agent',
          text: 'The reviewed contract requires stable idempotency keys. I’ll inspect the exact retry and submit paths now; the brief marked the background worker relationship unknown, so I will not claim it is unaffected.',
        },
      ],
    },
  },
  {
    id: 'review-knowledge-delta',
    number: '02',
    category: 'team',
    title: 'Review the Knowledge Delta before sharing the outcome.',
    summary: 'Keep decisions, constraints, checks, invalidations, and risks—leave the private session behind.',
    why: 'A reviewed delta is small enough to inspect and precise enough for the next engineer to reuse without inheriting unreviewed narration.',
    practice: [
      'Write the required handoff separately from durable candidates.',
      'Check the source evidence and exact mutation preview for every candidate.',
      'Approve, edit, defer, or reject at the current review revision.',
      'Cross the personal-to-team publication boundary only after candidate approval.',
    ],
    scenario: {
      eyebrow: 'Reviewable closeout',
      title: 'A task leaves one decision, not a transcript',
      description: 'The handoff preserves branch state while the reusable decision remains a reviewed proposal.',
      steps: [
        {
          kind: 'user',
          actor: 'You',
          text: 'Close out the retry change and show me exactly what should survive.',
        },
        {
          kind: 'tool',
          actor: 'remember_context',
          text: '{"kind":"handoff","project":"commerce","topic":"retry-rollout","text":"Implementation and focused tests pass. Canary verification remains. Next: run the staged rollout check."}',
          meta: 'required local handoff · never team-published',
        },
        {
          kind: 'tool',
          actor: 'review_session_context',
          text: '{"task":"Change checkout retries without breaking order submission","outcome":"Preserved idempotency keys and added bounded retry verification.","project":"commerce","evidence":["apps/checkout/src/retry.ts","focused retry tests passed"],"decisions":["Keep the original idempotency key across retries."],"constraints":["Do not retry non-idempotent submissions."],"verificationPerformed":["Focused checkout retry tests passed."],"knowledgeInvalidated":["The old fixed-delay retry note is obsolete."],"unresolvedRisks":["Canary verification remains outstanding."]}',
          meta: 'task + outcome + evidence · structured closeout fields',
        },
        {
          kind: 'result',
          actor: 'Threadnote',
          text: 'Knowledge Delta preview: 1 decision, 1 verification record, 1 unresolved rollout risk',
          evidence: ['review review-a1b2c3 · revision 4', 'candidate decision-01 · create'],
        },
        {
          kind: 'action',
          actor: 'You',
          text: 'Approve the edited decision and verification. Defer the rollout risk until the canary completes.',
        },
        {
          kind: 'assistant',
          actor: 'Agent',
          text: 'Applied only the two reviewed changes at revision 4. The handoff remains local, and nothing has been published to the team yet.',
        },
      ],
    },
  },
  {
    id: 'prove-cross-agent-reuse',
    number: '03',
    category: 'team',
    title: 'Prove the decision works in a second agent surface.',
    summary: 'A shared decision earns its keep when another supported surface can retrieve and apply it.',
    why: 'Cross-surface reuse tests the actual product outcome: continuity that survives the vendor boundary with provenance intact.',
    practice: [
      'Publish only active durable knowledge; never publish a handoff or preference.',
      'Preview the exact shared bytes and resolve every scrubber finding.',
      'Recall by project and task from the second configured surface, then read the returned pointer.',
      'Record Applied feedback only when the decision materially changes the plan or implementation.',
    ],
    scenario: {
      eyebrow: 'Cross-vendor reuse',
      title: 'A reviewed decision crosses surfaces through Git',
      description: 'Publication stays explicit, and the receiving agent performs its own bounded recall.',
      steps: [
        {
          kind: 'tool',
          actor: 'share_publish',
          text: '{"uri":"threadnote://user/alice/memories/durable/projects/commerce/retry-contract.md","team":"platform","preview":true}',
          meta: 'exact bytes · no write',
        },
        {
          kind: 'action',
          actor: 'You',
          text: 'Approve these exact bytes for the platform team.',
        },
        {
          kind: 'tool',
          actor: 'share_publish',
          text: '{"uri":"threadnote://user/alice/memories/durable/projects/commerce/retry-contract.md","team":"platform","preview":false}',
          meta: 'approved Git publication',
        },
        {
          kind: 'tool',
          actor: 'recall_context · second surface',
          text: '{"project":"commerce","query":"checkout retry idempotency contract","callerCwd":"/repo/commerce"}',
          meta: 'different catalog-supported agent surface',
        },
        {
          kind: 'assistant',
          actor: 'Second agent',
          text: 'I found the reviewed team decision and its current code evidence. It changes my plan: I will preserve the original idempotency key and verify the order worker before editing.',
        },
      ],
    },
  },
  {
    id: 'repair-context-decay',
    number: '04',
    category: 'operations',
    title: 'Treat unknown and overdue context as work to review.',
    summary: 'Health findings should produce bounded repair proposals, not silent cleanup.',
    why: 'A trustworthy context system must show when it cannot prove freshness and preserve the history behind superseded or retired knowledge.',
    practice: [
      'Add an opaque owner, review date, or explicit validity only when the team actually chose it.',
      'Run health before a risky change and Context Check beside the code review.',
      'Treat missing, partial, or stale graph coverage as unknown—not clean.',
      'Preview repairs and bind contradiction direction explicitly before superseding either record.',
    ],
    scenario: {
      eyebrow: 'Continuous context health',
      title: 'A changed citation becomes a review, not a deletion',
      description: 'The report distinguishes evidence states and keeps semantic judgment with a person.',
      steps: [
        {
          kind: 'user',
          actor: 'You',
          text: 'Check whether the commerce context is still safe to reuse before this release.',
        },
        {
          kind: 'action',
          actor: 'Agent',
          text: 'Run the read-only project health report and compare this branch with the review base.',
        },
        {
          kind: 'result',
          actor: 'Threadnote',
          text: 'One changed citation, one overdue decision, one possible contradiction, and one unknown graph-impact lane',
          evidence: ['repairable: review required', 'Context Check exit 2: evidence unavailable'],
        },
        {
          kind: 'assistant',
          actor: 'Agent',
          text: 'I will not report this project clean. I can preview an owner/review update and a citation repair, but the contradiction needs a person to identify which record is current.',
        },
      ],
    },
  },
  {
    id: 'admit-verified-procedure',
    number: '05',
    category: 'operations',
    title: 'Admit a procedure only when it is current and compatible.',
    summary: 'Keep reusable workflows behind exact verification, dependency, surface, and rollout checks.',
    why: 'A procedure can change the repository or environment; compatibility and current verification matter more than how confidently its prose is written.',
    practice: [
      'Preview local verification before allowing any command to execute.',
      'Bind the receipt to exact manifest, artifact, fixture, runtime, and post-command bytes.',
      'Publish exact reviewed bytes under a stable artifact ID and semantic version.',
      'Let Context Brief admit only a task-relevant, compatible, rollout-eligible dependency closure.',
    ],
    scenario: {
      eyebrow: 'Reviewed procedural context',
      title: 'The brief includes the safe rollout playbook—and excludes the stale one',
      description:
        'Procedure provenance stays distinct from factual decisions and no executable body enters the brief.',
      steps: [
        {
          kind: 'user',
          actor: 'You',
          text: 'Prepare the checkout retry rollout using our current verified procedure.',
        },
        {
          kind: 'tool',
          actor: 'context_brief',
          text: '{"mode":"brief","project":"commerce","task":"Prepare the checkout retry rollout using the current verified procedure","callerCwd":"/repo/commerce","budgetTokens":1250}',
          meta: 'task relevance + compatibility + verification gate',
        },
        {
          kind: 'result',
          actor: 'Threadnote',
          text: 'Admitted retry-rollout 2.1.0 with current Git verification; excluded 2.0.0 as superseded',
          evidence: ['verified-procedure-git-share · platform', 'dependency closure complete'],
        },
        {
          kind: 'assistant',
          actor: 'Agent',
          text: 'The brief identifies the reviewed procedure and current receipt without embedding executable commands. I’ll open the exact local artifact before following it.',
        },
      ],
    },
  },
];
