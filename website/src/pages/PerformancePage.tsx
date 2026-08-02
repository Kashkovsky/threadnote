import {Icon} from '../components/Icons';
import {SiteShell} from '../components/SiteShell';
import {
  performanceControlLanguages,
  retainedPerformanceArtifactFieldPaths,
  type RetainedPerformanceArtifact,
} from '../content/performance';
import {performanceEvidence} from '../content/performanceEvidence';
import {setDocumentMeta, siteHref} from '../lib/site';

const integerFormatter = new Intl.NumberFormat('en-US');

function formatInteger(value: number): string {
  return integerFormatter.format(value);
}

function formatBytes(value: number): string {
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  return `${(value / 1024 ** 3).toFixed(1)} GiB`;
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds.toFixed(1)} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)} s`;
  return `${(milliseconds / 60_000).toFixed(1)} min`;
}

const pipeline = [
  {
    number: '01',
    label: 'Discover',
    title: 'Prune before reading',
    body: 'Dependency trees, hidden folders, generated roots, build output, and Bazel output trees are excluded during traversal—not materialized and discarded later.',
  },
  {
    number: '02',
    label: 'Extract',
    title: 'Bound each file, not the repository',
    body: 'A bounded parser worker pool applies per-file complexity budgets. Pathological source keeps declarations and imports; low-signal structured data keeps useful metadata.',
  },
  {
    number: '03',
    label: 'Persist',
    title: 'Prepare in parallel, write with backpressure',
    body: 'Workers feed one backpressured SQLite writer. Deterministic batches and compact lexical postings control transient memory and write amplification.',
  },
  {
    number: '04',
    label: 'Activate',
    title: 'Keep the last good snapshot live',
    body: 'Queries continue reading the ready graph until the building snapshot validates and promotes atomically. Interrupted builds never replace known-good evidence.',
  },
] as const;

function surfaceCards(artifact: RetainedPerformanceArtifact | undefined) {
  return [
    {
      label: 'CLI',
      title: 'Operational detail for the person waiting',
      body: 'File and language activity, phase timings, row counts, persistence stages, storage high-water, and liveness make long cold builds observable.',
      detail: 'Interactive progress · privacy-safe diagnostics',
    },
    {
      label: 'Manager',
      title: artifact ? 'Bounded views, retained measurements' : 'Manager performance remains gated',
      body: artifact
        ? `The retained run covers indexed catalog, bounded graph query, overview, detail, and render work with a ${formatInteger(artifact.manager.nodeBudget)}-node / ${formatInteger(artifact.manager.edgeBudget)}-edge evidence budget, snapshot binding, and stale-request cancellation.`
        : 'This page makes no Manager-speed claim until the reviewed Manager implementation and retained artifact supply catalog, bounded-query latency and payload, overview, detail, render, snapshot-binding, and stale-request-cancellation evidence together.',
      detail: artifact
        ? `Query p95 ${formatDuration(artifact.manager.queryP95Milliseconds)} · max payload ${formatBytes(artifact.manager.queryMaxPayloadBytes)}`
        : 'Pending reviewed code + retained measurements',
    },
    {
      label: 'Graph MCP',
      title: 'Concise evidence for the agent',
      body: 'Graph responses stay deliberately bounded so a large repository cannot flood an agent context. Stable IDs support precise node, neighbor, path, and impact follow-ups.',
      detail: 'Small result · explicit drill-down',
    },
    {
      label: 'Memory MCP',
      title: 'Canonical memory reads stay complete',
      body: 'Recall returns ranked pointers. Reading a selected canonical memory returns the complete record; graph response budgets are never reused to truncate memory content.',
      detail: 'Ranked recall · uncapped canonical read',
    },
  ] as const;
}

const proofGroups = [
  {
    label: 'Exact provenance',
    body: 'Artifact URL, artifact SHA-256, UTC timestamp, exact Threadnote commit, exact public-repository commit, clean-checkout state, hardware, OS, Bun, SQLite, and disk details.',
  },
  {
    label: 'End-to-end phases',
    body: 'Cold discovery, extraction, materialization, resolution, activation, and total time; then a one-file incremental overlay and an independent rebuild of that same overlay.',
  },
  {
    label: 'Resource high-water',
    body: 'Database footprint, resident memory, WAL, temporary storage, durable growth, query latency distribution, and bounded Manager response and render measurements.',
  },
  {
    label: 'Correctness controls',
    body: 'Java, Kotlin, TypeScript, and Bazel controls plus the clean digest and exact incremental-versus-independent-rebuild structural digest parity.',
  },
] as const;

type EvidenceCard = Readonly<{label: string; value: string; detail: string}>;

function scaleCards(artifact: RetainedPerformanceArtifact | undefined): readonly EvidenceCard[] {
  if (!artifact) {
    return [
      {label: 'Eligible files', value: 'Pending', detail: 'Pinned public checkout inventory'},
      {label: 'Symbols', value: 'Pending', detail: 'Searchable declarations and structural nodes'},
      {label: 'Relationships', value: 'Pending', detail: 'Provenance-bearing graph edges'},
      {label: 'Graph database', value: 'Pending', detail: 'Final persistent SQLite footprint'},
    ];
  }
  return [
    {
      label: 'Eligible files',
      value: formatInteger(artifact.inventory.eligibleFiles),
      detail: `${formatInteger(artifact.inventory.indexedFiles)} indexed`,
    },
    {label: 'Symbols', value: formatInteger(artifact.graph.symbols), detail: 'Searchable declarations and structure'},
    {
      label: 'Relationships',
      value: formatInteger(artifact.graph.relationships),
      detail: `${formatInteger(artifact.graph.references)} references`,
    },
    {
      label: 'Graph database',
      value: formatBytes(artifact.storage.databaseBytes),
      detail: 'Persistent SQLite footprint',
    },
  ];
}

function phaseCards(artifact: RetainedPerformanceArtifact | undefined): readonly EvidenceCard[] {
  if (!artifact) {
    return [
      {label: 'Cold index', value: 'Pending', detail: 'All indexing phases from a clean home'},
      {label: 'One-file incremental', value: 'Pending', detail: 'A semantic edit over the ready snapshot'},
      {label: 'Independent rebuild', value: 'Pending', detail: 'Fresh graph of the identical overlay'},
      {label: 'Graph queries', value: 'Pending', detail: 'Retained p50, p95, and maximum latency'},
    ];
  }
  return [
    {
      label: 'Cold index',
      value: formatDuration(artifact.phases.cold.totalMilliseconds),
      detail: 'Clean exact-HEAD run',
    },
    {
      label: 'One-file incremental',
      value: formatDuration(artifact.phases.incremental.totalMilliseconds),
      detail: `${formatInteger(artifact.phases.incremental.changedFiles)} changed file`,
    },
    {
      label: 'Independent rebuild',
      value: formatDuration(artifact.phases.independentRebuild.totalMilliseconds),
      detail: 'Identical dirty overlay',
    },
    {
      label: 'Graph query p95',
      value: formatDuration(artifact.queries.p95Milliseconds),
      detail: `${formatInteger(artifact.queries.sampleCount)} retained samples`,
    },
  ];
}

function ProvenanceCard({artifact}: {artifact: RetainedPerformanceArtifact | undefined}) {
  if (!artifact) {
    return (
      <aside className="performance-run-card performance-run-card--pending">
        <header>
          <div>
            <span className="status-dot" />
            <strong>Retained evidence pending</strong>
          </div>
          <small>fail closed</small>
        </header>
        <dl>
          <div>
            <dt>Threadnote source</dt>
            <dd>Exact final HEAD pending</dd>
          </div>
          <div>
            <dt>Public repository</dt>
            <dd>Pinned commit pending</dd>
          </div>
          <div>
            <dt>Artifact</dt>
            <dd>URL + SHA-256 pending</dd>
          </div>
        </dl>
        <p>
          The page publishes no provisional result values. Numbers appear only after one complete artifact passes the
          build-time byte and source binding plus strict controls, parity, storage, query, and Manager validation.
        </p>
      </aside>
    );
  }
  return (
    <aside className="performance-run-card performance-run-card--verified">
      <header>
        <div>
          <span className="status-dot" />
          <strong>Retained evidence verified</strong>
        </div>
        <small>{artifact.artifact.generatedAt}</small>
      </header>
      <a href={artifact.artifact.url} target="_blank" rel="noreferrer">
        <span>Benchmark artifact</span>
        <strong>{artifact.source.repository.name}</strong>
        <code>{artifact.artifact.sha256.slice(0, 16)}…</code>
      </a>
      <dl>
        <div>
          <dt>Threadnote</dt>
          <dd>{artifact.source.threadnote.commit.slice(0, 12)}</dd>
        </div>
        <div>
          <dt>Repository</dt>
          <dd>{artifact.source.repository.commit.slice(0, 12)}</dd>
        </div>
        <div>
          <dt>Runner</dt>
          <dd>{artifact.runner.hardware}</dd>
        </div>
      </dl>
      <p>
        {artifact.runner.runtime.name} {artifact.runner.runtime.version} · {artifact.runner.database.name}{' '}
        {artifact.runner.database.version} · {formatBytes(artifact.runner.memoryBytes)} memory
      </p>
    </aside>
  );
}

export default function PerformancePage() {
  setDocumentMeta(
    'Performance',
    'Threadnote 4 large-repository architecture and retained benchmark evidence for polyglot, Bazel, and concurrent-worktree codebases.',
  );

  const artifact = performanceEvidence.state === 'verified' ? performanceEvidence.artifact : undefined;
  const metrics = scaleCards(artifact);
  const phases = phaseCards(artifact);
  const surfaces = surfaceCards(artifact);

  return (
    <SiteShell page="performance" fullBleed>
      <section className="performance-hero">
        <div className="performance-hero__copy">
          <span className="eyebrow">Threadnote 4 performance</span>
          <h1>Large codebases are a normal case.</h1>
          <p>
            Threadnote is built for the repository you actually work in: polyglot, Bazel-aware, nested, and active
            across concurrent worktrees. Repository size is never an admission test.
          </p>
          <div className="performance-hero__actions">
            <a className="button" href="#evidence">
              Inspect the evidence gate
              <Icon name="arrow" aria-hidden="true" />
            </a>
            <a className="button button--ghost" href={siteHref('docs/#graph-monorepos')}>
              Large-repository docs
            </a>
          </div>
        </div>
        <ProvenanceCard artifact={artifact} />
      </section>

      <section className="performance-scale" id="evidence" aria-label="Retained benchmark scale">
        {metrics.map(metric => (
          <article key={metric.label} className={artifact ? undefined : 'is-pending'}>
            <span>{metric.label}</span>
            <strong>{metric.value}</strong>
            <small>{metric.detail}</small>
          </article>
        ))}
      </section>

      <section className="performance-section performance-proof">
        <header className="section-heading section-heading--split">
          <div>
            <span className="eyebrow">One artifact or no claim</span>
            <h2>Public, pinned, reproducible evidence.</h2>
          </div>
          <p>
            Final numbers are admitted together—not copied from different runs. Exact source, scale, phase, resource,
            query, language-control, Manager, and digest evidence must all describe the same clean retained run.
          </p>
        </header>

        <div className="performance-proof-grid">
          {proofGroups.map(group => (
            <article key={group.label}>
              <span className={artifact ? 'performance-check performance-check--passed' : 'performance-check'} />
              <small>{artifact ? 'verified' : 'pending'}</small>
              <h3>{group.label}</h3>
              <p>{group.body}</p>
            </article>
          ))}
        </div>

        <div className="performance-control-panel">
          <header>
            <div>
              <span className="eyebrow">Polyglot controls</span>
              <h3>Definitions and build structure must survive scale.</h3>
            </div>
            <p>Each control records its exact query, path, stable node ID, latency, and pass state.</p>
          </header>
          <div>
            {performanceControlLanguages.map(language => {
              const control = artifact?.controls[language];
              return (
                <article key={language}>
                  <span>{language === 'bazel' ? 'Bazel / Starlark' : language}</span>
                  <strong>{control ? formatDuration(control.milliseconds) : 'Pending'}</strong>
                  <small>{control ? control.path : 'Retained control not published yet'}</small>
                </article>
              );
            })}
          </div>
        </div>

        <div className="performance-phase-panel">
          <header>
            <span className="eyebrow">End-to-end evidence</span>
            <p>Every timing has one named scope. File-rate estimates are never presented as total completion time.</p>
          </header>
          <div>
            {phases.map(phase => (
              <article key={phase.label} className={artifact ? undefined : 'is-pending'}>
                <span>{phase.label}</span>
                <strong>{phase.value}</strong>
                <small>{phase.detail}</small>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="performance-pipeline">
        <header className="section-heading section-heading--split">
          <div>
            <span className="eyebrow">Bounded by architecture</span>
            <h2>Control the work. Never reject the repository.</h2>
          </div>
          <p>
            Large-repository reliability comes from bounded units and backpressure, not an arbitrary repository byte or
            row limit. Complexity budgets degrade individual pathological artifacts while useful structure remains
            searchable.
          </p>
        </header>
        <ol>
          {pipeline.map(stage => (
            <li key={stage.number}>
              <div>
                <span>{stage.number}</span>
                <small>{stage.label}</small>
              </div>
              <h3>{stage.title}</h3>
              <p>{stage.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="performance-worktrees">
        <div className="performance-worktrees__copy">
          <span className="eyebrow">Built for orchestrated work</span>
          <h2>One commit graph. One truthful overlay per worktree.</h2>
          <p>
            Conductor-style orchestrators and parallel agents can edit linked worktrees simultaneously. Threadnote
            reuses the immutable commit snapshot, then isolates staged, unstaged, renamed, deleted, and eligible
            untracked changes to the checkout that owns them.
          </p>
          <ul>
            <li>
              <Icon name="check" aria-hidden="true" /> Shared immutable commit snapshot
            </li>
            <li>
              <Icon name="check" aria-hidden="true" /> Isolated dirty overlay per linked worktree
            </li>
            <li>
              <Icon name="check" aria-hidden="true" /> Queued writers without blocking concurrent reads
            </li>
          </ul>
        </div>
        <div className="performance-worktrees__diagram" aria-label="Concurrent worktree snapshot model">
          <div className="performance-worktrees__base">
            <span>Reusable base</span>
            <strong>Git commit snapshot</strong>
            <code>{artifact ? artifact.source.repository.commit.slice(0, 12) : 'exact SHA pending'}</code>
          </div>
          <div className="performance-worktrees__branches">
            <article>
              <span>worktree / checkout-a</span>
              <strong>Agent A overlay</strong>
              <small>staged · unstaged</small>
            </article>
            <article>
              <span>worktree / checkout-b</span>
              <strong>Agent B overlay</strong>
              <small>renamed · untracked</small>
            </article>
            <article>
              <span>worktree / main</span>
              <strong>Ready snapshot</strong>
              <small>clean · reusable</small>
            </article>
          </div>
        </div>
      </section>

      <section className="performance-section performance-surfaces">
        <header className="section-heading">
          <span className="eyebrow">Right detail for the reader</span>
          <h2>Detailed where humans operate. Compact where agents reason.</h2>
          <p>
            Operational visibility should not become MCP context pollution. Threadnote intentionally gives each surface
            a different information budget.
          </p>
        </header>
        <div>
          {surfaces.map(surface => (
            <article key={surface.label}>
              <span>{surface.label}</span>
              <h3>{surface.title}</h3>
              <p>{surface.body}</p>
              <code>{surface.detail}</code>
            </article>
          ))}
        </div>
      </section>

      <section className="performance-methodology">
        <div>
          <span className="eyebrow">Read the numbers honestly</span>
          <h2>Evidence, not a universal SLA.</h2>
        </div>
        <div>
          <p>
            One pinned public repository on one reviewed runner proves that the complete pipeline works at that shape.
            It does not promise identical times for every repository, disk, operating system, or machine.
          </p>
          <p>
            The strict adapter currently requires {retainedPerformanceArtifactFieldPaths.length} retained fields. If any
            field is missing, malformed, comes from a different commit, or overlay digests disagree, the page remains
            explicitly pending.
          </p>
        </div>
      </section>

      <section className="content-section content-section--cta">
        <div className="cta-panel cta-panel--compact">
          <span className="eyebrow">Built for agents</span>
          <h2>Your agents will love it—even when the repository is enormous.</h2>
          <p>Give them precise current-source evidence without filling their context with the machinery behind it.</p>
          <div className="cta-panel__actions">
            <a className="button" href={siteHref('docs/#installation')}>
              Install Threadnote
            </a>
            <a className="button button--ghost" href={siteHref('manager-demo/')}>
              Explore Manager
            </a>
          </div>
        </div>
      </section>
    </SiteShell>
  );
}
