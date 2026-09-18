import {lazy, Suspense, useState} from 'react';
import articles from 'virtual:threadnote-articles';
import {AgentTrace} from '../components/AgentTrace';
import {CodeBlock} from '../components/CodeBlock';
import {Icon, type IconName} from '../components/Icons';
import {SiteShell} from '../components/SiteShell';
import {graphAnalyzeScenario, graphInspectScenario, heroScenario} from '../content/landing';
import {performanceEvidence} from '../content/performanceEvidence';
import {docsArticleHref, githubUrl, setDocumentMeta, siteHref, whatsNewArticleHref} from '../lib/site';

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
    label: 'Context Brief',
    title: 'Start with the smallest trustworthy evidence set.',
    body: 'Bring reviewed decisions, active handoffs, compatible procedures, and current code evidence into one bounded brief with provenance, freshness, and visible gaps.',
    detail: 'Bounded · cited · source-aware',
  },
  {
    icon: 'local',
    accent: 'teal',
    label: 'Knowledge Delta',
    title: 'Finish with reviewed knowledge, not a transcript.',
    body: 'Review decisions and rationale, constraints, verification, invalidated knowledge, and unresolved risks before any proposal becomes durable.',
    detail: 'Approve · edit · defer · reject',
  },
  {
    icon: 'team',
    accent: 'blue',
    label: 'Cross-agent sharing',
    title: 'Move approved context through the Git policy you already trust.',
    body: 'Publish one reviewed decision directly or materialize a provider-neutral branch and commit for normal team review. Private handoffs stay local.',
    detail: 'Git-backed · policy-aware · portable',
  },
  {
    icon: 'graph',
    accent: 'violet',
    label: 'Continuous health',
    title: 'Know when context changed, expired, drifted, or became uncertain.',
    body: 'Review dates, citations, relations, guidance drift, contradictions, and Context CI keep maintenance in the same lifecycle as retrieval.',
    detail: 'Detect · review · repair · retire',
  },
  {
    icon: 'manager',
    accent: 'magenta',
    label: 'Verified procedures',
    title: 'Reuse workflows only when their exact evidence is current.',
    body: 'Bind reviewed procedures to versions, owners, dependencies, compatible catalog surfaces, rollout policy, fixtures, and exact verification receipts.',
    detail: 'Preview-first · compatible · never auto-run',
  },
  {
    icon: 'obsidian',
    accent: 'amber',
    label: 'Visible value',
    title: 'Measure applied reuse without collecting the work.',
    body: 'Inspect local counts for activation, first evidence, second-agent reuse, Knowledge Delta outcomes, feedback, and health resolution.',
    detail: 'Content-free · local · consent-exported',
  },
];

