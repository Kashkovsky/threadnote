export const sitePagePaths = {
  home: '',
  performance: 'performance',
  docs: 'docs',
  'pro-tips': 'pro-tips',
  'manager-demo': 'manager-demo',
  faq: 'faq',
} as const;

export type SitePage = keyof typeof sitePagePaths;

export interface SitePageModuleCache<T> {
  readonly load: (page: SitePage) => Promise<T>;
  readonly prefetch: (page: SitePage) => Promise<void>;
}

const pagesByPath = new Map<string, SitePage>(
  Object.entries(sitePagePaths).map(([page, path]) => [path, page as SitePage]),
);

function normalizedBasePath(basePath: string): string {
  const withLeadingSlash = basePath.startsWith('/') ? basePath : `/${basePath}`;
  return withLeadingSlash.endsWith('/') ? withLeadingSlash : `${withLeadingSlash}/`;
}

export function sitePageForPathname(pathname: string, basePath: string): SitePage | undefined {
  const base = normalizedBasePath(basePath);
  const baseWithoutTrailingSlash = base === '/' ? '' : base.slice(0, -1);
  let relativePath: string;

  if (pathname === baseWithoutTrailingSlash || pathname === base) {
    relativePath = '';
  } else if (pathname.startsWith(base)) {
    relativePath = pathname.slice(base.length).replace(/\/+$/, '');
  } else {
    return undefined;
  }

  return pagesByPath.get(relativePath);
}

export function siteCanonicalUrlForPathname(pathname: string, basePath: string): string {
  const page = sitePageForPathname(pathname, basePath) ?? 'home';
  const route = sitePagePaths[page];
  return new URL(route ? `${route}/` : '', 'https://threadnote.io/').href;
}

export function isSameDocumentNavigation(current: URL, target: URL): boolean {
  return current.origin === target.origin && current.pathname === target.pathname && current.search === target.search;
}

export function createSitePageModuleCache<T>(
  loaders: Readonly<Record<SitePage, () => Promise<T>>>,
): SitePageModuleCache<T> {
  const cache = new Map<SitePage, Promise<T>>();

  const load = (page: SitePage): Promise<T> => {
    const cached = cache.get(page);
    if (cached) return cached;
    const pending = loaders[page]();
    cache.set(page, pending);
    void pending.catch(() => {
      if (cache.get(page) === pending) cache.delete(page);
    });
    return pending;
  };

  return {
    load,
    async prefetch(page) {
      try {
        await load(page);
      } catch {
        // A navigation can retry a transient chunk failure.
      }
    },
  };
}

export async function commitPreparedRoute<T>(
  load: () => Promise<T>,
  isCurrent: () => boolean,
  commit: (prepared: T) => void,
): Promise<boolean> {
  const prepared = await load();
  if (!isCurrent()) return false;
  commit(prepared);
  return true;
}
