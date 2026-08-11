import {useEffect} from 'react';
import releases from 'virtual:threadnote-release-notes';
import {Icon} from '../components/Icons';
import {SiteShell} from '../components/SiteShell';
import {docsArticleHref, setDocumentMeta} from '../lib/site';

const releaseDate = new Intl.DateTimeFormat('en', {
  day: 'numeric',
  month: 'long',
  timeZone: 'UTC',
  year: 'numeric',
});

function displayVersion(version: string): string {
  return version.replace(/^v/, '');
}

function ReleaseMeta({publishedAt, version}: {readonly publishedAt: string; readonly version: string}) {
  return (
    <div className="release-meta">
      <span>Release</span>
      <strong>{version}</strong>
      <time dateTime={publishedAt}>{releaseDate.format(new Date(publishedAt))}</time>
    </div>
  );
}

export default function WhatsNewPage() {
  const latest = releases[0]!;
  const earlier = releases.slice(1);

  useEffect(() => {
    setDocumentMeta(
      "What's new",
      `The latest Threadnote ${latest.major} releases, improvements, and upgrade highlights.`,
    );
  }, [latest.major]);

  return (
    <SiteShell page="whats-new" fullBleed>
      <section className="release-hero" aria-labelledby="latest-release-title">
        <div className="release-hero__intro">
          <ReleaseMeta publishedAt={latest.publishedAt} version={latest.version} />
          <span className="eyebrow">What&apos;s new in Threadnote {latest.major}</span>
          <h1 id="latest-release-title">
            Threadnote {displayVersion(latest.version)} <span>is here.</span>
          </h1>
          <p>{latest.summary}</p>
          <div className="release-hero__actions">
            <a className="button" href={latest.releaseUrl} target="_blank" rel="noreferrer">
              Read the full release notes
              <Icon name="arrow" aria-hidden="true" />
            </a>
            <a className="button button--ghost" href={docsArticleHref('installation')}>
              Install or update
            </a>
          </div>
        </div>

        <div className="release-hero__highlights" aria-label={`${latest.version} highlights`}>
          <div className="release-hero__index">
            <span>Latest stable</span>
            <strong>{String(latest.major).padStart(2, '0')}</strong>
          </div>
          <ol>
            {latest.highlights.slice(0, 4).map((highlight, index) => (
              <li key={highlight}>
                <span>{String(index + 1).padStart(2, '0')}</span>
                <strong>{highlight}</strong>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="release-archive" aria-labelledby="release-archive-title">
        <header className="release-archive__heading">
          <div>
            <span className="eyebrow">Release archive</span>
            <h2 id="release-archive-title">Earlier in Threadnote {latest.major}.</h2>
          </div>
          <p>
            {releases.length} stable releases in the current major line, ordered newest first. Prereleases and older
            major versions stay out of this view.
          </p>
        </header>

        <div className="release-grid">
          {earlier.map((release, index) => (
            <article className="release-card" key={release.version}>
              <ReleaseMeta publishedAt={release.publishedAt} version={release.version} />
              <div className="release-card__number" aria-hidden="true">
                {String(index + 2).padStart(2, '0')}
              </div>
              <h3>Threadnote {displayVersion(release.version)}</h3>
              <p>{release.summary}</p>
              {release.highlights.length > 0 ? (
                <ul>
                  {release.highlights.slice(0, 3).map(highlight => (
                    <li key={highlight}>{highlight}</li>
                  ))}
                </ul>
              ) : null}
              <a className="text-link" href={release.releaseUrl} target="_blank" rel="noreferrer">
                View release notes
                <Icon name="arrow" aria-hidden="true" />
              </a>
            </article>
          ))}
        </div>
      </section>
    </SiteShell>
  );
}
