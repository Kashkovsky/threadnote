import {Icon} from '../components/Icons';
import {SiteShell} from '../components/SiteShell';
import {
  performanceControlLanguages,
  retainedPerformanceArtifactFieldPaths,
  retainedPerformanceObjectiveResults,
  type RetainedPerformanceArtifact,
} from '../content/performance';
import {performanceEvidence} from '../content/performanceEvidence';
import {checkedInPerformanceEvidence} from '../content/performanceHighlights';
import {docsArticleHref, setDocumentMeta, siteHref} from '../lib/site';

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
      title: artifact ? 'Bounded views, retained measurements' : 'Bounded, snapshot-aware views',
      body: artifact
        ? `The retained run covers indexed catalog, bounded graph query, overview, detail, and client-side layout preparation with a ${formatInteger(artifact.manager.nodeBudget)}-node / ${formatInteger(artifact.manager.edgeBudget)}-edge evidence budget and snapshot binding. Real Manager query controls exercise the GraphWorkspace request gate: superseding aborts an in-flight request, and a completed late response is rejected before it can update the UI.`
        : 'Manager reads bounded snapshots and rejects stale responses. Its current architecture is covered here without turning a development observation into a browser-rendering SLA.',
      detail: artifact
        ? `Query p95 ${formatDuration(artifact.manager.queryP95Milliseconds)} · max payload ${formatBytes(artifact.manager.queryMaxPayloadBytes)}`
        : 'Bounded payloads · cancellable requests',
    },
    {
      label: 'Graph MCP',
      title: 'Concise evidence for the agent',
      body: 'Graph responses stay deliberately bounded so a large repository cannot flood an agent context. Stable IDs support precise node, neighbor, path, and impact follow-ups.',
      detail: 'Small result · explicit drill-down',
    },
    {
      label: 'Memory MCP',
      title: 'Canonical memory reads stay retrievable',
      body: 'Recall returns ranked pointers. Bounded memory pages preserve canonical content and provide explicit continuation until the selected record is complete.',
      detail: 'Ranked recall · bounded continuation',
    },
  ] as const;
}

const retainedProofGroups = [
  {
    label: 'Exact provenance',
    body: 'The complete harness artifact binds its bytes, exact source and public-repository commits, the measured local-source ApplicationLayer, and a separately validated—but not executed—managed payload, plus hardware, Bun, SQLite, and disk details.',
  },
  {
    label: 'End-to-end phases',
    body: 'Cold discovery, extraction, materialization, resolution, activation, and total time; then a one-file incremental overlay with explicit registration, post-scan, and proportional-work counters plus an independent rebuild of that same overlay.',
  },
  {
    label: 'Resource high-water',
    body: 'Database footprint, resident-memory and transient-storage high-water marks, end-to-end durable filesystem growth, query latency distribution, and bounded Manager response and layout-preparation measurements.',
  },
  {
    label: 'Correctness controls',
    body: 'Java, Kotlin, TypeScript, and Bazel controls plus the clean digest and exact incremental-versus-independent-rebuild structural digest parity.',
  },
] as const;

const checkedInProofGroups = [
  {
    label: 'Pinned public scale',
    body: 'The repository name, exact clean checkout commit, graph counts, database size, runner, and measurement scopes are retained together.',
  },
  {
    label: 'Separated query cost',
    body: 'Hot indexed SQL is reported separately from exact Git observation, process startup, MCP serialization, and strict second observations.',
  },
  {
    label: 'Polyglot controls',
    body: 'Java, Kotlin, TypeScript, and Bazel / Starlark queries were exercised against the same pinned IntelliJ Community snapshot.',
  },
  {
    label: 'Focused parity checks',
    body: 'The separate 100k-symbol lexical run retains canonical, posting-count, and query parity while measuring write time and storage.',
  },
] as const;

type EvidenceCard = Readonly<{label: string; value: string; detail: string}>;

