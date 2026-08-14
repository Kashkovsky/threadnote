import {Icon} from '../components/Icons';
import {SiteShell} from '../components/SiteShell';
import {docsArticleHref, setDocumentMeta, siteHref} from '../lib/site';

const SHOW_GRAPHIFY_COMPARISON = import.meta.env.VITE_SHOW_GRAPHIFY_COMPARISON === 'true';

const comparisonRows = [
  {
    topic: 'Primary job',
    threadnote: 'Persistent engineering context: durable memory plus current-source code intelligence',
    graphify: 'Generate, analyze, and explore a knowledge graph over a mixed project corpus',
  },
  {
    topic: 'Runtime & setup',
    threadnote: 'One standalone JavaScript runtime with CLI, MCP, parsers, SQLite, and local AI included; no Python',
    graphify: 'Python 3.10+ package; MCP, Office, video, and several parsers or exporters use optional extras',
  },
  {
    topic: 'Source languages',
    threadnote:
      'Compiler-backed TypeScript/JavaScript plus bundled, verified structural AST packs for Java/Kotlin/Scala, Swift/Objective-C, Python/Go/Rust/C/C++/C#, Ruby/PHP, Bash/PowerShell/HCL, Dart/Elixir/Julia/Lua/Solidity/Zig, Verilog/SystemVerilog, and Vue/Svelte component markup; Fortran, Apex, and Razor use bounded deterministic text structure',
    graphify:
      'Not TypeScript-only: v0.9.29 and v0.9.31 declare Java, Kotlin, Swift, and many more; the project lists 36 tree-sitter grammars',
  },
  {
    topic: 'Documents & media',
    threadnote:
      'Extracts Markdown and text, PDF text and links, OpenXML/OpenDocument/EPUB text, notebooks, diagrams, and schema formats locally; image, audio, and video assets are searchable by filename and deterministic metadata, not OCR or transcription',
    graphify:
      'Has implemented passes for docs, PDFs, images, Office files, and media; semantic inputs require an assistant or configured model',
  },
  {
    topic: 'Large repositories',
    threadnote:
      'Pages graph and vector generations through SQLite with no eligible-repository admission cap; per-artifact corpus safety budgets keep oversized files as searchable metadata-only nodes instead of rejecting the repository',
    graphify:
      'The default graph.json is hydrated into NetworkX and has a configurable 512 MiB load guard; larger limits increase in-memory work',
  },
  {
    topic: 'Git & worktrees',
    threadnote:
      'Aliases graph-equivalent commits, builds compatible clean deltas, and isolates staged, unstaged, deleted, renamed, and untracked overlays',
    graphify:
      'Uses content-hash caching, update/watch workflows, and a post-commit hook; docs and images may need a manual update',
  },
  {
    topic: 'Search & evidence',
    threadnote:
      'Exact and lexical retrieval plus local vector seeds; scoped query, stable-ID node/neighbor round-trips, shortest path, explain, and Git-diff impact preserve five authority tiers and return current-snapshot evidence',
    graphify:
      'Term/trigram retrieval and traversal with query, path, explain, neighbors, communities, and PR impact; no vector store by design',
  },
  {
    topic: 'Graph analysis',
    threadnote:
      'Deterministic components, stable community drill-down, structural n-ary groups, hubs and god nodes, surprising links, confidence audits, suggested questions, and explicit partial-coverage warnings; rationale comments become first-class graph nodes',
    graphify:
      'Provides Leiden communities, god nodes, surprising links, rationale nodes, confidence analysis, hyperedges, and generated reports',
  },
  {
    topic: 'Reports & exports',
    threadnote:
      'Writes deterministic Markdown architecture reports and streams JSON, GraphML, HTML, or SVG from a pinned SQLite snapshot',
    graphify:
      'Exports interactive HTML, JSON, SVG, GraphML, Obsidian, wiki and call-flow artifacts, Cypher, Neo4j, and FalkorDB targets',
  },
  {
    topic: 'Beyond the graph',
    threadnote: 'Memory lifecycle, local AI, team sharing, Manager, Obsidian, seeding, and handoffs',
    graphify: 'Graph artifacts, audits, visualization, corpus ingestion, and an optional MCP server',
  },
  {
    topic: 'Best fit',
    threadnote:
      'Large, active repositories where current-source analysis and team memory must stay correct across agents, sessions, and worktrees',
    graphify:
      'Optional model-backed media semantics, Leiden clustering, SCIP input, PR triage, and a larger family of downstream graph targets',
  },
];

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
    question: 'Can agents query a graph while it is still indexing?',
    answer:
      'Agents never query partial rows from an unpromoted snapshot. A cold repository reports indexing and a retry delay until one consistent lexical snapshot is ready. After promotion, exact and lexical queries can use that snapshot while optional vectors and whole-graph summaries finish in the background; during later refreshes, bounded lookups may explicitly use the previous ready snapshot as stale.',
  },
  {
    question: 'Can I use Obsidian without giving it the whole memory store?',
    answer:
      'Yes. Vault notes enter recall only through allowlisted sources, and memories leave Threadnote only through an explicitly configured projection with selected URIs. Generated files are one-way, scrubbed, and drift-protected.',
  },
  {
    question: 'Can Threadnote and Graphify be installed together?',
    answer:
      'Yes. Threadnote 4 does not depend on Graphify and does not read or overwrite graphify-out. Threadnote now covers broad polyglot structural extraction, deterministic corpus ingestion, community and n-ary group analysis, confidence audits, reports, and portable exports while retaining worktree-correct SQLite paging, local vectors, and persistent team memory. Graphify still offers optional model-backed media semantics, Leiden clustering, SCIP and remote PR workflows, and more specialized downstream graph targets. Use the strengths you need, or both.',
    comparisonOnly: true,
  },
];

