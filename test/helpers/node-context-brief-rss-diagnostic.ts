#!/usr/bin/env bun
// Isolated diagnostic branch only. Build here; run the emitted shell separately.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {isAbsolute, join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

const base = 'e30866498152a0cd9bca6da22066c331e0e92bc1';
const baseSourceSha = 'acf6324614e475bfdb4bab6e6835edd9e23ba7270bf8d992c89e0f0c0271b228';
const driverSha = '80a86a376d6c11659959b0a08e629738e152b5a42d942fc47c23c944b74db9ae';
const root = process.cwd();
const candidate = process.env.GITHUB_SHA ?? '';
const outdir = process.env.THREADNOTE_DIAGNOSTIC_ROOT ?? '';
const classification = 'instrumented-hosted-diagnostic-never-release-qualification';
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const git = (...args: string[]) => {
  const result = spawnSync('git', args, {cwd: root, encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024});
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const clean = () => {
  assert.equal(git('rev-parse', 'HEAD'), candidate);
  assert.equal(
    git(
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.untrackedCache=false',
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
    ),
    '',
  );
};
assert.equal(Bun.version, '1.3.14');
assert.equal(process.platform, 'darwin');
assert.equal(process.arch, 'arm64');
assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.RUNNER_OS, 'macOS');
assert.equal(process.env.GITHUB_RUN_ATTEMPT, '1');
assert(/^[0-9a-f]{40}$/.test(candidate) && candidate !== base);
assert(isAbsolute(outdir) && !resolve(outdir).startsWith(resolve(root) + '/'));
assert.equal(git('merge-base', base, candidate), base);
clean();
const changed = git('diff', '--name-only', base, candidate).split('\n').filter(Boolean).sort();
assert.deepEqual(changed, ['.github/workflows/benchmarks.yml', 'test/helpers/node-context-brief-rss-diagnostic.ts']);
assert(!existsSync(outdir), 'Refuse to replace an existing diagnostic directory');
mkdirSync(outdir, {recursive: false});
const write = (name: string, bytes: string | Uint8Array) => writeFileSync(join(outdir, name), bytes, {flag: 'wx'});
const sourcePath = join(root, 'src/evaluation/context-brief-citation-scale.ts');
const source = readFileSync(sourcePath, 'utf8');
assert.equal(sha(source), baseSourceSha);
const driverPath = realpathSync(join(root, 'node_modules/@effect/sql-sqlite-bun/dist/SqliteClient.js'));
const driver = readFileSync(driverPath, 'utf8');
assert.equal(sha(driver), driverSha);
const version = JSON.parse(git('show', `${base}:package.json`)).version;
assert.equal(version, '4.6.8');
const cpu = spawnSync('sysctl', ['-n', 'machdep.cpu.brand_string'], {encoding: 'utf8', timeout: 5000, maxBuffer: 4096});
assert.equal(cpu.status, 0);
assert.equal(cpu.stdout.trim(), 'Apple M1 (Virtual)', 'This design targets the observed failing CPU class');
const counterKey = '__threadnote_e308_diagnostic_sql_counts';
const capture = `import {heapStats as diagnosticHeapStats, memoryUsage as diagnosticJscMemoryUsage} from 'bun:jsc';
import {writeFileSync as diagnosticWrite} from 'node:fs';
import {spawnSync as diagnosticSpawnSync} from 'node:child_process';
let diagnosticSequence = 0;
function diagnosticVmmap(profile: string): void {
  const prefix = ${JSON.stringify(outdir)} + '/vmmap-' + profile;
  try {
    const result = diagnosticSpawnSync('/usr/bin/vmmap', ['-summary', String(process.pid)], {timeout:5000, killSignal:'SIGKILL', maxBuffer:2097152});
    diagnosticWrite(prefix+'.stdout.txt',result.stdout ?? new Uint8Array(),{flag:'wx'});
    diagnosticWrite(prefix+'.stderr.txt',result.stderr ?? new Uint8Array(),{flag:'wx'});
    diagnosticWrite(prefix+'.result.json',JSON.stringify({classification:${JSON.stringify(classification)},status:result.status,signal:result.signal,errorCode:result.error && 'code' in result.error ? result.error.code : undefined,available:result.status===0})+'\\n',{flag:'wx'});
  } catch(error) {
    try { diagnosticWrite(prefix+'.unavailable.json',JSON.stringify({classification:${JSON.stringify(classification)},available:false,errorType:error instanceof Error?error.name:'unknown'})+'\\n',{flag:'wx'}); } catch {}
  }
}
function captureDiagnosticHeap(profile: string,ordinal: number): void {
  if(diagnosticSequence>=301) throw new Error('Diagnostic capture bound exceeded');
  if(ordinal===0) diagnosticVmmap(profile);
  const heap=diagnosticHeapStats(); const jsc=diagnosticJscMemoryUsage(); const memory=process.memoryUsage();
  const counts=(globalThis as any)[${JSON.stringify(counterKey)}] ?? {opens:0,closeAttempts:0,closes:0};
  const record={classification:${JSON.stringify(classification)},baseProductionCommit:${JSON.stringify(base)},sourceCommit:${JSON.stringify(candidate)},instrumentedBundleSha256:process.env.THREADNOTE_DIAGNOSTIC_BUNDLE_SHA256,
    phase:'after-existing-reset-and-full-gc-before-observer-barrier',profile,ordinal,sequence:diagnosticSequence,
    heapSize:heap.heapSize,heapCapacity:heap.heapCapacity,extraMemorySize:heap.extraMemorySize,objectCount:heap.objectCount,
    protectedObjectCount:heap.protectedObjectCount,globalObjectCount:heap.globalObjectCount,protectedGlobalObjectCount:heap.protectedGlobalObjectCount,
    objectTypeCounts:heap.objectTypeCounts,protectedObjectTypeCounts:heap.protectedObjectTypeCounts,jscMemory:jsc,processMemory:memory,
    sqliteDriver:{opens:counts.opens,closeAttempts:counts.closeAttempts,closes:counts.closes,openMinusClosed:counts.opens-counts.closes}};
  const line=JSON.stringify(record)+'\\n'; if(Buffer.byteLength(line)>262144) throw new Error('Diagnostic line bound exceeded');
  diagnosticWrite(${JSON.stringify(join(outdir, 'heap-observations.jsonl'))},line,{flag:diagnosticSequence===0?'wx':'a'}); diagnosticSequence++;
}

`;
function once(input: string, before: string, after: string) {
  assert.equal(input.split(before).length - 1, 1);
  return input.replace(before, after);
}
let transformed = once(
  source,
  '            prepareContextBriefCitationScaleObservation(graph);\n            const memoryRun = yield* observer.observe(',
  '            prepareContextBriefCitationScaleObservation(graph);\n            captureDiagnosticHeap(profileId,index);\n            const memoryRun = yield* observer.observe(',
);
transformed = once(
  transformed,
  '        prepareContextBriefCitationScaleObservation(graph);\n        return yield* observer.finish;',
  "        prepareContextBriefCitationScaleObservation(graph);\n        captureDiagnosticHeap('final',0);\n        return yield* observer.finish;",
);
transformed = capture + transformed;
const counter = `const diagnosticSqlCounts = globalThis[${JSON.stringify(counterKey)}] ??= {opens:0,closeAttempts:0,closes:0};\n`;
const instrumentedDriver =
  counter +
  once(
    driver,
    '    yield* Effect.addFinalizer(() => Effect.sync(() => db.close()));',
    '    diagnosticSqlCounts.opens++;\n    yield* Effect.addFinalizer(() => Effect.sync(() => { diagnosticSqlCounts.closeAttempts++; db.close(); diagnosticSqlCounts.closes++; }));',
  );