function scaleCards(artifact: RetainedPerformanceArtifact | undefined): readonly EvidenceCard[] {
  if (!artifact) {
    return [
      {
        label: 'Indexed files',
        value: formatInteger(checkedInPerformanceEvidence.scale.indexedFiles),
        detail: 'Pinned public IntelliJ checkout',
      },
      {
        label: 'Symbols',
        value: formatInteger(checkedInPerformanceEvidence.scale.symbols),
        detail: 'Searchable declarations and structural nodes',
      },
      {
        label: 'Relationships',
        value: formatInteger(checkedInPerformanceEvidence.scale.relationships),
        detail: 'Provenance-bearing graph edges',
      },
      {
        label: 'Graph database',
        value: formatBytes(checkedInPerformanceEvidence.scale.databaseBytes),
        detail: 'Observed SQLite footprint',
      },
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
      detail: `${formatInteger(artifact.graph.referenceCandidates)} reference candidates`,
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
      {
        label: 'Approx. hot SQL work',
        value: formatDuration(checkedInPerformanceEvidence.query.hotSearchAndAdjacencyMilliseconds),
        detail: 'Separately sampled indexed search + adjacency SQL, summed',
      },
      {
        label: 'Exact-current query',
        value: formatDuration(checkedInPerformanceEvidence.query.exactCurrentCliMilliseconds),
        detail: 'CLI including Git observation + startup',
      },
      {
        label: 'Whole-graph summary',
        value: `${checkedInPerformanceEvidence.analysis.persistedSummaryMinimumMilliseconds}–${checkedInPerformanceEvidence.analysis.persistedSummaryMaximumMilliseconds} ms`,
        detail: 'Persisted analysis read',
      },
      {
        label: 'Lexical index build',
        value: `${checkedInPerformanceEvidence.lexicalStorage.writeSpeedup.toFixed(1)}× faster`,
        detail: '100k-symbol write phase vs previous index format · identical results',
      },
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
      detail:
        `Registration ${formatDuration(artifact.phases.incremental.registrationMilliseconds)} · ` +
        `post-scan ${formatDuration(artifact.phases.incremental.postCommittedScanMilliseconds)}`,
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
      <aside className="performance-run-card performance-run-card--observed">
        <header>
          <div>
            <span className="status-dot" />
            <strong>Checked-in engineering evidence</strong>
          </div>
          <small>{checkedInPerformanceEvidence.measuredAt.slice(0, 10)}</small>
        </header>
        <a
          href={checkedInPerformanceEvidence.source.repositoryCommitUrl}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open the pinned ${checkedInPerformanceEvidence.source.repository} repository commit on GitHub`}
        >
          <span>Pinned public repository</span>
          <strong>{checkedInPerformanceEvidence.source.repository}</strong>
          <code>{checkedInPerformanceEvidence.source.repositoryCommit.slice(0, 16)}…</code>
        </a>
        <dl>
          <div>
            <dt>Threadnote source</dt>
            <dd>{checkedInPerformanceEvidence.source.threadnoteCommit.slice(0, 12)}</dd>
          </div>
          <div>
            <dt>Public repository</dt>
            <dd>{checkedInPerformanceEvidence.source.repositoryCommit.slice(0, 12)}</dd>
          </div>
          <div>
            <dt>Runner</dt>
            <dd>{checkedInPerformanceEvidence.source.runner}</dd>
          </div>
        </dl>
        <p>
          Review the checked-in, privacy-reviewed{' '}
          <a href={checkedInPerformanceEvidence.artifacts.query} target="_blank" rel="noreferrer">
            query evidence
          </a>
          ,{' '}
          <a href={checkedInPerformanceEvidence.artifacts.analysis} target="_blank" rel="noreferrer">
            analysis evidence
          </a>{' '}
          and{' '}
          <a href={checkedInPerformanceEvidence.artifacts.lexicalStorage} target="_blank" rel="noreferrer">
            lexical-storage evidence
          </a>
          .
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
        {artifact.runner.database.version} · {artifact.runner.runtime.target} ·{' '}
        {formatBytes(artifact.runner.memoryBytes)} memory
      </p>
    </aside>
  );
}

export default function PerformancePage() {
  setDocumentMeta(
    'Performance',
    'Threadnote 4 large-repository architecture and retained benchmark evidence for polyglot, Bazel, and fast concurrent-worktree codebases.',
  );

  const artifact = performanceEvidence.state === 'verified' ? performanceEvidence.artifact : undefined;
  const metrics = scaleCards(artifact);
  const phases = phaseCards(artifact);
  const objectives = artifact ? retainedPerformanceObjectiveResults(artifact) : [];
  const passedObjectiveCount = objectives.filter(objective => objective.passed).length;
  const surfaces = surfaceCards(artifact);
  const proofGroups = artifact ? retainedProofGroups : checkedInProofGroups;

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
              Inspect measured evidence
              <Icon name="arrow" aria-hidden="true" />
            </a>
            <a className="button button--ghost" href={docsArticleHref('graph-monorepos')}>
              Large-repository docs
            </a>
            <a className="button button--ghost" href={siteHref('performance/graphify/')}>
              Compare with Graphify
            </a>
          </div>
        </div>
        <ProvenanceCard artifact={artifact} />
      </section>

      <section className="performance-scale" id="evidence" aria-label="Retained benchmark scale">
        {metrics.map(metric => (
          <article key={metric.label}>
            <span>{metric.label}</span>
            <strong>{metric.value}</strong>
            <small>{metric.detail}</small>
          </article>
        ))}
      </section>

      <section className="performance-section performance-proof">
        <header className="section-heading section-heading--split">
          <div>
            <span className="eyebrow">Measured with named scope</span>
            <h2>Public evidence, honest boundaries.</h2>
          </div>
          <p>
            The large-repository measurements come from one pinned IntelliJ Community snapshot. Focused optimization
            measurements use separate checked-in artifacts and are labeled by scope instead of being presented as one
            universal end-to-end run.
          </p>
        </header>

        <div className="performance-proof-grid">
          {proofGroups.map(group => (
            <article key={group.label}>
              <span className={artifact ? 'performance-check performance-check--passed' : 'performance-check'} />
              <small>{artifact ? 'verified release run' : 'checked-in observation'}</small>
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
              const checkedInControl = checkedInPerformanceEvidence.controls[language];
              return (
                <article key={language}>
                  <span>{language === 'bazel' ? 'Bazel / Starlark' : language}</span>
                  <strong>{formatDuration(control?.milliseconds ?? checkedInControl.milliseconds)}</strong>
                  <small>{control?.path ?? `Public IntelliJ MCP query · ${checkedInControl.query}`}</small>
                </article>
              );
            })}
          </div>
        </div>

        <div className="performance-phase-panel">
          <header>
            <span className="eyebrow">Measured execution paths</span>
            <p>
              Every timing has one named scope. Hot SQLite work, exact Git observation, process startup, and browser
              rendering are not blended into a more flattering number.
            </p>
          </header>
          <div>
            {phases.map(phase => (
              <article key={phase.label}>
                <span>{phase.label}</span>
                <strong>{phase.value}</strong>
                <small>{phase.detail}</small>
              </article>
            ))}
          </div>
        </div>

        {artifact ? (
          <div className="performance-phase-panel">
            <header>
              <span className="eyebrow">Release engineering targets</span>
              <p>
                {passedObjectiveCount} of {objectives.length} targets passed on this exact pinned run. Open targets stay
                visible; they do not invalidate complete, correct evidence.
              </p>
            </header>
            <div>
              {objectives.map(objective => (
                <article key={objective.measurement}>
                  <span>{objective.label}</span>
                  <strong>{objective.passed ? 'Passed' : 'Open'}</strong>
                  <small>
                    {formatDuration(objective.observedMilliseconds)} observed · target under{' '}
                    {formatDuration(objective.targetMilliseconds)}
                  </small>
                </article>
              ))}
            </div>
          </div>
        ) : null}
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
            One pinned public repository on one reviewed runner shows the observed cold, one-file incremental,
            independent-rebuild, query, and Manager paths working at that shape. It does not promise identical times for
            every repository, disk, operating system, or machine.
          </p>
          {artifact ? (
            <>
              <p>
                The release-run adapter verified all {retainedPerformanceArtifactFieldPaths.length} retained fields and
                fails closed on malformed, mixed, or source-mismatched evidence. The public artifact is bound to its
                exact bytes, Threadnote source, {artifact.source.threadnote.version} release commit, and pinned IntelliJ
                commit.
              </p>
              <p>
                The retained IntelliJ run covers {formatInteger(artifact.inventory.indexedFiles)} indexed files,{' '}
                {formatInteger(artifact.graph.symbols)} symbols, {formatInteger(artifact.graph.relationships)}{' '}
                relationships, and Java, Kotlin, TypeScript, and Bazel controls. Its one-file overlay matches the
                independent rebuild's structural digest exactly.
              </p>
              <p>
                This exact release run met {passedObjectiveCount} of {objectives.length} stated engineering targets.
                Targets that remain open are shown beside their observed measurements instead of being hidden or
                promoted into a universal latency promise.
              </p>
              <p>
                For that {formatInteger(artifact.phases.incremental.changedFiles)}-file overlay, the harness recorded:{' '}
                {formatInteger(artifact.phases.incremental.inventoryFilesInspected)} inventory files inspected;{' '}
                {formatInteger(artifact.phases.incremental.baseFactsLoaded)} base facts loaded;{' '}
                {formatInteger(artifact.phases.incremental.attributionContextFiles)} attribution-context files; and{' '}
                {formatInteger(artifact.phases.incremental.probedDependencyPaths)} dependency-path probes against{' '}
                {formatInteger(artifact.phases.incremental.totalFiles)} total files. It planned{' '}
                {formatInteger(artifact.phases.incremental.plannedRows)} rows from{' '}
                {formatBytes(artifact.phases.incremental.sourceBytes)} of source and{' '}
                {formatBytes(artifact.phases.incremental.factBytes)} of facts, with{' '}
                {formatInteger(artifact.phases.incremental.deletedFiles)} deleted files. These counters distinguish
                bounded changed/fanout work from a repository-wide scan.
              </p>
            </>
          ) : (
            <>
              <p>
                A comprehensive release-run adapter still requires {retainedPerformanceArtifactFieldPaths.length}{' '}
                retained fields and fails closed on malformed or mixed evidence. Until that artifact is available, this
                page shows narrower checked-in engineering measurements with their exact scope instead of empty cards.
              </p>
              <p>
                The checked-in IntelliJ observation covers{' '}
                {formatInteger(checkedInPerformanceEvidence.scale.indexedFiles)} files and polyglot Java, Kotlin,
                TypeScript, and Bazel controls.
              </p>
            </>
          )}
          <p>
            The separate 100k-symbol lexical artifact records{' '}
            {checkedInPerformanceEvidence.lexicalStorage.storageReductionPercent.toFixed(1)}% less allocated storage
            than Threadnote's previous lexical index format, with canonical, query, and posting-count parity.
          </p>
          <p>
            Threadnote 4.1 also gates large-worktree safety with separate production-shape, parser-heavy-tail,
            interruption, concurrency, and low-disk evidence. Those retained runs validate bounded behavior and recovery
            on their stated runner; they are never merged into a universal latency percentile or a promise that every
            repository has the same wall time.
          </p>
        </div>
      </section>

      <section className="content-section content-section--cta">
        <div className="cta-panel cta-panel--compact">
          <span className="eyebrow">Built for agents</span>
          <h2>Your agents will love it—even when the repository is enormous.</h2>
          <p>Give them precise current-source evidence without filling their context with the machinery behind it.</p>
          <div className="cta-panel__actions">
            <a className="button" href={docsArticleHref('installation')}>
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
