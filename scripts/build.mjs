import {build} from 'esbuild';

const nodeBanner = {
  js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
};

await Promise.all([
  build({
    banner: nodeBanner,
    bundle: true,
    entryPoints: ['src/threadnote.ts'],
    format: 'esm',
    legalComments: 'none',
    minify: true,
    outfile: 'dist/threadnote.js',
    platform: 'node',
    target: 'node20',
  }),
  build({
    banner: nodeBanner,
    bundle: true,
    entryPoints: ['src/mcp_server.ts'],
    format: 'esm',
    legalComments: 'none',
    minify: true,
    outfile: 'dist/mcp_server.js',
    platform: 'node',
    target: 'node20',
  }),
  build({
    bundle: true,
    entryPoints: ['src/manager_ui.tsx'],
    format: 'iife',
    legalComments: 'none',
    minify: true,
    outfile: 'manager/app.js',
    platform: 'browser',
    target: 'es2020',
  }),
]);
