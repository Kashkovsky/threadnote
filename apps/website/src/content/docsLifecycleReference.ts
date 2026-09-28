import type {CliCommandReference, McpToolReference} from './docsTypes.js';

export const activationCliCommands: CliCommandReference[] = [
  {
    command: 'setup / agents',
    summary: 'Discover catalog support and preview, apply, inspect, repair, or undo one local agent-surface setup.',
    examples: [
      'threadnote agents list',
      'threadnote agents status',
      'threadnote setup <surface>',
      'threadnote setup <surface> --apply',
    ],
  },
  {
    command: 'activate',
    summary: 'Run the resumable two-surface journey through reviewed import, cited context, sharing, and reuse proof.',
    examples: [
      'threadnote activate start --request ./activation.json',
      'threadnote activate continue --activation-id <id> --request ./activation.json --apply',
      'threadnote activate status --activation-id <id>',
    ],
  },
];

export const lifecycleCliCommands: CliCommandReference[] = [
  {
    command: 'context brief',
    summary:
      'Compile task-relevant graph evidence, durable decisions, active handoffs, freshness, and gaps into one bounded agent brief.',
    examples: [
      'threadnote context brief --task "Trace checkout retries" --budget-tokens 1250',
      'threadnote context brief --task "Trace checkout retries" --workset commerce --mode trace --json',
    ],
  },
  {
    command: 'closeout',
    summary: 'Preview and explicitly decide each bounded Knowledge Delta candidate at an exact review revision.',
    examples: [
      'threadnote closeout preview --review-id <review-id>',
      'threadnote closeout apply --review-id <review-id> --revision <revision> --candidate-id <id> --action approve --operation create --approved',
    ],
  },
  {
    command: 'share propose / materialize',
    summary: 'Export an approved Knowledge Delta and preview or create its deterministic local Git branch and commit.',
    examples: [
      'threadnote share propose --review-id <review-id> --revision <revision> --candidate-id <id> --approved',
      'threadnote share materialize --proposal ./knowledge-delta-proposal.json --apply',
    ],
  },
  {
    command: 'context metadata / health / repair / check',
    summary: 'Author maintenance metadata, inspect decay, review repairs, aggregate health, and run Context CI.',
    examples: [
      'threadnote context metadata preview --uri <threadnote-uri> --owner platform-team',
      'threadnote context health --project commerce',
      'threadnote context repair preview --project commerce --json',
      'threadnote context check --project commerce --base origin/main --format sarif',
    ],
  },
  {
    command: 'procedure verify / status / publish',
    summary: 'Verify exact local procedure bytes, inspect compatibility, and explicitly publish reviewed artifacts.',
    examples: [
      'threadnote procedure verify ./procedure.json --apply --artifact ./SKILL.md',
      'threadnote procedure status ./procedure.json --artifact ./SKILL.md --receipt ./receipt.json',
      'threadnote procedure publish ./procedure.json --artifact ./SKILL.md --receipt ./receipt.json',
    ],
  },
  {
    command: 'recall-feedback / value report',
    summary:
      'Record content-free usefulness or applied reuse and inspect, retain, delete, or export local value counts.',
    examples: [
      'threadnote recall-feedback <threadnote-uri> --query "checkout contract" --action applied --project commerce',
      'threadnote value report --project commerce --period 14',
      'threadnote value report export --project commerce --period 14',
    ],
  },
];

export const activationMcpTools: McpToolReference[] = [
  {
    name: 'share_propose',
    toolset: 'core',
    summary: 'Export explicitly approved Knowledge Delta candidates as a provider-neutral, read-only Git proposal.',
    keyInputs: ['reviewId', 'revision', 'candidateIds', 'approved', 'team'],
  },
  {
    name: 'complete_activation_retrieval_proof',
    toolset: 'core',
    summary: 'Complete the guided-activation reuse challenge from the exact named secondary agent surface.',
    keyInputs: ['challengeId', 'callerCwd', 'project', 'query', 'topic'],
  },
];

export const lifecycleMcpTools: McpToolReference[] = [
  {
    name: 'context_metadata_preview / context_metadata_apply',
    toolset: 'full',
    summary: 'Preview and explicitly apply maintenance-only owner, review, or validity metadata changes.',
    keyInputs: [
      'uri or memoryId',
      'owner',
      'reviewAfter',
      'validTo',
      'expectedContentHash (apply)',
      'proposalId',
      'revision',
      'approved',
    ],
  },
  {
    name: 'context_health / context_health_aggregate / context_health_schedule',
    toolset: 'full',
    summary: 'Inspect local or Git-team health and render a read-only, network-disabled schedule contract.',
    keyInputs: ['project', 'callerCwd', 'team or teams', 'cadenceMinutes'],
  },
  {
    name: 'context_health_repair_preview / context_health_repair_apply',
    toolset: 'full',
    summary: 'Preview bounded repairs and apply one explicitly approved personal-memory lifecycle change.',
    keyInputs: ['project', 'callerCwd', 'proposalId', 'revision', 'approved'],
  },
  {
    name: 'procedure_publish_preview / procedure_publish_apply',
    toolset: 'full',
    summary: 'Preview or explicitly publish an exact verified procedure to a configured Git team share.',
    keyInputs: ['manifest', 'artifact', 'receipt', 'team', 'proposalId', 'approved', 'push'],
  },
];
