import type {DocsArticle, DocsSection} from './docsTypes.js';

export const threadnote5JourneyDocsArticle: DocsArticle = {
  id: 'threadnote-5-journey',
  title: 'The Threadnote 5 journey',
  summary: 'Start one task with cited context, finish with a reviewed delta, and prove another agent can reuse it.',
  keywords: [
    'guided activation',
    'two agent workflow',
    'source-verifiable context',
    'knowledge delta',
    'second agent reuse',
  ],
  body: [
    {
      type: 'paragraph',
      text: 'Threadnote 5 gives engineering teams one context lifecycle across the [agent surfaces they already use](/agents/). An agent starts with the smallest useful set of current code evidence and reviewed decisions. When the task ends, the agent proposes only what changed for a person to review. Approved knowledge can move through the team’s Git policy and be reused from another supported surface.',
    },
    {
      type: 'heading',
      text: 'The complete loop',
    },
    {
      type: 'list',
      items: [
        'Connect two catalog-supported surfaces. The catalog declares each surface’s managed capabilities and any safety limitation.',
        'Import selected repository guidance or ADRs into review. Imported text never becomes trusted knowledge automatically.',
        'Ask for a bounded Context Brief. It combines relevant decisions, active handoffs, verified procedures, and current code evidence with provenance and freshness.',
        'Work from exact local files and graph evidence. The current worktree remains authoritative.',
        'At closeout, review a Knowledge Delta: decisions and rationale, constraints, checks performed, knowledge made obsolete, and unresolved risks.',
        'Approve, edit, defer, or reject each proposal. Publish an approved durable decision directly or materialize a provider-neutral Git proposal for normal review.',
        'Keep the result healthy with review dates, expiry, citation checks, Context CI, and preview-first repair or retirement.',
        'Retrieve the approved decision from the second surface and inspect local, content-free value evidence.',
      ],
    },
    {
      type: 'note',
      text: 'The local and Git-team journey works without an organization service. Hosted identity, scheduling, dashboards, and provider automation are a separate deployment track and are not required for this workflow.',
    },
    {
      type: 'heading',
      text: 'Try the guided two-surface journey',
    },
    {
      type: 'paragraph',
      text: 'Use guided activation after [installing Threadnote](installation/) and configuring a Git-backed team. It pauses at every review or publication boundary, records only bounded content-free progress, and can resume without repeating completed work.',
    },
    {
      type: 'code',
      language: 'sh',
      code: `cp docs/examples/threadnote-activation-request.json /tmp/threadnote-activation.json
# Edit the two catalog surface IDs, absolute paths, project, topic, and selected guidance.
threadnote activate start --request /tmp/threadnote-activation.json
threadnote activate start --request /tmp/threadnote-activation.json --apply`,
    },
    {
      type: 'paragraph',
      text: 'Each apply run advances to at most one approval boundary. Review the exact preview, use the emitted approval token, and continue with the same request. The final challenge must be completed from the named second surface; pasted recall output is not accepted as proof of reuse.',
    },
    {
      type: 'code',
      language: 'sh',
      code: `threadnote activate continue \
  --activation-id <activation-id> \
  --request /tmp/threadnote-activation.json \
  --approval <approval-token> \
  --approved \
  --apply

threadnote activate status --activation-id <activation-id>`,
    },
    {
      type: 'warning',
      text: 'Activation never silently publishes a decision. If you choose proposal mode, merge the materialized local proposal into the configured team branch and sync it before asking the second surface to prove retrieval.',
    },
  ],
};

