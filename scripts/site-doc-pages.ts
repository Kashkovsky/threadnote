import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {docsSections, type DocsArticle} from '../website/src/content/docs.js';
import {docsArticlePath} from '../website/src/lib/routes.js';

const publicOrigin = 'https://threadnote.io/';
const generatedSitemapStart = '  <!-- BEGIN GENERATED DOCS ARTICLES -->';
const generatedSitemapEnd = '  <!-- END GENERATED DOCS ARTICLES -->';

export const docsArticles: readonly DocsArticle[] = docsSections.flatMap(section => section.articles);

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceTagAttribute(
  html: string,
  tagName: string,
  identifyingAttribute: string,
  identifyingValue: string,
  updatedAttribute: string,
  updatedValue: string,
): string {
  const tagPattern = new RegExp(
    `<${tagName}\\b[^>]*\\b${escapeRegExp(identifyingAttribute)}="${escapeRegExp(identifyingValue)}"[^>]*>`,
    'i',
  );
  const tag = html.match(tagPattern)?.[0];
  if (!tag) throw new Error(`Docs HTML template is missing ${tagName}[${identifyingAttribute}="${identifyingValue}"]`);

  const attributePattern = new RegExp(`\\b${escapeRegExp(updatedAttribute)}="[^"]*"`, 'i');
  if (!attributePattern.test(tag)) {
    throw new Error(
      `Docs HTML template ${tagName}[${identifyingAttribute}="${identifyingValue}"] is missing ${updatedAttribute}`,
    );
  }
  const updatedTag = tag.replace(attributePattern, `${updatedAttribute}="${escapeHtml(updatedValue)}"`);
  return html.replace(tagPattern, updatedTag);
}

export function renderDocsArticleHtml(
  template: string,
  article: Pick<DocsArticle, 'id' | 'summary' | 'title'>,
): string {
  const canonicalUrl = new URL(docsArticlePath(article.id), publicOrigin).href;
  const pageTitle = `${article.title} · Docs — Threadnote`;
  let html = template;
  html = replaceTagAttribute(html, 'meta', 'name', 'description', 'content', article.summary);
  html = replaceTagAttribute(html, 'link', 'rel', 'canonical', 'href', canonicalUrl);
  html = replaceTagAttribute(html, 'link', 'rel', 'icon', 'href', '../../threadnote-logo.svg');
  html = replaceTagAttribute(html, 'meta', 'property', 'og:title', 'content', pageTitle);
  html = replaceTagAttribute(html, 'meta', 'property', 'og:description', 'content', article.summary);
  html = replaceTagAttribute(html, 'meta', 'property', 'og:type', 'content', 'article');
  html = replaceTagAttribute(html, 'meta', 'property', 'og:url', 'content', canonicalUrl);
  html = replaceTagAttribute(html, 'meta', 'name', 'twitter:title', 'content', pageTitle);
  html = replaceTagAttribute(html, 'meta', 'name', 'twitter:description', 'content', article.summary);
  if (!/<title>[^<]*<\/title>/i.test(html)) throw new Error('Docs HTML template is missing its title');
  return html.replace(/<title>[^<]*<\/title>/i, `<title>${escapeHtml(pageTitle)}</title>`);
}

export function renderDocsSitemap(sitemap: string, articles: readonly Pick<DocsArticle, 'id'>[]): string {
  const generated = [
    generatedSitemapStart,
    ...articles.map(article => `  <url><loc>${new URL(docsArticlePath(article.id), publicOrigin).href}</loc></url>`),
    generatedSitemapEnd,
  ].join('\n');
  const generatedPattern = new RegExp(
    `${escapeRegExp(generatedSitemapStart)}[\\s\\S]*?${escapeRegExp(generatedSitemapEnd)}`,
  );
  if (generatedPattern.test(sitemap)) return sitemap.replace(generatedPattern, generated);
  if (!sitemap.includes('</urlset>')) throw new Error('Website sitemap is missing </urlset>');
  return sitemap.replace('</urlset>', `${generated}\n</urlset>`);
}

export async function generateDocsArticlePages(siteDist = join(process.cwd(), 'site-dist')): Promise<number> {
  const templatePath = join(siteDist, 'docs', 'index.html');
  const [template, sitemap] = await Promise.all([
    readFile(templatePath, 'utf8'),
    readFile(join(siteDist, 'sitemap.xml'), 'utf8'),
  ]);
  const articleIds = new Set<string>();

  await Promise.all(
    docsArticles.map(async article => {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(article.id)) {
        throw new Error(`Docs article id is not a URL-safe slug: ${article.id}`);
      }
      if (articleIds.has(article.id)) throw new Error(`Duplicate docs article id: ${article.id}`);
      articleIds.add(article.id);
      const outputPath = join(siteDist, docsArticlePath(article.id), 'index.html');
      await mkdir(dirname(outputPath), {recursive: true});
      await writeFile(outputPath, renderDocsArticleHtml(template, article));
    }),
  );

  await writeFile(join(siteDist, 'sitemap.xml'), renderDocsSitemap(sitemap, docsArticles));
  return docsArticles.length;
}

if (import.meta.main) {
  const generatedCount = await generateDocsArticlePages();
  process.stdout.write(`Generated ${generatedCount} crawler-visible documentation pages.\n`);
}
