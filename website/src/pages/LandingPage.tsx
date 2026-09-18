import {lazy, Suspense, useState} from 'react';
import articles from 'virtual:threadnote-articles';
import latestRelease from 'virtual:threadnote-latest-release';
import {AgentTrace} from '../components/AgentTrace';
import {CodeBlock} from '../components/CodeBlock';
import {Icon, type IconName} from '../components/Icons';
import {SiteShell} from '../components/SiteShell';
import {graphAnalyzeScenario, graphInspectScenario, heroScenario} from '../content/landing';
import {performanceEvidence} from '../content/performanceEvidence';
import {
  docsArticleHref,
  githubUrl,
  setDocumentMeta,
  siteHref,
  whatsNewArticleHref,
  whatsNewReleaseHref,
} from '../lib/site';

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
    title: 'Give the agent a useful briefing before it starts.',
    body: 'A Context Brief is a short, cited summary of the decisions, open work, and code related to the task. It also shows what may be missing or out of date.',
    detail: 'Short · cited · current',
  },
  {
    icon: 'local',
    accent: 'teal',
    label: 'Knowledge Delta',
    title: 'Save the useful lesson, not the whole chat.',
    body: 'A Knowledge Delta is a short list of new decisions, checks, outdated notes, and open risks. You approve, edit, defer, or reject every item.',
    detail: 'You stay in control',
  },
  {
    icon: 'team',
    accent: 'blue',
    label: 'Cross-agent sharing',
    title: 'Reuse approved decisions in another coding agent.',
    body: 'Keep decisions private or share selected ones through Git. Your normal branch review and CODEOWNERS rules still apply.',
    detail: 'Git-backed · portable',
  },
  {
    icon: 'graph',
    accent: 'violet',
    label: 'Continuous health',
    title: 'See when saved context may no longer be true.',
    body: 'Threadnote checks code links, review dates, conflicting notes, and changed guidance. Repairs are previewed before anything is updated.',
    detail: 'Find · review · repair',
  },
  {
    icon: 'manager',
    accent: 'magenta',
    label: 'Verified procedures',
    title: 'Reuse team workflows without running mystery automation.',
    body: 'Procedures show their owner, version, dependencies, compatible agents, and verification. Threadnote previews them and never runs downloaded steps automatically.',
    detail: 'Reviewed · compatible · explicit',
  },
  {
    icon: 'obsidian',
    accent: 'amber',
    label: 'Private by default',
    title: 'Keep your code and saved context on your machine.',
    body: 'Threadnote stores local files, indexes, models, and code maps under your control. Only the decisions you explicitly share leave the machine.',
    detail: 'Local · offline-capable · explicit sharing',
  },
];