export const contextLifecycleConceptDocsArticle: DocsArticle = {
  id: 'context-lifecycle',
  title: 'The context lifecycle',
  summary:
    'Keep source, reviewed knowledge, task state, procedures, and suggestions distinct from capture to retirement.',
  keywords: ['context lifecycle', 'authority', 'knowledge delta', 'context brief', 'provenance', 'freshness'],
  body: [
    {
      type: 'paragraph',
      text: 'Threadnote is a source-verifiable context lifecycle, not a transcript archive or a second code portal. It compiles a bounded task view from several evidence types while preserving what each one can legitimately claim.',
    },
    {
      type: 'table',
      headers: ['Evidence', 'What it contributes', 'Authority'],
      rows: [
        ['Repository and worktree', 'Current implementation, tests, and local changes', 'Exact local files win'],
        [
          'Durable memory',
          'Reviewed decisions, rationale, contracts, and constraints',
          'Canonical Markdown or reviewed team Git',
        ],
        ['Handoff', 'Current task state, checks, blockers, and next step', 'Local and temporary; never team-published'],
        [
          'Verified procedure',
          'A reviewed workflow with compatibility and a current verification receipt',
          'Exact Git-backed artifact and receipt',
        ],
        [
          'Candidate or repair proposal',
          'A suggested knowledge change',
          'Not authoritative until explicitly reviewed and applied',
        ],
        [
          'Derived index or graph',
          'Fast retrieval and current-source relationships',
          'Disposable evidence with snapshot and coverage receipts',
        ],
      ],
    },
    {
      type: 'heading',
      text: 'Start with a Context Brief',
    },
    {
      type: 'paragraph',
      text: 'A Context Brief is the bounded starting package for one task. It selects only relevant graph evidence, decisions, handoffs, freshness results, and compatible verified procedures. Gaps and incomplete evidence remain visible; Threadnote does not turn unavailable evidence into a clean result.',
    },
    {
      type: 'heading',
      text: 'Finish with a Knowledge Delta',
    },
    {
      type: 'paragraph',
      text: 'A Knowledge Delta is a reviewable summary of what the task learned: decisions and rationale, constraints, verification performed, knowledge invalidated, and unresolved risks. It is deliberately smaller than the transcript. Review changes before applying them, then cross the personal-to-team boundary separately.',
    },
    {
      type: 'heading',
      text: 'Maintenance is part of retrieval',
    },
    {
      type: 'paragraph',
      text: 'Owners, review dates, expiry, code citations, relations, guidance projections, and contradiction evidence let health checks distinguish current, changed, missing, unknown, overdue, expired, duplicated, contradictory, drifted, and broken states. Repair, supersession, and retirement preserve history and require review; durable knowledge is never silently deleted.',
    },
  ],
};

export const memorySchemaV5DocsArticle: DocsArticle = {
  id: 'memory-schema-v5',
  title: 'Memory schema v5 compatibility',
  summary: 'Use ownership and review metadata without changing the authority of existing memory.',
  keywords: ['memory schema v5', 'owner', 'review after', 'valid to', 'maintenance metadata', 'compatibility'],
  body: [
    {
      type: 'paragraph',
      text: 'Schema v5 is the compatibility foundation for the Threadnote 5 lifecycle. It adds optional maintenance metadata and safe lifecycle transitions while preserving stable memory identity, code citations, relations, and existing v4 content. It is not a new authority model: adding an owner or review date does not make a claim true.',
    },
    {
      type: 'table',
      headers: ['Field', 'Meaning', 'Behavior'],
      rows: [
        ['owner', 'Opaque person or team label responsible for review', 'Optional; not an organization identity'],
        [
          'review_after',
          'Canonical ISO instant after which review is due',
          'Overdue becomes visible; Threadnote does not renew it',
        ],
        [
          'valid_to',
          'Explicit canonical ISO validity instant',
          'Expired becomes visible; Threadnote does not delete it',
        ],
        [
          'status',
          'Active, archived, superseded, or expired lifecycle state',
          'History and stable identity are preserved',
        ],
      ],
    },
    {
      type: 'paragraph',
      text: 'Existing v4 documents remain readable. Deterministic migration updates the schema header without inventing owner, review, or expiry values. Use the preview-first metadata workflow to change maintenance fields without rewriting the memory body or unrelated provenance.',
    },
    {
      type: 'code',
      language: 'sh',
      code: `threadnote context metadata preview \
  --uri <threadnote-uri> \
  --owner platform-team \
  --review-after 2026-12-31T00:00:00.000Z

# Copy content_hash, proposal_id, and revision from the preview.
# Apply repeats the exact target and patch so Threadnote can recheck them.
threadnote context metadata apply \
  --uri <threadnote-uri> \
  --owner platform-team \
  --review-after 2026-12-31T00:00:00.000Z \
  --content-hash <content-hash> \
  --proposal-id <proposal-id> \
  --revision <revision> \
  --approved`,
    },
  ],
};

