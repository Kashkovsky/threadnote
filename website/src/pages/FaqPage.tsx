import {Icon} from '../components/Icons';
import {SiteShell} from '../components/SiteShell';
import {docsArticleHref, setDocumentMeta, siteHref} from '../lib/site';

const questions = [
  {
    question: 'Is Threadnote a hosted memory service?',
    answer:
      'No. Threadnote 4 is a standalone local runtime. Canonical Markdown, models, SQLite indexes, graph snapshots, and share metadata live under ~/.threadnote. A network boundary is crossed only for explicit operations such as downloading a verified release or model, syncing a configured team share, submitting an approved issue, or after explicitly enabling anonymous operational telemetry.',
  },
  {
    question: 'Does Threadnote send prompts or memory to an AI provider?',
    answer:
      'No provider is required for core functionality. The default embedding model runs locally through node-llama-cpp. Threadnote supplies context to the coding agent you connected, so that agent’s own provider and privacy policy still apply.',
  },
  {
    question: 'Does it replace AGENTS.md, repository docs, or source code?',
    answer:
      'No. Repository files remain authoritative. Threadnote makes scoped operational knowledge recallable and gives agents a current structural view of source. Stable project rules and reviewed design documents still belong in the repository.',
  },
  {
    question: 'Why are memory recall and code graph search separate tools?',
    answer:
      'They answer different questions. Recall finds what was learned, decided, or handed off and returns pointers to canonical records. inspect_code_graph answers scoped current-source questions; analyze_code_graph summarizes whole-repository topology. Keeping those surfaces separate stops historical paths from masquerading as current source evidence and avoids mixing a focused query with an architecture-wide analysis.',
  },
  {
    question: 'What do memory-to-code citations and stale-link warnings mean?',
    answer:
      'Code citations are optional capture-time evidence for exact files or symbols. Context Brief checks selected citations against an already-ready current graph: exact or uniquely relocated evidence keeps the memory fresh, while relocation adds a stale-link warning so you can recapture the new locator. That warning is about the link, not the memory. Changed or deleted evidence makes the memory stale, and unavailable or ambiguous evidence stays unknown. Even an exact citation proves that the cited bytes survived—not that the memory prose is automatically correct.',
  },
  {
    question: 'Will my existing memories disappear after upgrading to 4.4?',
    answer:
      'No. v1 and other uncited memories stay recallable and can appear in Context Brief. They keep conservative commit-level freshness when Threadnote can resolve it and otherwise show unknown; Threadnote does not invent precise citations or require a migration just to keep recall working. Portable checkpoint operations touch only disposable graph storage, so they do not migrate or filter existing memory either.',
  },
  {
    question: 'Do I need a Workset to use code citations or Context Brief?',
    answer:
      'No. For an ordinary one-repository task, pass the absolute callerCwd—or run the CLI from that checkout—and use its ready current graph. A named, explicitly prepared Workset is only for bounded multi-repository evidence. Citation writes never start indexing implicitly: unavailable evidence returns a recovery receipt. Queries against a prepared Workset use only its published ready generation and never fan out cold graph builds.',
  },
  {
    question: 'Which agents can use it?',
    answer:
      'Any agent that can connect a local stdio MCP server or invoke the CLI can use Threadnote. The installer includes guided MCP setup for Codex, Claude, Cursor, and Copilot, and the underlying contract is tool-neutral.',
  },
  {
    question: 'Does every memory get shared with my team?',
    answer:
      'No. Memory is private by default. Publishing is a separate previewed and scanned action for selected durable memories or reusable artifacts; soft-leak redaction is explicit. Handoffs, preferences, secrets, customer data, and raw logs should not be published.',
  },
  {
    question: 'What happens when local AI is unavailable?',
    answer:
      'Recall fails open to deterministic lexical, field, scope, lifecycle, authority, and other non-model signals. Derived vector indexes are disposable and can be rebuilt; canonical Markdown remains intact.',
  },
  {
    question: 'Do large monorepos have a hard graph-size cap?',
    answer:
      'There is no repository-size admission cap. Threadnote 4 stores graph generations in SQLite instead of one monolithic JSON document; a bounded parser pool, one backpressured writer, generated-root pruning, and metadata-only snapshot data bound transient work. Individual query responses still honor explicit node, edge, and result limits so an agent receives a useful evidence set rather than an unbounded dump.',
  },
  {
    question: 'Will every new worktree rebuild its graph from scratch?',
    answer:
      'No. Linked worktrees share one checkout graph store. Threadnote 4.1 can immediately alias a graph-equivalent commit, build a compatible clean commit as a bounded delta from a ready full anchor, or construct an already-dirty worktree directly from that anchor. Extractor, workspace, manifest, or unbounded resolution changes still fall back to a full build for correctness.',
  },
  {
    question: 'How does Manager keep long graph work responsive?',
    answer:
      'In Threadnote 4.4, Manager launches graph indexing and Workset preparation in isolated processes instead of running those builds inside the UI service. Workset repositories prepare with bounded concurrency and report progress independently. Queries still read only a ready, atomically published generation rather than partial build state.',
  },
  {
    question: 'Can I move a graph to another machine without a Workset or cloud?',
    answer:
      'Yes. Portable graph checkpoints are free, manual, offline files. Export the exact ready, clean graph for the current commit, transfer the artifact plus an independently obtained expected SHA-256 digest, run inspect and then the full verify with that digest, and import from a local checkout of the same repository where the source commit already exists. No account, hosted service, or Workset is required, and schema-v1 or uncited legacy memories are unaffected.',
  },
  {
    question: 'Can agents query a graph while it is still indexing?',
    answer:
      'Agents never query partial rows from an unpromoted snapshot. A cold repository reports indexing and a retry delay until one consistent lexical snapshot is ready. After promotion, exact and lexical queries can use that snapshot while optional vectors and whole-graph summaries finish in the background; during later refreshes, bounded lookups may explicitly use the previous ready snapshot as stale.',
  },
  {
    question: 'Can I use Obsidian without giving it the whole memory store?',
    answer:
      'Yes. Vault notes enter recall only through allowlisted sources, and memories leave Threadnote only through an explicitly configured projection with selected URIs. Generated files are one-way, scrubbed, and drift-protected.',
  },
];

