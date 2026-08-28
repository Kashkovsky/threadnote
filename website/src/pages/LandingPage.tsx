import {lazy, Suspense, useState} from 'react';
import {AgentTrace} from '../components/AgentTrace';
import {CodeBlock} from '../components/CodeBlock';
import {Icon, type IconName} from '../components/Icons';
import {SiteShell} from '../components/SiteShell';
import {graphAnalyzeScenario, graphInspectScenario, heroScenario} from '../content/landing';
import {performanceEvidence} from '../content/performanceEvidence';
import {docsArticleHref, githubUrl, setDocumentMeta, siteHref} from '../lib/site';

const ThreadScene = lazy(() => import('../visuals/ThreadScene'));

function formatMeasuredDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds.toFixed(1)} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(3)} s`;
  const minutes = Math.floor(milliseconds / 60_000);
  return `${minutes}m ${((milliseconds % 60_000) / 1_000).toFixed(3)}s`;
}

const features: Array<{
  icon: IconName;
  accent: string;
  label: string;
  title: string;
  body: string;
  detail: string;
}> = [
  {
    icon: 'memory',
    accent: 'teal',
    label: 'Durable memory',
    title: 'The useful part survives—and can check its sources.',
    body: 'Decisions, handoffs, workflows, and lessons become scoped Markdown with stable URIs. Important claims can cite exact files or symbols, while older uncited memories stay recallable.',
    detail: 'Optional citations · stale-link warnings · legacy recall',
  },
  {
    icon: 'local',
    accent: 'teal',
    label: 'Local AI',
    title: 'Core recall works out of the box.',
    body: 'A verified embedding model installs by default. A supervised local worker adds semantic recall while lexical search stays ready to fail open.',
    detail: 'No Python · no daemon · no OpenViking',
  },
  {
    icon: 'team',
    accent: 'blue',
    label: 'Cross-team sharing',
    title: 'Share the conclusion, not the private session.',
    body: 'Preview, scan, and publish selected durable memory through a Git-backed team store. Teammates sync it into local Threadnote, then recall it from any compatible agent.',
    detail: 'Explicit boundary · conflict-safe · auditable',
  },
  {
    icon: 'graph',
    accent: 'violet',
    label: 'Polyglot code graph',
    title: 'Ask about the code as it exists now.',
    body: 'Inspect paths and impact, then drill into communities, structural groups, hubs, confidence, and surprising links across broad bundled language packs, schemas, and project documents—even in large nested monorepos.',
    detail: 'Inspect · analyze · drill down · report · export',
  },
  {
    icon: 'manager',
    accent: 'magenta',
    label: 'Manager',
    title: 'See the system, not just its output.',
    body: 'Explore graph topology, memory health, shares, models, tools, and diagnostics in a focused local control plane.',
    detail: 'Three.js graph · inspectable evidence',
  },
  {
    icon: 'obsidian',
    accent: 'amber',
    label: 'Obsidian bridge',
    title: 'Human notes and agent memory can meet safely.',
    body: 'Allowlist vault notes for recall or publish selected memories into a drift-protected generated view. No plugin required.',
    detail: 'Explicit imports · one-way projections',
  },
];

const workflow = [
  {
    number: '01',
    title: 'Recall what was learned',
    body: 'Threadnote ranks scoped memories—including older uncited records—and returns small, explainable pointers.',
  },
  {
    number: '02',
    title: 'Check the current evidence',
    body: 'Context Brief validates optional citations while the graph answers current-source questions; neither rewrites the memory.',
  },
  {
    number: '03',
    title: 'Do the work',
    body: 'The agent starts with the decisions, files, tests, blockers, and next step already in view.',
  },
  {
    number: '04',
    title: 'Preserve the outcome',
    body: 'Update stable memory, cite consequential source claims when useful, leave a concise handoff, and optionally publish the reusable part.',
  },
];

const graphCapabilities = [
  {
    number: '01',
    label: 'Current-worktree truth',
    title: 'Reuse graph work without pinning the control plane.',
    body: 'Graph-equivalent commits reuse ready content, while compatible clean commits build bounded deltas. Manager-launched indexing and Workset preparation run in isolated processes, with bounded member concurrency; dirty overlays remain scoped to their own linked worktree.',
  },
  {
    number: '02',
    label: 'Polyglot by architecture',
    title: 'One query can cross language and project boundaries.',
    body: 'Compiler-backed TypeScript/JavaScript, bundled structural AST packs, Bazel/Starlark metadata, and deterministic schema, configuration, documentation, and corpus packs share one provenance-aware graph contract.',
  },
  {
    number: '03',
    label: 'Large monorepos',
    title: 'Repository size is not an admission test.',
    body: 'A bounded parser pool feeds one backpressured SQLite writer. Generated roots are pruned before reads, while oversized and low-signal snapshot data becomes lightweight metadata instead of parser work.',
  },
  {
    number: '04',
    label: 'Architecture signals',
    title: 'Deterministic topology, with honest coverage.',
    body: 'Weak components, stable community drill-down, structural n-ary groups, hubs and god nodes, confidence audits, and surprising links identify boundaries and blast radius. Budgets report partial coverage explicitly and the result suggests useful next questions.',
  },
  {
    number: '05',
    label: 'Rationale and outputs',
    title: 'Carry the evidence into the next conversation.',
    body: 'Rationale comments and ADR/RFC references become evidence nodes. Generate a deterministic Markdown report or export a pinned snapshot as JSON, GraphML, HTML, or SVG.',
  },
  {
    number: '06',
    label: 'Manager visualization',
    title: 'Explore the graph without reading raw rows.',
    body: 'The local Manager lets you search and walk current symbols, inspect relationship provenance, and request architecture signals on demand with mocked-data demos available publicly.',
  },
];

function GraphSearchShowcase() {
  const [mode, setMode] = useState<'analyze' | 'inspect'>('inspect');
  const scenario = mode === 'inspect' ? graphInspectScenario : graphAnalyzeScenario;
  const performanceArtifact = performanceEvidence.state === 'verified' ? performanceEvidence.artifact : undefined;

  return (
    <section className="graph-showcase" id="graph-search">
      <header className="section-heading section-heading--split graph-showcase__heading">
        <div>
          <span className="eyebrow">Native graph search</span>
          <h2>Search a symbol. Read the architecture. Trust the same current snapshot.</h2>
        </div>
        <p>
          Threadnote gives agents two deliberate graph surfaces. One answers a scoped source question. The other
          summarizes whole-repository topology. Neither is mixed into historical memory recall.
        </p>
      </header>

      <div className="graph-showcase__tool-switcher" role="tablist" aria-label="Graph MCP workflow">
        <button
          id="graph-inspect-tab"
          type="button"
          role="tab"
          aria-selected={mode === 'inspect'}
          aria-controls="graph-workflow-panel"
          onClick={() => setMode('inspect')}
        >
          <span>01</span>
          <strong>inspect_code_graph</strong>
          <small>query · node · neighbors · path · impact</small>
        </button>
        <button
          id="graph-analyze-tab"
          type="button"
          role="tab"
          aria-selected={mode === 'analyze'}
          aria-controls="graph-workflow-panel"
          onClick={() => setMode('analyze')}
        >
          <span>02</span>
          <strong>analyze_code_graph</strong>
          <small>stats · communities · groups · confidence</small>
        </button>
      </div>
      <div
        id="graph-workflow-panel"
        className="graph-showcase__trace"
        role="tabpanel"
        aria-labelledby={mode === 'inspect' ? 'graph-inspect-tab' : 'graph-analyze-tab'}
      >
        <AgentTrace key={mode} scenario={scenario} compact />
      </div>

      <div className="graph-showcase__capabilities">
        {graphCapabilities.map(capability => (
          <article key={capability.number}>
            <div>
              <span>{capability.number}</span>
              <small>{capability.label}</small>
            </div>
            <h3>{capability.title}</h3>
            <p>{capability.body}</p>
          </article>
        ))}
      </div>

      <a className="graph-showcase__performance-cta" href={siteHref('performance/')}>
        <div>
          <span className="eyebrow">4.4 graph pipeline · large repositories · fast worktrees</span>
          <h3>Inspect the exact-release evidence behind proportional graph updates.</h3>
        </div>
        <p>
          {performanceArtifact ? (
            <>
              {performanceArtifact.source.threadnote.version} indexed{' '}
              {performanceArtifact.inventory.indexedFiles.toLocaleString('en-US')} IntelliJ files in{' '}
              {formatMeasuredDuration(performanceArtifact.phases.cold.totalMilliseconds)}. Its one-file update took{' '}
              {formatMeasuredDuration(performanceArtifact.phases.incremental.totalMilliseconds)}, including{' '}
              {formatMeasuredDuration(performanceArtifact.phases.incremental.registrationMilliseconds)} registration and{' '}
              {formatMeasuredDuration(performanceArtifact.phases.incremental.postCommittedScanMilliseconds)}
              post-scan, with exact independent-rebuild parity.
            </>
          ) : (
            'Current exact-release performance evidence is pending; older release measurements are not substituted.'
          )}
        </p>
        <Icon name="arrow" aria-hidden="true" />
      </a>

      <div className="graph-showcase__manager">
        <div className="graph-showcase__manager-copy">
          <span className="eyebrow">From MCP evidence to a visual map</span>
          <h3>Walk the same graph in Manager.</h3>
          <p>
            Search the active snapshot, inspect symbol and edge provenance, then request community drill-down,
            structural groups, confidence, hub, and surprising-link signals only when you need them. The real Manager
            remains local and reads your current checkout; the public demo uses synthetic data.
          </p>
          <div>
            <a className="button" href={siteHref('manager-demo/')}>
              Open the Manager demo
              <Icon name="arrow" aria-hidden="true" />
            </a>
            <a className="button button--ghost" href={docsArticleHref('graph-operations')}>
              Graph search docs
            </a>
          </div>
        </div>
        <div className="graph-showcase__manager-preview" aria-label="Illustrative Manager graph analysis preview">
          <header>
            <span>Manager / Graph / Architecture signals</span>
            <strong>Illustrative local snapshot</strong>
          </header>
          <div className="graph-showcase__manager-body">
            <div className="graph-showcase__manager-map" aria-hidden="true">
              <svg viewBox="0 0 720 360" preserveAspectRatio="xMidYMid meet">
                <g className="graph-showcase__manager-edges">
                  <path d="M112 84 C196 86 255 136 356 180" />
                  <path d="M178 192 C246 192 286 185 356 180" />
                  <path d="M114 294 C212 286 278 224 356 180" />
                  <path d="M350 58 C350 101 353 137 356 180" />
                  <path d="M356 180 C437 138 495 95 596 78" />
                  <path d="M356 180 C424 184 481 188 550 194" />
                  <path d="M356 180 C430 225 505 278 606 294" />
                  <path d="M112 84 C225 42 273 48 350 58" className="is-secondary" />
                  <path d="M550 194 C579 222 596 254 606 294" className="is-secondary" />
                </g>
                <g className="graph-showcase__manager-nodes">
                  <circle cx="112" cy="84" r="10" className="is-teal" />
                  <circle cx="178" cy="192" r="8" className="is-amber" />
                  <circle cx="114" cy="294" r="9" className="is-teal" />
                  <circle cx="350" cy="58" r="8" className="is-blue" />
                  <circle cx="356" cy="180" r="17" className="is-core" />
                  <circle cx="596" cy="78" r="10" className="is-blue" />
                  <circle cx="550" cy="194" r="9" className="is-teal" />
                  <circle cx="606" cy="294" r="10" className="is-violet" />
                </g>
              </svg>
            </div>
            <dl>
              <div>
                <dt>Coverage</dt>
                <dd>complete</dd>
              </div>
              <div>
                <dt>Communities</dt>
                <dd>14</dd>
              </div>
              <div>
                <dt>Components</dt>
                <dd>3</dd>
              </div>
              <div>
                <dt>Top hub</dt>
                <dd>RequestCoordinator</dd>
              </div>
              <div>
                <dt>Surprising links</dt>
                <dd>4</dd>
              </div>
            </dl>
          </div>
        </div>
      </div>
    </section>
  );
}

export default function LandingPage() {
  setDocumentMeta(
    'Your team remembers',
    'Local-first engineering memory with optional code citations, honest freshness warnings, and large-scale polyglot graph search for every coding agent.',
  );

  return (
    <SiteShell page="home" fullBleed>
      <section className="hero section-grid">
        <div className="hero__copy">
          <div className="hero__version">
            <span className="status-dot" />
            Threadnote 4.4 · self-contained
          </div>
          <h1>
            Your team remembers.
            <span>Every coding agent can use it.</span>
          </h1>
          <p className="hero__lede">
            Local-first engineering memory that can cite current code and warn when evidence moves or changes, plus
            large-scale polyglot graph search for Codex, Claude, Cursor, Copilot, and the next agent you try.
          </p>
          <div className="hero__actions">
            <a className="button" href={docsArticleHref('installation')}>
              Install Threadnote
              <Icon name="arrow" aria-hidden="true" />
            </a>
            <a className="button button--ghost" href="#graph-search">
              Explore graph search
            </a>
          </div>
          <div className="hero__install">
            <code>curl -fsSL https://raw.githubusercontent.com/Kashkovsky/threadnote/main/scripts/install.sh | sh</code>
            <span>macOS & Linux · standalone runtime</span>
          </div>
        </div>
        <div className="hero__visual">
          <Suspense fallback={<div className="thread-scene thread-scene--fallback" />}>
            <ThreadScene />
          </Suspense>
          <div className="hero-node hero-node--memory">
            <span>memory</span>
            <strong>auth-contract.md</strong>
          </div>
          <div className="hero-node hero-node--graph">
            <span>code graph</span>
            <strong>inspect + analyze · current worktree</strong>
          </div>
          <div className="hero-node hero-node--share">
            <span>team share</span>
            <strong>mobile-platform</strong>
          </div>
          <div className="hero__caption">
            <span>Historical knowledge</span>
            <i />
            <span>Current source</span>
          </div>
        </div>
      </section>

      <section className="trust-strip" aria-label="Threadnote runtime guarantees">
        <div>
          <strong>Standalone installation</strong>
          <span>Executable and pinned native runtime</span>
        </div>
        <div>
          <strong>Private by default</strong>
          <span>Canonical home at ~/.threadnote</span>
        </div>
        <div>
          <strong>Core model installed automatically</strong>
          <span>Verified BGE Small embeddings</span>
        </div>
        <div>
          <strong>No service to babysit</strong>
          <span>No Python, daemon, or external server</span>
        </div>
      </section>

      <section className="content-section content-section--trace">
        <header className="section-heading">
          <span className="eyebrow">Context that can check its sources</span>
          <h2>One prompt. Memory, current code, and honest freshness.</h2>
          <p>
            Memory explains what people learned and decided. The graph explains what the current worktree contains.
            Optional citations let Context Brief distinguish evidence that moved unchanged from evidence that changed,
            disappeared, or could not be verified. A stale-link warning means the evidence moved—not that the memory
            became stale—and older uncited memories still participate in recall.
          </p>
        </header>
        <AgentTrace scenario={heroScenario} />
      </section>

      <GraphSearchShowcase />

      <section className="content-section" id="features">
        <header className="section-heading section-heading--split">
          <div>
            <span className="eyebrow">A durable context layer</span>
            <h2>Built for the whole engineering thread.</h2>
          </div>
          <p>
            Threadnote sits between your repositories, local tools, team knowledge, and coding agents—without trying to
            replace any of them.
          </p>
        </header>
        <div className="feature-grid">
          {features.map((feature, index) => (
            <article className={`feature-card feature-card--${feature.accent}`} key={feature.label}>
              <div className="feature-card__top">
                <span className="feature-card__index">0{index + 1}</span>
                <Icon name={feature.icon} aria-hidden="true" />
              </div>
              <span className="eyebrow">{feature.label}</span>
              <h3>{feature.title}</h3>
              <p>{feature.body}</p>
              <code>{feature.detail}</code>
            </article>
          ))}
        </div>
      </section>

      <section className="architecture-band">
        <div className="architecture-band__copy">
          <span className="eyebrow">Private by architecture</span>
          <h2>Your machine is the default trust boundary.</h2>
          <p>
            Canonical Markdown, SQLite indexes, models, graph snapshots, and share metadata live under{' '}
            <code>~/.threadnote</code>. Derived indexes can be rebuilt. Sharing is an explicit previewed action.
          </p>
          <a className="text-link" href={docsArticleHref('architecture')}>
            Read the architecture
            <Icon name="arrow" aria-hidden="true" />
          </a>
        </div>
        <div className="architecture-map" aria-label="Threadnote data flow">
          <div className="architecture-map__boundary">
            <span>Your machine</span>
            <div className="architecture-map__core">
              <small>~/.threadnote</small>
              <strong>Canonical memory</strong>
              <strong>SQLite indexes</strong>
              <strong>Local models</strong>
              <strong>Code snapshots</strong>
            </div>
            <div className="architecture-map__agents">
              <span>Codex</span>
              <span>Claude</span>
              <span>Cursor</span>
              <span>Copilot</span>
            </div>
          </div>
          <div className="architecture-map__external">
            <div>
              <span>Explicit</span>
              <strong>Team share</strong>
            </div>
            <div>
              <span>Allowlisted</span>
              <strong>Obsidian</strong>
            </div>
          </div>
        </div>
      </section>

      <section className="content-section">
        <header className="section-heading">
          <span className="eyebrow">The daily loop</span>
          <h2>Start informed. Finish with a clean thread.</h2>
        </header>
        <ol className="workflow-list">
          {workflow.map(item => (
            <li key={item.number}>
              <span>{item.number}</span>
              <div>
                <h3>{item.title}</h3>
                <p>{item.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="manager-teaser">
        <div className="manager-teaser__copy">
          <span className="eyebrow">Threadnote Manager</span>
          <h2>Your context, visible.</h2>
          <p>
            Walk a polyglot dependency graph, inspect topology signals, follow a memory’s lifecycle, check share health,
            and verify local AI—without leaving the local runtime.
          </p>
          <a className="button button--light" href={siteHref('manager-demo/')}>
            Open interactive demo
            <Icon name="arrow" aria-hidden="true" />
          </a>
        </div>
        <div className="manager-teaser__window">
          <div className="manager-teaser__chrome">
            <span />
            <span />
            <span />
            <code>localhost · Manager</code>
          </div>
          <div className="manager-teaser__app">
            <aside>
              <strong>TN</strong>
              <span className="is-active">Graph</span>
              <span>Memory</span>
              <span>Shares</span>
              <span>Doctor</span>
            </aside>
            <div className="manager-teaser__canvas">
              <svg viewBox="0 0 620 300" aria-hidden="true">
                <g className="preview-lines">
                  <path d="M90 150 220 82 330 152 475 70" />
                  <path d="M90 150 215 245 330 152 500 226" />
                  <path d="M220 82 325 45 475 70" />
                  <path d="M215 245 360 255 500 226" />
                </g>
                <g className="preview-nodes">
                  <circle cx="90" cy="150" r="13" />
                  <circle cx="220" cy="82" r="10" />
                  <circle cx="215" cy="245" r="11" />
                  <circle cx="330" cy="152" r="16" />
                  <circle cx="325" cy="45" r="8" />
                  <circle cx="475" cy="70" r="12" />
                  <circle cx="360" cy="255" r="9" />
                  <circle cx="500" cy="226" r="13" />
                </g>
              </svg>
              <div className="manager-teaser__legend">
                <span>
                  <i className="dot dot--ts" /> TypeScript
                </span>
                <span>
                  <i className="dot dot--kt" /> Kotlin
                </span>
                <span>
                  <i className="dot dot--swift" /> Swift
                </span>
              </div>
            </div>
            <div className="manager-teaser__detail">
              <span>SYMBOL</span>
              <h3>AuthSession</h3>
              <code>libs/auth/session.ts:18</code>
              <dl>
                <div>
                  <dt>Inbound</dt>
                  <dd>7</dd>
                </div>
                <div>
                  <dt>Outbound</dt>
                  <dd>5</dd>
                </div>
              </dl>
            </div>
          </div>
        </div>
      </section>

      <section className="content-section content-section--cta">
        <div className="cta-panel">
          <span className="eyebrow">Keep the long thread</span>
          <h2>Give your next agent the context your last one earned.</h2>
          <CodeBlock
            label="macOS & Linux"
            code="curl -fsSL https://raw.githubusercontent.com/Kashkovsky/threadnote/main/scripts/install.sh | sh"
          />
          <div className="cta-panel__actions">
            <a className="button" href={siteHref('docs/')}>
              Read the docs
            </a>
            <a className="button button--ghost" href={githubUrl}>
              View on GitHub
            </a>
          </div>
        </div>
      </section>
    </SiteShell>
  );
}