export const contextLifecycleDocsSection: DocsSection = {
  id: 'context-lifecycle-workflows',
  title: 'Context lifecycle workflows',
  description: 'Start with verified context, review what changed, share it through Git, and keep it healthy.',
  articles: [
    {
      id: 'context-brief-workflow',
      title: 'Start with a Context Brief',
      summary: 'Give an agent the smallest useful set of reviewed decisions and current code evidence.',
      keywords: ['context brief', 'bounded context', 'code evidence', 'freshness', 'verified procedures'],
      body: [
        {
          type: 'paragraph',
          text: 'Use a Context Brief at the start of a non-trivial task. It combines ready graph evidence, relevant durable decisions, active handoffs, freshness results, and compatible verified procedures inside an 800–1,500 estimated-token budget. It returns provenance and coverage so the agent knows what was established and what still needs exact local inspection.',
        },
        {
          type: 'code',
          language: 'sh',
          code: `threadnote context brief \
  --task "Change checkout retries without breaking order submission" \
  --project commerce \
  --code-ref apps/checkout/src/retry.ts \
  --budget-tokens 1250`,
        },
        {
          type: 'list',
          items: [
            'Use `mode locate` to find implementation surfaces, `trace` for relationships, `impact` for downstream effects, and `explain` for concise rationale.',
            'Pass up to eight graph-indexed repository-relative paths or exact `cgs_` IDs to move from current code to memories that cite it.',
            'Read recalled `threadnote://` pointers before relying on them; ranking is discovery, not evidence.',
            'Verify consequential current-source claims in the worktree. Stale or partial graph evidence can guide bounded discovery but cannot prove an exact path, impact, or absence.',
            'Specify a catalog surface when procedure compatibility must be evaluated for a different managed agent surface.',
          ],
        },
      ],
    },
    {
      id: 'knowledge-delta',
      title: 'Review a Knowledge Delta',
      summary: 'Turn task closeout into a small, editable change set instead of storing the conversation.',
      keywords: ['knowledge delta', 'structured closeout', 'review session context', 'candidate review'],
      body: [
        {
          type: 'paragraph',
          text: 'At closeout, keep the required handoff separate from reusable knowledge. The reviewed Knowledge Delta contains at most three proposed changes and shows source evidence, comparison state, confidence, destination, recommendation, and the exact mutation preview.',
        },
        {
          type: 'list',
          items: [
            'Decisions and rationale explain what the task established and why.',
            'Constraints record boundaries the next engineer must preserve.',
            'Verification names the checks that actually ran and their outcome.',
            'Invalidated knowledge identifies what is no longer safe to reuse.',
            'Unresolved risks remain explicit instead of being converted into facts.',
          ],
        },
        {
          type: 'paragraph',
          text: 'Create the candidate review first with `review_session_context`. The required inputs are the task, outcome, a stable project or absolute callerCwd, and at least one evidence pointer when proposing reusable knowledge. Add the five closeout fields when they apply: decisions, constraints, verification performed, knowledge invalidated, and unresolved risks.',
        },
        {
          type: 'code',
          language: 'json',
          code: `{
  "tool": "review_session_context",
  "arguments": {
    "task": "Change checkout retries without breaking order submission",
    "outcome": "Preserved idempotency keys and added bounded retry verification.",
    "project": "commerce",
    "evidence": ["apps/checkout/src/retry.ts", "focused retry tests passed"],
    "decisions": ["Keep the original idempotency key across retries."],
    "constraints": ["Do not retry non-idempotent submissions."],
    "verificationPerformed": ["Focused checkout retry tests passed."],
    "knowledgeInvalidated": ["The old fixed-delay retry note is obsolete."],
    "unresolvedRisks": ["Canary verification remains outstanding."]
  }
}`,
        },
        {
          type: 'paragraph',
          text: 'The tool returns the review ID, revision, and up to three candidates. Use those exact values with `threadnote closeout preview` and `threadnote closeout apply`, or decide the candidate directly with `apply_memory_candidates`.',
        },
        {
          type: 'code',
          language: 'sh',
          code: `threadnote closeout preview --review-id <review-id>
threadnote closeout apply \
  --review-id <review-id> \
  --revision <revision> \
  --candidate-id <candidate-id> \
  --action approve \
  --operation create \
  --approved`,
        },
        {
          type: 'note',
          text: 'Approve, edit, defer, or reject each candidate at the reviewed revision. Applying a candidate changes personal canonical memory; it does not publish it to a team.',
        },
      ],
    },
    {
      id: 'context-git-review',
      title: 'Share through Git review',
      summary: 'Publish one approved decision directly or materialize a provider-neutral proposal for team review.',
      keywords: ['context PR', 'Git proposal', 'share propose', 'share materialize', 'CODEOWNERS'],
      body: [
        {
          type: 'paragraph',
          text: 'The personal-to-team boundary is separate from Knowledge Delta approval. A small team can preview and publish one approved durable memory directly. A team that requires normal branch review can export a content-addressed proposal and materialize it as a local branch and commit.',
        },
        {
          type: 'code',
          language: 'sh',
          code: `threadnote share propose \
  --review-id <review-id> \
  --revision <revision> \
  --candidate-id <candidate-id> \
  --approved \
  --output ./knowledge-delta-proposal.json

threadnote share materialize --proposal ./knowledge-delta-proposal.json
threadnote share materialize --proposal ./knowledge-delta-proposal.json --apply`,
        },
        {
          type: 'paragraph',
          text: 'Preview is read-only. Apply rechecks the configured team, repository identity, exact base commit, proposal hash, and target preconditions before creating the deterministic local branch and commit. It does not switch or dirty the current checkout, run Git hooks, push, or open a provider pull request. Those remain explicit team actions.',
        },
      ],
    },
    {
      id: 'continuous-context-health',
      title: 'Keep context healthy',
      summary: 'Find decay, review repairs, and aggregate local and Git-team health without silent mutation.',
      keywords: ['context health', 'repair', 'supersede', 'retire', 'schedule', 'aggregate'],
      body: [
        {
          type: 'paragraph',
          text: 'Health is a normal part of the lifecycle. Reports distinguish current, changed, missing, unknown, overdue, expired, duplicated, contradictory, drifted, and broken-relation states. Incomplete evidence is unknown, never clean.',
        },
        {
          type: 'code',
          language: 'sh',
          code: `threadnote context health --project commerce
threadnote context health aggregate --project commerce --team platform --json
threadnote context health schedule --project commerce --cadence-minutes 1440 --json`,
        },
        {
          type: 'paragraph',
          text: 'Aggregate reads configured local Git-team snapshots without fetching, syncing, or writing. Schedule renders a provider-neutral, read-only, network-disabled invocation contract; it does not install a scheduler.',
        },
        {
          type: 'code',
          language: 'sh',
          code: `threadnote context repair preview --project commerce --json
threadnote context repair apply \
  --project commerce \
  --proposal-id <proposal-id> \
  --revision <revision> \
  --approved`,
        },
        {
          type: 'warning',
          text: 'Personal lifecycle-safe repairs still require explicit apply. Shared, citation, guidance, ambiguous, and semantic changes remain review-only. Contradictions do not imply which record is stale; a person must bind that direction before supersession can be proposed.',
        },
      ],
    },
    {
      id: 'context-ci',
      title: 'Run Context CI',
      summary: 'Fail a change when reviewed context is affected—or when the evidence needed to decide is unavailable.',
      keywords: ['context CI', 'context check', 'SARIF', 'graph impact', 'capture advisory'],
      body: [
        {
          type: 'paragraph',
          text: 'Context Check is a provider-neutral, read-only gate. It compares the checkout with a Git base and combines direct citation changes, exact-current reverse graph impact, active conflicts, cited-document gaps, and bounded capture advisories.',
        },
        {
          type: 'code',
          language: 'sh',
          code: `threadnote context check --project commerce --base origin/main --format text
threadnote context check --project commerce --base origin/main --format json
threadnote context check --project commerce --base origin/main --format sarif > threadnote-context.sarif`,
        },
        {
          type: 'table',
          headers: ['Exit', 'Meaning'],
          rows: [
            ['0', 'Evidence is complete and no actionable finding exists.'],
            ['1', 'At least one affected citation, graph impact, conflict, document gap, or capture advisory exists.'],
            ['2', 'Invocation is invalid or required Git, graph, citation, or health evidence is unavailable.'],
          ],
        },
        {
          type: 'note',
          text: 'Treat exit 2 as a failed gate, never as clean. Context Check never prepares a graph, writes memory, materializes a proposal, pushes, or contacts a provider. The checked-in GitHub Actions example is one provider adapter; the report contract is not GitHub-specific.',
        },
      ],
    },
    {
      id: 'verified-procedures',
      title: 'Use verified procedures',
      summary:
        'Reuse reviewed workflows only when their exact bytes, dependencies, and agent compatibility are current.',
      keywords: ['verified procedures', 'procedure verify', 'procedure publish', 'rollout', 'compatibility'],
      body: [
        {
          type: 'paragraph',
          text: 'A verified procedure is a reviewed Git-backed workflow, not a transcript or an automatically executed download. Its manifest declares stable identity and version, ownership and review date, dependencies, compatible catalog capabilities and surfaces, task keywords, rollout policy, and the exact artifact and fixtures to verify.',
        },
        {
          type: 'code',
          language: 'sh',
          code: `threadnote procedure verify ./procedure.json
threadnote procedure verify ./procedure.json \
  --apply \
  --artifact ./SKILL.md \
  --fixture smoke=./fixtures/smoke

threadnote procedure status ./procedure.json \
  --artifact ./SKILL.md \
  --receipt ./verification-receipt.json`,
        },
        {
          type: 'paragraph',
          text: 'Verification preview never executes. Apply runs only the manifest’s explicit local commands with the current user’s permissions and emits a receipt only if the manifest, artifact, fixtures, and post-command bytes remain exact. Publication is separately previewed and approved. Context Brief admits only task-relevant, compatible, rollout-eligible procedures with a current exact dependency closure, and never includes executable bodies or commands.',
        },
      ],
    },
    {
      id: 'visible-value',
      title: 'Inspect local value',
      summary: 'Measure reuse and health outcomes with content-free local counts and consent-based export.',
      keywords: ['value report', 'applied feedback', 'second agent reuse', 'local metrics', 'redacted export'],
      body: [
        {
          type: 'paragraph',
          text: 'Feedback closes the loop. Use `useful` when a result looks relevant, `wrong` when it misleads, `pin` or `dismiss` to shape project recall, and `applied` only when the context materially informed a plan or change. The local report separates applied reuse from superficial relevance.',
        },
        {
          type: 'code',
          language: 'sh',
          code: `threadnote recall-feedback <threadnote-uri> \
  --query '<original query>' \
  --action applied \
  --project commerce

threadnote value report --project commerce --period 14
threadnote value report export --project commerce --period 14`,
        },
        {
          type: 'paragraph',
          text: 'The report covers activation, time to first evidence, second-surface reuse, Knowledge Delta outcomes, feedback, and health resolution. It stores bounded counts and query fingerprints—not query text, memory bodies, source code, paths, repository names, or stable user IDs. Export is a redacted preview by default and writes a private bundle only with explicit apply.',
        },
      ],
    },
  ],
};
