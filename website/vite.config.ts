import react from '@vitejs/plugin-react';
import {defineConfig} from 'vite';
import {loadRetainedPerformanceEvidence} from '../scripts/site-performance-evidence.ts';

const repositoryRoot = process.cwd();
const siteRoot = `${repositoryRoot}/website`;
const virtualEvidenceId = 'virtual:threadnote-performance-evidence';
const resolvedVirtualEvidenceId = `\0${virtualEvidenceId}`;

const performanceEvidencePlugin = {
  name: 'threadnote-performance-evidence',
  resolveId(id: string) {
    return id === virtualEvidenceId ? resolvedVirtualEvidenceId : undefined;
  },
  async load(id: string) {
    if (id !== resolvedVirtualEvidenceId) return undefined;
    const evidence = await loadRetainedPerformanceEvidence(repositoryRoot);
    return `export default ${JSON.stringify(evidence)};`;
  },
};

export default defineConfig({
  root: siteRoot,
  base: process.env.THREADNOTE_SITE_BASE ?? '/',
  plugins: [react(), performanceEvidencePlugin],
  build: {
    outDir: `${siteRoot}/../site-dist`,
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      input: {
        home: `${siteRoot}/index.html`,
        performance: `${siteRoot}/performance/index.html`,
        docs: `${siteRoot}/docs/index.html`,
        proTips: `${siteRoot}/pro-tips/index.html`,
        managerDemo: `${siteRoot}/manager-demo/index.html`,
        faq: `${siteRoot}/faq/index.html`,
      },
    },
  },
});
