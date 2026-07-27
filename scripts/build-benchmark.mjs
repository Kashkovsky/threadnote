import {build} from 'esbuild';

await build({
  bundle: true,
  entryPoints: ['scripts/benchmark-target.ts'],
  format: 'esm',
  legalComments: 'none',
  minify: true,
  outfile: 'build/benchmark/recall.js',
  platform: 'node',
  target: 'node22',
});
