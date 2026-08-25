import {Icon} from '../components/Icons';
import {SiteShell} from '../components/SiteShell';
import {
  graphifyReviewedSource,
  graphifySharedCapabilities,
  graphifyVerifiedDifferences,
} from '../content/graphifyComparison';
import {performanceEvidence} from '../content/performanceEvidence';
import {docsArticleHref, setDocumentMeta, siteHref} from '../lib/site';

const integerFormatter = new Intl.NumberFormat('en-US');

function formatInteger(value: number): string {
  return integerFormatter.format(value);
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds.toFixed(1)} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(3)} s`;
  const minutes = Math.floor(milliseconds / 60_000);
  return `${minutes}m ${((milliseconds % 60_000) / 1_000).toFixed(3)}s`;
}

export default function GraphifyPerformancePage() {
  setDocumentMeta(
    'Threadnote and Graphify',
    'A source-reviewed Threadnote and Graphify comparison with shared graph capabilities, verified workflow differences, and separately labeled performance evidence.',
  );

  const artifact = performanceEvidence.state === 'verified' ? performanceEvidence.artifact : undefined;

  return (
    <SiteShell page="performance-graphify" fullBleed>
      <section className="subpage-hero comparison-hero">
        <div>
          <span className="eyebrow">Performance / Graphify</span>
          <h1>Compare the evidence boundary, not the feature count.</h1>
          <p>
            Threadnote and Graphify overlap substantially in graph analysis. This page starts with that parity, then
            separates only source-verified architecture, workflow, semantic, and scale differences.
          </p>
        </div>
        <div className="subpage-hero__metric">
          <strong>{graphifyReviewedSource.version}</strong>
          <span>Graphify source reviewed</span>
          <small>Exact commit {graphifyReviewedSource.commit.slice(0, 12)} · 25 August 2026</small>
        </div>
      </section>

      <section className="comparison-section comparison-parity" id="shared-capabilities">
        <header className="section-heading section-heading--split">
          <div>
            <span className="eyebrow">Shared capabilities</span>
            <h2>These are parity, not reasons to choose one.</h2>
          </div>
          <p>
            Similar labels do not imply identical files or algorithms. They do mean that neither product should be
            presented as uniquely offering the following graph-analysis workflows.
          </p>
        </header>
        <div className="performance-proof-grid">
          {graphifySharedCapabilities.map(capability => (
            <article key={capability.title}>
              <span className="performance-check performance-check--passed" />
              <small>available in both</small>
              <h3>{capability.title}</h3>
              <p>{capability.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="comparison-section" id="verified-differences">
        <header className="section-heading section-heading--split">
          <div>
            <span className="eyebrow">Verified differences</span>
            <h2>The systems optimize for different continuity boundaries.</h2>
          </div>
          <p>
            Threadnote is an engineering-context runtime around a current, worktree-aware graph. Graphify is a project
            graph suite with a wider optional semantic and downstream-target surface. Both can be useful together.
          </p>
        </header>

        <div className="comparison-intro">
          <article className="comparison-product comparison-product--threadnote">
            <span>Threadnote 4</span>
            <h3>Current source plus memory across sessions</h3>
            <p>
              Choose Threadnote when exact repository state, bounded agent evidence, durable decisions, and team
              handoffs must stay connected as work moves between worktrees and assistants.
            </p>
          </article>
          <div className="comparison-plus" aria-hidden="true">
            <span>or</span>
            <small>often, both</small>
          </div>
          <article className="comparison-product comparison-product--graphify">
            <span>Graphify {graphifyReviewedSource.version}</span>
            <h3>Project graph plus optional semantic pipelines</h3>
            <p>
              Choose Graphify for its project-graph workflow, optional model-backed document and image semantics,
              transcription path, PR tooling, and additional generated graph destinations.
            </p>
          </article>
        </div>

        <div className="comparison-table-wrap">
          <table className="comparison-table">
            <thead>
              <tr>
                <th>Dimension</th>
                <th>Threadnote 4</th>
                <th>Graphify {graphifyReviewedSource.version}</th>
              </tr>
            </thead>
            <tbody>
              {graphifyVerifiedDifferences.map(row => (
                <tr key={row.dimension}>
                  <th>{row.dimension}</th>
                  <td>{row.threadnote}</td>
                  <td>{row.graphify}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="comparison-note">
          Graphify descriptions were reviewed against the published{' '}
          <a href={graphifyReviewedSource.sourceUrl} target="_blank" rel="noreferrer">
            {graphifyReviewedSource.version} source at {graphifyReviewedSource.commit.slice(0, 12)}
            <span aria-hidden="true"> ↗</span>
          </a>{' '}
          and its{' '}
          <a href={graphifyReviewedSource.packageUrl} target="_blank" rel="noreferrer">
            package metadata <span aria-hidden="true">↗</span>
          </a>
          . Product capabilities can evolve independently.
        </p>
      </section>

      <section className="comparison-section comparison-scale" id="scale-evidence">
        <header className="section-heading section-heading--split">
          <div>
            <span className="eyebrow">Scale evidence</span>
            <h2>One result completed. One never reached an artifact.</h2>
          </div>
          <p>
            The Graphify observation is a right-censored lower bound, not an invented eventual completion time. Its
            operator stop and absent artifact are reported as practical non-admission under the frozen run contract.
          </p>
        </header>

        <div className="comparison-intro">
          <article className="comparison-product comparison-product--threadnote">
            <span>
              {artifact ? `${artifact.source.threadnote.version} exact release` : 'Threadnote release evidence'}
            </span>
            <h3>
              {artifact
                ? `${formatDuration(artifact.phases.cold.totalMilliseconds)} cold build`
                : 'Evidence unavailable'}
            </h3>
            <p>
              {artifact ? (
                <>
                  {formatInteger(artifact.inventory.indexedFiles)} files · {formatInteger(artifact.graph.symbols)}{' '}
                  symbols · {formatInteger(artifact.graph.relationships)} relationships. One-file incremental:{' '}
                  {formatDuration(artifact.phases.incremental.totalMilliseconds)} with exact independent-rebuild parity.
                </>
              ) : (
                'The fail-closed release adapter did not expose a verified artifact for this build.'
              )}
            </p>
            {artifact ? (
              <a className="text-link" href={artifact.artifact.url} target="_blank" rel="noreferrer">
                Inspect retained Threadnote evidence <Icon name="arrow" aria-hidden="true" />
              </a>
            ) : null}
          </article>
          <div className="comparison-plus" aria-hidden="true">
            <span>vs</span>
            <small>same fixture</small>
          </div>
          <article className="comparison-product comparison-product--graphify">
            <span>Graphify {graphifyReviewedSource.version}</span>
            <h3>No graph after 5h 32m 40s</h3>
            <p>
              The guarded code-only run was operator-terminated after exceeding a five-hour developer-utility threshold.
              Per-file AST progress completed, but neither a graph nor a write-temp appeared, so no supported query
              could be exercised.
            </p>
            <a
              className="text-link"
              href={siteHref('graphify-intellij-evidence.json')}
              target="_blank"
              rel="noreferrer"
            >
              Inspect retained Graphify evidence <Icon name="arrow" aria-hidden="true" />
            </a>
          </article>
        </div>
        <p className="comparison-note">
          The fixture commit is shared; product-native storage and execution models are not forced into an artificial
          common implementation. A bounded failure is evidence too and will be reported as such.
        </p>
        <p className="comparison-note">
          The common structural stopwatch compares Threadnote lexical-only indexing with Graphify code-only extraction;
          both stay on local AST work and spend no provider tokens. Separately, Threadnote can add its installed local
          embedding model for semantic vector seeds without calling a hosted embedding service. Graphify&apos;s
          model-backed document and media paths are useful product capabilities, but they are outside this structural
          timing arm.
        </p>
        <p className="comparison-note">
          At the stop, Graphify had kept one CPU core busy after its final per-file AST progress line, with 11.8 GB
          current resident memory, a 14.8 GB process-tree peak, zero swap growth, and no sampler failures. Its 3.7 GB
          per-file AST cache survived, but no persisted checkpoint could resume the in-memory cross-file resolution and
          downstream graph construction. The <code>SIGINT</code> stack located current work in{' '}
          <code>disambiguate_ambiguous_candidates</code>, where <code>set(test_cands)</code> was rebuilt inside a
          candidate loop. That is a source-visible superlinear risk and the exact interruption point—not proof that one
          line consumed the entire silent interval.
        </p>
      </section>

      <section className="comparison-section" id="queryability-contract">
        <header className="section-heading section-heading--split">
          <div>
            <span className="eyebrow">Queryability contract</span>
            <h2>A graph file is not the finish line.</h2>
          </div>
          <p>
            The terminal comparison must show that an agent can load and query the result—not merely that extraction
            eventually wrote bytes. Construction, admission, cold hydration, and warm traversal are reported separately.
          </p>
        </header>
        <div className="performance-proof-grid">
          <article>
            <span className="performance-check" />
            <small>default admission · not reached</small>
            <h3>No graph file reached the loader</h3>
            <p>
              Construction produced neither <code>graph.json</code> nor a write-temp, so Graphify&apos;s supported
              default 512 MiB file guard had no artifact to admit or reject.
            </p>
          </article>
          <article>
            <span className="performance-check" />
            <small>cold load · not reached</small>
            <h3>No artifact could be hydrated</h3>
            <p>
              The predeclared raised-cap probe could not read, parse, or hydrate nodes and links into NetworkX because
              the construction stage never published its monolithic JSON input.
            </p>
          </article>
          <article>
            <span className="performance-check" />
            <small>warm use · not reached</small>
            <h3>No warm query process existed</h3>
            <p>
              Exact-symbol, natural structural, and affected-node controls remained unrun. Reporting them as query
              failures would be inaccurate; the graph never reached the prerequisite queryability boundary.
            </p>
          </article>
        </div>
        <p className="comparison-note">
          This result establishes practical non-admission for pinned IntelliJ Community on the tested machine and
          no-token configuration. It does not claim Graphify could never finish on another machine or with an unknown
          longer wait; it records that an agent had no usable graph after more than five ordinary work hours.
        </p>
      </section>

      <section className="content-section content-section--cta">
        <div className="cta-panel cta-panel--compact">
          <span className="eyebrow">Keep reading the evidence</span>
          <h2>Inspect Threadnote’s retained run and architecture.</h2>
          <p>The main Performance page keeps exact release measurements, methodology, and open targets together.</p>
          <div className="cta-panel__actions">
            <a className="button" href={siteHref('performance/')}>
              Performance evidence
            </a>
            <a className="button button--ghost" href={docsArticleHref('architecture')}>
              Architecture docs
            </a>
          </div>
        </div>
      </section>
    </SiteShell>
  );
}
