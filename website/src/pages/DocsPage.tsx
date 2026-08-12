import {useCallback, useDeferredValue, useEffect, useMemo, useRef, useState} from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {CodeBlock} from '../components/CodeBlock';
import {Icon} from '../components/Icons';
import {ManagerOperationsVisual} from '../components/ManagerOperationsVisual.js';
import {SiteShell} from '../components/SiteShell';
import {defaultDocId, docsSections, type DocsBlock} from '../content/docs';
import {
  createDocsSearchIndex,
  DOCS_SEARCH_MAXIMUM_LENGTH,
  normalizeDocsSearchText,
  searchDocs,
  type DocsSearchResult,
} from '../lib/docsSearch';
import {docsArticleIdForPathname} from '../lib/routes';
import {docsArticleHref, setDocumentMeta, siteHref} from '../lib/site';

const articles = docsSections.flatMap(section => section.articles.map(article => ({article, section})));
const docsSearchIndex = createDocsSearchIndex(docsSections);
const focusableSelector = [
  'a[href]',
  'button:not(:disabled)',
  'input:not(:disabled)',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function trapFocus(event: KeyboardEvent, container: HTMLElement | null): void {
  if (event.key !== 'Tab' || !container) return;
  const focusable = [...container.querySelectorAll<HTMLElement>(focusableSelector)].filter(
    element => element.getClientRects().length > 0 && element.tabIndex >= 0,
  );
  const first = focusable[0];
  const last = focusable.at(-1);
  if (!first || !last) {
    event.preventDefault();
    return;
  }
  if (!(document.activeElement instanceof Node) || !container.contains(document.activeElement)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
    return;
  }
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function HighlightedText({terms, text}: {terms: readonly string[]; text: string}) {
  const escapedTerms = terms
    .filter(term => term.length > 1)
    .sort((left, right) => right.length - left.length)
    .map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (escapedTerms.length === 0) return text;
  const matcher = new RegExp(`(${escapedTerms.join('|')})`, 'gi');
  return (
    <>
      {text
        .split(matcher)
        .map((part, index) =>
          terms.includes(normalizeDocsSearchText(part)) ? <mark key={`${part}-${index}`}>{part}</mark> : part,
        )}
    </>
  );
}

function InlineMarkdown({children}: {children: string}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({href, children: linkChildren}) => {
          const resolvedHref =
            href && !href.startsWith('/') && !href.startsWith('#') && !/^[a-z][a-z0-9+.-]*:/i.test(href)
              ? new URL(href, new URL(siteHref('docs/'), window.location.origin)).href
              : href;
          return <a href={resolvedHref}>{linkChildren}</a>;
        },
      }}
    >
      {children}
    </ReactMarkdown>
  );
}

