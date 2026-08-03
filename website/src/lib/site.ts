import {siteCanonicalUrlForPathname} from './routes.js';

const base = import.meta.env.BASE_URL;

export function siteHref(path = ''): string {
  const normalized = path.replace(/^\/+/, '');
  return `${base}${normalized}`;
}

export const githubUrl = 'https://github.com/Kashkovsky/threadnote';

export function setDocumentMeta(title: string, description: string): void {
  const pageTitle = `${title} — Threadnote`;
  const canonicalUrl = siteCanonicalUrlForPathname(window.location.pathname, base);
  document.title = pageTitle;
  const descriptionElement = document.querySelector<HTMLMetaElement>('meta[name="description"]');
  if (descriptionElement) {
    descriptionElement.content = description;
  }
  const canonicalElement = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (canonicalElement) canonicalElement.href = canonicalUrl;
  const openGraphUrl = document.querySelector<HTMLMetaElement>('meta[property="og:url"]');
  if (openGraphUrl) openGraphUrl.content = canonicalUrl;
  const openGraphTitle = document.querySelector<HTMLMetaElement>('meta[property="og:title"]');
  if (openGraphTitle) openGraphTitle.content = pageTitle;
  const openGraphDescription = document.querySelector<HTMLMetaElement>('meta[property="og:description"]');
  if (openGraphDescription) openGraphDescription.content = description;
  const twitterTitle = document.querySelector<HTMLMetaElement>('meta[name="twitter:title"]');
  if (twitterTitle) twitterTitle.content = pageTitle;
  const twitterDescription = document.querySelector<HTMLMetaElement>('meta[name="twitter:description"]');
  if (twitterDescription) twitterDescription.content = description;
}
