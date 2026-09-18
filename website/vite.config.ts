import react from '@vitejs/plugin-react';
import {defineConfig, type Plugin} from 'vite';
import {loadWebsiteArticles} from '../scripts/site-articles.ts';
import {
  loadRetainedPerformanceEvidence,
  performanceArtifactRelativePath,
} from '../scripts/site-performance-evidence.ts';
import {loadLatestMajorWebsiteReleases} from '../scripts/site-release-notes.ts';

const repositoryRoot = process.cwd();
const siteRoot = `${repositoryRoot}/website`;
const siteBase = process.env.THREADNOTE_SITE_BASE ?? '/';
const virtualEvidenceId = 'virtual:threadnote-performance-evidence';
const resolvedVirtualEvidenceId = `\0${virtualEvidenceId}`;
const virtualReleaseNotesId = 'virtual:threadnote-release-notes';
const resolvedVirtualReleaseNotesId = `\0${virtualReleaseNotesId}`;
const virtualLatestReleaseId = 'virtual:threadnote-latest-release';
const resolvedVirtualLatestReleaseId = `\0${virtualLatestReleaseId}`;
const virtualArticlesId = 'virtual:threadnote-articles';
const resolvedVirtualArticlesId = `\0${virtualArticlesId}`;
let cachedWebsiteReleases: ReturnType<typeof loadLatestMajorWebsiteReleases> | undefined;

const performanceEvidencePlugin: Plugin = {
  name: 'threadnote-performance-evidence',
  resolveId(id: string) {
    return id === virtualEvidenceId ? resolvedVirtualEvidenceId : undefined;
  },
  async load(id: string) {
    if (id !== resolvedVirtualEvidenceId) return undefined;
    const evidence = await loadRetainedPerformanceEvidence(repositoryRoot, siteBase);
    return `export default ${JSON.stringify(evidence)};`;
  },
  async generateBundle() {
    const evidence = await loadRetainedPerformanceEvidence(repositoryRoot, siteBase);
    if (evidence.state !== 'verified') return;
    const source = await Bun.file(`${repositoryRoot}/${performanceArtifactRelativePath}`).text();
    this.emitFile({
      fileName: `performance-evidence.${evidence.artifact.artifact.sha256}.json`,
      source,
      type: 'asset',
    });
  },
};

const releaseNotesPlugin: Plugin = {
  name: 'threadnote-release-notes',
  resolveId(id: string) {
    if (id === virtualReleaseNotesId) return resolvedVirtualReleaseNotesId;
    if (id === virtualLatestReleaseId) return resolvedVirtualLatestReleaseId;
    return undefined;
  },
  load(id: string) {
    if (id !== resolvedVirtualReleaseNotesId && id !== resolvedVirtualLatestReleaseId) return undefined;
    const releases = cachedWebsiteReleases ?? (cachedWebsiteReleases = loadLatestMajorWebsiteReleases(repositoryRoot));
    if (id === resolvedVirtualReleaseNotesId) return `export default ${JSON.stringify(releases)};`;
    if (id === resolvedVirtualLatestReleaseId) {
      const latest = releases[0];
      const banner = latest === undefined ? undefined : {headline: latest.headline, version: latest.version};
      return `export default ${JSON.stringify(banner)};`;
    }
    return undefined;
  },
};

const articlesPlugin: Plugin = {
  name: 'threadnote-articles',
  resolveId(id: string) {
    return id === virtualArticlesId ? resolvedVirtualArticlesId : undefined;
  },
  async load(id: string) {
    if (id !== resolvedVirtualArticlesId) return undefined;
    const articles = await loadWebsiteArticles(repositoryRoot);
    return `export default ${JSON.stringify(articles)};`;
  },
};

export default defineConfig({
  root: siteRoot,
  base: siteBase,
  plugins: [react(), performanceEvidencePlugin, releaseNotesPlugin, articlesPlugin],
  build: {
    outDir: `${siteRoot}/../site-dist`,
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      input: {
        home: `${siteRoot}/index.html`,
        performance: `${siteRoot}/performance/index.html`,
        performanceGraphify: `${siteRoot}/performance/graphify/index.html`,
        docs: `${siteRoot}/docs/index.html`,
        agents: `${siteRoot}/agents/index.html`,
        whatsNew: `${siteRoot}/whats-new/index.html`,
        proTips: `${siteRoot}/pro-tips/index.html`,
        managerDemo: `${siteRoot}/manager-demo/index.html`,
        faq: `${siteRoot}/faq/index.html`,
      },
    },
  },
});