write('original-scale.ts', source);
write('instrumented-scale.ts', transformed);
write('original-sql-driver.js', driver);
write('instrumented-sql-driver.js', instrumentedDriver);
write('branch.diff', git('diff', '--binary', base, candidate) + '\n');
write(
  'budget.json',
  readFileSync(join(root, 'test/evaluation/baselines/context-brief-citations-v1/scale-budgets.json')),
);
write('workflow.yml', readFileSync(join(root, '.github/workflows/benchmarks.yml')));
let scaleLoads = 0,
  driverLoads = 0;
const options = {
  bytecode: false,
  define: {THREADNOTE_VERSION: JSON.stringify(version)},
  entrypoints: [join(root, 'scripts/benchmark-context-brief-citations-target.ts')],
  format: 'esm' as const,
  minify: true,
  naming: 'context-brief-citation-scale-diagnostic.mjs',
  outdir,
  sourcemap: 'none' as const,
  target: 'bun' as const,
  write: true,
};
const result = await Bun.build({
  ...options,
  plugins: [
    {
      name: 'diagnostic-only-exact-two-boundaries-and-scalar-driver-counts',
      setup(build) {
        build.onLoad({filter: /context-brief-citation-scale\.ts$/}, args => {
          if (resolve(args.path) !== sourcePath) return;
          scaleLoads++;
          return {contents: transformed, loader: 'ts'};
        });
        build.onLoad({filter: /SqliteClient\.js$/}, args => {
          if (realpathSync(args.path) !== driverPath) return;
          driverLoads++;
          return {contents: instrumentedDriver, loader: 'js'};
        });
      },
    },
  ],
});
assert(result.success, result.logs.map(x => x.message).join('\n'));
assert.equal(scaleLoads, 1);
assert.equal(driverLoads, 1);
clean();
const bundle = join(outdir, 'context-brief-citation-scale-diagnostic.mjs');
const bundleSha = sha(readFileSync(bundle));
write(
  'build-manifest.json',
  JSON.stringify(
    {
      classification,
      qualification: false,
      baseProductionCommit: base,
      observedBranchCommit: candidate,
      sourceTree: git('rev-parse', 'HEAD^{tree}'),
      changedPaths: changed,
      sourceSha256: sha(source),
      instrumentedSourceSha256: sha(transformed),
      driverSha256: sha(driver),
      instrumentedDriverSha256: sha(instrumentedDriver),
      instrumentedBundleSha256: bundleSha,
      buildRuntime: Bun.version,
      cpu: cpu.stdout.trim(),
      buildOptions: options,
      runId: process.env.GITHUB_RUN_ID,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT,
      workflowRef: process.env.GITHUB_WORKFLOW_REF,
      repository: process.env.GITHUB_REPOSITORY,
      runnerOS: process.env.RUNNER_OS,
      runnerArch: process.env.RUNNER_ARCH,
      perturbation:
        'Scalar/type maps, JSONL writes, counters and four optional bounded vmmap invocations may perturb RSS; never release qualification.',
      scope: {
        memoryCandidates: 100000,
        samples: 100,
        warmups: 5,
        fixtureRunCount: 205,
        profiles: ['local-100k', 'workset-50', 'workset-128'],
      },
    },
    null,
    2,
  ) + '\n',
);
const q = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
write(
  'run.sh',
  `#!/bin/sh
set -eu
cd ${q(root)}
test "$(git rev-parse HEAD)" = ${q(candidate)}
test -z "$(git -c core.fsmonitor=false -c core.untrackedCache=false status --porcelain=v1 --untracked-files=all)"
test "$(bun --version)" = 1.3.14
test ! -e ${q(join(outdir, 'heap-observations.jsonl'))}
test ! -e ${q(join(outdir, 'diagnostic-artifact.json'))}
test "$(shasum -a 256 ${q(bundle)} | cut -d ' ' -f 1)" = ${q(bundleSha)}
export THREADNOTE_DIAGNOSTIC_BUNDLE_SHA256=${q(bundleSha)}
exec bun ${q(bundle)} --candidate-commit ${q(candidate)} --memory-candidates 100000 --samples 100 --warmups 5 --profiles local-100k,workset-50,workset-128 --output ${q(join(outdir, 'diagnostic-artifact.json'))} --built-artifact-sha256 ${q(bundleSha)}
`,
);
await Bun.write(
  Bun.stdout,
  JSON.stringify({
    classification,
    built: true,
    executed: false,
    manifest: join(outdir, 'build-manifest.json'),
    bundleSha,
  }),
);
