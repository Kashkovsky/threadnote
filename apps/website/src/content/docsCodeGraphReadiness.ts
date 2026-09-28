import type {DocsArticle} from './docsTypes.js';

export const codeGraphReadinessDocsArticle: DocsArticle = {
  id: 'graph-readiness',
  title: 'Code graph readiness and refresh continuity',
  summary: 'Use stale graph cards for bounded discovery while preserving strict current-source claims.',
  keywords: ['stale graph', 'refresh continuity', 'code graph readiness', 'bounded retry', 'cgdq'],
  body: [
    {
      type: 'paragraph',
      text: 'Query, node, neighbors, and explain may use an immutable compatible ready snapshot while a durable refresh is active, queued, or deferred. Verify exact literals in source before relying on details. Path, impact, analyze_code_graph, and exact-current citations remain strict; cold reads or reads without usable cards follow the bounded current-refresh path.',
    },
    {
      type: 'table',
      headers: ['Continuity state', 'What to do'],
      rows: [
        ['active', 'Continue bounded discovery; do not poll repeatedly.'],
        ['queued', 'Use surviving stale cards and verify exact source literals.'],
        ['deferred', 'Retry before a strict current or relationship claim, or when no usable cards survive.'],
        ['idle', 'No refresh is currently demanded.'],
      ],
    },
    {
      type: 'paragraph',
      text: 'Continuity metadata is additive and privacy-safe. Opaque cgdq_… queue, current, and latest-demand tokens are correlation values only, never paths or capabilities. The durable reducer is latest-wins before publication; published snapshots are irrevocable, and crash recovery reconciles persisted demand until the system converges.',
    },
    {
      type: 'note',
      text: 'An active private cited memory may store now, anchor privately, and finalize after a current graph is ready. Shared and inactive writes remain strict. See the canonical [agent catalog](/agents/) for supported integrations.',
    },
  ],
};