function DocsBlockView({block}: {block: DocsBlock}) {
  switch (block.type) {
    case 'paragraph':
      return (
        <div className="docs-prose">
          <InlineMarkdown>{block.text}</InlineMarkdown>
        </div>
      );
    case 'note':
      return (
        <aside className="docs-callout docs-callout--note">
          <strong>Note</strong>
          <InlineMarkdown>{block.text}</InlineMarkdown>
        </aside>
      );
    case 'warning':
      return (
        <aside className="docs-callout docs-callout--warning">
          <strong>Watch out</strong>
          <InlineMarkdown>{block.text}</InlineMarkdown>
        </aside>
      );
    case 'heading':
      return <h2>{block.text}</h2>;
    case 'code':
      return <CodeBlock code={block.code} language={block.language} />;
    case 'list':
      return (
        <ul className="docs-list">
          {block.items.map(item => (
            <li key={item}>
              <InlineMarkdown>{item}</InlineMarkdown>
            </li>
          ))}
        </ul>
      );
    case 'table':
      return (
        <div className="docs-table-wrap">
          <table>
            <thead>
              <tr>
                {block.headers.map(header => (
                  <th key={header}>{header}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, index) => (
                <tr key={`${row[0]}-${index}`}>
                  {row.map((cell, cellIndex) => (
                    <td key={`${cell}-${cellIndex}`}>
                      <InlineMarkdown>{cell}</InlineMarkdown>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'visual':
      return <ManagerOperationsVisual kind={block.visual} />;
  }
}

function currentIdFromLocation(): string {
  const pathId = docsArticleIdForPathname(window.location.pathname, import.meta.env.BASE_URL);
  if (pathId && articles.some(({article}) => article.id === pathId)) return pathId;
  const hash = window.location.hash.replace(/^#/, '');
  return articles.some(({article}) => article.id === hash) ? hash : defaultDocId;
}

export default function DocsPage() {
  const [activeId, setActiveId] = useState(currentIdFromLocation);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [searchOpen, setSearchOpen] = useState(false);
  const [activeSearchResult, setActiveSearchResult] = useState(0);
  const [navOpen, setNavOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const searchPanelRef = useRef<HTMLDivElement>(null);
  const searchReturnFocusRef = useRef<HTMLElement | null>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const sidebarCloseRef = useRef<HTMLButtonElement>(null);
  const navReturnFocusRef = useRef<HTMLElement | null>(null);
  const browseDocsRef = useRef<HTMLButtonElement>(null);
  const articleHeadingRef = useRef<HTMLHeadingElement>(null);
  const shouldFocusArticleRef = useRef(false);
  const activeIndex = Math.max(
    0,
    articles.findIndex(({article}) => article.id === activeId),
  );
  const activeEntry = articles[activeIndex] ?? articles[0]!;

  const restoreFocus = useCallback((target: HTMLElement | null): void => {
    window.requestAnimationFrame(() => {
      if (target?.isConnected) target.focus();
    });
  }, []);

  const closeSearch = useCallback(
    (shouldRestoreFocus = true): void => {
      if (searchOpen && shouldRestoreFocus) restoreFocus(searchReturnFocusRef.current);
      setSearchOpen(false);
    },
    [restoreFocus, searchOpen],
  );

  const closeNav = useCallback(
    (shouldRestoreFocus = true): void => {
      if (navOpen && shouldRestoreFocus) restoreFocus(navReturnFocusRef.current);
      setNavOpen(false);
    },
    [navOpen, restoreFocus],
  );

  const openSearch = useCallback((): void => {
    const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const returnTarget =
      navOpen && activeElement && sidebarRef.current?.contains(activeElement) ? browseDocsRef.current : activeElement;
    closeNav(false);
    if (!searchOpen) searchReturnFocusRef.current = returnTarget;
    setSearchOpen(true);
  }, [closeNav, navOpen, searchOpen]);

  const openNav = useCallback((): void => {
    closeSearch(false);
    navReturnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : browseDocsRef.current;
    setNavOpen(true);
  }, [closeSearch]);

  useEffect(() => {
    const onLocationChange = () => setActiveId(currentIdFromLocation());
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        openSearch();
        return;
      }
      if (event.key === 'Escape') {
        if (searchOpen) {
          event.preventDefault();
          closeSearch();
        } else if (navOpen) {
          event.preventDefault();
          closeNav();
        }
        return;
      }
      if (searchOpen) trapFocus(event, searchPanelRef.current);
      else if (navOpen) trapFocus(event, sidebarRef.current);
    };
    window.addEventListener('hashchange', onLocationChange);
    window.addEventListener('popstate', onLocationChange);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('hashchange', onLocationChange);
      window.removeEventListener('popstate', onLocationChange);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [closeNav, closeSearch, navOpen, openSearch, searchOpen]);

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  useEffect(() => {
    if (navOpen) sidebarCloseRef.current?.focus();
  }, [navOpen]);

  useEffect(() => {
    const mobileBreakpoint = window.matchMedia('(max-width: 980px)');
    const reconcileNavForViewport = (matches: boolean): void => {
      if (matches) return;
      navReturnFocusRef.current = null;
      setNavOpen(false);
    };
    const onBreakpointChange = (event: MediaQueryListEvent): void => reconcileNavForViewport(event.matches);
    reconcileNavForViewport(mobileBreakpoint.matches);
    mobileBreakpoint.addEventListener('change', onBreakpointChange);
    return () => mobileBreakpoint.removeEventListener('change', onBreakpointChange);
  }, []);

  useEffect(() => {
    if (!searchOpen && !navOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [navOpen, searchOpen]);

  useEffect(() => {
    const pathId = docsArticleIdForPathname(window.location.pathname, import.meta.env.BASE_URL);
    const hashId = window.location.hash.replace(/^#/, '');
    if (!pathId && hashId === activeEntry.article.id) {
      window.history.replaceState({}, '', docsArticleHref(activeEntry.article.id));
    }
    setDocumentMeta(`${activeEntry.article.title} · Docs`, activeEntry.article.summary);
    window.scrollTo({top: 0, behavior: 'instant'});
    if (shouldFocusArticleRef.current) {
      shouldFocusArticleRef.current = false;
      window.requestAnimationFrame(() => articleHeadingRef.current?.focus({preventScroll: true}));
    }
  }, [activeEntry]);

  const results = useMemo(
    () => searchDocs(docsSearchIndex, deferredQuery, deferredQuery.trim() ? 12 : 8),
    [deferredQuery],
  );
  const selectedSearchResultIndex = Math.min(activeSearchResult, Math.max(0, results.length - 1));

  useEffect(() => {
    if (activeSearchResult < results.length) return;
    setActiveSearchResult(Math.max(0, results.length - 1));
  }, [activeSearchResult, results.length]);

  const moveSearchSelection = useCallback(
    (direction: -1 | 1): void => {
      if (results.length === 0) return;
      setActiveSearchResult(current => {
        const boundedCurrent = Math.min(current, results.length - 1);
        const next = (boundedCurrent + direction + results.length) % results.length;
        window.requestAnimationFrame(() =>
          document.getElementById(`docs-search-result-${next}`)?.scrollIntoView({block: 'nearest'}),
        );
        return next;
      });
    },
    [results.length],
  );

  const navigate = (id: string) => {
    shouldFocusArticleRef.current = true;
    const href = docsArticleHref(id);
    if (window.location.href !== new URL(href, window.location.href).href) {
      window.history.pushState({}, '', href);
    }
    setActiveId(id);
    closeNav(false);
    closeSearch(false);
    setQuery('');
    if (id === activeId) {
      shouldFocusArticleRef.current = false;
      window.requestAnimationFrame(() => articleHeadingRef.current?.focus({preventScroll: true}));
    }
  };

  const previous = articles[activeIndex - 1];
  const next = articles[activeIndex + 1];

  return (
    <SiteShell page="docs" fullBleed>
      <div className="docs-shell">
        <aside className={`docs-sidebar${navOpen ? ' docs-sidebar--open' : ''}`} id="docs-sidebar" ref={sidebarRef}>
          <div className="docs-sidebar__top">
            <span className="eyebrow">Threadnote 4</span>
            <strong>Documentation</strong>
            <button
              className="docs-sidebar__close"
              ref={sidebarCloseRef}
              type="button"
              aria-label="Close documentation navigation"
              onClick={() => closeNav()}
            >
              ×
            </button>
          </div>
          <button aria-haspopup="dialog" className="docs-search-button" type="button" onClick={openSearch}>
            <span>Search documentation</span>
            <kbd>⌘ K</kbd>
          </button>
          <nav aria-label="Documentation">
            {docsSections.map(section => (
              <div className="docs-nav-section" key={section.id}>
                <h2>{section.title}</h2>
                {section.articles.map(article => (
                  <a
                    key={article.id}
                    href={docsArticleHref(article.id)}
                    aria-current={activeId === article.id ? 'page' : undefined}
                    onClick={event => {
                      event.preventDefault();
                      navigate(article.id);
                    }}
                  >
                    {article.title}
                  </a>
                ))}
              </div>
            ))}
          </nav>
          <a className="docs-sidebar__github" href="https://github.com/Kashkovsky/threadnote">
            Edit or report an issue <span aria-hidden="true">↗</span>
          </a>
        </aside>

        {navOpen && (
          <button
            type="button"
            className="docs-sidebar-backdrop"
            aria-label="Close documentation navigation"
            onClick={() => closeNav()}
          />
        )}

        <article className="docs-article">
          <div className="docs-mobile-bar">
            <button
              aria-expanded={navOpen}
              aria-controls="docs-sidebar"
              ref={browseDocsRef}
              type="button"
              onClick={openNav}
            >
              Browse docs
            </button>
            <button aria-haspopup="dialog" type="button" onClick={openSearch}>
              Search
            </button>
          </div>
          <div className="docs-breadcrumbs">
            <a href={siteHref('docs/')}>Docs</a>
            <span>/</span>
            <span>{activeEntry.section.title}</span>
          </div>
          <header className="docs-article__header">
            <span className="eyebrow">{activeEntry.section.title}</span>
            <h1 ref={articleHeadingRef} tabIndex={-1}>
              {activeEntry.article.title}
            </h1>
            <p>{activeEntry.article.summary}</p>
          </header>
          <div className="docs-article__body">
            {activeEntry.article.body.map((block, index) => (
              <DocsBlockView block={block} key={`${block.type}-${'text' in block ? block.text : index}`} />
            ))}
          </div>
          <nav className="docs-pagination" aria-label="Adjacent documentation">
            {previous ? (
              <a
                href={docsArticleHref(previous.article.id)}
                onClick={event => {
                  event.preventDefault();
                  navigate(previous.article.id);
                }}
              >
                <small>Previous</small>
                <strong>← {previous.article.title}</strong>
              </a>
            ) : (
              <span />
            )}
            {next && (
              <a
                href={docsArticleHref(next.article.id)}
                onClick={event => {
                  event.preventDefault();
                  navigate(next.article.id);
                }}
              >
                <small>Next</small>
                <strong>{next.article.title} →</strong>
              </a>
            )}
          </nav>
        </article>

        <aside className="docs-outline">
          <span>On this page</span>
          <strong>{activeEntry.article.title}</strong>
          {activeEntry.article.body
            .filter((block): block is Extract<DocsBlock, {type: 'heading'}> => block.type === 'heading')
            .map(block => (
              <span key={block.text}>{block.text}</span>
            ))}
          <div className="docs-outline__help">
            <span className="status-dot" />
            <strong>Something unclear?</strong>
            <a href="https://github.com/Kashkovsky/threadnote/issues/new">Open a documentation issue</a>
          </div>
        </aside>
      </div>

      {searchOpen && (
        <div className="search-dialog" role="dialog" aria-modal="true" aria-label="Search documentation">
          <button
            className="search-dialog__backdrop"
            type="button"
            tabIndex={-1}
            aria-label="Close search"
            onClick={() => closeSearch()}
          />
          <div className="search-dialog__panel" ref={searchPanelRef}>
            <div className="search-dialog__field">
              <label className="sr-only" htmlFor="docs-search-input">
                Search documentation
              </label>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="10.5" cy="10.5" r="6.5" />
                <path d="m15.5 15.5 5 5" />
              </svg>
              <input
                ref={searchRef}
                id="docs-search-input"
                maxLength={DOCS_SEARCH_MAXIMUM_LENGTH}
                value={query}
                onChange={event => {
                  setQuery(event.target.value);
                  setActiveSearchResult(0);
                }}
                onKeyDown={event => {
                  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault();
                    moveSearchSelection(event.key === 'ArrowDown' ? 1 : -1);
                  } else if (event.key === 'Enter') {
                    const currentResults =
                      query === deferredQuery ? results : searchDocs(docsSearchIndex, query, query.trim() ? 12 : 8);
                    const currentResultIndex = Math.min(activeSearchResult, Math.max(0, currentResults.length - 1));
                    const result: DocsSearchResult | undefined = currentResults[currentResultIndex];
                    if (!result) return;
                    event.preventDefault();
                    navigate(result.article.id);
                  }
                }}
                placeholder="Search memory, graph, sharing, commands…"
                role="combobox"
                aria-autocomplete="list"
                aria-controls="docs-search-results"
                aria-expanded="true"
                aria-activedescendant={
                  results.length > 0 ? `docs-search-result-${selectedSearchResultIndex}` : undefined
                }
                aria-describedby="docs-search-help"
              />
              <button
                aria-label="Close documentation search"
                className="search-dialog__close"
                type="button"
                onClick={() => closeSearch()}
              >
                esc
              </button>
            </div>
            <div
              className="search-dialog__results"
              id="docs-search-results"
              role="listbox"
              aria-busy={query !== deferredQuery}
              aria-label="Documentation search results"
            >
              <div className="search-dialog__results-meta" aria-live="polite">
                <span>
                  {query.trim()
                    ? `${results.length} ranked result${results.length === 1 ? '' : 's'}`
                    : 'Suggested documentation'}
                </span>
                <span id="docs-search-help">↑↓ select · enter open</span>
              </div>
              {results.length ? (
                results.map((result, index) => (
                  <button
                    type="button"
                    id={`docs-search-result-${index}`}
                    key={result.article.id}
                    role="option"
                    aria-selected={index === selectedSearchResultIndex}
                    tabIndex={index === selectedSearchResultIndex ? 0 : -1}
                    onFocus={() => setActiveSearchResult(index)}
                    onMouseEnter={() => setActiveSearchResult(index)}
                    onClick={() => navigate(result.article.id)}
                  >
                    <div>
                      <small>
                        {result.section.title} · {result.matchLabel}
                      </small>
                      <strong>
                        <HighlightedText terms={result.matchedTerms} text={result.article.title} />
                      </strong>
                      <p>
                        <HighlightedText terms={result.matchedTerms} text={result.snippet} />
                      </p>
                    </div>
                    <Icon name="arrow" aria-hidden="true" />
                  </button>
                ))
              ) : (
                <div className="search-dialog__empty">
                  <strong>No matching documentation</strong>
                  <p>Try a command name, feature, or shorter phrase.</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </SiteShell>
  );
}
