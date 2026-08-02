import {useEffect, useState, type ReactNode} from 'react';
import {githubUrl, siteHref} from '../lib/site';
import {ThreadnoteMark} from './Brand';

type SitePage = 'home' | 'performance' | 'docs' | 'pro-tips' | 'manager-demo' | 'faq';

const navItems: Array<{page: SitePage; label: string; href: string}> = [
  {page: 'home', label: 'Product', href: ''},
  {page: 'performance', label: 'Performance', href: 'performance/'},
  {page: 'docs', label: 'Docs', href: 'docs/'},
  {page: 'pro-tips', label: 'Pro tips', href: 'pro-tips/'},
  {page: 'manager-demo', label: 'Manager demo', href: 'manager-demo/'},
  {page: 'faq', label: 'FAQ', href: 'faq/'},
];

export function SiteShell({
  page,
  children,
  fullBleed = false,
}: {
  page: SitePage;
  children: ReactNode;
  fullBleed?: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    setMenuOpen(false);
  }, [page]);

  useEffect(() => {
    const closeMenu = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('keydown', closeMenu);
    return () => window.removeEventListener('keydown', closeMenu);
  }, []);

  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header className="site-header">
        <div className="site-header__inner">
          <ThreadnoteMark />
          <button
            className="nav-toggle"
            type="button"
            aria-expanded={menuOpen}
            aria-controls="site-nav"
            onClick={() => setMenuOpen(current => !current)}
          >
            <span />
            <span />
            <span />
            <span className="sr-only">Toggle navigation</span>
          </button>
          <nav id="site-nav" className={`site-nav${menuOpen ? ' site-nav--open' : ''}`} aria-label="Primary navigation">
            {navItems.map(item => (
              <a key={item.page} href={siteHref(item.href)} aria-current={page === item.page ? 'page' : undefined}>
                {item.label}
              </a>
            ))}
            <a href={githubUrl} target="_blank" rel="noreferrer">
              GitHub
              <span aria-hidden="true"> ↗</span>
            </a>
            <a className="button button--small" href={siteHref('docs/#installation')}>
              Install
            </a>
          </nav>
        </div>
      </header>
      <main id="main-content" className={fullBleed ? 'site-main site-main--full' : 'site-main'}>
        {children}
      </main>
      <footer className="site-footer">
        <div>
          <ThreadnoteMark />
          <p>Durable context for people and their agents.</p>
        </div>
        <div className="site-footer__links">
          <a href={siteHref('docs/')}>Documentation</a>
          <a href={siteHref('performance/')}>Performance</a>
          <a href={siteHref('pro-tips/')}>Pro tips</a>
          <a href={siteHref('faq/')}>FAQ</a>
          <a href={siteHref('font-licenses.txt')}>Font licenses</a>
          <a href={githubUrl}>Source</a>
          <a href={`${githubUrl}/issues`}>Issues</a>
        </div>
        <p className="site-footer__meta">
          © Denys Kashkovskyi 2026 · AGPL-3.0 · Local-first · Built for the long thread
        </p>
      </footer>
    </>
  );
}
