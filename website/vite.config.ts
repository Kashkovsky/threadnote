import react from '@vitejs/plugin-react';
import {defineConfig, type Plugin} from 'vite';
import {loadWebsiteArticles} from '../scripts/site-articles.ts';
import {loadRetainedPerformanceEvidence} from '../scripts/site-performance-evidence.ts';
import {loadLatestMajorWebsiteReleases} from '../scripts/site-release-notes.ts';
import {embeddingContextPerformanceArtifactPath} from './src/content/embeddingContextPerformance.ts';
import {worktreeReadinessArtifactPath} from './src/content/worktreeReadiness.ts';

const repositoryRoot = process.cwd();
const siteRoot = `${repositoryRoot}/website`;
const siteBase = process.env.THREADNOTE_SITE_BASE ?? '/';
const virtualEvidenceId = 'virtual:threadnote-performance-evidence';
const resolvedVirtualEvidenceId = `\0${virtualEvidenceId}`;
const virtualReleaseNotesId = 'virtual:threadnote-release-notes';
const resolvedVirtualReleaseNotesId = `\0${virtualReleaseNotesId}`;
const virtualArticlesId = 'virtual:threadnote-articles';
const resolvedVirtualArticlesId = `\0${virtualArticlesId}`;
const worktreeReadinessArtifactSource =
  `${repositoryRoot}/test/evaluation/candidates/threadnote-4.0.1/benchmarks/` +
  'darwin-arm64-m1-max/code-graph-worktree-readiness-2026-08-04.json';
const embeddingContextPerformanceArtifactSource =
  `${repositoryRoot}/test/evaluation/candidates/threadnote-4.2.5/benchmarks/` +
  'darwin-arm64-m1-max/code-graph-embedding-contexts-10000-2026-08-14.json';

const performanceEvidencePlugin = {
  name: 'threadnote-performance-evidence',
  resolveId(id: string) {
    return id === virtualEvidenceId ? resolvedVirtualEvidenceId : undefined;
  },
  async load(id: string) {
    if (id !== resolvedVirtualEvidenceId) return undefined;
    const evidence = await loadRetainedPerformanceEvidence(repositoryRoot, siteBase);
    return `export default ${JSON.stringify(evidence)};`;
  },
};

const releaseNotesPlugin: Plugin = {
  name: 'threadnote-release-notes',
  resolveId(id: string) {
    return id === virtualReleaseNotesId ? resolvedVirtualReleaseNotesId : undefined;
  },
  load(id: string) {
    if (id !== resolvedVirtualReleaseNotesId) return undefined;
    const releases = loadLatestMajorWebsiteReleases(repositoryRoot);
    return `export default ${JSON.stringify(releases)};`;
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

const worktreeReadinessEvidencePlugin: Plugin = {
  name: 'threadnote-worktree-readiness-evidence',
  async generateBundle() {
    const source = await Bun.file(worktreeReadinessArtifactSource).text();
    JSON.parse(source);
    this.emitFile({fileName: worktreeReadinessArtifactPath, source, type: 'asset'});
  },
};

const embeddingContextPerformanceEvidencePlugin: Plugin = {
  name: 'threadnote-embedding-context-performance-evidence',
  async generateBundle() {
    const source = await Bun.file(embeddingContextPerformanceArtifactSource).text();
    JSON.parse(source);
    this.emitFile({fileName: embeddingContextPerformanceArtifactPath, source, type: 'asset'});
  },
};

export default defineConfig({
  root: siteRoot,
  base: siteBase,
  plugins: [
    react(),
    performanceEvidencePlugin,
    releaseNotesPlugin,
    articlesPlugin,
    worktreeReadinessEvidencePlugin,
    embeddingContextPerformanceEvidencePlugin,
  ],
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
        whatsNew: `${siteRoot}/whats-new/index.html`,
        proTips: `${siteRoot}/pro-tips/index.html`,
        managerDemo: `${siteRoot}/manager-demo/index.html`,
        faq: `${siteRoot}/faq/index.html`,
      },
    },
  },
});
