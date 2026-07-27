import {bench, do_not_optimize, run} from 'mitata';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdir, rename, writeFile} from 'node:fs/promises';
import {arch, cpus, platform, release, totalmem} from 'node:os';
import {dirname, resolve} from 'node:path';
import {createBenchmarkFixture, runBenchmarkQuery} from '../build/benchmark/recall.js';

const sizes = process.env.THREADNOTE_BENCHMARK_100K === '1' ? [200, 1_000, 10_000, 100_000] : [200, 1_000, 10_000];
const fixtures = new Map(sizes.map(size => [size, createBenchmarkFixture(size)]));

for (const size of sizes) {
  const fixture = fixtures.get(size);
  bench(`hybrid rank one query / ${size} documents`, () => {
    do_not_optimize(runBenchmarkQuery(fixture));
  }).gc('once');
}

if (process.argv.includes('--json') || process.argv.includes('--output')) {
  const result = await run({format: 'quiet', throw: true});
  const artifact = {
    benchmarks: result.benchmarks.flatMap(trial =>
      trial.runs.map(runResult => ({
        arguments: runResult.args,
        error: runResult.error ? String(runResult.error) : undefined,
        name: runResult.name,
        statistics: runResult.stats
          ? {
              averageNanoseconds: runResult.stats.avg,
              heap: runResult.stats.heap,
              maximumNanoseconds: runResult.stats.max,
              minimumNanoseconds: runResult.stats.min,
              p50Nanoseconds: runResult.stats.p50,
              p99Nanoseconds: runResult.stats.p99,
              samples: runResult.stats.ticks,
            }
          : undefined,
      })),
    ),
    createdAt: new Date().toISOString(),
    environment: {
      architecture: arch(),
      commit: git(['rev-parse', 'HEAD']),
      cpu: cpus()[0]?.model ?? result.context.cpu.name,
      dirty: git(['status', '--porcelain']).length > 0,
      memoryBytes: totalmem(),
      node: process.version,
      operatingSystem: `${platform()} ${release()}`,
      packageManager: `npm/${execFileSync('npm', ['--version'], {encoding: 'utf8'}).trim()}`,
      runtime: result.context.runtime,
    },
    fixtures: Object.fromEntries(
      [...fixtures].map(([size, fixture]) => [
        String(size),
        createHash('sha256').update(JSON.stringify(fixture)).digest('hex'),
      ]),
    ),
    runner: {name: 'mitata', version: '1.0.34'},
    version: 1,
  };
  const json = `${JSON.stringify(artifact, undefined, 2)}\n`;
  const outputIndex = process.argv.indexOf('--output');
  if (outputIndex !== -1) {
    const outputPath = process.argv[outputIndex + 1];
    if (!outputPath) throw new Error('--output requires a path');
    const target = resolve(outputPath);
    const temporary = `${target}.tmp-${process.pid}`;
    await mkdir(dirname(target), {recursive: true});
    await writeFile(temporary, json, 'utf8');
    await rename(temporary, target);
  }
  if (process.argv.includes('--json') || outputIndex === -1) process.stdout.write(json);
} else {
  await run({throw: true});
}

function git(args) {
  return execFileSync('git', args, {encoding: 'utf8'}).trim();
}