const workflow = [
  {
    number: '01',
    title: 'Connect catalog-supported surfaces',
    body: 'Preview each managed setup and finish the first one with a real, cited Context Brief.',
  },
  {
    number: '02',
    title: 'Import existing guidance for review',
    body: 'Bring selected project instructions and ADRs into a candidate review without silently making them canonical.',
  },
  {
    number: '03',
    title: 'Work from cited context and exact local code',
    body: 'Use the brief to start informed, then verify consequential claims in the current worktree.',
  },
  {
    number: '04',
    title: 'Review the Knowledge Delta',
    body: 'Approve only the decisions, constraints, verification, invalidations, and risks worth carrying forward.',
  },
  {
    number: '05',
    title: 'Publish or propose through Git',
    body: 'Keep the personal-to-team boundary explicit and let normal review policy govern shared context.',
  },
  {
    number: '06',
    title: 'Reuse it, then keep it healthy',
    body: 'Retrieve the approved decision from another surface, inspect local value, and repair decay without silent deletion.',
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
    label: 'Free · manual · offline',
    title: 'Move one verified graph without a cloud.',
    body: 'Export the exact ready, clean graph for the current commit, inspect and fully verify the artifact against an independently obtained SHA-256 digest, then import it from a local checkout of the same repository. No account, hosted service, or Workset is required.',
  },
  {
    number: '07',
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
          <span className="eyebrow">Current-code evidence · large repositories · fast worktrees</span>
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
            <a className="button button--ghost" href={docsArticleHref('graph-checkpoints')}>
              Graph checkpoint docs
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
  const latestArticle = articles[0];
  setDocumentMeta(
    'Source-verifiable context across coding agents',
    'Start engineering tasks with reviewed decisions and current code evidence, then leave a reviewed Knowledge Delta for the next agent.',
  );

  return (
    <SiteShell page="home" fullBleed>
      <section className="hero section-grid">
        <div className="hero__copy">
          <div className="hero__version">
            <span className="status-dot" />
            Threadnote 5.0 · local and Git-backed
          </div>
          <h1>
            Start with the right context.
            <span>Leave it better for the next agent.</span>
          </h1>
          <p className="hero__lede">
            Threadnote is the source-verifiable context lifecycle for engineering work. Give{' '}
            <a href={siteHref('agents/')}>supported agents</a> reviewed decisions and current code evidence across
            vendors, then close the task with a Knowledge Delta a person can approve.
          </p>
          <div className="hero__actions">
            <a className="button" href={docsArticleHref('installation')}>
              Install Threadnote
              <Icon name="arrow" aria-hidden="true" />
            </a>
            <a className="button button--ghost" href={docsArticleHref('threadnote-5-journey')}>
              Follow the complete journey
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
            <span>reviewed decision</span>
            <strong>auth-contract · current</strong>
          </div>
          <div className="hero-node hero-node--graph">
            <span>current evidence</span>
            <strong>exact local worktree</strong>
          </div>
          <div className="hero-node hero-node--share">
            <span>closeout</span>
            <strong>reviewed Knowledge Delta</strong>
          </div>
          <div className="hero__caption">
            <span>Reviewed context</span>
            <i />
            <span>Current evidence</span>
          </div>
        </div>
      </section>

      {latestArticle ? (
        <a className="home-update-banner" href={whatsNewArticleHref(latestArticle.slug)}>
          <span className="home-update-banner__label">Latest · What&apos;s new</span>
          <div>
            <strong>{latestArticle.title}</strong>
            <p>{latestArticle.summary}</p>
          </div>
          <span className="home-update-banner__action">
            Read what&apos;s new
            <Icon name="arrow" aria-hidden="true" />
          </span>
        </a>
      ) : null}

      <section className="trust-strip" aria-label="Threadnote runtime guarantees">
        <div>
          <strong>Cross-vendor</strong>
          <span>Catalog-driven agent surfaces</span>
        </div>
        <div>
          <strong>Source-verifiable</strong>
          <span>Provenance, freshness, and honest gaps</span>
        </div>
        <div>
          <strong>Review-first</strong>
          <span>No silent import, apply, or publication</span>
        </div>
        <div>
          <strong>Local/offline floor</strong>
          <span>No hosted organization service required</span>
        </div>
      </section>

      <section className="content-section content-section--trace">
        <header className="section-heading">
          <span className="eyebrow">One bounded starting point</span>
          <h2>Reviewed decisions and current code—together, but never confused.</h2>
          <p>
            A Context Brief compiles only the relevant decisions, handoffs, verified procedures, and current-source
            evidence for the task. Provenance stays attached, the local worktree remains authoritative, and incomplete
            evidence stays unknown instead of becoming a confident answer.
          </p>
        </header>
        <AgentTrace scenario={heroScenario} />
      </section>

      <section className="content-section" id="features">
        <header className="section-heading section-heading--split">
          <div>
            <span className="eyebrow">The context lifecycle</span>
            <h2>From first evidence to reviewed reuse.</h2>
          </div>
          <p>
            Threadnote keeps capture, review, sharing, health, and reuse connected—without replacing repositories, Git
            review, or the agent surfaces your team already chose.
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
              <span>Supported</span>
              <span>agent</span>
              <span>surfaces</span>
              <span>↗</span>
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
          <span className="eyebrow">One cross-agent workflow</span>
          <h2>Start informed. Finish with context the next engineer can trust.</h2>
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

      <GraphSearchShowcase />

      <section className="manager-teaser">
        <div className="manager-teaser__copy">
          <span className="eyebrow">Threadnote Manager</span>
          <h2>Health and value stay inspectable.</h2>
          <p>
            Follow reviewed knowledge through its lifecycle, inspect share and guidance health, walk current code
            evidence, and see content-free activation, reuse, Knowledge Delta, feedback, and repair outcomes.
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
          <span className="eyebrow">Keep the context lifecycle moving</span>
          <h2>Give the next agent reviewed decisions and current evidence—not another transcript.</h2>
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
