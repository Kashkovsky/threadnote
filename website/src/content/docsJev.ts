import type {DocsBlock} from './docsTypes.js';

export const jevConfigurationRows: string[][] = [
  ['THREADNOTE_DECISION_PROVIDER=jev', 'Explicitly enable the optional TypeSafe Jev recall decision provider', 'unset'],
  ['TYPESAFE_API_KEY', 'BYOK credential for Jev; read only from the process environment and never persisted', 'unset'],
  [
    'THREADNOTE_JEV_MODEL',
    'Concrete pinned Jev model version (for example, jev-1.13.0); aliases are rejected',
    'unset',
  ],
  [
    'THREADNOTE_JEV_MODE',
    'Jev evaluation mode: shadow records an advisory result, enforced may select from offered weak-recall candidates',
    'shadow',
  ],
  ['THREADNOTE_JEV_NOUL_THRESHOLD', 'Minimum 0–1 Jev relevance probability for enforced candidate selection', '0.5'],
];

export const jevConfigurationBlocks: DocsBlock[] = [
  {
    type: 'warning',
    text: 'Jev is off unless THREADNOTE_DECISION_PROVIDER=jev, TYPESAFE_API_KEY, and a pinned THREADNOTE_JEV_MODEL are all present. When enabled, Threadnote sends only the weak-recall query and up to 24 opaque candidate IDs with bounded summaries to TypeSafe for a typed relevance decision. It never sends credentials, raw provider responses, or full memory bodies to telemetry or receipts. TypeSafe zero-data retention is an enterprise-only offering; do not assume it for standard accounts.',
  },
  {
    type: 'paragraph',
    text: 'Run `threadnote jev status` (or `threadnote jev status --json`) for a local-only diagnostic. It reports only whether Jev is disabled, misconfigured, or configured, plus provider, model, mode, threshold, and whether a key is present; it never contacts TypeSafe or displays the key. During an enabled weak-recall decision, Threadnote emits a bounded receipt with mode, model, candidate count, selected count, outcome, and fallback kind. Shadow receipts are observable for evaluation but never change recall results.',
  },
];
