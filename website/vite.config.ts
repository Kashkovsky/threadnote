import {resolve} from 'node:path';
import react from '@vitejs/plugin-react';
import {defineConfig} from 'vite';

const siteRoot = resolve(import.meta.dirname);

export default defineConfig({
  root: siteRoot,
  base: process.env.THREADNOTE_SITE_BASE ?? '/',
  plugins: [react()],
  build: {
    outDir: resolve(siteRoot, '../site-dist'),
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      input: {
        home: resolve(siteRoot, 'index.html'),
        docs: resolve(siteRoot, 'docs/index.html'),
        proTips: resolve(siteRoot, 'pro-tips/index.html'),
        managerDemo: resolve(siteRoot, 'manager-demo/index.html'),
        faq: resolve(siteRoot, 'faq/index.html'),
      },
    },
  },
});