export default function FaqPage() {
  setDocumentMeta(
    'FAQ',
    'Threadnote 4 frequently asked questions about local data, code citations, memory compatibility, scope, and sharing.',
  );

  return (
    <SiteShell page="faq" fullBleed>
      <section className="subpage-hero subpage-hero--faq">
        <div>
          <span className="eyebrow">Frequently asked questions</span>
          <h1>Understand the boundary before you trust the context.</h1>
          <p>Straight answers about local data, source freshness, existing memory, agent integration, and scope.</p>
        </div>
        <a className="button button--ghost" href={siteHref('docs/')}>
          Read the full docs
          <Icon name="arrow" aria-hidden="true" />
        </a>
      </section>

      <section className="faq-section content-section">
        <header className="section-heading">
          <span className="eyebrow">The practical questions</span>
          <h2>What teams ask before installing.</h2>
        </header>
        <div className="faq-list">
          {questions.map((item, index) => (
            <details key={item.question} open={index === 0}>
              <summary>
                <span>{String(index + 1).padStart(2, '0')}</span>
                <strong>{item.question}</strong>
                <i aria-hidden="true" />
              </summary>
              <p>{item.answer}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="content-section content-section--cta">
        <div className="cta-panel cta-panel--compact">
          <span className="eyebrow">Still deciding?</span>
          <h2>Try the workflow, inspect the storage, keep the source.</h2>
          <p>
            Threadnote is open source. Start with the walkthrough, explore the mocked Manager, or inspect the
            architecture before connecting an agent.
          </p>
          <div className="cta-panel__actions">
            <a className="button" href={docsArticleHref('installation')}>
              Install guide
            </a>
            <a className="button button--ghost" href={siteHref('manager-demo/')}>
              Manager demo
            </a>
          </div>
        </div>
      </section>
    </SiteShell>
  );
}
