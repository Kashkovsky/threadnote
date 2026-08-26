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
