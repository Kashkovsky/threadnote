import type {McpToolReference} from './docsTypes.js';

export const rememberMemoryCitationCliExamples = [
  'threadnote remember --kind durable --project mobile --topic auth-contract --text "..."',
  'threadnote remember --kind durable --project mobile --topic auth-contract --code-ref src/auth/session.ts --code-ref cgs_… --text "..."',
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
  keyInputs: ['task', 'callerCwd', 'codeRefs (max 8 file/cgs_)', 'workset', 'project', 'mode', 'budgetTokens'],
} satisfies McpToolReference;

export const reviewSessionContextMcpTool = {
  name: 'review_session_context',
  toolset: 'core',
  summary: 'Create up to three additional review candidates; this never silently creates active memory.',
  keyInputs: reviewSessionMemoryCitationInputs,
} satisfies McpToolReference;

export const finalizeCodeRefsMcpTool = {
  name: 'finalize_code_refs',
  toolset: 'full',
  summary: 'Finalize explicitly deferred private memory citations from already-ready exact-current graphs.',
  keyInputs: ['uri', 'limit'],
} satisfies McpToolReference;
