import type {DocsArticle, McpToolReference} from './docsTypes.js';

export const typedMemoryRelationsDocsArticle: DocsArticle = {
  id: 'typed-memory-relations',
  title: 'Typed memory relations',
  summary:
    'Record a small explicit connection to another active memory without turning Threadnote into a general graph editor.',
  body: [
    {
      type: 'paragraph',
      text: 'In local and Cursor Cloud Git profiles, remember_context accepts relations as up to 16 {type, uri} objects. The CLI uses a repeatable --relation type=uri flag. Types are depends_on, evidence_for, references, related_to, and supersedes. Targets must resolve inside the authorized active memory scope; Threadnote rejects missing, inactive, conflicted, duplicate, cross-scope, and self targets, then stores the target’s stable threadnote://memory/tn_… identity.',
    },
    {
      type: 'code',
      language: 'json',
      code: `{
  "kind": "durable",
  "project": "mobile",
  "topic": "auth-rollout",
  "relations": [
    {
      "type": "depends_on",
      "uri": "threadnote://user/me/memories/durable/projects/mobile/auth-contract.md"
    }
  ],
  "text": "Roll out only after the authentication contract is deployed."
}`,
    },
    {
      type: 'paragraph',
      text: 'Relations are canonical metadata and a rebuildable local projection; they do not make ordinary recall recursive or expand Context Brief yet. Shared writes restrict targets to the same share. On replacement, the supplied relation list is the revised set and omission clears prior explicit relations. Manager raw saves preserve existing relation headers but cannot change them until its structured relation editor ships.',
    },
  ],
};

export const rememberMemoryCitationCliExamples = [
  'threadnote remember --kind durable --project mobile --topic auth-contract --text "..."',
  'threadnote remember --kind durable --project mobile --topic auth-contract --code-ref src/auth/session.ts --code-ref cgs_… --text "..."',
  'threadnote remember --kind durable --project mobile --topic auth-contract --relation depends_on=<threadnote-memory-uri> --text "..."',
  'threadnote remember --kind durable --project mobile --topic auth-contract --replace <threadnote-uri> --text "..."',
];

export const handoffMemoryCitationCliExamples = [
  'threadnote handoff --project mobile --topic auth-rollout --task "Ship refresh tokens" --tests "bun test" --next-step "Open PR"',
  'threadnote handoff --project mobile --topic auth-rollout --code-ref cgs_… --task "Ship refresh tokens"',
];

export const rememberContextMemoryCitationInputs = [
  'text',
  'kind',
  'project',
  'topic',
  'callerCwd',
  'codeRefs',
  'citationPolicy',
  'replaceUri',
  'references',
  'relations (local/Git-share; max 16 typed memory targets)',
  'sourceAgentClient',
];

export const reviewSessionMemoryCitationInputs = [
  'task',
  'outcome',
  'project or callerCwd',
  'decisions',
  'invariants',
  'preferences',
  'handoff',
  'evidence',
  'codeRefs',
];

export const rememberContextMcpTool = {
  name: 'remember_context',
  toolset: 'core',
  summary: 'Store or replace normal durable knowledge, handoffs, incidents, or preferences.',
  keyInputs: rememberContextMemoryCitationInputs,
} satisfies McpToolReference;

export const contextBriefMcpTool = {
  name: 'context_brief',
  toolset: 'core',
  summary:
    'Compile a token-bounded task brief from current graph evidence, durable decisions, active handoffs, freshness signals, and optional explicit code-citation backlinks.',
  keyInputs: [
    'task',
    'callerCwd',
    'codeRefs (max 8 canonical repository-relative path or exact cgs_<32 hex>; no cgr_)',
    'workset',
    'project',
    'mode',
    'budgetTokens (800-1500)',
  ],
} satisfies McpToolReference;

export const reviewSessionContextMcpTool = {
  name: 'review_session_context',
  toolset: 'core',
  summary: 'Create up to three additional review candidates; this never silently creates active memory.',
  keyInputs: reviewSessionMemoryCitationInputs,
} satisfies McpToolReference;

export const finalizeCodeRefsMcpTool = {
  name: 'finalize_code_refs',
  toolset: 'core',
  summary:
    'Finalize deferred private memory citations from already-ready exact-current graphs. uri is optional; omit it to finalize up to 25 pending personal memories.',
  keyInputs: ['uri'],
} satisfies McpToolReference;