export default function FaqPage() {
  setDocumentMeta('FAQ', 'Threadnote 4 frequently asked questions about local data, AI, sharing, and large monorepos.');

  const visibleQuestions = questions.filter(item => !item.comparisonOnly || SHOW_GRAPHIFY_COMPARISON);

  return (
    <SiteShell page="faq" fullBleed>
      <section className="subpage-hero subpage-hero--faq">
        <div>
          <span className="eyebrow">Frequently asked questions</span>
          <h1>Understand the boundary before you trust the context.</h1>
          <p>Straight answers about local data, AI models, agent integration, sharing, and large monorepos.</p>
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
          {visibleQuestions.map((item, index) => (
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

      {SHOW_GRAPHIFY_COMPARISON ? (
        <section className="comparison-section" id="graphify">
          <header className="section-heading section-heading--split">
            <div>
              <span className="eyebrow">Threadnote vs Graphify</span>
              <h2>Threadnote keeps active monorepos correct. Graphify maximizes optional integrations.</h2>
            </div>
            <p>
              Threadnote’s first native graph was informed by experience using Graphify, but 4.0 is an independent
              implementation. It now combines polyglot AST packs, deterministic corpus and topology analysis, portable
              exports, paged storage, explicit Git and worktree state, local semantic retrieval, and durable memory in
              one self-contained runtime.
            </p>
          </header>
          <div className="comparison-intro">
            <article className="comparison-product comparison-product--threadnote">
              <span>Threadnote 4</span>
              <h3>The worktree-aware engineering context layer</h3>
              <p>
                Choose it when a large repository keeps changing and current-source evidence, architecture signals,
                decisions, handoffs, and team knowledge must remain available across sessions and agents.
              </p>
            </article>
            <div className="comparison-plus" aria-hidden="true">
              <span>or</span>
              <small>often, both</small>
            </div>
            <article className="comparison-product comparison-product--graphify">
              <span>Graphify</span>
              <h3>The broad corpus graph suite</h3>
              <p>
                Choose it for optional model-backed document and media semantics, Leiden clustering, SCIP and remote PR
                workflows, and its larger family of specialized generated graph targets.
              </p>
            </article>
          </div>
          <div className="comparison-table-wrap">
            <table className="comparison-table">
              <thead>
                <tr>
                  <th>Dimension</th>
                  <th>Threadnote 4</th>
                  <th>Graphify</th>
                </tr>
              </thead>
              <tbody>
                {comparisonRows.map(row => (
                  <tr key={row.topic}>
                    <th>{row.topic}</th>
                    <td>{row.threadnote}</td>
                    <td>{row.graphify}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="comparison-note">
            Graphify details were checked against its public v0.9.29 and v0.9.31 package source on 31 July 2026, not
            inferred from the product copy alone. Capabilities can evolve independently.{' '}
            <a
              href="https://github.com/Graphify-Labs/graphify/tree/4fe11092ccbe9f543608f140c790f68d5d83cae4"
              target="_blank"
              rel="noreferrer"
            >
              Inspect the reviewed Graphify source <span aria-hidden="true">↗</span>
            </a>{' '}
            or{' '}
            <a
              href="https://graphify.net/knowledge-graph-for-ai-coding-assistants.html"
              target="_blank"
              rel="noreferrer"
            >
              read its own overview <span aria-hidden="true">↗</span>
            </a>
            .
          </p>
        </section>
      ) : null}

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