const workflow = [
  {
    number: '01',
    title: 'Connect one coding agent',
    body: 'Preview the setup, prepare the current repository, and verify the connection with a real Context Brief.',
  },
  {
    number: '02',
    title: 'Start with a short briefing',
    body: 'Let Threadnote find the decisions, task state, and current code that matter for the work.',
  },
  {
    number: '03',
    title: 'Work in the repository as usual',
    body: 'The agent uses the brief as a guide and checks important claims against your current local files.',
  },
  {
    number: '04',
    title: 'Review what the task learned',
    body: 'Keep only the new decisions, checks, outdated notes, and risks that will help future work.',
  },
  {
    number: '05',
    title: 'Share only what the team needs',
    body: 'Keep the result private or send selected decisions through your normal Git review process.',
  },
  {
    number: '06',
    title: 'Reuse it next time',
    body: 'The same agent—or a different supported agent—can find the decision, with its source and freshness still visible.',
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
    'Shared context for coding agents',
    'Give coding agents the decisions and current code they need, then review what they leave for the next task.',
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
            Threadnote helps <a href={siteHref('agents/')}>coding agents</a> understand why your code is the way it is.
            Before a task, they get a short briefing with relevant decisions and current code. After the task, you
            choose which new lessons are worth keeping.
          </p>
          <div className="hero__actions">
            <a className="button" href={docsArticleHref('installation')}>
              Install Threadnote
              <Icon name="arrow" aria-hidden="true" />
            </a>
            <a className="button button--ghost" href={docsArticleHref('threadnote-5-journey')}>
              See how it works
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
            <span>why it was built this way</span>
            <strong>reviewed decision</strong>
          </div>
          <div className="hero-node hero-node--graph">
            <span>what the code does now</span>
            <strong>current local files</strong>
          </div>
          <div className="hero-node hero-node--share">
            <span>what this task learned</span>
            <strong>your review</strong>
          </div>
          <div className="hero__caption">
            <span>Reviewed context</span>
            <i />
            <span>Current evidence</span>
          </div>
        </div>
      </section>

      {latestRelease || latestArticle ? (
        <div className="home-update-banners" aria-label="Latest Threadnote updates">
          {latestRelease ? (
            <a
              className="home-update-banner home-update-banner--release"
              href={whatsNewReleaseHref(latestRelease.version)}
            >
              <span className="home-update-banner__label">Latest release</span>
              <div>
                <strong>Threadnote {latestRelease.version.replace(/^v/, '')}</strong>
                <p>{latestRelease.headline}</p>
              </div>
              <span className="home-update-banner__action">
                Read release notes
                <Icon name="arrow" aria-hidden="true" />
              </span>
            </a>
          ) : null}
          {latestArticle ? (
            <a className="home-update-banner" href={whatsNewArticleHref(latestArticle.slug)}>
              <span className="home-update-banner__label">Latest article</span>
              <div>
                <strong>{latestArticle.title}</strong>
                <p>{latestArticle.summary}</p>
              </div>
              <span className="home-update-banner__action">
                Read article
                <Icon name="arrow" aria-hidden="true" />
              </span>
            </a>
          ) : null}
        </div>
      ) : null}

      <section className="trust-strip" aria-label="Threadnote runtime guarantees">
        <div>
          <strong>Works across agents</strong>
          <span>One source of approved context</span>
        </div>
        <div>
          <strong>Shows its sources</strong>
          <span>See where a decision came from</span>
        </div>
        <div>
          <strong>You approve changes</strong>
          <span>Nothing is silently saved or shared</span>
        </div>
        <div>
          <strong>Local by default</strong>
          <span>No Threadnote cloud account required</span>
        </div>
      </section>

      <section className="content-section content-section--trace">
        <header className="section-heading">
          <span className="eyebrow">Meet the Context Brief</span>
          <h2>A short, useful briefing before the agent starts.</h2>
          <p>
            A Context Brief brings together the decisions, unfinished work, and current code that matter for one task.
            Every important claim keeps a link to its source, and missing information stays clearly marked as unknown.
          </p>
        </header>
        <AgentTrace scenario={heroScenario} />
      </section>

      <section className="content-section" id="features">
        <header className="section-heading section-heading--split">
          <div>
            <span className="eyebrow">What Threadnote does</span>
            <h2>Useful context before the task. Better context after it.</h2>
          </div>
          <p>
            Threadnote does not replace your repository, Git review, or coding agent. It connects them with context that
            stays cited, reviewable, and reusable.
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
          <span className="eyebrow">Private by default</span>
          <h2>Your context stays on your machine.</h2>
          <p>
            Saved decisions, indexes, local models, and code maps live under <code>~/.threadnote</code>. Threadnote
            shows you a preview before anything is shared.
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
          <span className="eyebrow">How it works</span>
          <h2>From a first briefing to a decision the next agent can reuse.</h2>
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
          <h2>See what Threadnote knows and when it needs attention.</h2>
          <p>
            Browse saved decisions, check team shares and agent guidance, explore the current code map, and see which
            context is current, outdated, or waiting for review.
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
          <span className="eyebrow">Try Threadnote</span>
          <h2>Stop explaining the same project decisions to every new coding agent.</h2>
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
